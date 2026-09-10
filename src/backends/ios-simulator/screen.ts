/**
 * A device type's screen as the neutral `ScreenInfo` of `src/core/device.ts`, and an
 * accessibility read as its neutral `ScreenElement[]`.
 *
 * Sibling in spirit to `../android/screen.ts`: pure arithmetic and vocabulary, no process.
 * `./parsers/simctl-list.js` owns the listing, `./parsers/device-type-profile.js` owns the
 * plist, `./parsers/accessibility.js` owns the read, and this owns the mapping — so
 * everything below is asserted in `tests/unit/backends/ios-simulator/screen.test.ts` against
 * two captured profiles and three captured reads rather than against a simulator.
 *
 * **The two halves of that file meet in one place and nowhere else**: the points
 * {@link toScreenElements} hands back are the same unit as the `widthDp`/`heightDp`
 * {@link toScreenInfo} divides out, which is the whole reason one performs a division and the
 * other performs none.
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
import { type ScreenElement, type ScreenInfo, ScreenInfoSchema } from '../../core/device.js';
import { parseElementId } from '../../core/ids.js';
import type { AccessibilityRead } from './parsers/accessibility.js';
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
 */
export function toScreenInfo(profile: DeviceTypeProfile): ScreenInfo {
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
