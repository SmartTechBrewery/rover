/**
 * What this backend declares it can do.
 *
 * `./index.ts` registers it, which it could only do once every required method of the
 * contract was real (PROJECT.md §9.3 row R5, ai/TESTING.md "A backend under construction
 * registers nothing"): registering a manifest whose methods are half-written is what
 * forces an exemption that disables the conformance gate for the backends already passing
 * it.
 *
 * Every capability is still declared `false`, and that is not the manifest lagging behind
 * the platform: the flags describe what the class in `./backend.ts` answers *today*. Each
 * one flips in the change that lands the methods behind it — `canReadScreen` in #13,
 * `canInput` in #12, `canControlNetwork` in #16 — so the manifest is honest at every
 * commit rather than aspirational. A capability declared before its methods exist is
 * exactly the "an agent is told a device can do something it cannot" failure D11 is for,
 * and an honest opt-out is a complete backend rather than an unfinished one.
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
		canControlNetwork: false,
	},
};
