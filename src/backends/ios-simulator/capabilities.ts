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
 * every commit rather than aspirational. Two flipped when this backend first registered (#230),
 * because its five phases all landed before it registered at all:
 *
 * - **`canRecordVideo`** names exactly one method, `recordVideo`, and this backend answers it —
 *   `simctl io <device> recordVideo` to a path derived from the udid, a wait on the
 *   `Recording started` marker, a deadline timer whose callback sends `SIGINT`, and the container
 *   checked on the bytes that arrived (`./backend.ts`).
 * - **`canControlRecording`** names the three above, and all three go through this host's own
 *   process table rather than a remembered handle (D6), which is what lets the lease-end teardown
 *   stop a recorder an earlier daemon started.
 *
 * **`canReadScreen` is the third, and it flips here** (#251, `PROJECT.md` R47 phase 4). It names
 * exactly one method, `readScreen`, and this backend answers it: one `accessibility_info` through
 * the `idb_companion` `./idb-client.ts` supervises for that target, projected by
 * `./parsers/accessibility.ts` and mapped by `./screen.ts`. **What that flag now depends on is
 * not Xcode.** Every other `true` above needs only what an Xcode install has; this one needs a
 * **second external program, third-party, with a lifecycle of its own and no canonical install
 * location** (`./idb-companion-path.ts`). A host without it answers `readScreen` with an
 * `IdbCompanionNotFoundError` naming every place it looked — which is the honest failure for a
 * capability the *backend* has and this *machine* is not set up for, and is why it is still a
 * declared capability rather than a per-host one: `CapabilityManifest` describes what a backend
 * can do (D11), and a manifest that went `false` on a machine with no companion would make the
 * same device advertise different abilities depending on which host was lending it.
 *
 * **The label stays `iOS Simulator (simctl)` until the input vocabulary lands** — see
 * {@link IOS_SIMULATOR_LABEL}, which carries why.
 *
 * **The two remaining `false` flags are honest, and each has its own reason.**
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
 * - **`canInput`** is `false` because the four methods behind it are the phase after this one
 *   (`PROJECT.md` R47 phase 5, `docs/IOS.md` §10): the transport they need is now here and the
 *   vocabulary is not, and `canInput` names `tap`, `swipe`, `typeText` **and** `pressKey`, so it
 *   cannot honestly move for three of the four. `PROJECT.md` R46 is the per-key refusal it will
 *   move behind. Until it does, an absent method beside a `false` flag is a complete backend.
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
 * **`(simctl)` rather than `docs/IOS.md` §10's `(simctl + idb)`, even though idb is now here**,
 * and it stays that way until the input vocabulary lands with it. A label is what a person picking
 * a device reads, so naming the program that does taps and text while `canInput` is still `false`
 * would promise exactly what this file says a manifest must not — and it would promise it in the
 * one place there is no capability flag beside to correct it. It moves in the phase that makes it
 * true (`PROJECT.md` R47 phase 5). The registry key itself is `./devices.ts`'s
 * `IOS_SIMULATOR_PLATFORM_ID` — reused rather than restated, because that module carries the whole
 * argument for `ios-simulator` over `ios`.
 */
const IOS_SIMULATOR_LABEL = 'iOS Simulator (simctl)';

export const iosSimulatorCapabilityManifest: CapabilityManifestInput = {
	platform: IOS_SIMULATOR_PLATFORM_ID,
	label: IOS_SIMULATOR_LABEL,
	capabilities: {
		canReadScreen: true,
		canInput: false,
		canControlNetwork: false,
		canRecordVideo: true,
		canControlRecording: true,
	},
};
