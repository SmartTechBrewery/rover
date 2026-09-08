import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDeviceTypeProfile } from '@/backends/ios-simulator/parsers/device-type-profile.js';
import { parseSimctlDeviceTypes } from '@/backends/ios-simulator/parsers/simctl-list.js';
import { deviceTypeProfilePath, toScreenInfo } from '@/backends/ios-simulator/screen.js';

/**
 * The screen mapping, pinned end to end against real captures: the `bundlePath` comes out of
 * the committed `simctl list -j`, and the numbers out of the `profile.plist` copied from that
 * very bundle (`tests/fixtures/ios-simulator/`). Nothing here spawns anything or needs a
 * simulator; the whole point of reading the screen from the device type is that it does not.
 */
const bytes = (name: string): Uint8Array =>
	new Uint8Array(readFileSync(new URL(`../../../fixtures/ios-simulator/${name}`, import.meta.url)));

const text = (name: string): string =>
	readFileSync(new URL(`../../../fixtures/ios-simulator/${name}`, import.meta.url), 'utf8');

const ALL_LISTINGS = text('simctl-list.xcode26.4.1-ios26.4.1.json');

const IPHONE_17_PRO = readDeviceTypeProfile(
	bytes('device-type-profile.iphone-17-pro.xcode26.4.1.plist'),
);
const IPAD_PRO_13_M5 = readDeviceTypeProfile(
	bytes('device-type-profile.ipad-pro-13-inch-m5.xcode26.4.1.plist'),
);

/** A profile to vary one key of, so an inline case says only what it is about. */
const VALID = {
	mainScreenWidth: 1206,
	mainScreenHeight: 2622,
	mainScreenScale: 3,
	mainScreenWidthDPI: 460,
	mainScreenHeightDPI: 460,
	modelIdentifier: 'iPhone18,1',
};

describe('deviceTypeProfilePath', () => {
	/**
	 * The join is asserted against the path the fixture was actually copied from, and the
	 * `bundlePath` half of it is read out of the capture rather than typed here — which is
	 * what makes this a check that the tool's own answer leads to the file, rather than that
	 * two string literals in this repository agree with each other.
	 *
	 * Note where it lands: `/Library/Developer/CoreSimulator/`, not inside Xcode. A path built
	 * from `DEVELOPER_DIR` would find no device type at all on this machine.
	 */
	it("joins the tool's own bundlePath to the profile the fixture came from", () => {
		const iPhone17Pro = parseSimctlDeviceTypes(ALL_LISTINGS).devicetypes.find(
			(type) => type.identifier === 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
		);

		expect(deviceTypeProfilePath(iPhone17Pro?.bundlePath ?? '')).toBe(
			'/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 17 Pro.simdevicetype/Contents/Resources/profile.plist',
		);
	});
});

describe('toScreenInfo, against the real captures', () => {
	it('maps the iPhone 17 Pro profile onto the neutral screen', () => {
		expect(toScreenInfo(IPHONE_17_PRO)).toEqual({
			widthPx: 1206,
			heightPx: 2622,
			density: 460,
			densityScale: 3,
			widthDp: 402,
			heightDp: 874,
		});
	});

	// The acceptance criterion's arithmetic, stated on its own so a failure says which half
	// broke: 1206/3 and 2622/3, both exact.
	it('divides the captured pixels by the captured scale exactly', () => {
		const screen = toScreenInfo(IPHONE_17_PRO);

		expect(screen.widthDp).toBe(402);
		expect(screen.heightDp).toBe(874);
	});

	/**
	 * Trap 6 in executable form (`docs/IOS.md` §8). `idb describe` reports `density: 3.0` for
	 * this device — which is the **scale** — so a backend that copied that field across would
	 * satisfy every other assertion in this file while putting a number 153 times too small in
	 * `density`. The negative half is what catches it.
	 */
	it('takes density from the dpi and densityScale from the scale, which are not the same number', () => {
		const screen = toScreenInfo(IPHONE_17_PRO);

		expect(screen.density).toBe(460);
		expect(screen.densityScale).toBe(3);
		expect(screen.density).not.toBe(screen.densityScale);
	});

	// A different product family at a different scale, so none of the above is pinned on 3.
	it('maps the iPad Pro 13-inch (M5) profile at its own scale', () => {
		expect(toScreenInfo(IPAD_PRO_13_M5)).toEqual({
			widthPx: 2064,
			heightPx: 2752,
			density: 264,
			densityScale: 2,
			widthDp: 1032,
			heightDp: 1376,
		});
	});
});

describe('toScreenInfo, on profiles no device type here ships', () => {
	/**
	 * Inline, and the case the captures cannot make: every device type measured divides
	 * evenly, so an implementation that rounded would pass every assertion above. Rounding is
	 * a presentation decision — a backend that rounds leaves no way to ask what the device
	 * said (`ScreenInfoSchema`, `../android/screen.ts`).
	 */
	it('keeps a quotient that is not a whole number', () => {
		const screen = toScreenInfo({ ...VALID, mainScreenWidth: 1205 });

		expect(screen.widthDp).toBeCloseTo(401.6667, 4);
		expect(screen.widthDp).not.toBe(402);
	});

	/**
	 * Inline because the two dpi values are equal on all 124 device types measured (Xcode
	 * 26.4.1, 2026-09-08). `ScreenInfo.density` is one number, and the day a device type has
	 * two the honest answer is a failure naming the device rather than a silent choice of one.
	 */
	it('refuses a device type whose two densities disagree, naming it', () => {
		expect(() => toScreenInfo({ ...VALID, mainScreenHeightDPI: 458 })).toThrow(/iPhone18,1/);
		expect(() => toScreenInfo({ ...VALID, mainScreenHeightDPI: 458 })).toThrow(/460.*458/s);
	});
});
