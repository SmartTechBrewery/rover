/**
 * The spine every verb that *acts on* a resolved target is built on — the one place D12's
 * three rules meet.
 *
 * The waits are the deliberate exception, and the only one: `waitFor` and `waitUntilGone`
 * (`./wait-for.ts`) reach {@link resultAfterAction} directly, because a spine that resolves
 * the target before running the action would resolve it before the wait had happened. They
 * share this module's answer shape rather than its order (`ai/ARCHITECTURE.md`, "The verb
 * layer").
 *
 * A verb hands {@link performAction} what it needs, what it is aimed at and what it does;
 * the order below is not the verb author's to choose:
 *
 * 1. **the manifest is consulted before anything is dispatched** (D11) — an undeclared
 *    capability is a `MissingCapabilityError` naming capability, device and backend, and
 *    the backend is not touched at all, not even for the screen read;
 * 2. **the application in front is checked, when the caller named one** (#332), from a
 *    `deviceInfo` read taken inside this call (D12(a)) — a different application, or a device
 *    that cannot say, is an `AppNotInForegroundError` and nothing is dispatched;
 * 3. **the target is resolved from a screen captured inside this call** (D12(a)), a miss
 *    naming what was on screen instead and two matches naming every candidate;
 * 4. **the state after the action is captured, after it** (D12(c)), and the result names
 *    the device and its density (D14).
 *
 * Skipping one of those is what a verb written against the backend directly does by
 * accident, which is why the backend's input methods are primitives and this is the layer
 * above them (`src/core/device.ts`, "The methods are **primitives**").
 */

import { type CapabilityId, requireCapability } from '../core/capabilities.js';
import type { AppId } from '../core/ids.js';
import type { VerbContext } from './context.js';
import { AppNotInForegroundError } from './errors.js';
import type { ResolvedTarget } from './result.js';
import { type ActionResult, resultAfterAction } from './result.js';
import { type ResolveOptions, requireTarget, type Target } from './target.js';

export interface PerformActionOptions {
	/** The verb's own name, as the agent asked for it — `tap`, not the method underneath. */
	readonly verb: string;
	/**
	 * The capabilities this verb needs, asserted before any of it runs.
	 *
	 * Required rather than optional, and an empty list is a legitimate answer for a verb
	 * built only on required interface methods. An optional field would be one a verb author
	 * can leave off, and a capability check nobody is forced into is the one D11 says this
	 * must not be.
	 */
	readonly requires: readonly CapabilityId[];
	/**
	 * What the verb is aimed at, if anything. Absent for a verb that addresses no element —
	 * a key press, a screen read — which is a fact about the verb, not a resolution that
	 * failed.
	 */
	readonly target?: Target;
	/**
	 * How that target is resolved, for the one verb whose spine target is not where its touch
	 * starts.
	 *
	 * Absent means the default, which is what every verb aimed at a point it then touches wants:
	 * the resolved point is checked against the on-screen keyboard. `scroll` is the exception —
	 * its spine target is a *region*, and the point it actually drags from is computed a quarter
	 * into that region rather than taken from its centre (`./input.ts`), so the centre is a
	 * coordinate no touch lands on and refusing it by the keyboard would be a false explanation
	 * of a gesture the keyboard was never in the way of (#318 review). It passes
	 * `touchStartsHere: false` and checks its own computed start instead.
	 *
	 * Deliberately narrow: this forwards {@link ResolveOptions} and nothing else, so a verb can
	 * only turn off a check that does not apply to it, never add one the spine does not make.
	 */
	readonly resolve?: ResolveOptions;
	/**
	 * The application the caller expects in the foreground, if it named one (#332).
	 *
	 * Checked after the manifest and **before the target is resolved**: when the application
	 * has gone, a target inside it would otherwise fail as `target-not-found` listing the
	 * launcher's elements, which names the symptom rather than the cause. Absent means no check
	 * and no extra device query — the verb acts on whatever is in front, as it always has.
	 */
	readonly expectApp?: AppId;
	/** The action itself, handed the point that was resolved for it. */
	readonly act: (target: ResolvedTarget | null) => Promise<void>;
}

/**
 * Run one action against one device and answer with the state after it.
 *
 * The capability assertions come first so a device that cannot do this is refused before a
 * screen is read or an element is looked for: the answer is the same either way, and doing
 * the work first would spend a screen read to reach it.
 */
export async function performAction(
	context: VerbContext,
	options: PerformActionOptions,
): Promise<ActionResult> {
	for (const capability of options.requires) {
		requireCapability(context.manifest, capability, context.serial);
	}

	if (options.expectApp !== undefined) {
		await requireForegroundApp(context, options.verb, options.expectApp);
	}

	const target =
		options.target === undefined
			? null
			: await requireTarget(context, options.target, options.resolve);

	await options.act(target);

	return resultAfterAction(context, options.verb, target);
}

/**
 * Refuse unless the device names `expectApp` as the application in front.
 *
 * A fresh `deviceInfo` read, never a value remembered from an earlier answer (D12(a)), and a
 * required backend method, so this needs no capability and works on a device that cannot read
 * its screen. `null` refuses too: it means the device did not answer, and an expectation that
 * could not be checked is not one that held.
 *
 * One read moments before the gesture, so an application that dies between the two is not
 * caught here — the after-state's `device.foregroundApp` reports where the gesture went.
 */
async function requireForegroundApp(
	context: VerbContext,
	verb: string,
	expectApp: AppId,
): Promise<void> {
	const { foregroundApp } = await context.backend.deviceInfo(context.serial);
	if (foregroundApp !== expectApp) {
		throw new AppNotInForegroundError(context.serial, verb, expectApp, foregroundApp);
	}
}
