/**
 * The two read verbs that answer with nothing but the state itself — `read_screen` and
 * `device_info` (PROJECT.md §4, "Reading"; backlog row R13, phase 2).
 *
 * **Their `act` is empty, and that is the design rather than a gap.** Every other verb does
 * something to the device and then reports the state after it; these two ask for that state
 * and nothing else, and the spine already captures it — `captureAfterState()` reads the
 * screen and `resultAfterAction()` reads the device fresh, after the action, for every verb
 * there is (`./result.ts`). So the work of a read verb *is* the spine's own capture. Routing
 * these through {@link performAction} rather than around it costs one no-op call and is what
 * keeps "every verb answers the same way" true: a `read_screen` that assembled its own
 * `ActionResult` from a bare `backend.readScreen()` would be a second place deciding what an
 * answer looks like, and the first shape to drift from it.
 *
 * **`read_screen` declares `requires: ['canReadScreen']` and that declaration is the whole
 * verb.** Without it the call would still "work" on a backend that cannot read a screen —
 * the spine would answer `after: { kind: 'unavailable' }`, which is the honest thing for a
 * *tap* to say and the wrong thing here, because for this verb the after-state is not
 * context around an action, it is the entire answer. D11 says a verb with no backing fails
 * **loudly**, naming the capability, the device and the backend, and `requires` is what makes
 * that a `MissingCapabilityError` raised before anything is dispatched — not even a screen
 * read is attempted (`./perform.ts`). The difference between those two answers is this
 * phase's acceptance criterion, so `tests/unit/verbs/read.test.ts` asserts it directly.
 *
 * **`device_info` requires nothing, and says so with an explicit empty list.** `deviceInfo`
 * is a *required* method of `DeviceBackend` (`src/core/device.ts`) — every backend answers
 * it or is not a backend — so there is no capability to assert, exactly as the app verbs
 * have none (`./app.ts`). It is the one verb whose answer is `ActionResult.device` rather
 * than `ActionResult.after`: size, density, the computed width in dp and the OS version all
 * live in the `DeviceInfo` D14 already puts on *every* result. Nothing new is reported here;
 * what this verb adds is a way to ask for it without moving the device first.
 *
 * **Neither addresses anything on the screen**, so neither passes a `target` and both answer
 * `target: null` — a fact about the verb rather than a resolution that failed
 * (`PerformActionOptions.target`). A `read_screen` that took a target would be a wait
 * (`./wait-for.ts`), which is a different question with a different answer.
 *
 * `screenshot` is the third read verb and is phase 3: it is the one that cannot answer in the
 * shape above, because pixels are bytes rather than a state a result already carries (R24).
 */

import type { VerbContext } from './context.js';
import { performAction } from './perform.js';
import type { ActionResult } from './result.js';

/**
 * Read what is on the screen — the texts and the rectangles, in dp.
 *
 * The elements come back in `result.after`, which is the same after-state every other verb
 * reports and therefore the same shape an agent already knows how to read. On a backend that
 * does not declare `canReadScreen` this throws `MissingCapabilityError` before touching the
 * device at all, rather than answering with an empty screen — see this module's header.
 */
export async function readScreen(context: VerbContext): Promise<ActionResult> {
	return performAction(context, {
		verb: 'read_screen',
		requires: ['canReadScreen'],
		act: async () => {},
	});
}

/**
 * Ask the device what it is: model, screen size in both pixels and dp, density and OS
 * version.
 *
 * The answer is `result.device`, read fresh by the spine after the (empty) action rather
 * than taken from anything cached — a device that rotated since the last call reports the
 * dimensions it has now.
 */
export async function deviceInfo(context: VerbContext): Promise<ActionResult> {
	return performAction(context, {
		verb: 'device_info',
		requires: [],
		act: async () => {},
	});
}
