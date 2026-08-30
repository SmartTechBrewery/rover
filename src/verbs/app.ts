/**
 * The app-lifecycle verbs — `launch_app`, `stop_app` and `clear_app_data` (PROJECT.md §4,
 * "Apps"; backlog row R15, phase 1).
 *
 * Like the gestures (`./input.ts`), each of these is one {@link performAction} call and none
 * of them reads a screen itself, so D12 holds for them by construction. What is different
 * here is what they are aimed at and what they need, and both differences are the point:
 *
 * **`requires: []` is the honest answer, not an omission.** `launchApp`, `stopApp` and
 * `clearAppData` are *required* methods on `DeviceBackend` (`src/core/device.ts`), so there
 * is no capability to assert — a `canControlApps` flag would be one that is always true,
 * which is exactly the noise `src/core/capabilities.ts` warns against. The spine is still the
 * entry point, because it is what captures the state after the action (D12(c)) and names the
 * device and its density in the answer (D14).
 *
 * **These verbs address a package, not something on the screen.** So they pass no `target` at
 * all: no screen is read before the action and `ActionResult.target` is `null`, the same
 * answer a `scroll` with no region already gives. That is a fact about the verb rather than a
 * resolution that failed, and `PerformActionOptions.target` documents the distinction.
 *
 * **They reach `context.backend` directly rather than through `capabilityMethod()`**, which
 * is the one place this family departs from `./input.ts`. `capabilityMethod` is typed over
 * the capability-gated methods and these three are not gated; the type saying so is the
 * design working, not an obstacle to route around.
 *
 * **`stop_app` cannot tell "stopped it" from "there was no such package".** At least one
 * platform's stop command succeeds silently in both cases (PROJECT.md §5 and §6, and the
 * backend that drives it says so), so the verb answers `ok` for a package the device never
 * had. What settles it is the after-state, once `read_screen` (#13) lands; until then the
 * after-state is an honest `unavailable`, and there is deliberately no probe here pretending
 * otherwise.
 *
 * A device-level refusal — `launch_app` on a package that is not installed — is still a
 * rejected promise out of the backend rather than a `VerbFailure`, so it reaches an agent as
 * `internal_error`. That is a pre-existing, repo-wide gap shared by every verb family rather
 * than anything this one introduced; it is pinned by a test rather than papered over here.
 *
 * `install_app`, `pull_file`, `push_file` and `read_logs` are the rest of R15 and are their
 * own issues: the first three are a byte-transfer concern (R24) and the last needs a backend
 * method that does not exist yet.
 */

import type { AppId } from '../core/ids.js';
import type { VerbContext } from './context.js';
import { performAction } from './perform.js';
import type { ActionResult } from './result.js';

/**
 * Bring an app to the foreground, launching it if it is not already running.
 *
 * Launching one that is already the top-most instance is a launch that succeeded, not an
 * error — the backend records what the device says about that case.
 */
export async function launchApp(context: VerbContext, appId: AppId): Promise<ActionResult> {
	return performAction(context, {
		verb: 'launch_app',
		requires: [],
		act: async () => {
			await context.backend.launchApp(context.serial, appId);
		},
	});
}

/**
 * Stop an app, including every process it has running.
 *
 * See this module's header for what this verb cannot tell you: a package the device does not
 * have is stopped exactly as silently as one it does.
 */
export async function stopApp(context: VerbContext, appId: AppId): Promise<ActionResult> {
	return performAction(context, {
		verb: 'stop_app',
		requires: [],
		act: async () => {
			await context.backend.stopApp(context.serial, appId);
		},
	});
}

/**
 * Delete an app's data, putting it back to the state a fresh install is in.
 *
 * Destructive by definition and on purpose — it is how a test gets a known starting point —
 * which is why the app id is a parsed {@link AppId} the whole way down rather than a string
 * a backend assembles a device-side command out of.
 */
export async function clearAppData(context: VerbContext, appId: AppId): Promise<ActionResult> {
	return performAction(context, {
		verb: 'clear_app_data',
		requires: [],
		act: async () => {
			await context.backend.clearAppData(context.serial, appId);
		},
	});
}
