/**
 * The three read verbs — `read_screen`, `device_info` and `screenshot` (PROJECT.md §4,
 * "Reading"; backlog row R13, phases 2 and 3).
 *
 * **Two of the three have an empty `act`, and that is the design rather than a gap.** Every
 * other verb does something to the device and then reports the state after it; `read_screen`
 * and `device_info` ask for that state
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
 * **`screenshot` is the one read whose answer is not a state the result already carries**,
 * because pixels are bytes. It is on the same spine and needs no capability either —
 * `screenshot` is a *required* backend method (`src/core/device.ts`) — and what it adds is
 * an `act` that does something and an `ActionResult.artifact` attached to the spine's
 * answer afterwards. The bytes never become a path on the host (D19): `artifactFrom` encodes
 * them and refuses one too large for a single answer by name, so an oversized capture is a
 * failure an agent can read rather than a picture cut short (`./result.ts`).
 *
 * **None of the three addresses anything on the screen**, so none passes a `target` and all
 * answer `target: null` — a fact about the verb rather than a resolution that failed
 * (`PerformActionOptions.target`). A `read_screen` that took a target would be a wait
 * (`./wait-for.ts`), which is a different question with a different answer.
 */

import type { VerbContext } from './context.js';
import { performAction } from './perform.js';
import { type ActionResult, ActionResultSchema, type Artifact, artifactFrom } from './result.js';

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

/**
 * Capture the screen as an image.
 *
 * The bytes come back on `result.artifact`, base64-encoded, together with what kind of image
 * they are and how many bytes they decode to. **Never a path**: the capture happens on the
 * host and the answer is read wherever the agent is, so a filesystem location would name a
 * file that is not there — or, worse, one that is (D19). Somewhere to put them is the
 * client's decision and the client's disk.
 *
 * A capture larger than one answer can carry is refused by name — `artifact-too-large`,
 * carrying the size and the bound — rather than trimmed to fit. See `./result.ts` for why
 * truncation is the failure worth spending a branch on.
 *
 * **A black image is a true answer about the device, not a failed capture.** An application
 * can block screen capture, and the system then hands back a valid, entirely black image
 * with nothing in any log to say so (PROJECT.md §6). Nothing here judges the pixels,
 * because at this layer a black screen and a blocked one are the same bytes. The check that
 * separates them, when it matters, is to capture the **system home screen**: black there is
 * a broken device, black only inside the application is that application blocking capture.
 * And `read_screen` is the read that survives the block — the hierarchy stays fully readable
 * while the pixels are gone — so it is what to reach for on a screen this verb cannot see.
 */
export async function screenshot(context: VerbContext): Promise<ActionResult> {
	let captured: Artifact | null = null;

	const result = await performAction(context, {
		verb: 'screenshot',
		requires: [],
		act: async () => {
			// Encoded here, inside the action, so a capture too large to answer with refuses
			// before the spine spends a screen read reaching the same refusal.
			captured = artifactFrom(context.serial, await context.backend.screenshot(context.serial));
		},
	});

	// Re-parsed rather than spread and returned, so the artifact is held to the same schema
	// the spine's own answer was — this is the one verb assembling part of a result itself.
	return ActionResultSchema.parse({ ...result, artifact: captured });
}
