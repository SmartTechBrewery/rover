/**
 * The two environment verbs — `set_airplane_mode` and `set_wifi` (PROJECT.md §4,
 * "Environment"; backlog row R16).
 *
 * Like the app verbs (`./app.ts`) each of these is one {@link performAction} call, so D12
 * holds for them by construction. What is different is what they need and what their answer
 * can honestly say, and both differences are the family's whole content:
 *
 * **`requires: ['canControlNetwork']`, and it is not an empty list.** `setAirplaneMode` and
 * `setWifiEnabled` are *optional* members of `DeviceBackend` gated by that one capability
 * (`src/core/capabilities.ts`), so unlike the app family there genuinely is something to
 * assert — and D11 wants it asserted before anything is dispatched. A backend that does not
 * declare it gets a `MissingCapabilityError` naming the capability, the device and the
 * backend, which reaches an agent as a `missing-capability` failure rather than as a toggle
 * that reported success and moved no radio.
 *
 * **They reach the backend through `capabilityMethod()`**, which is the one place this
 * family departs from `./app.ts`: that module reaches `context.backend` directly because its
 * methods are required ones and `capabilityMethod` will not typecheck for them. Here the
 * opposite holds, and `capabilityMethod` is the only sanctioned route to a gated method
 * (`./context.ts`).
 *
 * **Neither addresses anything on the screen.** A radio is not an element, so neither passes
 * a `target`, no screen is read before the action, and `ActionResult.target` is `null` — the
 * same answer `press_key` gives, and a fact about the verb rather than a resolution that
 * failed.
 *
 * **The verb names and the method names differ on purpose.** `set_airplane_mode` and
 * `set_wifi` are the verbs PROJECT.md §4 names; `setAirplaneMode` and `setWifiEnabled` are
 * the backend methods underneath. Neither list is renamed to match the other.
 *
 * **These are the same two backend methods the daemon's restoration drives**
 * (`src/daemon/restore.ts`, which sets airplane mode off and then wifi on when a lease ends,
 * on the release path and the expiry path alike). That shared method *is* the guarantee the
 * two callers cannot drift: there is one recipe per toggle, in one backend, and this module
 * adds a second caller rather than a second path. The order the restoration uses is worth
 * copying for the same reason it exists — the airplane-mode toggle can move wifi underneath
 * it in a direction that depends on state the device remembers, while the wifi toggle never
 * moves airplane mode (PROJECT.md §6) — so an agent that wants both set predictably sets
 * airplane mode first and wifi last.
 *
 * **What the after-state can and cannot tell you.** Both verbs answer with the state after
 * themselves, which is D12(c) and is the spine's own capture: the screen, or an honest
 * `unavailable` naming `canReadScreen` on a backend that cannot read one. It is evidence
 * that the device was still there and answering, **not** a reading of the radio — nothing in
 * `DeviceBackend` reads one back, so nothing here pretends to. Whether a status bar happens
 * to render an indicator is the device's own business, and the verbs are silent about it
 * rather than inviting the screen to be read as confirmation.
 *
 * A device-level refusal is still a rejected promise out of the backend rather than a
 * `VerbFailure`, so it reaches an agent as `internal_error`. That is the same pre-existing,
 * repo-wide gap every verb family shares; it is pinned by a test rather than papered over
 * here.
 */

import { capabilityMethod, type VerbContext } from './context.js';
import { performAction } from './perform.js';
import type { ActionResult } from './result.js';

/**
 * Put the device into airplane mode, or take it out of it.
 *
 * Idempotent as far as the device is concerned: asking for the state it is already in is a
 * call that succeeds, which is what lets a restoration set a resting state without reading
 * it first. See this module's header for why this is not a wifi switch in either direction.
 */
export async function setAirplaneMode(
	context: VerbContext,
	enabled: boolean,
): Promise<ActionResult> {
	return performAction(context, {
		verb: 'set_airplane_mode',
		requires: ['canControlNetwork'],
		act: async () => {
			const set = capabilityMethod(context, 'canControlNetwork', 'setAirplaneMode');
			await set(context.serial, enabled);
		},
	});
}

/**
 * Turn the device's wifi on or off.
 *
 * Honoured while airplane mode is on and never changes airplane mode itself (PROJECT.md §6),
 * which is what makes it the predictable half of the pair and the one to set last.
 */
export async function setWifi(context: VerbContext, enabled: boolean): Promise<ActionResult> {
	return performAction(context, {
		verb: 'set_wifi',
		requires: ['canControlNetwork'],
		act: async () => {
			const set = capabilityMethod(context, 'canControlNetwork', 'setWifiEnabled');
			await set(context.serial, enabled);
		},
	});
}
