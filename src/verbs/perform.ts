/**
 * The spine every verb is built on — the one place D12's three rules meet.
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
import { type ActionResult, ActionResultSchema, captureAfterState } from './result.js';
import { requireTarget, type Target } from './target.js';

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

	const target = options.target === undefined ? null : await requireTarget(context, options.target);

	await options.act(target);

	// Past this line the action has happened, so the after-state is captured rather than
	// risked: `captureAfterState` answers a `failed` branch instead of throwing, because an
	// exception here would take the whole result with it and leave the agent unable to tell
	// whether the action landed — the one thing D12(c) exists to rule out.
	const after = await captureAfterState(context);

	// `deviceInfo` is read again, after the action, and is deliberately *not* the value
	// target resolution used: an action can rotate the device, and a result pairing
	// post-action elements with pre-action screen dimensions describes a coordinate space
	// that never existed. It is also the one call here that may throw, and rightly — D14
	// makes the device half of a result mandatory, so a device that can no longer say what
	// it is has nothing left to report an action about.
	const device = await context.backend.deviceInfo(context.serial);

	return ActionResultSchema.parse({ verb: options.verb, device, target, after });
}
