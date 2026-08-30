/**
 * What this backend declares it can do.
 *
 * `./index.ts` registers it, which it could only do once every required method of the
 * contract was real (PROJECT.md §9.3 row R5, ai/TESTING.md "A backend under construction
 * registers nothing"): registering a manifest whose methods are half-written is what
 * forces an exemption that disables the conformance gate for the backends already passing
 * it.
 *
 * Each flag flips in the change that lands the methods behind it, so the manifest is
 * honest at every commit rather than aspirational. `canControlNetwork` flipped here (#9)
 * because state restoration needs `setAirplaneMode` and `setWifiEnabled` to be real before
 * anything drives them, and `canInput` flips here (#12) on the same seam: the four
 * primitives `tap`, `swipe`, `typeText` and `pressKey` are what this backend now answers,
 * while the verbs over them are phases 2 and 3 — R16 is the *verb* layer over what #9
 * landed, not the primitives, and it is not what moved either flag.
 *
 * All four had to land together rather than one at a time. `CAPABILITY_METHODS.canInput`
 * names every one of them, so a manifest declaring the capability with three of the four
 * implemented fails `tests/helpers/backend-conformance.ts` — the split point is forced by
 * the repository rather than chosen.
 *
 * `canReadScreen` (#13) is the one flag still declared `false`, because `readScreen` does
 * not exist yet.
 *
 * A capability declared before its methods exist is exactly the "an agent is told a device
 * can do something it cannot" failure D11 is for, and an honest opt-out is a complete
 * backend rather than an unfinished one.
 */

import type { CapabilityManifestInput } from '../../core/capabilities.js';

/** The registry key for this backend. */
export const ANDROID_PLATFORM_ID = 'android';

export const androidCapabilityManifest: CapabilityManifestInput = {
	platform: ANDROID_PLATFORM_ID,
	label: 'Android',
	capabilities: {
		canReadScreen: false,
		canInput: true,
		canControlNetwork: true,
	},
};
