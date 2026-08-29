import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	type AdbDevice,
	isUsable,
	parseAdbDeviceLines,
	parseAdbDevices,
} from '@/backends/android/parsers/devices.js';
import { TrackFrameDecoder } from '@/backends/android/parsers/track.js';

const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const DEVICES = fixture('devices-l.api37-sdk-gphone16k-arm64.txt');
const EMPTY = fixture('devices-l.empty.txt');
const DAEMON_START = fixture('devices-l.daemon-start.api37-sdk-gphone16k-arm64.txt');
const DAEMON_FAILED = fixture('devices-l.daemon-failed.txt');
const OFFLINE = fixture('devices-l.offline.api37-sdk-gphone16k-arm64.txt');
/** The framed capture, so the header-less payloads below are adb's own, not this file's. */
const TRACK_PAYLOADS = new TrackFrameDecoder().push(
	readFileSync(
		new URL(
			'../../../../fixtures/adb/track-devices-l.connect-disconnect.api37-sdk-gphone16k-arm64.txt',
			import.meta.url,
		),
	),
);

const only = (stdout: string): AdbDevice => {
	const devices = parseAdbDevices(stdout);
	expect(devices).toHaveLength(1);
	return devices[0] as AdbDevice;
};

describe('parseAdbDevices', () => {
	it('parses the serial, state and property tail of a real `adb devices -l` line', () => {
		expect(only(DEVICES)).toEqual({
			serial: 'emulator-5554',
			state: 'device',
			properties: {
				product: 'sdk_gphone16k_arm64',
				model: 'sdk_gphone16k_arm64',
				device: 'emu64a16k',
				transport_id: '3',
			},
		});
	});

	/**
	 * The headline acceptance criterion of issue #4, made checkable rather than declared:
	 * the fixture's serial is `emulator-5554` and the parsed device still says nothing
	 * about emulation, platform or transport. Emulator-ness is `getprop`'s answer.
	 */
	it('carries exactly serial, state and properties — nothing inferred from the serial', () => {
		expect(Object.keys(only(DEVICES)).sort()).toEqual(['properties', 'serial', 'state']);
	});

	it('returns [] when no device is attached', () => {
		expect(parseAdbDevices(EMPTY)).toEqual([]);
	});

	it('skips the daemon-startup banner and still finds the device', () => {
		expect(DAEMON_START).toContain('* daemon not running');
		expect(only(DAEMON_START).serial).toBe('emulator-5554');
	});

	/**
	 * The capture that made header-anchoring load-bearing: an `error:` line ahead of the
	 * header parses as a device with the serial `error:` under any skip-known-prefixes
	 * scheme.
	 */
	it('treats an error line above the header as preamble, not as a device', () => {
		expect(DAEMON_FAILED).toContain('error: cannot connect to daemon');
		expect(parseAdbDevices(DAEMON_FAILED)).toEqual([]);
	});

	it('throws, quoting the output, when there is no device-list header', () => {
		expect(() => parseAdbDevices('adb: command not found')).toThrow(/adb: command not found/);
	});

	it('parses plain `adb devices` output, which is tab-separated and has no property tail', () => {
		expect(only('List of devices attached\nemulator-5554\tdevice\n')).toEqual({
			serial: 'emulator-5554',
			state: 'device',
			properties: {},
		});
	});
});

describe('isUsable', () => {
	it('is true for the `device` state', () => {
		expect(isUsable(only(DEVICES))).toBe(true);
	});

	it('is false for the `offline` state captured while the device rebooted', () => {
		const device = only(OFFLINE);
		expect(device.state).toBe('offline');
		expect(isUsable(device)).toBe(false);
	});
});

/**
 * The same line format with no header to anchor on — what a `track-devices` frame carries.
 * Driven off the framed capture rather than off a hand-trimmed copy of the `devices -l`
 * fixture, because "the payload is the long format minus the header" is the claim under
 * test and re-deriving it here would assume it.
 */
describe('parseAdbDeviceLines', () => {
	it('parses a header-less payload exactly as the headed output is parsed', () => {
		const framed = parseAdbDeviceLines(TRACK_PAYLOADS[0] as string);
		const headed = parseAdbDevices(`List of devices attached\n${TRACK_PAYLOADS[0]}`);

		expect(framed).toEqual(headed);
		expect(framed).toEqual([
			{
				serial: 'emulator-5554',
				state: 'device',
				properties: {
					product: 'sdk_gphone16k_arm64',
					model: 'sdk_gphone16k_arm64',
					device: 'emu64a16k',
					transport_id: '1',
				},
			},
		]);
	});

	// Every change re-emits the whole list, so a two-device payload is the ordinary case
	// and not an edge one — this is also the only captured list with more than one entry.
	it('parses every device of a multi-device payload', () => {
		const payload = TRACK_PAYLOADS.find((frame) => frame.includes('localhost:5555')) as string;

		expect(parseAdbDeviceLines(payload).map((device) => device.serial)).toEqual([
			'emulator-5554',
			'localhost:5555',
		]);
	});

	// A device negotiating its connection passes through states no `devices -l` fixture
	// captured. `state` is an open string precisely so this parses rather than throwing.
	it('parses a state token no devices-l fixture has', () => {
		const payload = TRACK_PAYLOADS.find((frame) => frame.includes('authorizing')) as string;

		expect(parseAdbDeviceLines(payload).map((device) => device.state)).toContain('authorizing');
	});

	/**
	 * An empty payload is a real answer — the tracker saying nothing is attached — where
	 * empty *output* from the command would be a failure to surface. That difference is
	 * the reason this is its own entry point rather than a flag.
	 */
	it('answers an empty payload with an empty list rather than throwing', () => {
		expect(parseAdbDeviceLines('')).toEqual([]);
	});

	it('still refuses a line it cannot read as a device', () => {
		expect(() => parseAdbDeviceLines('serial-with-no-state\n')).toThrow(/cannot parse device line/);
	});

	/**
	 * The cost of dropping the header, stated rather than discovered later: with no
	 * preamble to reject, adb's daemon-failure line reads as a device with the serial
	 * `error:` — the exact bug {@link parseAdbDevices} anchors on the header to avoid. It
	 * is safe here only because a frame's delimiter is its length prefix and adb's banner
	 * and error lines go to stderr, never into a frame. Nothing but a framed payload may be
	 * passed to this function.
	 */
	it('would read a daemon-failure line as a device, which is why only frames reach it', () => {
		expect(parseAdbDeviceLines('error: cannot connect to daemon\n')[0]?.serial).toBe('error:');
		expect(parseAdbDevices(DAEMON_FAILED)).toEqual([]);
	});
});
