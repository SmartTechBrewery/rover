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
 * 2. **the target is resolved from a screen captured inside this call** (D12(a)), a miss
 *    naming what was on screen instead and two matches naming every candidate;
 * 3. **the state after the action is captured, after it** (D12(c)), and the result names
 *    the device and its density (D14).
 *
 * Skipping one of those is what a verb written against the backend directly does by
 * accident, which is why the backend's input methods are primitives and this is the layer
 * above them (`src/core/device.ts`, "The methods are **primitives**").
 */

import { type CapabilityId, requireCapability } from '../core/capabilities.js';
import type { VerbContext } from './context.js';
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

	const target =
		options.target === undefined
			? null
			: await requireTarget(context, options.target, options.resolve);

	await options.act(target);

	return resultAfterAction(context, options.verb, target);
}
