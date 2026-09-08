/**
 * A device type's screen, as the neutral `ScreenInfo` of `src/core/device.ts`.
 *
 * Sibling in spirit to `../android/screen.ts`: pure arithmetic and vocabulary, no process.
 * `./parsers/simctl-list.js` owns the listing, `./parsers/device-type-profile.js` owns the
 * plist, and this owns the mapping — so everything below is asserted in
 * `tests/unit/backends/ios-simulator/screen.test.ts` against two captured profiles rather
 * than against a simulator.
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
import { type ScreenInfo, ScreenInfoSchema } from '../../core/device.js';
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
	});
}
