import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	DeviceTypeProfileSchema,
	parseDeviceTypeProfile,
	readDeviceTypeProfile,
} from '@/backends/ios-simulator/parsers/device-type-profile.js';

/**
 * Pinned against two `profile.plist` files **copied byte for byte out of the device type
 * bundles Xcode installed**, `tests/fixtures/ios-simulator/` (ai/TESTING.md). A
 * hand-written plist would encode what someone believes the file contains, and this
 * particular file is a *binary* container nobody writes by hand correctly anyway.
 *
 * Nothing here runs `xcrun`, boots anything or reads `DEVELOPER_DIR`: the suite passes on a
 * machine with no simulator and no Xcode at all.
 *
 * The inline cases are all the same kind — a profile no device type on this machine ships,
 * held inline so the behaviour is decided here rather than discovered on somebody else's
 * Xcode upgrade. Each says which.
 */
const fixture = (name: string): Uint8Array =>
	new Uint8Array(
		readFileSync(new URL(`../../../../fixtures/ios-simulator/${name}`, import.meta.url)),
	);

const IPHONE_17_PRO = fixture('device-type-profile.iphone-17-pro.xcode26.4.1.plist');
const IPAD_PRO_13_M5 = fixture('device-type-profile.ipad-pro-13-inch-m5.xcode26.4.1.plist');

/** A valid profile to vary one key of, so an inline case says only what it is about. */
const VALID = {
	mainScreenWidth: 1206,
	mainScreenHeight: 2622,
	mainScreenScale: 3,
	mainScreenWidthDPI: 460,
	mainScreenHeightDPI: 460,
	modelIdentifier: 'iPhone18,1',
};

describe('readDeviceTypeProfile, against the real captures', () => {
	it('reads the iPhone 17 Pro profile exactly', () => {
		expect(readDeviceTypeProfile(IPHONE_17_PRO)).toEqual({
			mainScreenWidth: 1206,
			mainScreenHeight: 2622,
			mainScreenScale: 3,
			mainScreenWidthDPI: 460,
			mainScreenHeightDPI: 460,
			modelIdentifier: 'iPhone18,1',
		});
	});

	// The second capture is a different product family *and* a different scale, so nothing
	// below can be pinned on the number 3.
	it('reads the iPad Pro 13-inch (M5) profile exactly', () => {
		expect(readDeviceTypeProfile(IPAD_PRO_13_M5)).toEqual({
			mainScreenWidth: 2064,
			mainScreenHeight: 2752,
			mainScreenScale: 2,
			mainScreenWidthDPI: 264,
			mainScreenHeightDPI: 264,
			modelIdentifier: 'iPad17,4',
		});
	});

	/**
	 * The projection's whole point. The captured file carries eighteen top-level keys —
	 * `chromeIdentifier`, `framebufferMask`, `productClass`, `springBoardConfigName`,
	 * `supportedArchs`, `supportedFeatures` and the rest — and six of them reach the shape.
	 */
	it('keeps only the six keys it reads', () => {
		expect(Object.keys(readDeviceTypeProfile(IPHONE_17_PRO)).sort()).toEqual([
			'mainScreenHeight',
			'mainScreenHeightDPI',
			'mainScreenScale',
			'mainScreenWidth',
			'mainScreenWidthDPI',
			'modelIdentifier',
		]);
	});

	/**
	 * `bplist-parser` wants a real `Buffer` and this signature takes a `Uint8Array`, so the
	 * re-wrap is load-bearing. The offset case is the half that would break silently: a
	 * `Buffer.from(bytes.buffer)` that dropped `byteOffset` reads from the padding instead
	 * and reports a corrupt file, and every caller holding a whole-file array would still
	 * pass.
	 */
	it('reads a view into a larger buffer, offset and all', () => {
		const padded = new Uint8Array(8 + IPHONE_17_PRO.length);
		padded.set(IPHONE_17_PRO, 8);

		expect(readDeviceTypeProfile(padded.subarray(8))).toEqual(readDeviceTypeProfile(IPHONE_17_PRO));
	});

	// Inline because the bench ships no XML profile: all 124 device types are `bplist00`
	// (Xcode 26.4.1, 2026-09-08). The other plist encoding is what a reader would most
	// plausibly be handed by mistake, and the message has to name the file rather than leave
	// "Expected 'bplist00' at offset 0" to be traced back to it.
	it('throws naming the file when the bytes are not a binary plist', () => {
		const xml = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?>\n<plist />');

		expect(() => readDeviceTypeProfile(xml)).toThrow(/profile\.plist/);
	});
});

describe('parseDeviceTypeProfile, on profiles no device type here ships', () => {
	/**
	 * Inline because the case is an Xcode release that has not happened: the vendor adds keys
	 * to this file per release, and a module that reads six of eighteen must not turn that
	 * into a load-time failure.
	 */
	it('ignores a vendor key it has never seen', () => {
		expect(parseDeviceTypeProfile({ ...VALID, somethingXcode27Added: { nested: true } })).toEqual(
			VALID,
		);
	});

	/**
	 * `ScreenInfoSchema.density` is a positive **integer**, so a fractional dpi has to fail
	 * here — naming `mainScreenWidthDPI`, the plist key an operator can go and look at —
	 * rather than be rounded on the way out into looking fine. Every dpi measured is an
	 * integer (40, 80, 264, 326, 458, 460, 461, 476), which is why this is inline.
	 */
	it('refuses a fractional dpi, by the plist key name', () => {
		expect(() => parseDeviceTypeProfile({ ...VALID, mainScreenWidthDPI: 459.5 })).toThrow(
			/mainScreenWidthDPI/,
		);
	});

	/**
	 * The mirror of the above, and the reason `mainScreenScale` is deliberately *not*
	 * `.int()`. The motivating device type is `Apple TV 4K (3rd generation) (at 1080p)`,
	 * whose profile encodes the scale 1 as a plist **real** where every other profile encodes
	 * it as a plist integer — a distinction JavaScript cannot represent once decoded, so a
	 * fractional value stands in for it here. Rejecting a non-integer scale would reject a
	 * device type Xcode ships today.
	 */
	it('accepts a scale that is not a whole number', () => {
		expect(parseDeviceTypeProfile({ ...VALID, mainScreenScale: 1.5 }).mainScreenScale).toBe(1.5);
	});

	// Inline for the same reason as the fractional dpi: all 124 profiles carry all six keys,
	// so the absent-key answer is decided rather than measured. It must name the key — a
	// screen this backend cannot describe is not a screen to report a default for.
	it('refuses a profile missing a key it reads, by name', () => {
		const { mainScreenScale: _dropped, ...withoutScale } = VALID;

		expect(() => parseDeviceTypeProfile(withoutScale)).toThrow(/mainScreenScale/);
	});

	it('refuses a zero or negative pixel count', () => {
		expect(() => DeviceTypeProfileSchema.parse({ ...VALID, mainScreenWidth: 0 })).toThrow(
			/mainScreenWidth/,
		);
	});
});
