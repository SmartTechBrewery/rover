import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type AdbDevice, isUsable, parseAdbDevices } from '@/backends/android/parsers/devices.js';

const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const DEVICES = fixture('devices-l.api37-sdk-gphone16k-arm64.txt');
const EMPTY = fixture('devices-l.empty.txt');
const DAEMON_START = fixture('devices-l.daemon-start.api37-sdk-gphone16k-arm64.txt');
const DAEMON_FAILED = fixture('devices-l.daemon-failed.txt');
const OFFLINE = fixture('devices-l.offline.api37-sdk-gphone16k-arm64.txt');

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
