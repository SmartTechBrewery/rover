/**
 * What this backend declares it can do.
 *
 * `./index.ts` registers it, which it could only do once every required method of the contract
 * was real *and* every capability it declares had every one of its methods
 * (`PROJECT.md` §9.3 row R45, `ai/TESTING.md` "A backend under construction registers nothing").
 * That is why this file lands in the phase that lands the recorder rather than in the one that
 * removed the last required-method stub: `CAPABILITY_METHODS.canControlRecording` names
 * `startRecording`, `stopRecording` **and** `discardRecording`, so a manifest declaring it with
 * two of the three implemented fails `tests/helpers/backend-conformance.ts` — the split point is
 * forced by the repository rather than chosen.
 *
 * Each flag flips in the change that lands the methods behind it, so the manifest is honest at
 * every commit rather than aspirational. Both `true` flags flip here (#230), because this
 * backend's five phases all landed before it registered at all:
 *
 * - **`canRecordVideo`** names exactly one method, `recordVideo`, and this backend answers it —
 *   `simctl io <device> recordVideo` to a path derived from the udid, a wait on the
 *   `Recording started` marker, a deadline timer whose callback sends `SIGINT`, and the container
 *   checked on the bytes that arrived (`./backend.ts`).
 * - **`canControlRecording`** names the three above, and all three go through this host's own
 *   process table rather than a remembered handle (D6), which is what lets the lease-end teardown
 *   stop a recorder an earlier daemon started.
 *
 * **The three `false` flags are honest opt-outs rather than gaps, and each has its own reason.**
 *
 * - **`canControlNetwork`** is the one that is `false` *for good* (`docs/IOS.md` §5, §10 step 1).
 *   A simulator has no airplane mode and no wifi toggle: it uses the **host's** network stack, so
 *   the only truthful `setWifiEnabled` would change the networking of a machine that is lending
 *   devices to other people. `simctl status_bar override --wifiMode failed` exists and is
 *   **cosmetic** — it draws a different icon and changes nothing about reachability — so wiring
 *   it would be exactly the "plausible-looking result where the honest answer is *this device
 *   cannot do that*" `ai/RULES.md` §2 forbids. `MissingCapabilityError` is what a caller gets,
 *   naming this capability and the device, and there is **no** `setAirplaneMode` and **no**
 *   `setWifiEnabled` method beside the flag.
 * - **`canReadScreen`** and **`canInput`** are `false` because the only routes to either need
 *   `idb`, a third-party companion with its own lifecycle, and this backend deliberately depends
 *   on nothing but Xcode (`docs/IOS.md` §4, §10). They are the two flags that can honestly move
 *   later — `canInput` behind the per-key refusal `PROJECT.md` R46 is about — and until they do,
 *   an absent method beside a `false` flag is a complete backend.
 *
 * That is the difference between this manifest and `../android/capabilities.ts`, where every flag
 * is `true`: a declared opt-out is not an unfinished backend, and a capability declared before its
 * methods exist is exactly the "an agent is told a device can do something it cannot" failure D11
 * is for. The next flag added to `CapabilityManifestInput` starts at `false` here too.
 */

import type { CapabilityManifestInput } from '../../core/capabilities.js';
import { IOS_SIMULATOR_PLATFORM_ID } from './devices.js';

/**
 * The label a client shows beside this platform's devices.
 *
 * **`(simctl)` rather than `docs/IOS.md` §10's `(simctl + idb)`**, on purpose: there is no idb
 * here and naming one would promise a `readScreen` and an input vocabulary this backend does not
 * have. The registry key itself is `./devices.ts`'s `IOS_SIMULATOR_PLATFORM_ID` — reused rather
 * than restated, because that module carries the whole argument for `ios-simulator` over `ios`.
 */
const IOS_SIMULATOR_LABEL = 'iOS Simulator (simctl)';

export const iosSimulatorCapabilityManifest: CapabilityManifestInput = {
	platform: IOS_SIMULATOR_PLATFORM_ID,
	label: IOS_SIMULATOR_LABEL,
	capabilities: {
		canReadScreen: false,
		canInput: false,
		canControlNetwork: false,
		canRecordVideo: true,
		canControlRecording: true,
	},
};
