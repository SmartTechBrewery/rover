/**
 * A device type's screen as the neutral `ScreenInfo` of `src/core/device.ts`, and an
 * accessibility read as its neutral `ScreenElement[]` and `OnScreenKeyboard`.
 *
 * Sibling in spirit to `../android/screen.ts`: pure arithmetic and vocabulary, no process.
 * `./parsers/simctl-list.js` owns the listing, `./parsers/device-type-profile.js` owns the
 * plist, `./parsers/accessibility.js` owns the read, and this owns the mapping — so
 * everything below is asserted in `tests/unit/backends/ios-simulator/screen.test.ts` against
 * two captured profiles and five captured reads rather than against a simulator.
 *
 * **The halves of that file meet in one place and nowhere else**: the points
 * {@link toScreenElements} and {@link toOnScreenKeyboard} hand back are the same unit as the
 * `widthDp`/`heightDp` {@link toScreenInfo} divides out, which is the whole reason one performs a
 * division and the other two perform none.
 *
 * **Two of the three read the same payload and answer different questions about it**, and that is
 * the split `ScreenInfo` and `ScreenElement[]` already are: `toScreenElements` says what is *in*
 * the application, `toOnScreenKeyboard` says what the **system** drew on top of it. Nothing
 * filters the keyboard's nodes out of the element list — they are on the screen and the device
 * listed them — and `src/verbs/target.ts` is the layer that decides what a touch may reach.
 *
 * **The screen comes from the device type, never from a captured image** — trap 6 of
 * `docs/IOS.md` §8, and the whole reason this layer exists. Two mistakes it forecloses:
 *
 * - **A scale derived from a screenshot's width.** That number is off by a few percent,
 *   which reads as a pile of small imperfections rather than as an arithmetic error and so
 *   survives review. It is the same error `../android/parsers/wm.ts` records for
 *   `DP_BASELINE_DPI`, and it cost a day on that side. The profile states the scale, so
 *   nothing here has to derive one — and `--mask` makes the screenshot route worse still,
 *   since the default capture is a rounded-corner PNG with alpha (`docs/IOS.md` §8, trap 5).
 * - **Taking idb's word for the density.** `idb describe` reports `density: 3.0` for an
 *   iPhone 17 Pro, which is the **scale**, not dots per inch. `ScreenInfo` wants 460 in
 *   `density` and 3 in `densityScale`, so copying that field across puts a number 153 times
 *   too small in it — small enough to look like a plausible density and wrong enough to
 *   misplace everything computed from one. {@link toScreenInfo} takes them from two
 *   different plist keys, and the suite asserts the two fields differ.
 */

import path from 'node:path';
import {
	type OnScreenKeyboard,
	type ScreenElement,
	type ScreenInfo,
	ScreenInfoSchema,
} from '../../core/device.js';
import { parseElementId } from '../../core/ids.js';
import {
	type AccessibilityRead,
	KEYBOARD_CANDIDATE_TRAIT,
	KEYBOARD_KEY_TRAIT,
} from './parsers/accessibility.js';
import type { DeviceTypeProfile } from './parsers/device-type-profile.js';

/** Where a `.simdevicetype` bundle keeps its profile, relative to the bundle root. */
const PROFILE_IN_BUNDLE = ['Contents', 'Resources', 'profile.plist'];

/**
 * The `profile.plist` of the device type whose bundle is at `bundlePath`.
 *
 * `bundlePath` is **the tool's own** — `SimctlDeviceType.bundlePath`, straight out of
 * `simctl list -j devicetypes` — and this only appends the fixed suffix inside it. The
 * bundles are not under `DEVELOPER_DIR`: on the bench machine all 124 sit under
 * `/Library/Developer/CoreSimulator/Profiles/DeviceTypes/` while Xcode is in
 * `/Applications` (measured on Xcode 26.4.1, 2026-09-08), so an Xcode-relative path would
 * find none of them. Reading the file is the caller's job; this decides where it is.
 */
export function deviceTypeProfilePath(bundlePath: string): string {
	return path.join(bundlePath, ...PROFILE_IN_BUNDLE);
}

/**
 * A device type's profile as the neutral screen shape.
 *
 * **Exact quotients, unrounded**, matching `ScreenInfoSchema`'s own wording for
 * `widthDp`/`heightDp` and `../android/screen.ts`'s `toScreenElements`: rounding is a
 * presentation decision, and a backend that rounds leaves no way to ask what the device
 * said. On the two captured profiles they come out integral anyway — 1206/3 = 402 and
 * 2622/3 = 874 on an iPhone 17 Pro, 2064/2 = 1032 and 2752/2 = 1376 on an iPad Pro 13-inch
 * — which is exactly why an implementation that rounded would pass a shallow test.
 *
 * **A device type whose two DPI values disagree is refused by name.** `ScreenInfo.density`
 * is one number and the width DPI is the one it takes; the two are equal on all 124 device
 * types measured (Xcode 26.4.1, 2026-09-08), so the day they are not is a device this
 * mapping has never seen rather than a choice to make quietly. `modelIdentifier` is in the
 * message because a caller holding a profile has no other way to say which type it was.
 *
 * `ScreenInfoSchema.parse` on the way out is what makes "these fields, from these keys" a
 * checked claim: a non-integer DPI that somehow reached here fails there too, having
 * already failed in `DeviceTypeProfileSchema` under the plist key's own name.
 *
 * **`keyboard` is a parameter rather than a field of the profile**, and that asymmetry is the
 * shape of the fact rather than a convenience: a device type says what a screen *is*, and whether
 * a keyboard is up is the most *now* fact there is, so it cannot come out of this plist. The
 * caller — `./backend.ts`'s `deviceInfo` — takes one accessibility read and hands down
 * {@link toOnScreenKeyboard}'s answer, or `null` when it could not. `null` goes straight through
 * and means *this device did not say*; see the field's own comment below.
 */
export function toScreenInfo(
	profile: DeviceTypeProfile,
	keyboard: OnScreenKeyboard | null,
): ScreenInfo {
	const { mainScreenWidth, mainScreenHeight, mainScreenScale } = profile;
	const { mainScreenWidthDPI, mainScreenHeightDPI, modelIdentifier } = profile;

	if (mainScreenWidthDPI !== mainScreenHeightDPI) {
		throw new Error(
			`Device type ${modelIdentifier} reports ${mainScreenWidthDPI} dpi across and ` +
				`${mainScreenHeightDPI} dpi down: a screen carries one density, and choosing ` +
				`either of these would report one the device never claimed`,
		);
	}

	return ScreenInfoSchema.parse({
		widthPx: mainScreenWidth,
		heightPx: mainScreenHeight,
		density: mainScreenWidthDPI,
		densityScale: mainScreenScale,
		widthDp: mainScreenWidth / mainScreenScale,
		heightDp: mainScreenHeight / mainScreenScale,
		/*
		 * **`null`, and it is the honest answer rather than a gap left for later.** The profile
		 * this whole function reads is a device-type plist: it carries the screen, its scale and
		 * its two DPI values, and **no safe area of any kind**. There is nothing here to read, and
		 * a table of insets per device type written from documentation is exactly the remembered
		 * fact `PROJECT.md` §6 exists to forbid — the Android side of this field measured 52 dp
		 * where every guide says 24, on the first device it met.
		 *
		 * So the consumer is told *not answered* and behaves accordingly (`core/device.ts`,
		 * `docs/DESIGN.md` §9), and **nothing branches on the platform to discover it**
		 * (`ai/RULES.md` §2). What would change this is a verified route to a booted simulator's
		 * own safe area; until somebody runs one, this stays `null`.
		 */
		systemBars: null,
		/*
		 * **Whatever the caller measured, and `null` when it measured nothing** (#298; this block
		 * is edited in place with its reasoning rewritten rather than deleted, `ai/RULES.md` §1).
		 *
		 * It said *this stays `null` until somebody runs a verified route to a booted simulator's
		 * own IME state against a device*. Somebody did. The profile still cannot answer it — the
		 * paragraph above about `systemBars` applies here word for word, a device type says what a
		 * screen *is* and this is a fact about what is drawn on one — but the **accessibility
		 * read** can: the software keyboard's own nodes carry `KeyboardKey`
		 * (`./parsers/accessibility.js`), and {@link toOnScreenKeyboard} unions their frames. So
		 * the route exists and runs one layer up, in the caller that is allowed to touch a device.
		 *
		 * `null` is still exactly what a caller gets when no read was possible — no companion on
		 * this host, a device that is not booted, a wedged bridge — because *not answered* and
		 * *no keyboard is up* are two different claims and a backend that folded them would be
		 * promising a clear screen it never looked at (`src/core/device.ts`, `ai/RULES.md` §2).
		 */
		keyboard,
	});
}

/** `''` and `null` are both "carries neither", which `ScreenElement` spells `null`. */
function content(value: string | null): string | null {
	return value === null || value.length === 0 ? null : value;
}

/**
 * An accessibility read as the neutral screen elements, **with no coordinate conversion at
 * all**.
 *
 * That absence is the one thing to read this function for, because the division
 * `../android/screen.ts` performs in the function of this name is exactly what a reader will
 * look for here. **idb reports frames in points**, which is the same unit as
 * {@link toScreenInfo}'s `widthDp`/`heightDp` — that one divides pixels by the scale to reach
 * this space, and this one is handed it. Measured on this bench (companion v1.5.2, Xcode
 * 26.4.1 / iOS 26.4.1, 2026-09-08): the `AXApplication` node of each committed capture is
 * `{x: 0, y: 0, width: 402, height: 874}` on an iPhone 17, whose profile says 1206×2622 px at
 * scale 3 — 402×874 dp exactly. A frame divided by the scale on the way through would land at
 * 134×291, a third of the way from the origin; multiplied, at 1206×2622, off the panel.
 *
 * **A read whose nodes all have zero-sized frames never reaches here.** That shape is the
 * launching application before it has drawn, and `./backend.ts` refuses it as
 * `UnreadableScreenError` rather than handing it down (`noScreenYet`, #300): mapping it would
 * produce a `ScreenElement` with a rectangle no caller can target and no label to match, which is
 * indistinguishable from a screen that genuinely holds one nameless thing. So everything below may
 * assume what the measurement found on every settled screen — at least one node with extent.
 *
 * So the frame goes **straight through**, unrounded and unclamped, for `toScreenInfo`'s own
 * reason: rounding is a presentation decision, and a backend that rounds leaves no way to ask
 * what the device said. A rectangle extending past the bottom edge survives — the captures
 * carry one (`./parsers/accessibility.js`) — because `src/verbs/target.ts` reads that to
 * decide what is addressable, the same way it reads a negative height on the other platform.
 *
 * **The id is a flat ordinal, and it is the only truthful one available.** `AXUniqueId` looks
 * like the field for this and cannot be used, which was established by capturing three real
 * screens rather than one:
 *
 * - On the Compose Multiplatform app it is `null` on all fifteen nodes, which is what
 *   `docs/IOS.md` §2 recorded.
 * - On Apple's own Safari it is populated on eleven of eighteen nodes — **and
 *   `favoritesItemIdentifierContent` appears on three of them**, the three favourites tiles.
 *   `findOnScreen` filters on `element.id === target.id` and treats two hits as the backend
 *   contradicting itself (`src/verbs/errors.ts`), so an id taken from that field would make
 *   Safari's start page unaddressable.
 *
 * A **flat** ordinal rather than `../android/screen.ts`' child-ordinal path, because this read
 * answers a flat list where uiautomator answers a tree. It carries that module's caveat
 * unchanged and the caveat is the honest claim rather than a footnote: **the id is stable only
 * for as long as the shape of the read is.** Anything that inserts a node above an element
 * moves every id below it, so a caller that remembers one across a turn has built D12(a)'s
 * remembered coordinate wearing a different hat — which is why the verb layer re-reads the
 * screen inside every verb instead.
 *
 * **`label` and `text` come from two different keys**, `AXLabel` and `AXValue`: an
 * accessibility name and the string showing in the control are different strings, and
 * conflating them taps the wrong thing (`ScreenElementSchema`). **`''` becomes `null`**,
 * because `ScreenElement`'s two fields are nullable precisely so "carries neither" is
 * representable, and `''` would match a substring target for `''`.
 *
 * **Every node, in the order the tool listed them, unfiltered.** Deciding which nodes are
 * interesting is a policy the verb layer already applies by matching on text, and a container
 * with no text of its own is exactly what `ScrollOptions.target` addresses — the argument is
 * `../android/screen.ts`' and it does not change for being a list rather than a tree.
 */
export function toScreenElements(read: AccessibilityRead): ScreenElement[] {
	return read.map((element, ordinal) => {
		const { x, y, width, height } = element.frame;

		return {
			id: parseElementId(String(ordinal)),
			text: content(element.AXValue),
			label: content(element.AXLabel),
			bounds: { x, y, width, height },
		};
	});
}

/**
 * An accessibility read as the neutral {@link OnScreenKeyboard} — the software keyboard, found by
 * the name the payload gives it.
 *
 * **The tree names the keyboard, and nothing else here does.** Measured on a throwaway iPhone 17
 * (companion v1.5.2, Xcode 26.4.1 / iOS 26.4.1, 2026-10-06; captured as
 * `tests/fixtures/ios-simulator/accessibility.uikit-keyboard.*.json`), with the Polish system
 * keyboard up over Settings' search field: **34** nodes carry `KeyboardKey` and the **3** cells of
 * the strip above them carry `AutoCorrectCandidate`. The union of those 37 frames is
 * `{x: 0, y: 539, width: 402, height: 335.434}` on a 402×874-point screen, which is the drawn
 * panel checked against the screenshot.
 *
 * - **`shown` is the keys, not the strip.** A candidate strip can be drawn without a keyboard
 *   panel, and the claim `ScreenInfo.keyboard` makes is about the thing that covers the screen.
 * - **`bounds` is both.** Keys alone give `{4.67, 590, 395, 284.43}` — 51 points short at the top,
 *   missing the whole strip, and therefore a band a touch would land in that nothing would refuse.
 *
 * **The node that looks like the panel is deliberately not used.** The only node whose frame
 * nearly matches is an unlabelled `AXGenericElement` at `{0, 583, 402, 291}` with traits
 * `["Scrollable", "Spacer"]`: a geometric coincidence rather than a name, missing the strip by 44
 * points, and indistinguishable from any other spacer on any other screen. The traits are what the
 * device *said*; the rectangle is what somebody would have recognised.
 *
 * **Unrounded and unclamped**, for {@link toScreenElements}' stated reason, and that is not
 * theoretical here: the union's bottom edge is 874.434 on an 874-point screen, because the bottom
 * key row is laid out at `y: 805.6989…` with `height: 68.7351…`. `RectSchema` permits it, the
 * committed captures already carry a row 9.67 points past the bottom, and `isInside` is half-open
 * — so a backend that rounded or clamped would be editing what the device said to make it tidy.
 *
 * **In points, so nothing is divided** — `./parsers/accessibility.js`'s frames are already the
 * space `OnScreenKeyboard.bounds` is stated in, which is the same absence {@link toScreenElements}
 * exists to make visible.
 *
 * **This function cannot produce `{shown: true, bounds: null}`**, and the schema's state stays
 * representable for other backends rather than for this one: a node carrying `KeyboardKey` always
 * has a frame, because `frame` is required by the parser and a read missing one fails there by
 * name. So on this platform *the keyboard is up* and *here is where* arrive together or not at
 * all, and a caller seeing that state is reading another device.
 */
export function toOnScreenKeyboard(read: AccessibilityRead): OnScreenKeyboard {
	const panel = read.filter(
		({ traits }) => claims(traits, KEYBOARD_KEY_TRAIT) || claims(traits, KEYBOARD_CANDIDATE_TRAIT),
	);
	const shown = panel.some(({ traits }) => claims(traits, KEYBOARD_KEY_TRAIT));
	if (!shown) return { shown: false, bounds: null };

	const left = Math.min(...panel.map(({ frame }) => frame.x));
	const top = Math.min(...panel.map(({ frame }) => frame.y));
	const right = Math.max(...panel.map(({ frame }) => frame.x + frame.width));
	const bottom = Math.max(...panel.map(({ frame }) => frame.y + frame.height));

	return { shown: true, bounds: { x: left, y: top, width: right - left, height: bottom - top } };
}

/**
 * Whether a node claimed a trait — with *claimed nothing* spelled `null` as well as `[]`.
 *
 * `traits` is nullable because one node really answers `null`: the zero-framed `AXApplication`
 * placeholder of a cold launch (`./parsers/accessibility.js`, `./backend.ts`'s `noScreenYet`).
 * Both spellings mean the same thing here and neither can be a keyboard key, because a keyboard
 * key is a node that **said so** — which is the whole premise of {@link toOnScreenKeyboard}, and
 * why the absent case needs no branch of its own further up.
 */
function claims(traits: string[] | null, trait: string): boolean {
	return traits?.includes(trait) ?? false;
}
