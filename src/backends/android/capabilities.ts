/**
 * What this backend declares it can do.
 *
 * **Nothing registers this manifest yet**, and that is deliberate: the backend is being
 * built phase by phase, and its `index.ts` lands in the change that removes the last stub
 * (PROJECT.md §9.3 row R5, ai/TESTING.md "A backend under construction registers
 * nothing"). Registering a manifest whose methods are half-written is what forces an
 * exemption that disables the conformance gate for the backends already passing it.
 *
 * Every capability is declared `false` for the same reason: the flags describe what the
 * class in `./backend.ts` answers *today*, not what the platform is capable of. Each one
 * flips in the change that lands the methods behind it — `canReadScreen` in #13,
 * `canInput` in #12, `canControlNetwork` in #16 — so the manifest is honest at every
 * commit rather than aspirational. A capability declared before its methods exist is
 * exactly the "an agent is told a device can do something it cannot" failure D11 is for.
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
