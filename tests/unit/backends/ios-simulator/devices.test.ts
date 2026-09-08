import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IOS_SIMULATOR_PLATFORM_ID, toDevices } from '@/backends/ios-simulator/devices.js';
import {
	parseSimctlDevices,
	parseSimctlRuntimes,
} from '@/backends/ios-simulator/parsers/simctl-list.js';

/**
 * The mapping, against output **captured from a real simulator** — Xcode 26.4.1 with the
 * iOS 26.4.1 and 26.1 runtimes and one iPhone 17 booted,
 * `tests/fixtures/ios-simulator/README.md`.
 *
 * No `xcrun`, no simulator, no `DEVELOPER_DIR`, nothing platform-conditional: this suite
 * passes on a machine that has never had Xcode.
 *
 * There is deliberately no suite for `./attachment.ts`. A test asserting that a constant
 * equals its own literal is a tautology; the behaviour is asserted here, where it is used,
 * for every device the capture carries.
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../fixtures/ios-simulator/${name}`, import.meta.url), 'utf8');

const ALL_LISTINGS = fixture('simctl-list.xcode26.4.1-ios26.4.1.json');

const CAPTURED = toDevices(parseSimctlDevices(ALL_LISTINGS), parseSimctlRuntimes(ALL_LISTINGS));

/** The runtime key the booted device sits under, and the version it does *not* spell. */
const BOOTED_RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';

const runtimes = (...entries: { identifier: string; version: string; platform: string }[]) =>
	parseSimctlRuntimes(JSON.stringify({ runtimes: entries }));

const devices = (map: Record<string, { udid: string; name: string; state: string }[]>) =>
	parseSimctlDevices(
		JSON.stringify({
			devices: Object.fromEntries(
				Object.entries(map).map(([identifier, entries]) => [
					identifier,
					entries.map((entry) => ({
						...entry,
						deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
						// Required by the schema and read by nothing in this module — the transfers'
						// business (`src/backends/ios-simulator/containers.ts`), not the mapping's.
						dataPath: `/Users/nobody/Library/Developer/CoreSimulator/Devices/${entry.udid}/data`,
					})),
				]),
			),
		}),
	);

describe('toDevices, against the real capture', () => {
	it('reports every device the host can see', () => {
		expect(CAPTURED).toHaveLength(22);
	});

	it('gives every device this platform id, no API level and this host', () => {
		for (const device of CAPTURED) {
			expect(device.platform).toBe(IOS_SIMULATOR_PLATFORM_ID);
			expect(device.platform).toBe('ios-simulator');
			// iOS has no API level, and inventing one from the version string would be
			// inventing data — see the module.
			expect(device.osApiLevel).toBeNull();
			// A simulator *is* this machine (`src/backends/ios-simulator/attachment.ts`).
			expect(device.attachment).toBe('this-host');
		}
	});

	it('maps the booted device, and only it, to ready', () => {
		const ready = CAPTURED.filter((device) => device.state === 'ready');

		expect(ready).toEqual([
			{
				serial: '997FA43E-FF9F-4109-BEF0-53D3F46653E7',
				platform: 'ios-simulator',
				model: 'iPhone 17',
				osVersion: '26.4.1',
				osApiLevel: null,
				state: 'ready',
				attachment: 'this-host',
			},
		]);
		expect(CAPTURED.filter((device) => device.state === 'offline')).toHaveLength(21);
	});

	it('takes the serial from the udid and the model from the name', () => {
		const parsed = Object.entries(parseSimctlDevices(ALL_LISTINGS).devices).flatMap(
			([, entries]) => entries,
		);

		expect(CAPTURED.map((device) => device.serial)).toEqual(parsed.map((entry) => entry.udid));
		expect(CAPTURED.map((device) => device.model)).toEqual(parsed.map((entry) => entry.name));
	});

	/**
	 * The trap, in the field that carries it: the runtime key ends `iOS-26-4` and every
	 * device under it reports `26.4.1`. The negative half is the point — it is what fails if
	 * somebody ever reads the version out of the identifier instead of joining the runtime
	 * list.
	 */
	it('takes the OS version from the joined runtime and never from the runtime key', () => {
		const underBootedRuntime = parseSimctlDevices(ALL_LISTINGS).devices[BOOTED_RUNTIME] ?? [];
		const serials = new Set(underBootedRuntime.map((entry) => entry.udid));
		const mapped = CAPTURED.filter((device) => serials.has(device.serial));

		expect(mapped).toHaveLength(11);
		for (const device of mapped) {
			expect(device.osVersion).toBe('26.4.1');
			expect(device.osVersion).not.toBe('26.4');
		}
	});
});

describe('toDevices, on shapes no capture on this machine carries', () => {
	/**
	 * Inline because holding it against a capture would mean deleting a runtime off the
	 * capturing host. An unresolved key is an uninstalled or renamed runtime, and that is
	 * not evidence the device is not one of this platform's — so it is reported without a
	 * version rather than dropped (`DeviceSchema`).
	 */
	it('keeps a device whose runtime key does not resolve, without a version', () => {
		const mapped = toDevices(
			devices({
				'com.apple.CoreSimulator.SimRuntime.iOS-19-9': [
					{
						udid: 'A1B2C3D4-0000-0000-0000-000000000001',
						name: 'iPhone Ancient',
						state: 'Shutdown',
					},
				],
			}),
			runtimes({ identifier: BOOTED_RUNTIME, version: '26.4.1', platform: 'iOS' }),
		);

		expect(mapped).toHaveLength(1);
		expect(mapped[0]?.osVersion).toBeNull();
		expect(mapped[0]?.model).toBe('iPhone Ancient');
	});

	/**
	 * Inline because no runtime on this machine is non-iOS. Decided from the runtime's own
	 * `platform` field rather than from a name or an identifier: reporting an Apple Watch
	 * simulator as `ios-simulator` would be a wrong answer this module has the evidence to
	 * avoid.
	 */
	it('excludes a device under a runtime that is not this platform', () => {
		const mapped = toDevices(
			devices({
				'com.apple.CoreSimulator.SimRuntime.watchOS-26-4': [
					{ udid: 'A1B2C3D4-0000-0000-0000-000000000002', name: 'Apple Watch', state: 'Booted' },
				],
				[BOOTED_RUNTIME]: [
					{ udid: 'A1B2C3D4-0000-0000-0000-000000000003', name: 'iPhone 17', state: 'Booted' },
				],
			}),
			runtimes(
				{
					identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-26-4',
					version: '26.4',
					platform: 'watchOS',
				},
				{ identifier: BOOTED_RUNTIME, version: '26.4.1', platform: 'iOS' },
			),
		);

		expect(mapped.map((device) => device.model)).toEqual(['iPhone 17']);
	});

	/**
	 * Inline for the same reason the parser's empty-map case is: a host with no simulators
	 * created is a real answer, not a failure to surface.
	 */
	it('answers an empty inventory for a host with no simulators', () => {
		expect(toDevices(devices({}), runtimes())).toEqual([]);
	});

	// `Booting` is the state trap 1 of docs/IOS.md §8 is about — a capture on a device that
	// is not `Booted` hangs for a minute and then fails — so it must not come out `ready`.
	// Inline because a capture cannot hold a transient state deterministically.
	it('maps every state that is not Booted to offline', () => {
		const mapped = toDevices(
			devices({
				[BOOTED_RUNTIME]: [
					{ udid: 'A1B2C3D4-0000-0000-0000-000000000004', name: 'Booting', state: 'Booting' },
					{
						udid: 'A1B2C3D4-0000-0000-0000-000000000005',
						name: 'Shutting down',
						state: 'Shutting Down',
					},
					{ udid: 'A1B2C3D4-0000-0000-0000-000000000006', name: 'Creating', state: 'Creating' },
				],
			}),
			runtimes({ identifier: BOOTED_RUNTIME, version: '26.4.1', platform: 'iOS' }),
		);

		expect(mapped.map((device) => device.state)).toEqual(['offline', 'offline', 'offline']);
	});
});
