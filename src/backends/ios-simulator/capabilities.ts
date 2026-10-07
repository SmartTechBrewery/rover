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
 * **`canInput` is the fourth and last, and it flips here** (#252, `PROJECT.md` R46/R47 phase 5).
 * It named four methods then — `tap`, `swipe`, `typeText` **and** `pressKey` — so it could not move
 * for three of them, which is what kept it `false` while the transport was already in place; it
 * names five now (`clearText`, below). All five go through one client-streaming `hid` call on the same companion `readScreen` uses, and each is
 * verified against a device by **reading the screen back** rather than by a return code, because
 * that call answers an empty message and answers it just as happily for a keycode that does not
 * exist (`src/backends/ios-simulator/input.ts`).
 *
 * **`pressKey` is where declaring this capability stops being a boolean.** `DeviceKey` has seven
 * members and this platform presses five of them: `home` and `wake` are buttons, `delete`,
 * `enter` and `tab` are keyboard keys watched landing before they were pressed (#302), and `back`
 * and `recents` are refused **by name** with `UnsupportedKeyError` (#215) — each reaching the
 * agent as an `unsupported-key` failure carrying the serial and the key. **`clearText` (#309) is
 * the fifth method behind the flag**, and it is answered with Cmd+A then backspace, measured the
 * same way (#302). The two refusals are not a hole in this
 * manifest — they are what the per-argument refusals exist for, and the alternative shapes are both
 * worse: a flag per key would put seven booleans behind one method and make `canInput` mean
 * nothing (D11), while declaring `canInput: false` to dodge two keys would refuse tapping, swiping and typing,
 * which work. `wake` is a *conditional* press for the same honesty: the button behind it toggles,
 * so it is pressed only when the screen is off.
 *
 * **The label moves with it**, to `iOS Simulator (simctl + idb)` — see {@link IOS_SIMULATOR_LABEL}.
 *
 * **Three flags are `false`.** Two are measured rather than pending — one because the platform
 * has nothing behind it, one because the only gesture that dismisses this platform's keyboard does
 * more than dismiss it — and the third is a route that exists and is not built yet.
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
 * - **`canHideKeyboard`** is `false`, and **both halves of why are measured now** (#321; this
 *   bullet is edited in place with its reasoning rewritten rather than replaced, `ai/RULES.md`
 *   §1). It said this backend reports no keyboard at all so there was nothing to decide on, then
 *   (#298) that the read existed and only a dismissal was missing. Neither sentence is the reason
 *   any more.
 *
 *   **The read exists** — `ScreenInfo.keyboard` is `{shown, bounds}` here whenever an
 *   accessibility read was possible, because the tree names the software keyboard on every key
 *   node (`./screen.ts`'s `toOnScreenKeyboard`, `./parsers/accessibility.ts`).
 *
 *   **The gesture is what fails, and it fails on what it also does.** The one candidate this
 *   transport has is **Escape, USB HID usage 41**, sent down-then-up over the same `hid` stream
 *   every other primitive uses. It does dismiss a keyboard — on a Settings search field with one
 *   up, one press took the read from 47 nodes to 9 and `screen.keyboard` from
 *   `{shown: true, bounds: {0, 539, 402, 335.43…}}` to `{shown: false, bounds: null}`, with the
 *   app, the screen and the search mode otherwise unchanged. But **Escape is iOS's generic
 *   cancel**, and on a screen that has something to cancel it cancels that instead: over
 *   Contacts' *Nowy kontakt* sheet, a presented modal with its first field focused and a keyboard
 *   over it, one Escape **took the whole sheet away** and landed back on the contacts list — and
 *   it took the same sheet away with **no keyboard up at all**, which is what proves the press is
 *   aimed at the presentation and not at the keyboard (`PROJECT.md` §6, measured 2026-10-06).
 *
 *   That is unusable from a method whose contract is *dismiss the keyboard if one is up, press
 *   nothing otherwise* (`src/core/device.ts`). The read this method would make — `keyboard.shown`
 *   — cannot tell the two screens apart: both say a keyboard is up, and on one of them the press
 *   discards the caller's half-filled form while `screen.keyboard` answers `{shown: false}` and
 *   the verb answers `ok`. That is the "plausible-looking result where the honest answer is *this
 *   device cannot do that*" `ai/RULES.md` §2 forbids, in its worst shape: a success that destroyed
 *   state. A bare modifier is not a way round it either — Left Shift (usage 225, which types
 *   nothing) did not dismiss the keyboard at all (#298) — and there is no keyboard-only call on
 *   this transport: `hid` sends buttons, touches and HID usages, and `simctl` has no keyboard
 *   subcommand. So `hide_keyboard` answers `missing-capability` naming this flag and the device,
 *   and there is **no** `hideKeyboard` method beside it.
 *
 *   What would flip it is a dismissal that is **only** a dismissal, verified on a screen with a
 *   presentation over it. Escape is not that, and a `canHideKeyboard` declared on Escape would be
 *   worse than the refusal it replaced.
 *
 * - **`canPullAppFile`** is `false` *until it is built* (#334). The route exists and is cheaper
 *   than Android's: a simulator's app container is a directory on **this host**, which
 *   `simctl get_app_container <udid> <bundle> data` names (measured working, `docs/IOS.md` §2),
 *   and `./containers.ts` already confines a path to such a root. What is missing is the
 *   `pullAppFile` method over it, its own confinement check against symlinks out of the
 *   container, and a run against a real app's database. Until then `pull_app_file` answers
 *   `missing-capability` naming this flag and the device, and there is **no** `pullAppFile`
 *   method beside it.
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
 * **`(simctl + idb)` at last**, `docs/IOS.md` §10's spelling and the one this backend has now
 * earned. It said `(simctl)` through the three phases in which idb was present but only some of
 * what it enables was: a label is what a person picking a device reads, and naming the program
 * that does taps and text while `canInput` was still `false` would have promised exactly what this
 * file says a manifest must not — in the one place there is no capability flag beside to correct
 * it. It moves in the phase that makes it true (#252), which is also the phase after which naming
 * idb promises nothing this backend does not have.
 *
 * The registry key itself is `./devices.ts`'s `IOS_SIMULATOR_PLATFORM_ID` — reused rather than
 * restated, because that module carries the whole argument for `ios-simulator` over `ios`.
 */
const IOS_SIMULATOR_LABEL = 'iOS Simulator (simctl + idb)';

export const iosSimulatorCapabilityManifest: CapabilityManifestInput = {
	platform: IOS_SIMULATOR_PLATFORM_ID,
	label: IOS_SIMULATOR_LABEL,
	capabilities: {
		canReadScreen: true,
		canInput: true,
		canControlNetwork: false,
		canRecordVideo: true,
		canControlRecording: true,
		canHideKeyboard: false,
		canPullAppFile: false,
	},
};
