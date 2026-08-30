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
 * anything drives them, and `canInput` flipped here (#12) on the same seam: the four
 * primitives `tap`, `swipe`, `typeText` and `pressKey` are what this backend answers,
 * while the verbs over them are separate phases — R16 is the *verb* layer over what #9
 * landed, not the primitives, and it is not what moved either flag.
 *
 * The four input primitives had to land together rather than one at a time.
 * `CAPABILITY_METHODS.canInput` names every one of them, so a manifest declaring the
 * capability with three of the four implemented fails
 * `tests/helpers/backend-conformance.ts` — the split point is forced by the repository
 * rather than chosen.
 *
 * `canReadScreen` flips here (#13), on that same seam and for that same reason:
 * `CAPABILITY_METHODS.canReadScreen` names exactly one method, `readScreen`, and this
 * backend now answers it — `uiautomator dump` mapped onto `ScreenElement[]` in dp
 * (`../android/screen.ts`). The three read *verbs* over it landed separately (#67, #68),
 * and none of them is what moves this flag either.
 *
 * `canRecordVideo` flips here (#14), on the same seam once more:
 * `CAPABILITY_METHODS.canRecordVideo` names exactly one method, `recordVideo`, and this
 * backend now answers it — `screenrecord` to a device-side scratch path, a wait on the
 * recorder being gone, and the pull (`../android/backend.ts`). The `record_video` *verb*
 * over it landed in the same change, and frame extraction is a separate phase; neither is
 * what moves this flag.
 *
 * **Every flag in this manifest is now `true`, so nothing here is a declared opt-out.**
 * That is a statement about this backend, not about the model: a capability declared
 * before its methods exist is exactly the "an agent is told a device can do something it
 * cannot" failure D11 is for, and the next flag added to `CapabilityManifestInput` starts
 * at `false` here until the change that lands its methods.
 */

import type { CapabilityManifestInput } from '../../core/capabilities.js';

/** The registry key for this backend. */
export const ANDROID_PLATFORM_ID = 'android';

export const androidCapabilityManifest: CapabilityManifestInput = {
	platform: ANDROID_PLATFORM_ID,
	label: 'Android',
	capabilities: {
		canReadScreen: true,
		canInput: true,
		canControlNetwork: true,
		canRecordVideo: true,
	},
};
