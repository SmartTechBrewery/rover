import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	parseSimctlDevices,
	parseSimctlRuntimes,
	SimctlDeviceSchema,
} from '@/backends/ios-simulator/parsers/simctl-list.js';

/**
 * Pinned against output **captured from a real simulator** — Xcode 26.4.1 (17E202) with
 * the iOS 26.4.1 and 26.1 runtimes installed and one iPhone 17 booted,
 * `tests/fixtures/ios-simulator/` (ai/TESTING.md). That is deliberately *not*
 * `docs/IOS.md`'s bench, which was Xcode 26.6 / iOS 26.5.
 *
 * Nothing here runs `xcrun`, boots anything, or reads `DEVELOPER_DIR`: the suite passes on
 * a machine with no simulator and no Xcode at all, which is what makes the acceptance
 * criterion checkable rather than declared.
 *
 * A few cases are inline and each says why. They are all the same kind: a shape no capture
 * on this machine can carry, held by an inline case so the behaviour is decided rather than
 * discovered on somebody else's Xcode upgrade.
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/ios-simulator/${name}`, import.meta.url), 'utf8');

/** `xcrun simctl list -j` — all four listings in one document. */
const ALL_LISTINGS = fixture('simctl-list.xcode26.4.1-ios26.4.1.json');

/** `xcrun simctl list -j devices` — the single-listing invocation form. */
const DEVICES_ONLY = fixture('simctl-list-devices.xcode26.4.1-ios26.4.1.json');

/** The runtime the booted device is under, and the version it actually reports. */
const BOOTED_RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';

describe('parseSimctlDevices, against the real capture', () => {
	/**
	 * The counts are asserted so a walk that silently reads nothing cannot pass: 22 devices
	 * across the two installed runtimes, exactly one of them booted.
	 */
	it('reads every device of every runtime', () => {
		const { devices } = parseSimctlDevices(ALL_LISTINGS);
		const entries = Object.values(devices).flat();

		expect(Object.keys(devices)).toEqual([
			BOOTED_RUNTIME,
			'com.apple.CoreSimulator.SimRuntime.iOS-26-1',
		]);
		expect(entries).toHaveLength(22);
		expect(entries.filter((entry) => entry.state === 'Booted')).toHaveLength(1);
	});

	it('reads the booted device entry exactly', () => {
		const booted = Object.values(parseSimctlDevices(ALL_LISTINGS).devices)
			.flat()
			.filter((entry) => entry.state === 'Booted');

		expect(booted).toEqual([
			{
				udid: '997FA43E-FF9F-4109-BEF0-53D3F46653E7',
				name: 'iPhone 17',
				state: 'Booted',
				deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
			},
		]);
	});

	/**
	 * The projection's whole point: the entry carries `isAvailable`, `dataPath`,
	 * `dataPathSize`, `logPath` and — on some entries only — `logPathSize` and
	 * `lastBootedAt`, and none of them reaches the parsed shape.
	 */
	it('keeps only the four fields it reads', () => {
		const [first] = Object.values(parseSimctlDevices(ALL_LISTINGS).devices).flat();

		expect(Object.keys(first ?? {}).sort()).toEqual([
			'deviceTypeIdentifier',
			'name',
			'state',
			'udid',
		]);
	});

	// Finding 3 of the plan, as a test: `simctl list`'s own usage text says to specify one
	// listing, the no-argument form answers all four, and this parser may not depend on
	// which of them produced its input. The all-listings capture parses above; the
	// single-listing one parses here, to the same 22 devices.
	it('parses the single-listing invocation form to the same devices', () => {
		expect(Object.values(parseSimctlDevices(DEVICES_ONLY).devices).flat()).toEqual(
			Object.values(parseSimctlDevices(ALL_LISTINGS).devices).flat(),
		);
	});
});

describe('parseSimctlRuntimes, against the real capture', () => {
	/**
	 * The trap this whole layer is shaped around, in the listing where it starts: the device
	 * map's key ends `iOS-26-4` and the runtime under it reports `26.4.1`. Asserted
	 * positively *and* negatively, because the negative half is what would catch a future
	 * rewrite that read the version out of the identifier.
	 */
	it('reads a runtime version that the identifier does not spell', () => {
		const runtime = parseSimctlRuntimes(ALL_LISTINGS).runtimes.find(
			(entry) => entry.identifier === BOOTED_RUNTIME,
		);

		expect(runtime).toEqual({
			identifier: BOOTED_RUNTIME,
			version: '26.4.1',
			platform: 'iOS',
		});
		expect(runtime?.version).not.toBe('26.4');
	});

	it('reads every installed runtime', () => {
		expect(parseSimctlRuntimes(ALL_LISTINGS).runtimes).toHaveLength(2);
	});

	// The `devices`-only capture has no `runtimes` key at all, which is the other half of
	// invocation-form indifference: a caller that asked for one listing must not be able to
	// parse it as the other.
	it('refuses a capture that does not carry the runtime listing', () => {
		expect(() => parseSimctlRuntimes(DEVICES_ONLY)).toThrow();
	});
});

describe('the schemas, on shapes no capture here carries', () => {
	/**
	 * Inline because the case is an Xcode release that has not happened: the vendor adds
	 * keys to a device entry per release (four of the 22 captured entries already carry a
	 * key the other eighteen do not), and this decides that such a release is not a
	 * load-time failure in a module that reads four fields.
	 */
	it('ignores a vendor field it has never seen', () => {
		expect(
			SimctlDeviceSchema.parse({
				udid: 'A1B2C3D4-0000-0000-0000-000000000000',
				name: 'iPhone 42',
				state: 'Shutdown',
				deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-42',
				somethingXcode27Added: { nested: true },
			}),
		).toEqual({
			udid: 'A1B2C3D4-0000-0000-0000-000000000000',
			name: 'iPhone 42',
			state: 'Shutdown',
			deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-42',
		});
	});

	// Inline, and taken from a real failure rather than imagined: on a host whose
	// `xcode-select` points at CommandLineTools this is the text `xcrun` prints
	// (docs/IOS.md §1), and a caller that merged the two streams hands it straight here.
	it('throws quoting the output when it is not JSON at all', () => {
		const stderr = 'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH';

		expect(() => parseSimctlDevices(stderr)).toThrow(/not a developer tool or in PATH/);
		expect(() => parseSimctlDevices(stderr)).toThrow(/simctl list -j devices/);
	});

	// Inline because no capture on a working machine can hold one without deleting the
	// operator's simulators: a host with none created is a real answer, not a failure.
	it('parses an empty device map to an empty map', () => {
		expect(parseSimctlDevices('{"devices":{}}')).toEqual({ devices: {} });
	});
});
