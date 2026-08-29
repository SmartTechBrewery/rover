import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AdbResult } from '@/backends/android/adb.js';
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

/** Answers each `adb shell …` by the arguments it was called with. */
function answers(replies: Record<string, string>): void {
	runAdbOnDevice.mockImplementation(async (_serial, args): Promise<AdbResult> => {
		const stdout = replies[args.join(' ')];
		if (stdout === undefined) throw new Error(`unexpected call: ${args.join(' ')}`);
		return { stdout, stderr: '' };
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
