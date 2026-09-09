import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	borrowableNow,
	IOS_SIMULATOR_PLATFORM_ID,
	toDevices,
	toNotifiedDevices,
} from '@/backends/ios-simulator/devices.js';
import {
	IdbNotifyFrameDecoder,
	type IdbTarget,
} from '@/backends/ios-simulator/parsers/idb-notify.js';
import {
	parseSimctlDevices,
	parseSimctlRuntimes,
} from '@/backends/ios-simulator/parsers/simctl-list.js';
import type { Device } from '@/core/device.js';

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

/**
 * The **same eleven simulators, in the same states, read two ways** — the pair of captures that
 * makes the two mappings comparable at all.
 *
 * They were taken minutes apart on one bench (companion v1.5.2, Xcode 26.6, iOS 26.5, one
 * `iPhone 17` booted and nothing else): `xcrun simctl list -j`, and the first frame of
 * `idb_companion --notify stdout`. That is the whole point of committing a second `simctl`
 * listing rather than reusing the Xcode 26.4.1 one — the drift worth asserting is between the two
 * *paths*, and two paths read off two different machines cannot be compared device by device.
 */
const SAME_BENCH_LISTINGS = fixture('simctl-list.xcode26.6-ios26.5.json');

const NOTIFY_CAPTURE = readFileSync(
	new URL(
		'../../../fixtures/ios-simulator/idb-notify.idbcompanion1.5.2-xcode26.6-ios26.5.txt',
		import.meta.url,
	),
);

const NOTIFY_FRAMES = new IdbNotifyFrameDecoder().push(NOTIFY_CAPTURE);

/** The first frame: the set exactly as the `simctl` capture beside it found it. */
const NOTIFIED = toNotifiedDevices(NOTIFY_FRAMES[0] ?? []);

/** One idb target, on the shape the capture pins, with a case's own overrides. */
const target = (overrides: Partial<IdbTarget> = {}): IdbTarget => ({
	udid: 'A1B2C3D4-0000-0000-0000-00000000000A',
	type: 'Simulator',
	name: 'iPhone 17',
	model: 'iPhone 17',
	os_version: 'iOS 26.5',
	state: 'Shutdown',
	...overrides,
});

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

/**
 * The narrowing the inventory goes through (#267, D41) — asserted here, over both mappings, for
 * the reason they share `toDeviceState`: it is one rule, and a second place to decide it is how
 * the poll and the stream come to disagree about what this host has.
 */
describe('borrowableNow', () => {
	/**
	 * The acceptance criterion, on the capture that motivated the issue: 22 simulators created on
	 * the bench, one of them booted, and the inventory names that one and no others.
	 */
	it('answers the booted simulator and nothing else', () => {
		expect(borrowableNow(CAPTURED)).toEqual([
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
		expect(CAPTURED).toHaveLength(22);
	});

	/** The same answer off the other source, so the two cannot disagree about the set. */
	it('answers the same one simulator off a notify frame', () => {
		expect(borrowableNow(NOTIFIED).map((device) => device.model)).toEqual(['iPhone 17']);
	});

	/**
	 * **The transitional decision, over the whole captured run.** `Shutdown → Booting → Booted →
	 * Shutting Down → Shutdown` for one simulator is one frame in which it can be borrowed, and
	 * four in which it is simply not there. Neither `Booting` nor `Shutting Down` is listed: a
	 * device that appeared and vanished across a single boot would be worse than either consistent
	 * answer, and a row `acquire` would refuse is a dead end for an agent (D21).
	 */
	it('lists a simulator only while it is booted, never while it is on the way', () => {
		const transitioning = 'D85C3449-4D0C-4E93-B8EC-77FD0E5A8F3F';
		const listed = NOTIFY_FRAMES.map((frame) => [
			frame.find((entry) => entry.udid === transitioning)?.state,
			borrowableNow(toNotifiedDevices(frame)).some((device) => device.serial === transitioning),
		]);

		expect(listed).toEqual([
			['Shutdown', false],
			['Booting', false],
			['Booted', true],
			['Shutting Down', false],
			['Shutdown', false],
		]);
	});

	/**
	 * A host with nothing booted is an empty inventory, and an empty inventory is a real answer —
	 * *no devices attached*, which is exactly what the Android half of the same list says when
	 * nothing is plugged in (D21). It is not the *no view* an interruption reports (D6).
	 */
	it('answers an empty inventory for a machine with simulators but none booted', () => {
		const mapped = toDevices(
			devices({
				[BOOTED_RUNTIME]: [
					{ udid: 'A1B2C3D4-0000-0000-0000-000000000007', name: 'iPhone 17', state: 'Shutdown' },
				],
			}),
			runtimes({ identifier: BOOTED_RUNTIME, version: '26.4.1', platform: 'iOS' }),
		);

		expect(mapped).toHaveLength(1);
		expect(borrowableNow(mapped)).toEqual([]);
	});
});

describe('toNotifiedDevices, against the real capture', () => {
	it('reports every simulator the frame carries', () => {
		expect(NOTIFIED).toHaveLength(11);
	});

	it('gives every device this platform id, no API level and this host', () => {
		for (const device of NOTIFIED) {
			expect(device.platform).toBe(IOS_SIMULATOR_PLATFORM_ID);
			expect(device.osApiLevel).toBeNull();
			expect(device.attachment).toBe('this-host');
		}
	});

	/**
	 * **The assertion this whole pairing of captures exists for.** `simctl`'s runtime reports
	 * `26.5` while the idb target for the same device reports `iOS 26.5`; if the watch published
	 * one spelling and `listDevices` the other, `list_devices` and the inventory would disclose
	 * two different OS versions for one device. Asserted as an equality between the two functions
	 * over one bench rather than against a literal, because a literal would go on passing while
	 * the two paths drifted apart.
	 */
	it('answers the same device as toDevices does, field for field', () => {
		const bySerial = (mapped: Device[]) =>
			Object.fromEntries(mapped.map((device) => [device.serial, device]));

		expect(bySerial(NOTIFIED)).toEqual(
			bySerial(
				toDevices(
					parseSimctlDevices(SAME_BENCH_LISTINGS),
					parseSimctlRuntimes(SAME_BENCH_LISTINGS),
				),
			),
		);
	});

	// The one `ready`, on both paths, from the one predicate.
	it('reports the booted simulator as the only ready one', () => {
		expect(
			NOTIFIED.filter((device) => device.state === 'ready').map((device) => device.model),
		).toEqual(['iPhone 17']);
	});

	/**
	 * The capture is a stream, so the states a device passes through are real data rather than a
	 * hand-written case — and `Booting` in particular must not come out `ready` (`docs/IOS.md` §8,
	 * trap 1).
	 */
	it('maps every state that is not Booted to offline, across the whole run', () => {
		const transitioning = 'D85C3449-4D0C-4E93-B8EC-77FD0E5A8F3F';
		const states = NOTIFY_FRAMES.map((frame) => {
			const mapped = toNotifiedDevices(frame).find((device) => device.serial === transitioning);
			return [frame.find((entry) => entry.udid === transitioning)?.state, mapped?.state];
		});

		expect(states).toEqual([
			['Shutdown', 'offline'],
			['Booting', 'offline'],
			['Booted', 'ready'],
			['Shutting Down', 'offline'],
			['Shutdown', 'offline'],
		]);
	});
});

/**
 * The allowlist, inline rather than from a capture — and that is the honest place for it.
 *
 * No physical iPhone was paired to the capturing bench and no watchOS or tvOS runtime was
 * installed on it, so neither exclusion appears in the committed frames: `Simulator` under
 * `iOS 26.5` is every target there is. These cases pin what happens to the targets this bench
 * could not produce, the way `unified-log.test.ts` pins `messageType: "None"` inline for the same
 * reason.
 */
describe('toNotifiedDevices, on the targets this bench could not produce', () => {
	/**
	 * A physical iPhone is outside this backend entirely — it cannot answer `screenshot`, a
	 * *required* method (`docs/IOS.md` §6), and `./attachment.ts` records that a paired-but-absent
	 * one is served by this platform's tooling by default, forever. Admitting it is D18's
	 * two-agents-one-device failure wearing a disguise.
	 */
	it('excludes a target that is not a simulator', () => {
		expect(toNotifiedDevices([target({ type: 'device', state: 'Booted' })])).toEqual([]);
	});

	/**
	 * An allowlist rather than a blocklist, because the direction of the mistake is not
	 * symmetric: an unrecognised target excluded is a device this host declines to lend, while one
	 * admitted by default is a device it lends and cannot drive.
	 */
	it('excludes a target whose type it has never seen rather than admitting it', () => {
		expect(toNotifiedDevices([target({ type: 'Something idb added in 1.6' })])).toEqual([]);
	});

	/** The same exclusion `toDevices` makes from the runtime's own `platform` field. */
	it('excludes a simulator under a runtime that is not iOS', () => {
		expect(toNotifiedDevices([target({ os_version: 'watchOS 26.5' })])).toEqual([]);
		expect(toNotifiedDevices([target({ os_version: 'tvOS 26.5' })])).toEqual([]);
	});

	/**
	 * `iOS26.5` and a bare `26.5` are both the shape this mapping cannot read, and neither is
	 * evidence that the target *is* one of this platform's — so they are dropped rather than
	 * reported with a `null` version. Where `toDevices` keeps a device whose runtime key does not
	 * resolve, the platform word here is the only evidence there is about which platform the
	 * target belongs to.
	 */
	it('excludes a target whose os_version carries no recognisable platform word', () => {
		expect(toNotifiedDevices([target({ os_version: 'iOS26.5' })])).toEqual([]);
		expect(toNotifiedDevices([target({ os_version: '26.5' })])).toEqual([]);
		expect(toNotifiedDevices([target({ os_version: 'iOS ' })])).toEqual([]);
	});

	/**
	 * `name` and not `model`: both are here, `simctl list devices` carries only the first, and
	 * they differ the moment anyone renames a simulator — taking `model` would make the two paths
	 * disagree about one device.
	 */
	it('reports the operator-chosen name, not the device type idb reports beside it', () => {
		const mapped = toNotifiedDevices([target({ name: 'Jacek’s bench phone', model: 'iPhone 17' })]);

		expect(mapped.map((device) => device.model)).toEqual(['Jacek’s bench phone']);
	});

	/** An empty frame is a real answer — a host with no simulators created — not a failure. */
	it('answers an empty inventory for an empty frame', () => {
		expect(toNotifiedDevices([])).toEqual([]);
	});
});
