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
 * honest at every commit rather than aspirational: `canControlNetwork` flipped here (#9)
 * because state restoration needs `setAirplaneMode` and `setWifiEnabled` to be real before
 * anything drives them, and `canReadScreen` (#13) and `canInput` (#12) are still declared
 * `false` because their methods do not exist yet. R16 is the *verb* layer over what #9
 * landed, not the primitives, so it is not what moves this flag.
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
		canInput: false,
		canControlNetwork: true,
	},
};
