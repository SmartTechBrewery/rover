import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type AdbResult,
	type AdbStreamHandlers,
	INSTALL_ADB_TIMEOUT_MS,
	SCREENSHOT_ADB_TIMEOUT_MS,
} from '@/backends/android/adb.js';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import type { Device, DeviceWatcher } from '@/core/device.js';
import { UnsupportedTextError } from '@/core/errors.js';
import { type AppId, InvalidIdError, parseAppId, parseDeviceSerial } from '@/core/ids.js';

/**
 * The backend driven off the **captured** adb output of `tests/fixtures/adb/`, with only
 * the process replaced. What that proves is the join — the argv, the mapping onto the
 * neutral vocabulary, and the arithmetic — and nothing whatsoever about a device
 * (ai/TESTING.md). `tests/device/android/backend.test.ts` is the other half.
 */
type Runner = typeof import('@/backends/android/adb.js');

const { runAdb, runAdbOnDevice, runAdbBinaryOnDevice, streamAdb } = vi.hoisted(() => ({
	runAdb: vi.fn<Runner['runAdb']>(),
	runAdbOnDevice: vi.fn<Runner['runAdbOnDevice']>(),
	runAdbBinaryOnDevice: vi.fn<Runner['runAdbBinaryOnDevice']>(),
	streamAdb: vi.fn<Runner['streamAdb']>(),
}));

vi.mock('@/backends/android/adb.js', async (importOriginal) => ({
	...(await importOriginal<Runner>()),
	runAdb,
	runAdbOnDevice,
	runAdbBinaryOnDevice,
	streamAdb,
}));

const fixture = (name: string): string =>
	readFileSync(new URL(`../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const DEVICES = fixture('devices-l.api37-sdk-gphone16k-arm64.txt');
const TRACK = readFileSync(
	new URL(
		'../../../fixtures/adb/track-devices-l.connect-disconnect.api37-sdk-gphone16k-arm64.txt',
		import.meta.url,
	),
);
const OFFLINE = fixture('devices-l.offline.api37-sdk-gphone16k-arm64.txt');
const EMPTY = fixture('devices-l.empty.txt');
const DAEMON_FAILED = fixture('devices-l.daemon-failed.txt');
const SIZE = fixture('wm-size.api37-sdk-gphone16k-arm64.txt');
const SIZE_OVERRIDE = fixture('wm-size.override.api37-sdk-gphone16k-arm64.txt');
const DENSITY = fixture('wm-density.api37-sdk-gphone16k-arm64.txt');
const DENSITY_OVERRIDE = fixture('wm-density.override.api37-sdk-gphone16k-arm64.txt');
const GETPROP = fixture('getprop.api37-sdk-gphone16k-arm64.txt');

const SERIAL = parseDeviceSerial('emulator-5554');
const SETTINGS = parseAppId('com.android.settings');
const ABSENT = parseAppId('com.rover.nope');
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
				attachment: 'this-host',
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
				attachment: 'this-host',
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

/**
 * `watchDevices`, driven by the **captured** bytes of a real `adb track-devices -l` run
 * with only the process replaced. What it proves is the join: the argv, one snapshot per
 * frame, and — the part that matters most — that an end of stream never reaches a listener
 * as an empty device list (PROJECT.md §6).
 *
 * The D18 case is covered here and in `attachment.test.ts` off the same capture rather
 * than by a device test: `adb connect` mutates the host's adb state, and a suite that did
 * it would race every other one on the machine.
 */
describe('watchDevices', () => {
	/** The handlers the backend passed to the runner, per tracker it started. */
	let trackers: AdbStreamHandlers[];
	let stops: Array<ReturnType<typeof vi.fn>>;

	function watcher(): DeviceWatcher & {
		onDevices: ReturnType<typeof vi.fn>;
		onInterrupted: ReturnType<typeof vi.fn>;
	} {
		return { onDevices: vi.fn(), onInterrupted: vi.fn() };
	}

	/** The snapshots a listener was handed, in order. */
	const snapshots = (listener: { onDevices: ReturnType<typeof vi.fn> }): Device[][] =>
		listener.onDevices.mock.calls.map(([devices]) => devices as Device[]);

	beforeEach(() => {
		vi.useFakeTimers();
		trackers = [];
		stops = [];
		streamAdb.mockImplementation((_args, handlers) => {
			trackers.push(handlers);
			const stop = vi.fn(async () => {});
			stops.push(stop);
			return { stop };
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('watches with the long format, and starts as soon as it is asked to', () => {
		backend.watchDevices(watcher());

		expect(streamAdb).toHaveBeenCalledTimes(1);
		expect(streamAdb.mock.calls[0]?.[0]).toEqual(['track-devices', '-l']);
	});

	it('delivers one full snapshot per frame, mapped onto the neutral vocabulary', () => {
		const listener = watcher();
		backend.watchDevices(listener);

		trackers[0]?.onStdout(TRACK);

		expect(snapshots(listener)).toHaveLength(7);
		expect(snapshots(listener)[0]).toEqual([
			{
				serial: 'emulator-5554',
				platform: 'android',
				model: 'sdk_gphone16k_arm64',
				state: 'ready',
				attachment: 'this-host',
			},
		]);
	});

	// The frame the capture exists for: one physical device, two entries, both physically
	// attached here, the second reached over loopback.
	it('classifies every device of a multi-device snapshot as attached to this host', () => {
		const listener = watcher();
		backend.watchDevices(listener);

		trackers[0]?.onStdout(TRACK);
		const both = snapshots(listener).find((devices) => devices.length === 2) ?? [];

		expect(both.map((device) => device.serial)).toEqual(['emulator-5554', 'localhost:5555']);
		expect(both.every((device) => device.attachment === 'this-host')).toBe(true);
	});

	/**
	 * Synthetic, deliberately: no capture on the writing host had a device attached through
	 * another machine's address, and taking one would have meant reaching a second machine
	 * (tests/fixtures/adb/README.md). The framing is the captured format; only the address
	 * is invented.
	 */
	it('reports a device reached over a network transport as another host’s', () => {
		const listener = watcher();
		backend.watchDevices(listener);

		trackers[0]?.onStdout(frame('192.168.1.9:5555         device transport_id:4\n'));

		expect(snapshots(listener)[0]?.[0]?.attachment).toBe('another-host');
	});

	it('reassembles a snapshot split across chunks, and delivers it once', () => {
		const listener = watcher();
		backend.watchDevices(listener);

		trackers[0]?.onStdout(TRACK.subarray(0, 30));
		expect(listener.onDevices).not.toHaveBeenCalled();

		trackers[0]?.onStdout(TRACK.subarray(30, 4 + 0x74));
		expect(listener.onDevices).toHaveBeenCalledTimes(1);
	});

	/**
	 * The trap this whole design is shaped around: on adb 37.0.1 the tracker exits **0**
	 * when its server dies (PROJECT.md §6). Delivered as an empty snapshot, that reads as
	 * every device having gone away at the exact moment the host lost the ability to know.
	 */
	it('reports an end of stream as an interruption and never as an empty list', () => {
		const listener = watcher();
		backend.watchDevices(listener);

		trackers[0]?.onStdout(TRACK);
		listener.onDevices.mockClear();
		trackers[0]?.onEnd('adb track-devices -l ended with exit 0');

		expect(listener.onInterrupted).toHaveBeenCalledWith('adb track-devices -l ended with exit 0');
		expect(listener.onDevices).not.toHaveBeenCalled();
	});

	it('restarts the tracker after a bounded wait', () => {
		backend.watchDevices(watcher());

		trackers[0]?.onEnd('ended');
		expect(streamAdb).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(250);
		expect(streamAdb).toHaveBeenCalledTimes(2);
	});

	// adb missing from PATH ends a tracker as fast as it can be started; a fixed delay
	// there is a busy loop with a process spawn in it.
	it('backs off, up to a ceiling, while every restart keeps failing', () => {
		backend.watchDevices(watcher());

		for (const delay of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
			trackers.at(-1)?.onEnd('ended');
			vi.advanceTimersByTime(delay - 1);
			const started = streamAdb.mock.calls.length;
			vi.advanceTimersByTime(1);
			expect(streamAdb.mock.calls.length).toBe(started + 1);
		}
	});

	it('goes back to the short wait once a tracker delivered a snapshot', () => {
		backend.watchDevices(watcher());

		trackers[0]?.onEnd('ended');
		vi.advanceTimersByTime(250);
		trackers[1]?.onEnd('ended');
		vi.advanceTimersByTime(500);
		// The third tracker works, so the fourth restart is a first failure again.
		trackers[2]?.onStdout(TRACK);
		trackers[2]?.onEnd('ended');

		vi.advanceTimersByTime(250);
		expect(streamAdb).toHaveBeenCalledTimes(4);
	});

	/**
	 * A payload that will not parse is reported and the tracker restarted, never thrown:
	 * this runs inside a stdout handler, where there is nothing above it to catch.
	 */
	it('treats an unparseable stream as a lost view rather than throwing', () => {
		const listener = watcher();
		backend.watchDevices(listener);

		expect(() => trackers[0]?.onStdout(Buffer.from('not-a-frame'))).not.toThrow();
		expect(listener.onInterrupted.mock.calls[0]?.[0]).toMatch(/track-devices/);
		expect(listener.onDevices).not.toHaveBeenCalled();

		// The tracker that lost its framing is stopped rather than left running: it can only
		// produce more of the same.
		expect(stops[0]).toHaveBeenCalled();
		vi.advanceTimersByTime(250);
		expect(streamAdb).toHaveBeenCalledTimes(2);
	});

	it('starts a fresh decoder per tracker, so a partial frame cannot cross a restart', () => {
		const listener = watcher();
		backend.watchDevices(listener);

		trackers[0]?.onStdout(TRACK.subarray(0, 30));
		trackers[0]?.onEnd('ended');
		vi.advanceTimersByTime(250);
		trackers[1]?.onStdout(TRACK.subarray(0, 4 + 0x74));

		expect(snapshots(listener)).toHaveLength(1);
	});

	it('stops the tracker and never restarts it again once stopped', async () => {
		const listener = watcher();
		const watch = backend.watchDevices(listener);

		await watch.stop();

		expect(stops[0]).toHaveBeenCalledTimes(1);
		trackers[0]?.onEnd('ended');
		vi.advanceTimersByTime(60_000);
		expect(streamAdb).toHaveBeenCalledTimes(1);
		expect(listener.onInterrupted).not.toHaveBeenCalled();
	});

	it('cancels a restart that was already scheduled', async () => {
		const watch = backend.watchDevices(watcher());

		trackers[0]?.onEnd('ended');
		await watch.stop();
		vi.advanceTimersByTime(60_000);

		expect(streamAdb).toHaveBeenCalledTimes(1);
	});

	it('can be stopped twice', async () => {
		const watch = backend.watchDevices(watcher());

		await watch.stop();
		await expect(watch.stop()).resolves.toBeUndefined();
	});
});

/** One synthetic frame, in the captured format: the length prefix counts bytes. */
function frame(payload: string): Buffer {
	const length = Buffer.byteLength(payload).toString(16).padStart(4, '0');
	return Buffer.from(`${length}${payload}`, 'utf8');
}

describe('describeDevice', () => {
	it('answers with the device when it is still attached', async () => {
		enumerates(DEVICES);

		expect(await backend.describeDevice(SERIAL)).toEqual({
			serial: 'emulator-5554',
			platform: 'android',
			model: 'sdk_gphone16k_arm64',
			state: 'ready',
			attachment: 'this-host',
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
 * The app lifecycle primitives. What the *wording* of each answer means is
 * `parsers/app-control.test.ts`'s, pinned there against `tests/fixtures/adb/`; what is
 * asserted here is the join — the argv, the pin to one device, the timeout, and that no
 * verb resolves on an answer that said it failed.
 *
 * Every app id and every component reaches the device **quoted**, because `adb shell`
 * joins its arguments into one string for the device's own `sh` (PROJECT.md §6). That is
 * why the argv below carries the quotes: they are the assertion, not noise.
 */
const RESOLVED_SETTINGS = fixture('resolve-activity.api37-sdk-gphone16k-arm64.txt');
const NO_ACTIVITY = fixture('resolve-activity.none.api37-sdk-gphone16k-arm64.txt');
const AM_START = fixture('am-start.api37-sdk-gphone16k-arm64.txt');
const RESOLVE_SETTINGS = "shell cmd package resolve-activity --brief 'com.android.settings'";
const START_SETTINGS = "shell am start -n 'com.android.settings/.Settings'";

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
		answers({ [RESOLVE_SETTINGS]: RESOLVED_SETTINGS, [START_SETTINGS]: AM_START });

		await backend.launchApp(SERIAL, SETTINGS);

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
		answers({ [RESOLVE_SETTINGS]: RESOLVED_SETTINGS, [START_SETTINGS]: AM_START });

		await backend.launchApp(SERIAL, SETTINGS);

		expect(runAdbOnDevice.mock.calls[1][1]).toEqual([
			'shell',
			'am',
			'start',
			'-n',
			"'com.android.settings/.Settings'",
		]);
	});

	/**
	 * `No activity found` on stdout with exit 0 is what a package that is not installed
	 * *and* one with nothing launchable both answer. Either way there is no component, and
	 * the failure has to name the app id — nothing downstream can work out which it was.
	 */
	it('throws, naming the app, when nothing launchable resolves', async () => {
		answers({ "shell cmd package resolve-activity --brief 'com.rover.nope'": NO_ACTIVITY });

		const failure = backend.launchApp(SERIAL, ABSENT);

		await expect(failure).rejects.toThrow(/com\.rover\.nope/);
		await expect(failure).rejects.toThrow(/No activity found/);
		expect(runAdbOnDevice).toHaveBeenCalledTimes(1);
	});

	// The app was already on top. That is a launch that succeeded, and treating the word
	// `Warning` as a failure would make re-launching the foreground app throw.
	it('treats the already-top-most warning as a launch that happened', async () => {
		answers({
			[RESOLVE_SETTINGS]: RESOLVED_SETTINGS,
			[START_SETTINGS]: fixture('am-start.top-most.api37-sdk-gphone16k-arm64.txt'),
		});

		await expect(backend.launchApp(SERIAL, SETTINGS)).resolves.toBeUndefined();
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

		await expect(backend.launchApp(SERIAL, SETTINGS)).rejects.toThrow(
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

		await expect(backend.launchApp(SERIAL, SETTINGS)).rejects.toThrow(/Permission Denial/);
	});

	// Silence from `am start` is not success either: nothing was dispatched.
	it('throws when am start said nothing at all', async () => {
		answers({ [RESOLVE_SETTINGS]: RESOLVED_SETTINGS, [START_SETTINGS]: '' });

		await expect(backend.launchApp(SERIAL, SETTINGS)).rejects.toThrow(
			/am start -n com\.android\.settings\/\.Settings/,
		);
	});
});

describe('stopApp', () => {
	// A force-stop that worked prints zero bytes on both streams, so silence is the only
	// success wording there is.
	it('force-stops through the pinned runner, and takes silence for success', async () => {
		answers({ "shell am force-stop 'com.android.settings'": '' });

		await backend.stopApp(SERIAL, SETTINGS);

		expect(runAdb).not.toHaveBeenCalled();
		expect(runAdbOnDevice.mock.calls[0][0]).toBe(SERIAL);
		expect(runAdbOnDevice.mock.calls[0][1]).toEqual([
			'shell',
			'am',
			'force-stop',
			"'com.android.settings'",
		]);
	});

	it('throws when force-stop said anything at all, on either stream', async () => {
		answers({
			"shell am force-stop 'com.android.settings'": {
				stdout: '',
				stderr:
					"\nException occurred while executing 'force-stop':\n" +
					'java.lang.IllegalArgumentException: Argument expected after "force-stop"\n',
			},
		});

		await expect(backend.stopApp(SERIAL, SETTINGS)).rejects.toThrow(/IllegalArgumentException/);
	});

	/**
	 * The captured banner, on a force-stop that worked and exited 0 — adb's own client
	 * writes it to stderr before the subcommand runs, on the first call after a server
	 * restart. Reading it as a device failure is a false rejection nobody can reproduce on
	 * demand, on the verb R9 restores state with.
	 */
	it('is not fooled by the daemon banner adb writes to stderr on the way through', async () => {
		answers({
			"shell am force-stop 'com.android.settings'": {
				stdout: '',
				stderr: fixture('am-force-stop.daemon-start.stderr.api37-sdk-gphone16k-arm64.txt'),
			},
		});

		await expect(backend.stopApp(SERIAL, SETTINGS)).resolves.toBeUndefined();
	});

	// The stdout half of the same rule — force-stop has nothing to say there either.
	it('throws when something came back on stdout', async () => {
		answers({ "shell am force-stop 'com.android.settings'": 'INJECTED\n' });

		await expect(backend.stopApp(SERIAL, SETTINGS)).rejects.toThrow(/INJECTED/);
	});
});

describe('clearAppData', () => {
	it('clears through the pinned runner', async () => {
		answers({
			"shell pm clear 'com.android.settings'": fixture(
				'pm-clear-success.api37-sdk-gphone16k-arm64.txt',
			),
		});

		await backend.clearAppData(SERIAL, SETTINGS);

		expect(runAdb).not.toHaveBeenCalled();
		expect(runAdbOnDevice.mock.calls[0][0]).toBe(SERIAL);
		expect(runAdbOnDevice.mock.calls[0][1]).toEqual([
			'shell',
			'pm',
			'clear',
			"'com.android.settings'",
		]);
	});

	// The one-word failure, on the stream API 37 puts it on…
	it('throws on the bare Failed adb answers with', async () => {
		answers({
			"shell pm clear 'com.rover.nope'": { stdout: '', stderr: 'Failed\n' },
		});

		const failure = backend.clearAppData(SERIAL, ABSENT);

		await expect(failure).rejects.toThrow(/pm clear com\.rover\.nope/);
		await expect(failure).rejects.toThrow(/Failed/);
	});

	// …and on the one every guide of the era shows it on, exit 0 and all.
	it('throws when Failed came back on stdout with exit 0', async () => {
		answers({ "shell pm clear 'com.rover.nope'": 'Failed\n' });

		await expect(backend.clearAppData(SERIAL, ABSENT)).rejects.toThrow(/Failed/);
	});
});

/**
 * The seam that made the app id worth branding. `adb shell a b c` is not an argv on the
 * device: adb joins the arguments with spaces and hands the string to the device's own
 * `sh`, so `execFile` protects the host and nothing else. All three shapes below were run
 * against emulator-5554 (API 37, adb 37.0.1) before the guard existed —
 * `am force-stop 'com.rover.nope;echo INJECTED'` printed `INJECTED` and exited 0, and
 * `pm clear 'com.rover.nope; echo Success'` answered `Success` on stdout with `Failed` on
 * stderr and exit 0: a clear that never happened, reported as done.
 *
 * The brand makes that a compile error, so these cases have to cast past it — which is
 * exactly the caller this re-check exists for: a cast, or a payload deserialized without
 * its schema.
 */
describe('an app id can never become a second command on the device', () => {
	const FORGED = 'com.rover.nope; echo Success' as AppId;

	const VERBS: ReadonlyArray<[string, (appId: AppId) => Promise<void>]> = [
		['launchApp', (appId) => backend.launchApp(SERIAL, appId)],
		['stopApp', (appId) => backend.stopApp(SERIAL, appId)],
		['clearAppData', (appId) => backend.clearAppData(SERIAL, appId)],
	];

	it.each(VERBS)('%s refuses one before adb is reached at all', async (_name, call) => {
		answers({});

		await expect(call(FORGED)).rejects.toThrow(InvalidIdError);
		expect(runAdbOnDevice).not.toHaveBeenCalled();
		expect(runAdb).not.toHaveBeenCalled();
	});

	// The reply that injection bought on the device: `echo` wrote `Success` to stdout, the
	// shell exited with the status of the *last* command, and `pm clear` had failed. With
	// the app id unable to carry a `;`, the reply is unreachable — the guard is upstream of
	// the output check, which is why it is the guard and not a smarter parser.
	it('cannot be handed the forged Success that shape produced', async () => {
		answers({});

		await expect(backend.clearAppData(SERIAL, FORGED)).rejects.toThrow(/AppId/);
	});

	// The component is device output going back into a device-side command line, and the
	// same rules apply to it — but `$` is legitimate there (`.Settings$WifiSettings…`), so
	// it is quoted rather than rejected. Unquoted, this component launched plain
	// `.Settings` and reported success.
	it('quotes the component so the device shell cannot expand an inner-class name', async () => {
		const inner = 'com.android.settings/.Settings$MyDeviceInfoActivity';
		answers({
			[RESOLVE_SETTINGS]: `priority=0 isDefault=true\n${inner}\n`,
			[`shell am start -n '${inner}'`]: AM_START,
		});

		await expect(backend.launchApp(SERIAL, SETTINGS)).resolves.toBeUndefined();
		expect(runAdbOnDevice.mock.calls[1][1].at(-1)).toBe(`'${inner}'`);
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
		['launchApp', { stdout: NO_ACTIVITY, stderr: '' }, () => backend.launchApp(SERIAL, ABSENT)],
		[
			'stopApp',
			{ stdout: '', stderr: 'Error: bad argument\n' },
			() => backend.stopApp(SERIAL, ABSENT),
		],
		[
			'clearAppData',
			{ stdout: '', stderr: 'Failed\n' },
			() => backend.clearAppData(SERIAL, ABSENT),
		],
	];

	it.each(REFUSALS)('%s rejects rather than resolving', async (_name, reply, call) => {
		runAdbOnDevice.mockResolvedValue(reply);

		await expect(call()).rejects.toThrow();
	});
});

/**
 * The capture. There is no fixture for it — a PNG is not text and pinning one would
 * pin the emulator that produced it, not the join — so what is asserted here is the argv,
 * the pin, that the bytes arrive unaltered, and that a payload which is not an image is
 * refused rather than handed on. `tests/device/android/screenshot.test.ts` is the half
 * that proves a real device answers this recipe at all.
 */
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CAPTURE = Buffer.concat([
	PNG_HEAD,
	Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
]);

function captures(stdout: Buffer, stderr = ''): void {
	runAdbBinaryOnDevice.mockResolvedValue({ stdout, stderr });
}

describe('screenshot', () => {
	it('captures with exec-out, pinned to the device, and returns the bytes untouched', async () => {
		captures(CAPTURE);

		const bytes = await backend.screenshot(SERIAL);

		expect(Buffer.from(bytes).equals(CAPTURE)).toBe(true);
		expect(runAdbBinaryOnDevice.mock.calls[0][0]).toBe(SERIAL);
		expect(runAdbBinaryOnDevice.mock.calls[0][1]).toEqual(['exec-out', 'screencap', '-p']);
	});

	// A capture measured 2.4 s on an emulator, against milliseconds for every other query
	// here, so it gets its own budget rather than the ten seconds a query is given.
	it('gives the capture its own timeout rather than the query budget', async () => {
		captures(CAPTURE);

		await backend.screenshot(SERIAL);

		expect(runAdbBinaryOnDevice.mock.calls[0][2]).toEqual({
			timeoutMs: SCREENSHOT_ADB_TIMEOUT_MS,
		});
	});

	/**
	 * The acceptance criterion, as an assertion about which runner was used: `adb shell`
	 * may put a pty between the device and this process, and a pty translates every 0x0a in
	 * the image into 0x0d 0x0a. Going through the text runner would also decode the result
	 * as UTF-8, which loses the bytes outright.
	 */
	it('never captures through a runner that would decode or translate the stream', async () => {
		captures(CAPTURE);

		await backend.screenshot(SERIAL);

		expect(runAdbOnDevice).not.toHaveBeenCalled();
		expect(runAdb).not.toHaveBeenCalled();
	});

	// Exactly what a pty hands back, byte for byte: the 0x0a inside the signature became
	// 0x0d 0x0a. Nothing downstream can tell that from a PNG without reading these bytes.
	it('throws, naming the first bytes, when the stream was translated into text', async () => {
		captures(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0d, 0x0a, 0x1a, 0x0d, 0x0a]));

		const failure = backend.screenshot(SERIAL);

		await expect(failure).rejects.toThrow(/did not return a PNG/);
		await expect(failure).rejects.toThrow(/89 50 4e 47 0d 0d 0a 1a/);
		await expect(failure).rejects.toThrow(/emulator-5554/);
	});

	// adb exits 0 having captured nothing more often than is comfortable, and an empty
	// buffer handed on is an agent looking at a zero-byte image.
	it('throws when the device answered with no bytes at all, quoting stderr', async () => {
		captures(Buffer.alloc(0), 'capture failed\n');

		const failure = backend.screenshot(SERIAL);

		await expect(failure).rejects.toThrow(/stdout: \(empty\)/);
		await expect(failure).rejects.toThrow(/capture failed/);
	});

	/**
	 * The deliberate non-check (PROJECT.md §6): an app blocking screen capture yields a
	 * valid, entirely black PNG. That is a true answer about the device, and this layer
	 * returning it is what lets the caller — who knows what was meant to be on screen —
	 * decide (#13 owns that check).
	 */
	it('returns a valid PNG without judging what it depicts', async () => {
		captures(Buffer.concat([PNG_HEAD, Buffer.alloc(4096)]));

		await expect(backend.screenshot(SERIAL)).resolves.toHaveLength(4104);
	});

	it('lets a failed run surface as the runner reported it', async () => {
		runAdbBinaryOnDevice.mockRejectedValue(new Error("device 'emulator-5554' not found"));

		await expect(backend.screenshot(SERIAL)).rejects.toThrow("device 'emulator-5554' not found");
	});
});

/**
 * The environment pair behind `canControlNetwork`. `tests/device/android/network.test.ts`
 * is the half that proves a real device accepts these two recipes at all; what is proved
 * here is the join, and above all the **argv**.
 *
 * That emphasis is the point of this block. The two commands take different words for the
 * same boolean — `airplane-mode` wants `enable`/`disable`, `set-wifi-enabled` wants
 * `enabled`/`disabled` — and there is no shared vocabulary to derive one from the other.
 * Crossing them is caught on a device (exit 255, PROJECT.md §6) but not by any type, so
 * all four literals are pinned here rather than left to the device suite to find.
 */
const AIRPLANE_BAD_ARGUMENT = fixture(
	'cmd-connectivity-airplane-mode.bad-argument.api37-sdk-gphone16k-arm64.txt',
);
const WIFI_BAD_ARGUMENT = fixture(
	'cmd-wifi-set-wifi-enabled.bad-argument.api37-sdk-gphone16k-arm64.txt',
);
const DAEMON_BANNER = fixture('am-force-stop.daemon-start.stderr.api37-sdk-gphone16k-arm64.txt');

describe('setAirplaneMode', () => {
	it('enables through the pinned runner, and takes silence for success', async () => {
		answers({ 'shell cmd connectivity airplane-mode enable': '' });

		await backend.setAirplaneMode(SERIAL, true);

		expect(runAdb).not.toHaveBeenCalled();
		expect(runAdbOnDevice.mock.calls[0][0]).toBe(SERIAL);
		expect(runAdbOnDevice.mock.calls[0][1]).toEqual([
			'shell',
			'cmd',
			'connectivity',
			'airplane-mode',
			'enable',
		]);
	});

	it('disables with the other word of the same pair', async () => {
		answers({ 'shell cmd connectivity airplane-mode disable': '' });

		await backend.setAirplaneMode(SERIAL, false);

		expect(runAdbOnDevice.mock.calls[0][1]).toEqual([
			'shell',
			'cmd',
			'connectivity',
			'airplane-mode',
			'disable',
		]);
	});

	// The serial reaches adb through the pin and never through the command line — an
	// unpinned call lands on whichever device adb picks, which here means taking someone
	// else's device off the network.
	it('never puts the serial in the argv', async () => {
		answers({ 'shell cmd connectivity airplane-mode enable': '' });

		await backend.setAirplaneMode(SERIAL, true);

		expect(runAdbOnDevice.mock.calls[0][1]).not.toContain('emulator-5554');
	});

	// The captured refusal: the connectivity service's entire help text, on stdout, with
	// nothing error-shaped in it.
	it('throws when the device answered with anything, naming the command and the device', async () => {
		answers({ 'shell cmd connectivity airplane-mode enable': AIRPLANE_BAD_ARGUMENT });

		const failure = backend.setAirplaneMode(SERIAL, true);

		await expect(failure).rejects.toThrow(/cmd connectivity airplane-mode enable/);
		await expect(failure).rejects.toThrow(/emulator-5554/);
	});

	// The banner is adb's client talking, on a call that worked — see `stopApp` above, and
	// this is the verb R9 restores state with, so a false rejection here is a lease that
	// cannot be released cleanly.
	it('is not fooled by the daemon banner adb writes to stderr on the way through', async () => {
		answers({
			'shell cmd connectivity airplane-mode disable': { stdout: '', stderr: DAEMON_BANNER },
		});

		await expect(backend.setAirplaneMode(SERIAL, false)).resolves.toBeUndefined();
	});
});

describe('setWifiEnabled', () => {
	it('enables through the pinned runner, and takes silence for success', async () => {
		answers({ 'shell cmd wifi set-wifi-enabled enabled': '' });

		await backend.setWifiEnabled(SERIAL, true);

		expect(runAdb).not.toHaveBeenCalled();
		expect(runAdbOnDevice.mock.calls[0][0]).toBe(SERIAL);
		expect(runAdbOnDevice.mock.calls[0][1]).toEqual([
			'shell',
			'cmd',
			'wifi',
			'set-wifi-enabled',
			'enabled',
		]);
	});

	// `disabled`, not `disable` — the argument §6 had never vouched for before #9, and the
	// one this file exists to keep from drifting into its neighbour's vocabulary.
	it('disables with the other word of the same pair', async () => {
		answers({ 'shell cmd wifi set-wifi-enabled disabled': '' });

		await backend.setWifiEnabled(SERIAL, false);

		expect(runAdbOnDevice.mock.calls[0][1]).toEqual([
			'shell',
			'cmd',
			'wifi',
			'set-wifi-enabled',
			'disabled',
		]);
	});

	it('never puts the serial in the argv', async () => {
		answers({ 'shell cmd wifi set-wifi-enabled disabled': '' });

		await backend.setWifiEnabled(SERIAL, false);

		expect(runAdbOnDevice.mock.calls[0][1]).not.toContain('emulator-5554');
	});

	it('throws when the device answered with anything, naming the command and the device', async () => {
		answers({ 'shell cmd wifi set-wifi-enabled enabled': WIFI_BAD_ARGUMENT });

		const failure = backend.setWifiEnabled(SERIAL, true);

		await expect(failure).rejects.toThrow(/cmd wifi set-wifi-enabled enabled/);
		await expect(failure).rejects.toThrow(/IllegalArgumentException/);
	});

	it('is not fooled by the daemon banner adb writes to stderr on the way through', async () => {
		answers({ 'shell cmd wifi set-wifi-enabled enabled': { stdout: '', stderr: DAEMON_BANNER } });

		await expect(backend.setWifiEnabled(SERIAL, true)).resolves.toBeUndefined();
	});
});

/**
 * The counterpart of "no app verb swallows a failure", for the two verbs a *restoration*
 * runs (D9). A teardown that reported success on a device it never touched is the exact
 * self-deception the daemon owning restoration exists to end, so both halves are asserted:
 * a refusal adb exited 0 on, and the failure the runner itself raises.
 */
describe('no environment verb swallows a failure', () => {
	const REFUSALS: ReadonlyArray<[string, AdbResult, () => Promise<void>]> = [
		[
			'setAirplaneMode',
			{ stdout: AIRPLANE_BAD_ARGUMENT, stderr: '' },
			() => backend.setAirplaneMode(SERIAL, true),
		],
		[
			'setWifiEnabled',
			{ stdout: WIFI_BAD_ARGUMENT, stderr: '' },
			() => backend.setWifiEnabled(SERIAL, false),
		],
	];

	it.each(REFUSALS)('%s rejects rather than resolving', async (_name, reply, call) => {
		runAdbOnDevice.mockResolvedValue(reply);

		await expect(call()).rejects.toThrow();
	});

	it.each(
		REFUSALS,
	)('%s lets a failed run surface as the runner reported it', async (_name, _reply, call) => {
		runAdbOnDevice.mockRejectedValue(new Error("device 'emulator-5554' not found"));

		await expect(call()).rejects.toThrow("device 'emulator-5554' not found");
	});
});

/**
 * The four primitives behind `canInput`. `tests/device/android/input.test.ts` is the half
 * that proves a real device accepts these recipes at all; what is proved here is the join,
 * and above all the **argv and the arithmetic**.
 *
 * Both matter more here than anywhere else in this file, because `input` is the one command
 * in this backend that accepts nonsense in silence. An unknown keycode, an off-screen
 * coordinate and a dp point sent unconverted are each exit 0 with zero bytes on both streams
 * (PROJECT.md §6) — so nothing downstream, and no device test, can tell them from work that
 * was done. The pin is the only place they are visible.
 */
const INPUT_REFUSAL = fixture('input.unknown-command.api37-sdk-gphone16k-arm64.txt');

/** What `wm density` is asked before every tap and swipe: 480 dpi, so a scale of 3. */
const TAP_FACTS = { 'shell wm density': DENSITY } as const;

describe('tap', () => {
	it('converts the point to physical pixels and taps through the pinned runner', async () => {
		answers({ ...TAP_FACTS, 'shell input tap 300 600': '' });

		await backend.tap(SERIAL, { x: 100, y: 200 });

		expect(runAdb).not.toHaveBeenCalled();
		expect(runAdbOnDevice.mock.calls[0][1]).toEqual(['shell', 'wm', 'density']);
		expect(runAdbOnDevice.mock.calls[1][0]).toBe(SERIAL);
		expect(runAdbOnDevice.mock.calls[1][1]).toEqual(['shell', 'input', 'tap', '300', '600']);
	});

	/**
	 * The density is asked **every time** rather than cached. `wm density <n>` changes it
	 * under a running lease, and a remembered scale would then put every subsequent tap
	 * somewhere the caller did not ask for, without a word (D6: adb is the truth).
	 */
	it('asks the device for its density on every call', async () => {
		answers({ ...TAP_FACTS, 'shell input tap 300 600': '' });

		await backend.tap(SERIAL, { x: 100, y: 200 });
		await backend.tap(SERIAL, { x: 100, y: 200 });

		expect(runAdbOnDevice.mock.calls.filter(([, args]) => args[1] === 'wm')).toHaveLength(2);
	});

	// The override is what the device renders at, so it is the scale a coordinate belongs to
	// — `wm density 320` on the same panel means a dp point lands twice as close to the
	// origin as the physical density would put it.
	it('honours an overridden density rather than the physical one', async () => {
		answers({ 'shell wm density': DENSITY_OVERRIDE, 'shell input tap 200 400': '' });

		await backend.tap(SERIAL, { x: 100, y: 200 });

		expect(runAdbOnDevice.mock.calls[1][1]).toEqual(['shell', 'input', 'tap', '200', '400']);
	});

	it('never puts the serial in the argv', async () => {
		answers({ ...TAP_FACTS, 'shell input tap 300 600': '' });

		await backend.tap(SERIAL, { x: 100, y: 200 });

		expect(runAdbOnDevice.mock.calls[1][1]).not.toContain('emulator-5554');
	});

	it('throws when the device answered with anything, naming the command and the device', async () => {
		answers({ ...TAP_FACTS, 'shell input tap 300 600': INPUT_REFUSAL });

		const failure = backend.tap(SERIAL, { x: 100, y: 200 });

		await expect(failure).rejects.toThrow(/input tap 300 600/);
		await expect(failure).rejects.toThrow(/emulator-5554/);
	});

	it('is not fooled by the daemon banner adb writes to stderr on the way through', async () => {
		answers({ ...TAP_FACTS, 'shell input tap 300 600': { stdout: '', stderr: DAEMON_BANNER } });

		await expect(backend.tap(SERIAL, { x: 100, y: 200 })).resolves.toBeUndefined();
	});

	// The parse failure carries the command and the other stream, the way `listDevices`'
	// does — a density that will not parse is not a tap that can be placed.
	it('refuses to tap when the density cannot be read', async () => {
		answers({ 'shell wm density': "Error: Can't find service: window\n" });

		await expect(backend.tap(SERIAL, { x: 1, y: 1 })).rejects.toThrow(/wm density/);
	});
});

describe('swipe', () => {
	it('converts both points off one density query', async () => {
		answers({ ...TAP_FACTS, 'shell input swipe 300 1200 300 600 250': '' });

		await backend.swipe(SERIAL, { x: 100, y: 400 }, { x: 100, y: 200 }, 250);

		expect(runAdbOnDevice.mock.calls).toHaveLength(2);
		expect(runAdbOnDevice.mock.calls[1][1]).toEqual([
			'shell',
			'input',
			'swipe',
			'300',
			'1200',
			'300',
			'600',
			'250',
		]);
	});

	/**
	 * A drag in place is how a long press is done — phase 2 composes one out of this rather
	 * than getting its own primitive. Pinned here so the two points staying equal survives
	 * any later edit to the conversion.
	 */
	it('keeps a drag in place in place', async () => {
		answers({ ...TAP_FACTS, 'shell input swipe 300 600 300 600 600': '' });

		await backend.swipe(SERIAL, { x: 100, y: 200 }, { x: 100, y: 200 }, 600);

		expect(runAdbOnDevice.mock.calls[1][1].slice(3)).toEqual(['300', '600', '300', '600', '600']);
	});

	// A programmer error costs no round trip and reads as itself, rather than arriving as a
	// Java stack trace about invalid arguments.
	it.each([Number.NaN, -1])('refuses a duration of %p before touching the device', async (ms) => {
		answers(TAP_FACTS);

		await expect(backend.swipe(SERIAL, { x: 1, y: 1 }, { x: 2, y: 2 }, ms)).rejects.toThrow(
			/duration/,
		);
		expect(runAdbOnDevice).not.toHaveBeenCalled();
	});

	it('throws when the device answered with anything', async () => {
		answers({ ...TAP_FACTS, 'shell input swipe 300 600 300 600 100': INPUT_REFUSAL });

		await expect(
			backend.swipe(SERIAL, { x: 100, y: 200 }, { x: 100, y: 200 }, 100),
		).rejects.toThrow(/input swipe 300 600 300 600 100/);
	});
});

describe('typeText', () => {
	// No `wm density`: text has no coordinate, so the query every tap pays for is not paid
	// here.
	it('sends the text as one quoted word, with no density query', async () => {
		answers({ "shell input text 'hello world'": '' });

		await backend.typeText(SERIAL, 'hello world');

		expect(runAdbOnDevice.mock.calls).toHaveLength(1);
		expect(runAdbOnDevice.mock.calls[0][1]).toEqual(['shell', 'input', 'text', "'hello world'"]);
	});

	/**
	 * The apostrophe case, which is the whole reason `shellText` exists beside `shellArg`.
	 * It reaches the device as one word carrying a real `'`, rather than being refused as
	 * every app id containing one is.
	 */
	it('splices an apostrophe rather than refusing the text', async () => {
		answers({ "shell input text 'don'\\''t'": '' });

		await backend.typeText(SERIAL, "don't");

		expect(runAdbOnDevice.mock.calls[0][1][3]).toBe("'don'\\''t'");
	});

	// Quoted, so they are one word and inert — the injection `shellArg` exists to stop, on
	// the one argument here that is arbitrary by definition.
	it('makes shell metacharacters one inert word', async () => {
		const text = 'a; echo INJECTED';
		answers({ [`shell input text '${text}'`]: '' });

		await backend.typeText(SERIAL, text);

		expect(runAdbOnDevice.mock.calls[0][1][3]).toBe(`'${text}'`);
	});

	/**
	 * The `%s` split. `input text` substitutes a space for a literal `%s`, so the caller's
	 * own `%s` costs two injections — and the pieces are what typed `a%sb` on API 37.
	 */
	it('types a literal %s as two calls so it arrives as itself', async () => {
		answers({ "shell input text 'a%'": '', "shell input text 'sb'": '' });

		await backend.typeText(SERIAL, 'a%sb');

		expect(runAdbOnDevice.mock.calls.map(([, args]) => args[3])).toEqual(["'a%'", "'sb'"]);
	});

	// Each piece is checked on its own, so a run that got half the text in says so rather
	// than reporting success for the half that landed.
	it('stops at the first piece the device refused', async () => {
		answers({ "shell input text 'a%'": INPUT_REFUSAL, "shell input text 'sb'": '' });

		await expect(backend.typeText(SERIAL, 'a%sb')).rejects.toThrow(/input text/);
		expect(runAdbOnDevice.mock.calls).toHaveLength(1);
	});

	/**
	 * What the device was measured not to type is refused before anything is sent — a tab is
	 * dropped in silence, and a non-ASCII character throws inside the device and types
	 * nothing at all (PROJECT.md §6).
	 *
	 * An `UnsupportedTextError` rather than a plain one, and that is the load-bearing half:
	 * it is the caller's string that is wrong rather than the host, so `src/verbs/failure.ts`
	 * carries it to the agent as `unsupported-text` naming the characters, where a plain
	 * `Error` would arrive as `internal_error` — "the host broke" — for a string the agent
	 * chose itself.
	 */
	it.each([
		['a tab', 'a\tb', 'U+0009'],
		['a non-ASCII character', 'café', 'U+00E9'],
	])('refuses %s without touching the device', async (_what, text, codepoint) => {
		answers({});

		const thrown = await backend.typeText(SERIAL, text).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(UnsupportedTextError);
		expect((thrown as UnsupportedTextError).serial).toBe(SERIAL);
		expect((thrown as UnsupportedTextError).text).toBe(text);
		expect((thrown as UnsupportedTextError).unsupported.join(' ')).toContain(codepoint);
		// The words for what this device *can* take are the backend's, and they reach the
		// message from here rather than from the neutral error class.
		expect((thrown as UnsupportedTextError).message).toContain('printable ASCII');
		expect(runAdbOnDevice).not.toHaveBeenCalled();
	});

	// Typing nothing still reaches the device, so a device that has gone away is reported
	// rather than resolving.
	it('still calls the device for an empty string', async () => {
		answers({ "shell input text ''": '' });

		await backend.typeText(SERIAL, '');

		expect(runAdbOnDevice.mock.calls[0][1]).toEqual(['shell', 'input', 'text', "''"]);
	});
});

describe('pressKey', () => {
	/**
	 * All four keycodes pinned, for the reason the environment pair's four literals are: no
	 * type can catch a wrong one, and neither can the device — `input keyevent NOT_A_KEY`
	 * exits 0 with zero bytes on both streams, so a typo here is a key that reports success
	 * and does nothing at all.
	 */
	it.each([
		['back', 'KEYCODE_BACK'],
		['home', 'KEYCODE_HOME'],
		['recents', 'KEYCODE_APP_SWITCH'],
		['wake', 'KEYCODE_WAKEUP'],
	] as const)('presses %s as %s', async (key, keycode) => {
		answers({ [`shell input keyevent ${keycode}`]: '' });

		await backend.pressKey(SERIAL, key);

		expect(runAdb).not.toHaveBeenCalled();
		expect(runAdbOnDevice.mock.calls[0][0]).toBe(SERIAL);
		expect(runAdbOnDevice.mock.calls[0][1]).toEqual(['shell', 'input', 'keyevent', keycode]);
	});

	// Power *toggles*, so a `wake` built on it would put an already-woken device to sleep.
	it('never presses the power key for wake', async () => {
		answers({ 'shell input keyevent KEYCODE_WAKEUP': '' });

		await backend.pressKey(SERIAL, 'wake');

		expect(runAdbOnDevice.mock.calls[0][1]).not.toContain('KEYCODE_POWER');
	});

	it('throws when the device answered with anything', async () => {
		answers({ 'shell input keyevent KEYCODE_BACK': INPUT_REFUSAL });

		await expect(backend.pressKey(SERIAL, 'back')).rejects.toThrow(/input keyevent KEYCODE_BACK/);
	});
});

/**
 * The counterpart of "no app verb swallows a failure" for the four primitives an agent
 * drives the screen with. An injection that reported success without landing is the false
 * green this whole tool exists to avoid, so both halves are asserted: a refusal adb exited 0
 * on, and the failure the runner itself raises.
 */
describe('no input verb swallows a failure', () => {
	const CALLS: ReadonlyArray<[string, () => Promise<void>]> = [
		['tap', () => backend.tap(SERIAL, { x: 100, y: 200 })],
		['swipe', () => backend.swipe(SERIAL, { x: 1, y: 1 }, { x: 2, y: 2 }, 100)],
		['typeText', () => backend.typeText(SERIAL, 'hello')],
		['pressKey', () => backend.pressKey(SERIAL, 'back')],
	];

	it.each(CALLS)('%s rejects rather than resolving', async (_name, call) => {
		runAdbOnDevice.mockImplementation(async (_serial, args): Promise<AdbResult> => {
			if (args[1] === 'wm') return { stdout: DENSITY, stderr: '' };
			return { stdout: INPUT_REFUSAL, stderr: '' };
		});

		await expect(call()).rejects.toThrow();
	});

	it.each(CALLS)('%s lets a failed run surface as the runner reported it', async (_name, call) => {
		runAdbOnDevice.mockRejectedValue(new Error("device 'emulator-5554' not found"));

		await expect(call()).rejects.toThrow("device 'emulator-5554' not found");
	});
});
