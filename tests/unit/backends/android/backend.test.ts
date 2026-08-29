import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { type AdbResult, INSTALL_ADB_TIMEOUT_MS } from '@/backends/android/adb.js';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import { parseDeviceSerial } from '@/core/ids.js';

/**
 * The backend driven off the **captured** adb output of `tests/fixtures/adb/`, with only
 * the process replaced. What that proves is the join — the argv, the mapping onto the
 * neutral vocabulary, and the arithmetic — and nothing whatsoever about a device
 * (ai/TESTING.md). `tests/device/android/backend.test.ts` is the other half.
 */
type Runner = typeof import('@/backends/android/adb.js');

const { runAdb, runAdbOnDevice } = vi.hoisted(() => ({
	runAdb: vi.fn<Runner['runAdb']>(),
	runAdbOnDevice: vi.fn<Runner['runAdbOnDevice']>(),
}));

vi.mock('@/backends/android/adb.js', async (importOriginal) => ({
	...(await importOriginal<Runner>()),
	runAdb,
	runAdbOnDevice,
}));

const fixture = (name: string): string =>
	readFileSync(new URL(`../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const DEVICES = fixture('devices-l.api37-sdk-gphone16k-arm64.txt');
const OFFLINE = fixture('devices-l.offline.api37-sdk-gphone16k-arm64.txt');
const EMPTY = fixture('devices-l.empty.txt');
const DAEMON_FAILED = fixture('devices-l.daemon-failed.txt');
const SIZE = fixture('wm-size.api37-sdk-gphone16k-arm64.txt');
const SIZE_OVERRIDE = fixture('wm-size.override.api37-sdk-gphone16k-arm64.txt');
const DENSITY = fixture('wm-density.api37-sdk-gphone16k-arm64.txt');
const DENSITY_OVERRIDE = fixture('wm-density.override.api37-sdk-gphone16k-arm64.txt');
const GETPROP = fixture('getprop.api37-sdk-gphone16k-arm64.txt');

const SERIAL = parseDeviceSerial('emulator-5554');
const backend = new AndroidDeviceBackend();

function enumerates(stdout: string, stderr = ''): void {
	runAdb.mockResolvedValue({ stdout, stderr });
}

/**
 * Answers each pinned call by the arguments it was called with. A bare string is stdout
 * with an empty stderr; a pair is used when the split between the two streams is the
 * thing under test, which for the app verbs it usually is.
 */
function answers(replies: Record<string, string | AdbResult>): void {
	runAdbOnDevice.mockImplementation(async (_serial, args): Promise<AdbResult> => {
		const reply = replies[args.join(' ')];
		if (reply === undefined) throw new Error(`unexpected call: ${args.join(' ')}`);
		return typeof reply === 'string' ? { stdout: reply, stderr: '' } : reply;
	});
}

const FACTS = {
	'shell wm size': SIZE,
	'shell wm density': DENSITY,
	'shell getprop': GETPROP,
};

describe('listDevices', () => {
	it('reports a usable device with the model adb already printed', async () => {
		enumerates(DEVICES);

		expect(await backend.listDevices()).toEqual([
			{
				serial: 'emulator-5554',
				platform: 'android',
				model: 'sdk_gphone16k_arm64',
				state: 'ready',
			},
		]);
		expect(runAdb.mock.calls[0][0]).toEqual(['devices', '-l']);
	});

	// The model is read off the `-l` tail rather than from a per-device query, and this is
	// what says that survives a device that cannot answer a query at all.
	it('still names a device that is attached but not usable', async () => {
		enumerates(OFFLINE);

		expect(await backend.listDevices()).toEqual([
			{
				serial: 'emulator-5554',
				platform: 'android',
				model: 'sdk_gphone16k_arm64',
				state: 'offline',
			},
		]);
	});

	it('reports no device at all as an empty list rather than a failure', async () => {
		enumerates(EMPTY);

		expect(await backend.listDevices()).toEqual([]);
	});

	/**
	 * Synthetic input, deliberately: this pins the **mapping**, not adb's vocabulary. Only
	 * `device` and `offline` have been captured (tests/fixtures/adb/README.md), so the
	 * token below is one adb will never print — what is asserted is that an unrecognised
	 * state is reported as unusable rather than optimistically as `ready`. Replace it with
	 * a capture the day a real one is taken.
	 */
	it('reports a state it has never seen as unusable', async () => {
		enumerates('List of devices attached\nserial-1\tsome-state-never-captured\n');

		expect((await backend.listDevices())[0]?.state).toBe('offline');
	});

	it('maps the refused-authorisation state onto its own vocabulary', async () => {
		enumerates('List of devices attached\nserial-1\tunauthorized\n');

		expect((await backend.listDevices())[0]?.state).toBe('unauthorized');
	});

	// An exit-0 body with no device list is a failure the parser catches, and the reason is
	// on the stream the parser never saw — so the rethrow has to carry it.
	it('quotes both streams when the output carries no device list', async () => {
		enumerates('', DAEMON_FAILED.split('List of devices attached')[0] as string);

		await expect(backend.listDevices()).rejects.toThrow(/cannot connect to daemon/);
		await expect(backend.listDevices()).rejects.toThrow(/adb devices -l/);
	});

	it('lets a failed run surface as the runner reported it', async () => {
		runAdb.mockRejectedValue(new Error('adb devices -l exited 1'));

		await expect(backend.listDevices()).rejects.toThrow('adb devices -l exited 1');
	});
});

describe('describeDevice', () => {
	it('answers with the device when it is still attached', async () => {
		enumerates(DEVICES);

		expect(await backend.describeDevice(SERIAL)).toEqual({
			serial: 'emulator-5554',
			platform: 'android',
			model: 'sdk_gphone16k_arm64',
			state: 'ready',
		});
	});

	it('answers null for a device that is not there', async () => {
		enumerates(DEVICES);

		expect(await backend.describeDevice(parseDeviceSerial('no-such-device'))).toBeNull();
	});

	it('re-reads the device list on every call rather than caching it', async () => {
		enumerates(DEVICES);
		await backend.describeDevice(SERIAL);
		await backend.describeDevice(SERIAL);

		expect(runAdb).toHaveBeenCalledTimes(2);
	});
});

describe('deviceInfo', () => {
	it('reports the screen, the dp scale and the OS, and names the device (D14)', async () => {
		answers(FACTS);

		const info = await backend.deviceInfo(SERIAL);

		expect(info.serial).toBe('emulator-5554');
		expect(info.platform).toBe('android');
		expect(info.model).toBe('sdk_gphone16k_arm64');
		expect(info.osVersion).toBe('17');
		expect(info.osApiLevel).toBe(37);
		expect(info.screen).toMatchObject({
			widthPx: 1280,
			heightPx: 2856,
			density: 480,
			densityScale: 3,
			heightDp: 952,
		});
		// Unrounded on purpose: 1280 ÷ 3 is not a whole number of dp, and rounding it here
		// would leave no way to ask what the device actually said.
		expect(info.screen.widthDp).toBeCloseTo(426.667, 3);
	});

	// The assertion that proves the *effective* values — the override — are what the dp
	// scale and a coordinate belong to, rather than the physical ones (PROJECT.md §6).
	it('measures what the device renders at when an override is set', async () => {
		answers({ ...FACTS, 'shell wm size': SIZE_OVERRIDE, 'shell wm density': DENSITY_OVERRIDE });

		expect((await backend.deviceInfo(SERIAL)).screen).toEqual({
			widthPx: 720,
			heightPx: 1600,
			density: 320,
			densityScale: 2,
			widthDp: 360,
			heightDp: 800,
		});
	});

	it('pins every one of its queries to the device it was asked about', async () => {
		answers(FACTS);
		await backend.deviceInfo(SERIAL);

		expect(runAdbOnDevice.mock.calls.map((call) => call[0])).toEqual([SERIAL, SERIAL, SERIAL]);
		expect(runAdbOnDevice.mock.calls.map((call) => call[1].join(' '))).toEqual([
			'shell wm size',
			'shell wm density',
			'shell getprop',
		]);
	});

	// `null` is this codebase's answer for a lookup miss, and `describeDevice` is where
	// that question is asked. A failed query is a failure.
	it('throws rather than answering an empty measurement when a query fails', async () => {
		runAdbOnDevice.mockRejectedValue(new Error("device 'emulator-5554' not found"));

		await expect(backend.deviceInfo(SERIAL)).rejects.toThrow("device 'emulator-5554' not found");
	});
});

/**
 * The app lifecycle primitives, driven off output **captured verbatim from a real
 * device** — an API 37 emulator (`sdk_gphone16k_arm64`) with adb 37.0.1, 2026-08-29. Same
 * rule as `tests/fixtures/adb/` (ai/TESTING.md "Fixtures come off a real device"); inline
 * rather than in a file because each is one to four short lines and every one of them is
 * only meaningful next to the assertion it explains.
 */
const RESOLVED_SETTINGS =
	'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n' +
	'com.android.settings/.Settings\n';
const NO_ACTIVITY = 'No activity found\n';
const RESOLVE_SETTINGS = 'shell cmd package resolve-activity --brief com.android.settings';
const START_SETTINGS = 'shell am start -n com.android.settings/.Settings';

describe('installApp', () => {
	// The whole point of `runAdbOnDevice`: an unpinned install lands on whichever device
	// adb picked, and looks like a success from both sides (PROJECT.md §2).
	it('installs through the pinned runner, replacing what is already there', async () => {
		answers({ 'install -r /tmp/probe.apk': 'Success\n' });

		await backend.installApp(SERIAL, '/tmp/probe.apk');

		expect(runAdb).not.toHaveBeenCalled();
		expect(runAdbOnDevice.mock.calls[0][0]).toBe(SERIAL);
		expect(runAdbOnDevice.mock.calls[0][1]).toEqual(['install', '-r', '/tmp/probe.apk']);
	});

	/**
	 * The captured success, in full. Neither `stdout.trim() === 'Success'` nor "stderr is
	 * empty" survives it — adb wraps the word in three other lines and writes a progress
	 * note to stderr on the way through — and either shortcut would reject an install that
	 * worked.
	 */
	it('accepts the four-line success adb actually prints, stderr and all', async () => {
		answers({
			'install -r /tmp/probe.apk': {
				stdout:
					'Serving...\nPerforming Incremental Install\nSuccess\n' +
					'Install command complete in 49 ms\n',
				stderr: 'All files should be loaded. Notifying the device.\n',
			},
		});

		await expect(backend.installApp(SERIAL, '/tmp/probe.apk')).resolves.toBeUndefined();
	});

	it('gives the install its own timeout rather than the ten seconds a query gets', async () => {
		answers({ 'install -r /tmp/probe.apk': 'Success\n' });

		await backend.installApp(SERIAL, '/tmp/probe.apk');

		expect(runAdbOnDevice.mock.calls[0][2]).toEqual({ timeoutMs: INSTALL_ADB_TIMEOUT_MS });
	});

	// The acceptance criterion of this change: exit 0 and a failure in the output is a
	// failure, and the message has to carry the reason the caller cannot otherwise see.
	it('throws on a Failure adb reported while exiting 0, quoting both streams', async () => {
		answers({
			'install -r /tmp/probe.apk': {
				stdout: 'Performing Streamed Install\n',
				stderr:
					'adb: failed to install /tmp/probe.apk: ' +
					'Failure [INSTALL_FAILED_TEST_ONLY: Failed to install test-only apk.]\n',
			},
		});

		const failure = backend.installApp(SERIAL, '/tmp/probe.apk');

		await expect(failure).rejects.toThrow(/INSTALL_FAILED_TEST_ONLY/);
		await expect(failure).rejects.toThrow(/Performing Streamed Install/);
		await expect(failure).rejects.toThrow(/emulator-5554/);
	});

	// Same failure, on the stream the era's guides do not put it on.
	it('throws when the Failure came back on stdout instead', async () => {
		answers({
			'install -r /tmp/probe.apk': 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]\n',
		});

		await expect(backend.installApp(SERIAL, '/tmp/probe.apk')).rejects.toThrow(
			/INSTALL_FAILED_INSUFFICIENT_STORAGE/,
		);
	});

	it('lets a non-zero exit surface as the runner reported it', async () => {
		runAdbOnDevice.mockRejectedValue(new Error('adb -s emulator-5554 install -r … exited 1'));

		await expect(backend.installApp(SERIAL, '/tmp/probe.apk')).rejects.toThrow('exited 1');
	});
});

describe('launchApp', () => {
	it('resolves the component on the device, then starts it — both calls pinned', async () => {
		answers({ [RESOLVE_SETTINGS]: RESOLVED_SETTINGS, [START_SETTINGS]: 'Starting: Intent { }\n' });

		await backend.launchApp(SERIAL, 'com.android.settings');

		expect(runAdb).not.toHaveBeenCalled();
		expect(runAdbOnDevice.mock.calls.map((call) => call[0])).toEqual([SERIAL, SERIAL]);
		expect(runAdbOnDevice.mock.calls.map((call) => call[1].join(' '))).toEqual([
			RESOLVE_SETTINGS,
			START_SETTINGS,
		]);
	});

	// `--brief` is not brief: it prints a `priority=… ` header above the answer, so a
	// parser reading the first line hands `priority=0 …` to `am start -n`.
	it('reads the component past the header line resolve-activity prints above it', async () => {
		answers({ [RESOLVE_SETTINGS]: RESOLVED_SETTINGS, [START_SETTINGS]: 'Starting: Intent { }\n' });

		await backend.launchApp(SERIAL, 'com.android.settings');

		expect(runAdbOnDevice.mock.calls[1][1]).toEqual([
			'shell',
			'am',
			'start',
			'-n',
			'com.android.settings/.Settings',
		]);
	});

	/**
	 * `No activity found` on stdout with exit 0 is what a package that is not installed
	 * *and* one with nothing launchable both answer. Either way there is no component, and
	 * the failure has to name the app id — nothing downstream can work out which it was.
	 */
	it('throws, naming the app, when nothing launchable resolves', async () => {
		answers({ 'shell cmd package resolve-activity --brief com.rover.nope': NO_ACTIVITY });

		const failure = backend.launchApp(SERIAL, 'com.rover.nope');

		await expect(failure).rejects.toThrow(/com\.rover\.nope/);
		await expect(failure).rejects.toThrow(/No activity found/);
		expect(runAdbOnDevice).toHaveBeenCalledTimes(1);
	});

	// The app was already on top. That is a launch that succeeded, and treating the word
	// `Warning` as a failure would make re-launching the foreground app throw.
	it('treats the already-top-most warning as a launch that happened', async () => {
		answers({
			[RESOLVE_SETTINGS]: RESOLVED_SETTINGS,
			[START_SETTINGS]:
				'Starting: Intent { cmp=com.android.settings/.Settings }\n' +
				'Warning: Activity not started, intent has been delivered to currently ' +
				'running top-most instance.\n',
		});

		await expect(backend.launchApp(SERIAL, 'com.android.settings')).resolves.toBeUndefined();
	});

	// `Starting: Intent …` is printed *before* anything can have gone wrong, so it is not
	// on its own evidence of a launch — this is the shape that would read as a success.
	it('throws when am start printed its Error on stdout and still exited 0', async () => {
		answers({
			[RESOLVE_SETTINGS]: RESOLVED_SETTINGS,
			[START_SETTINGS]:
				'Starting: Intent { cmp=com.android.settings/.Settings }\nError type 3\n' +
				'Error: Activity class {com.android.settings/.Settings} does not exist.\n',
		});

		await expect(backend.launchApp(SERIAL, 'com.android.settings')).rejects.toThrow(
			/Activity class .* does not exist/,
		);
	});

	it('throws when the refusal came back on stderr instead', async () => {
		answers({
			[RESOLVE_SETTINGS]: RESOLVED_SETTINGS,
			[START_SETTINGS]: {
				stdout: 'Starting: Intent { cmp=com.android.settings/.Settings }\n',
				stderr:
					"\nException occurred while executing 'start':\n" +
					'java.lang.SecurityException: Permission Denial: starting Intent …\n' +
					'\tat com.android.server.wm.ActivityStarter.execute(ActivityStarter.java:911)\n',
			},
		});

		await expect(backend.launchApp(SERIAL, 'com.android.settings')).rejects.toThrow(
			/Permission Denial/,
		);
	});

	// Silence from `am start` is not success either: nothing was dispatched.
	it('throws when am start said nothing at all', async () => {
		answers({ [RESOLVE_SETTINGS]: RESOLVED_SETTINGS, [START_SETTINGS]: '' });

		await expect(backend.launchApp(SERIAL, 'com.android.settings')).rejects.toThrow(
			/am start -n com\.android\.settings\/\.Settings/,
		);
	});
});

describe('stopApp', () => {
	// A force-stop that worked prints zero bytes on both streams, so silence is the only
	// success wording there is.
	it('force-stops through the pinned runner, and takes silence for success', async () => {
		answers({ 'shell am force-stop com.android.settings': '' });

		await backend.stopApp(SERIAL, 'com.android.settings');

		expect(runAdb).not.toHaveBeenCalled();
		expect(runAdbOnDevice.mock.calls[0][0]).toBe(SERIAL);
		expect(runAdbOnDevice.mock.calls[0][1]).toEqual([
			'shell',
			'am',
			'force-stop',
			'com.android.settings',
		]);
	});

	it('throws when force-stop said anything at all, on either stream', async () => {
		answers({
			'shell am force-stop com.android.settings': {
				stdout: '',
				stderr:
					"\nException occurred while executing 'force-stop':\n" +
					'java.lang.IllegalArgumentException: Argument expected after "force-stop"\n',
			},
		});

		await expect(backend.stopApp(SERIAL, 'com.android.settings')).rejects.toThrow(
			/IllegalArgumentException/,
		);
	});
});

describe('clearAppData', () => {
	it('clears through the pinned runner', async () => {
		answers({ 'shell pm clear com.android.settings': 'Success\n' });

		await backend.clearAppData(SERIAL, 'com.android.settings');

		expect(runAdb).not.toHaveBeenCalled();
		expect(runAdbOnDevice.mock.calls[0][0]).toBe(SERIAL);
		expect(runAdbOnDevice.mock.calls[0][1]).toEqual([
			'shell',
			'pm',
			'clear',
			'com.android.settings',
		]);
	});

	// The one-word failure, on the stream API 37 puts it on…
	it('throws on the bare Failed adb answers with', async () => {
		answers({
			'shell pm clear com.rover.nope': { stdout: '', stderr: 'Failed\n' },
		});

		const failure = backend.clearAppData(SERIAL, 'com.rover.nope');

		await expect(failure).rejects.toThrow(/pm clear com\.rover\.nope/);
		await expect(failure).rejects.toThrow(/Failed/);
	});

	// …and on the one every guide of the era shows it on, exit 0 and all.
	it('throws when Failed came back on stdout with exit 0', async () => {
		answers({ 'shell pm clear com.rover.nope': 'Failed\n' });

		await expect(backend.clearAppData(SERIAL, 'com.rover.nope')).rejects.toThrow(/Failed/);
	});
});

/**
 * The property the four share, asserted once over all of them rather than trusted to the
 * per-verb cases above: a verb that swallowed its failure would still pass every argv
 * assertion in this file.
 */
describe('no app verb swallows a failure', () => {
	const REFUSALS: ReadonlyArray<[string, AdbResult, () => Promise<void>]> = [
		[
			'installApp',
			{ stdout: 'Performing Streamed Install\n', stderr: 'Failure [INSTALL_FAILED_OLDER_SDK]\n' },
			() => backend.installApp(SERIAL, '/tmp/probe.apk'),
		],
		[
			'launchApp',
			{ stdout: NO_ACTIVITY, stderr: '' },
			() => backend.launchApp(SERIAL, 'com.rover.nope'),
		],
		[
			'stopApp',
			{ stdout: '', stderr: 'Error: bad argument\n' },
			() => backend.stopApp(SERIAL, 'com.rover.nope'),
		],
		[
			'clearAppData',
			{ stdout: '', stderr: 'Failed\n' },
			() => backend.clearAppData(SERIAL, 'com.rover.nope'),
		],
	];

	it.each(REFUSALS)('%s rejects rather than resolving', async (_name, reply, call) => {
		runAdbOnDevice.mockResolvedValue(reply);

		await expect(call()).rejects.toThrow();
	});
});
