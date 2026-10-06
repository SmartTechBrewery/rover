import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	type AccessibilityRead,
	parseAccessibilityRead,
} from '@/backends/ios-simulator/parsers/accessibility.js';
import { readDeviceTypeProfile } from '@/backends/ios-simulator/parsers/device-type-profile.js';
import { parseSimctlDeviceTypes } from '@/backends/ios-simulator/parsers/simctl-list.js';
import {
	deviceTypeProfilePath,
	toOnScreenKeyboard,
	toScreenElements,
	toScreenInfo,
} from '@/backends/ios-simulator/screen.js';

/**
 * The screen mapping, pinned end to end against real captures: the `bundlePath` comes out of
 * the committed `simctl list -j`, the numbers out of the `profile.plist` copied from that very
 * bundle, and the elements out of three accessibility reads taken from a booted simulator
 * (`tests/fixtures/ios-simulator/`). Nothing here spawns anything or needs a simulator; the
 * whole point of reading the screen from the device type is that it does not.
 */
const bytes = (name: string): Uint8Array =>
	new Uint8Array(readFileSync(new URL(`../../../fixtures/ios-simulator/${name}`, import.meta.url)));

const text = (name: string): string =>
	readFileSync(new URL(`../../../fixtures/ios-simulator/${name}`, import.meta.url), 'utf8');

const ALL_LISTINGS = text('simctl-list.xcode26.4.1-ios26.4.1.json');

const read = (name: string): AccessibilityRead =>
	parseAccessibilityRead({
		json: text(`accessibility.${name}.idbcompanion1.5.2-xcode26.4.1-ios26.4.1.json`),
	});

const IPHONE_17_PRO = readDeviceTypeProfile(
	bytes('device-type-profile.iphone-17-pro.xcode26.4.1.plist'),
);
const IPAD_PRO_13_M5 = readDeviceTypeProfile(
	bytes('device-type-profile.ipad-pro-13-inch-m5.xcode26.4.1.plist'),
);

/**
 * The three captures, taken through this repository's own gRPC client from the booted
 * `iPhone 17` of this bench — companion v1.5.2, Xcode 26.4.1 / iOS 26.4.1, 2026-09-08
 * (`tests/fixtures/ios-simulator/README.md`).
 */
const COMPOSE = read('compose');
const TOGGLES = read('uikit-toggles');
const TEXTFIELD = read('uikit-textfield');

/**
 * The pair #298 captured, on a **throwaway** `iPhone 17` created for the run — companion v1.5.2,
 * Xcode 26.4.1 / iOS 26.4.1, 2026-10-06 — with the Polish system keyboard up over Settings'
 * search field, and then the same screen after one `typeText('wifi')`.
 *
 * **The pair is the point, and it is why the second file is here at all.** The three captures
 * above already pin the no-keyboard case, but every one of them was taken on a screen where a
 * keyboard was never going to be up; the dismissed capture was taken on a screen where one
 * *was*, one keystroke earlier. That is what makes `shown: false` a measurement rather than the
 * branch nothing exercised — and it is the same open/closed pairing the Android fixtures carry.
 */
const KEYBOARD = read('uikit-keyboard');
const KEYBOARD_DISMISSED = read('uikit-keyboard-dismissed');

/**
 * The device the reads were taken on and the profile committed here are **two device types with
 * one panel**: `iPhone18,3` and `iPhone18,1` both report 1206×2622 at scale 3 and 460 dpi
 * (measured off both `profile.plist` files, Xcode 26.4.1, 2026-09-08). That is what lets the
 * assertions below join a capture from one to the profile of the other, and it is stated because
 * a reader would otherwise be right to ask.
 */
const SCREEN = toScreenInfo(IPHONE_17_PRO, null);

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
		expect(toScreenInfo(IPHONE_17_PRO, null)).toEqual({
			widthPx: 1206,
			heightPx: 2622,
			density: 460,
			densityScale: 3,
			widthDp: 402,
			heightDp: 874,
			systemBars: null,
			keyboard: null,
		});
	});

	// The acceptance criterion's arithmetic, stated on its own so a failure says which half
	// broke: 1206/3 and 2622/3, both exact.
	it('divides the captured pixels by the captured scale exactly', () => {
		const screen = toScreenInfo(IPHONE_17_PRO, null);

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
		const screen = toScreenInfo(IPHONE_17_PRO, null);

		expect(screen.density).toBe(460);
		expect(screen.densityScale).toBe(3);
		expect(screen.density).not.toBe(screen.densityScale);
	});

	/**
	 * The parameter is passed straight through, and `systemBars` beside it stays `null` — the two
	 * are different unanswered facts and only one of them has been measured (#298).
	 */
	it('reports the keyboard the caller measured, and leaves systemBars null', () => {
		const keyboard = { shown: true, bounds: { x: 0, y: 539, width: 402, height: 335.5 } };

		expect(toScreenInfo(IPHONE_17_PRO, keyboard).keyboard).toEqual(keyboard);
		expect(toScreenInfo(IPHONE_17_PRO, keyboard).systemBars).toBeNull();
	});

	/**
	 * `null` is *this device did not say* and must stay reachable: it is what a host with no
	 * companion, a device that is not booted and a wedged bridge all come back as, and folding it
	 * into `{ shown: false }` would promise a clear screen nothing looked at (`src/core/device.ts`).
	 */
	it('keeps null as an answer distinct from no keyboard being up', () => {
		expect(toScreenInfo(IPHONE_17_PRO, null).keyboard).toBeNull();
		expect(toScreenInfo(IPHONE_17_PRO, { shown: false, bounds: null }).keyboard).toEqual({
			shown: false,
			bounds: null,
		});
	});

	// A different product family at a different scale, so none of the above is pinned on 3.
	it('maps the iPad Pro 13-inch (M5) profile at its own scale', () => {
		expect(toScreenInfo(IPAD_PRO_13_M5, null)).toEqual({
			widthPx: 2064,
			heightPx: 2752,
			density: 264,
			densityScale: 2,
			widthDp: 1032,
			heightDp: 1376,
			systemBars: null,
			keyboard: null,
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
		const screen = toScreenInfo({ ...VALID, mainScreenWidth: 1205 }, null);

		expect(screen.widthDp).toBeCloseTo(401.6667, 4);
		expect(screen.widthDp).not.toBe(402);
	});

	/**
	 * Inline because the two dpi values are equal on all 124 device types measured (Xcode
	 * 26.4.1, 2026-09-08). `ScreenInfo.density` is one number, and the day a device type has
	 * two the honest answer is a failure naming the device rather than a silent choice of one.
	 */
	it('refuses a device type whose two densities disagree, naming it', () => {
		expect(() => toScreenInfo({ ...VALID, mainScreenHeightDPI: 458 }, null)).toThrow(/iPhone18,1/);
		expect(() => toScreenInfo({ ...VALID, mainScreenHeightDPI: 458 }, null)).toThrow(/460.*458/s);
	});
});

describe('toScreenElements, against the real reads', () => {
	/**
	 * Every node, in the tool's order, unfiltered — deciding which nodes are interesting is a
	 * policy the verb layer already applies by matching on text, and a container with no text of
	 * its own is exactly what a scroll target addresses.
	 */
	it('answers one element per node, in the order the read listed them', () => {
		expect(toScreenElements(COMPOSE)).toHaveLength(COMPOSE.length);
		expect(toScreenElements(TEXTFIELD).map((element) => element.label)).toEqual(
			TEXTFIELD.map((node) => node.AXLabel),
		);
	});

	/**
	 * **The acceptance criterion for "no scale conversion", in its strongest available form.**
	 * The `AXApplication` node covers the whole panel, and its frame is the device's screen *in
	 * dp* — the same number `toScreenInfo` reaches by dividing 1206 and 2622 by the scale. A
	 * mapping that divided again would put 134×291 here; one that multiplied would put
	 * 1206×2622, off the panel entirely.
	 */
	it('reports the root element as the device screen in dp, undivided and unmultiplied', () => {
		expect(toScreenElements(COMPOSE)[0]?.bounds).toEqual({
			x: 0,
			y: 0,
			width: SCREEN.widthDp,
			height: SCREEN.heightDp,
		});
		expect(SCREEN.widthDp).toBe(402);
		expect(SCREEN.heightDp).toBe(874);
	});

	/**
	 * And the tool's own numbers survive to the fraction. Points are a layout unit, so a layout
	 * engine's thirds arrive as thirds; rounding them is a presentation decision, and a backend
	 * that rounds leaves no way to ask what the device said (`toScreenInfo`'s own stance).
	 */
	it('passes a fractional frame straight through', () => {
		expect(toScreenElements(COMPOSE)[1]?.bounds).toEqual(COMPOSE[1]?.frame);
		expect(toScreenElements(COMPOSE)[1]?.bounds.y).toBeCloseTo(75.3333, 4);
	});

	/**
	 * A rectangle off the bottom of the screen survives too: this row ends 9.67 points below an
	 * 874-point panel because its list is scrolled. `src/verbs/target.ts` reads that to decide
	 * what is addressable, and clamping here would delete the only evidence it has.
	 */
	it('keeps an element that extends past the bottom edge', () => {
		const last = toScreenElements(TOGGLES).at(-1);

		expect((last?.bounds.y ?? 0) + (last?.bounds.height ?? 0)).toBeGreaterThan(SCREEN.heightDp);
	});

	/**
	 * The id is the flat ordinal, and **unique within one read** is what it has to be:
	 * `findOnScreen` filters on `element.id === target.id` and treats two hits as the backend
	 * contradicting itself (`src/verbs/errors.ts`).
	 */
	it('gives every element a distinct flat ordinal id', () => {
		for (const elements of [toScreenElements(COMPOSE), toScreenElements(TEXTFIELD)]) {
			const ids = elements.map((element) => element.id);

			expect(new Set(ids).size).toBe(elements.length);
			expect(ids.slice(0, 3)).toEqual(['0', '1', '2']);
		}
	});

	/**
	 * **Why the ordinal rather than `AXUniqueId`**, in executable form. That field looks like the
	 * one for this and `docs/IOS.md` §2 recorded it as `null` throughout — which held for the
	 * Compose app it was measured on. On Apple's own Safari it is populated on eleven of eighteen
	 * nodes and `favoritesItemIdentifierContent` is on **three** of them, so a backend that used
	 * it would hand `findOnScreen` three elements with one id and make that screen unaddressable.
	 */
	it('does not take the id from a field that repeats within one read', () => {
		const identifiers = JSON.parse(
			text('accessibility.uikit-textfield.idbcompanion1.5.2-xcode26.4.1-ios26.4.1.json'),
		).map((node: { AXUniqueId: string | null }) => node.AXUniqueId);

		expect(
			identifiers.filter((id: string | null) => id === 'favoritesItemIdentifierContent'),
		).toHaveLength(3);
		expect(new Set(toScreenElements(TEXTFIELD).map((element) => element.id)).size).toBe(18);
	});

	/**
	 * `label` and `text` come from two different keys, and Safari's address field is why: an
	 * accessibility name and the string showing in the control are different strings, and
	 * conflating them taps the wrong thing (`ScreenElementSchema`).
	 */
	it('maps the label and the value onto the two fields that are for them', () => {
		expect(toScreenElements(TEXTFIELD)[15]).toEqual({
			id: '15',
			label: 'Adres',
			text: 'Szukaj lub podaj witrynę',
			bounds: TEXTFIELD[15]?.frame,
		});
	});

	/** A toggle's value is its text, `'0'` or `'1'`, because that is what the device reported. */
	it('carries a toggle value through as text', () => {
		expect(
			toScreenElements(TOGGLES)
				.slice(12, 16)
				.map((element) => element.text),
		).toEqual(['0', '0', '0', '1']);
	});

	/** A node carrying neither comes out carrying neither, rather than carrying empty strings. */
	it('answers null for a node with no label and no value', () => {
		expect(toScreenElements(TEXTFIELD)[1]).toMatchObject({ label: null, text: null });
	});

	/** The Compose read has no value anywhere, which is what makes the case above worth making. */
	it('leaves text null across a read that carries no values at all', () => {
		expect(toScreenElements(COMPOSE).every((element) => element.text === null)).toBe(true);
	});
});

describe('toScreenElements, on reads no capture here contains', () => {
	/**
	 * Inline, and the case the captures cannot make: the payload does emit `''` — Settings ›
	 * Camera carries `role_description: ''` — but never in the two mapped keys, so this is where
	 * the rule is pinned. `ScreenElement`'s fields are nullable precisely so "carries neither" is
	 * representable, and `''` would match a substring target for `''`.
	 */
	it('turns an empty string into null', () => {
		expect(
			toScreenElements([
				{ frame: { x: 0, y: 0, width: 1, height: 1 }, AXLabel: '', AXValue: '', traits: [] },
			])[0],
		).toEqual({ id: '0', label: null, text: null, bounds: { x: 0, y: 0, width: 1, height: 1 } });
	});

	/** An empty read is an empty list — a screen with nothing accessible on it, not a failure. */
	it('answers an empty read with no elements', () => {
		expect(toScreenElements([])).toEqual([]);
	});
});

describe('toOnScreenKeyboard, against the real reads', () => {
	/**
	 * **The acceptance criterion of this phase, against the literal numbers.** The union of the 34
	 * `KeyboardKey` frames and the 3 `AutoCorrectCandidate` ones on the capture is the drawn panel
	 * as checked against the screenshot it was taken beside: the strip starts at `y: 539` over the
	 * full 402-point width, and the bottom key row ends at 874.434 on an 874-point screen.
	 */
	it('answers the drawn panel on the capture taken with the keyboard up', () => {
		expect(toOnScreenKeyboard(KEYBOARD)).toEqual({
			shown: true,
			bounds: { x: 0, y: 539, width: 402, height: 335.4341207349081 },
		});
	});

	/**
	 * The strip is part of the panel, and this is the assertion that fails rather than merely
	 * shifting a number if somebody narrows the union to the keys: keys alone start at `y: 590`,
	 * 51 points below the rectangle's top, and a touch landing in that band would be refused by
	 * nothing.
	 */
	it('covers the candidate strip above the topmost key', () => {
		const bounds = toOnScreenKeyboard(KEYBOARD).bounds;
		const topKey = Math.min(
			...KEYBOARD.filter((node) => node.traits?.includes('KeyboardKey')).map(
				(node) => node.frame.y,
			),
		);

		expect(topKey).toBe(590);
		expect(bounds?.y).toBeLessThan(topKey);
	});

	/**
	 * Unrounded and unclamped, for `toScreenElements`' reason — and not theoretically: the bottom
	 * key row is laid out at `y: 805.6989…`, so the union ends 0.43 points past the bottom of an
	 * 874-point screen. `RectSchema` permits it and `src/verbs/target.ts` is the layer that
	 * decides what is addressable.
	 */
	it('keeps the fractional edges the layout engine produced', () => {
		const bounds = toOnScreenKeyboard(KEYBOARD).bounds;

		expect(bounds?.height).not.toBe(Math.round(bounds?.height ?? 0));
		expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeGreaterThan(SCREEN.heightDp);
	});

	/**
	 * The one place the two halves of this module are checked against each other: the panel spans
	 * the screen's full width, so the rectangle has to be in the **same space** `widthDp` is.
	 * A mapping that divided by the scale would answer 134 here and one that multiplied 1206.
	 */
	it('answers in the same points as the screen it covers', () => {
		expect(toOnScreenKeyboard(KEYBOARD).bounds?.width).toBe(SCREEN.widthDp);
	});

	/**
	 * The closed half of the pair — the same screen one `typeText` later, which is what dismissed
	 * the keyboard on this platform. `bounds` is `null` rather than a zero rectangle, because
	 * *nothing is covered* has no rectangle.
	 */
	it('answers no keyboard on the capture taken one keystroke later', () => {
		expect(toOnScreenKeyboard(KEYBOARD_DISMISSED)).toEqual({ shown: false, bounds: null });
	});

	// The three captures that predate this function, none of which was taken over a keyboard.
	it('answers no keyboard on every read captured before this field existed', () => {
		for (const capture of [COMPOSE, TOGGLES, TEXTFIELD]) {
			expect(toOnScreenKeyboard(capture)).toEqual({ shown: false, bounds: null });
		}
	});
});

describe('toOnScreenKeyboard, on reads no capture here contains', () => {
	const node = (
		traits: string[],
		frame: { x: number; y: number; width: number; height: number },
	) => ({
		frame,
		AXLabel: null,
		AXValue: null,
		traits,
	});

	/**
	 * Inline, because no capture can make it: a strip is only ever drawn with keys under it. The
	 * candidate trait is in the **union** but not in the **test** — `shown` is a claim about the
	 * panel that covers the screen, and the keys are what that panel is.
	 */
	it('does not call a candidate strip on its own a keyboard', () => {
		expect(
			toOnScreenKeyboard([
				node(['AutoCorrectCandidate'], { x: 0, y: 539, width: 402, height: 44 }),
			]),
		).toEqual({ shown: false, bounds: null });
	});

	/** An empty read is a screen with nothing on it, which is a screen with no keyboard on it. */
	it('answers no keyboard on an empty read', () => {
		expect(toOnScreenKeyboard([])).toEqual({ shown: false, bounds: null });
	});

	/**
	 * **A node whose `traits` is `null` claims no trait, and must not throw** (#298). That value is
	 * not hypothetical — it is what the launching-app placeholder of a cold launch really answers
	 * (`./parsers/accessibility.test.ts`), and this read is exactly what `deviceInfo` hands here
	 * when it catches that device mid-launch. `null` and `[]` are the same claim, so both answer
	 * the same no-keyboard, and neither can be a key.
	 */
	it('reads a node claiming no traits at all as no keyboard, whichever way it says so', () => {
		const placeholder = {
			frame: { x: 0, y: 0, width: 0, height: 0 },
			AXLabel: null,
			AXValue: null,
		};

		expect(toOnScreenKeyboard([{ ...placeholder, traits: null }])).toEqual({
			shown: false,
			bounds: null,
		});
		expect(toOnScreenKeyboard([{ ...placeholder, traits: [] }])).toEqual({
			shown: false,
			bounds: null,
		});
	});

	/**
	 * And a `null` beside a real keyboard is skipped rather than fatal: the union is still the
	 * panel's, which is the property that would break if `claims` had been written as a cast.
	 */
	it('unions the keyboard around a node whose traits are null', () => {
		const withPlaceholder = [
			{ frame: { x: 0, y: 0, width: 0, height: 0 }, AXLabel: null, AXValue: null, traits: null },
			...KEYBOARD,
		];

		expect(toOnScreenKeyboard(withPlaceholder)).toEqual(toOnScreenKeyboard(KEYBOARD));
	});
});
