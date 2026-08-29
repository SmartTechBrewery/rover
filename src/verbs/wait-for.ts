/**
 * The two screen waits — `wait_for` and `wait_until_gone` (PROJECT.md §4, "Waiting").
 *
 * This is the vocabulary that replaces `sleep` (D12(b), ai/RULES.md §2), and a replacement
 * is only worth having if it is strictly better than the thing it forbids. What makes it
 * better is that **every poll reads the screen again**. A wait built over one cached read
 * would answer from a screen the device has since moved on from — the stale-coordinate
 * failure D12(a) exists to remove, re-grown inside the vocabulary meant to remove it — and
 * it would be indistinguishable from a correct wait right up to the moment it mattered.
 *
 * Both verbs answer with the same `ActionResult` every other action answers with (D12(c)),
 * so a wait is not a special case the agent has to interpret differently: it names the
 * device, what it resolved, and the screen as it stands afterwards.
 *
 * The two live in one module because they are one question read two ways — *does anything
 * on a fresh read match this target* — and splitting them would leave two copies of the
 * screen summariser that answers "and what was there instead" when neither succeeds.
 *
 * Neither is a general condition wait. `src/core/wait.ts` holds that vocabulary, and a
 * condition that is not about the screen — an app reaching the foreground, a line in a log
 * — is added there as its own verb when something actually needs one (ai/RULES.md §2),
 * never as an escape hatch bolted onto these.
 */

import { requireCapability } from '../core/capabilities.js';
import { type Observation, waitForCondition } from '../core/wait.js';
import type { VerbContext } from './context.js';
import { describeElement, describeScreen, UnaddressableElementError } from './errors.js';
import { type ActionResult, type ResolvedTarget, resultAfterAction } from './result.js';
import { describeTarget, findOnScreen, resolveOnScreen, type ScreenTarget } from './target.js';

/**
 * How long a wait runs when the caller does not say.
 *
 * Seconds rather than minutes on purpose: a screen transition, a list load and a network
 * round trip are all seconds, and a default generous enough to cover a hung application
 * turns every genuine failure into a long one. A caller that knows better passes its own
 * `timeoutMs` — this is the value for the caller that does not.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

/**
 * How long to wait and how often to look — plain data, so both verbs stay callable across
 * the boundary that will carry them (D19, R21).
 *
 * `now` and `delay` are the seams `waitForCondition` declares, passed straight through and
 * injected only by tests: no test in this suite may wait on a real duration to prove
 * something about waiting. They are not a configuration surface, and nothing on the wire
 * will ever carry them.
 */
export interface WaitVerbOptions {
	/** Defaults to {@link DEFAULT_WAIT_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
	/** Defaults to the wait vocabulary's `DEFAULT_POLL_INTERVAL_MS` — the gap *between* two reads. */
	readonly pollIntervalMs?: number;
	/** Defaults to `Date.now`. Injected by tests, not a configuration surface. */
	readonly now?: () => number;
	/** Defaults to the wait vocabulary's own poll gap (`pause`). Injected by tests. */
	readonly delay?: (ms: number) => Promise<void>;
}

/**
 * Wait until `target` is on the screen and can be acted on, then answer with the state.
 *
 * The resolved target in the result is the one the last poll produced, so a `wait_for`
 * followed by a tap is not two answers about two different screens — though the tap still
 * resolves again, because that is D12(a) and this verb does not get to exempt it.
 */
export async function waitFor(
	context: VerbContext,
	target: ScreenTarget,
	options: WaitVerbOptions = {},
): Promise<ActionResult> {
	const resolved = await pollScreen<ResolvedTarget>(
		context,
		options,
		describeTarget(target),
		// Resolution rather than a bare match: a caller waiting for a button is waiting for
		// one it can touch, and an element whose rectangle has no interior is not one yet.
		async () => {
			try {
				const resolution = await resolveOnScreen(context, target);
				return resolution.resolved === null
					? { met: false, found: describeScreen(resolution.screen) }
					: { met: true, value: resolution.resolved };
			} catch (error) {
				// The one throw this loop reads as "not yet", and only this one. An element
				// clipped out of its scrolling container is a screen still moving — which is
				// what a wait is for — so failing on it would end a wait that one more poll
				// would have passed. Nothing is swallowed: if it never becomes addressable, the
				// timeout says so in those words. Everything else propagates unchanged, an
				// ambiguous target most of all — two elements matching one target is an
				// under-specified request, and no amount of further polling specifies it.
				if (error instanceof UnaddressableElementError) {
					return {
						met: false,
						found: `${describeElement(error.element)}, matching but ${reasonOf(error)}`,
					};
				}
				throw error;
			}
		},
	);

	return resultAfterAction(context, 'wait_for', resolved);
}

/**
 * Wait until nothing on the screen matches `target`, then answer with the state.
 *
 * "Gone" is *absent from a read taken now*, never *absent from the read we already had* —
 * which is the whole reason this exists rather than a caller checking once and sleeping.
 *
 * Presence is a match, not a resolution: an element matched twice is still there twice, so
 * this asks {@link findOnScreen} rather than the resolver, and neither an ambiguity nor a
 * midpoint that cannot be tapped stands between a caller and the answer it asked for.
 */
export async function waitUntilGone(
	context: VerbContext,
	target: ScreenTarget,
	options: WaitVerbOptions = {},
): Promise<ActionResult> {
	await pollScreen<null>(context, options, `${describeTarget(target)} to go away`, async () => {
		const { matches, screen } = await findOnScreen(context, target);
		return matches.length === 0
			? { met: true, value: null }
			: { met: false, found: describeScreen(screen) };
	});

	// A null target, because there is deliberately nothing left to name: what this verb
	// waited for is the *absence* of an element, and reporting the one it last saw would
	// describe a screen that has since stopped being true.
	return resultAfterAction(context, 'wait_until_gone', null);
}

/** Why an element that matched still has no point on it to act on, in three words. */
function reasonOf(error: UnaddressableElementError): string {
	return error.reason === 'clipped' ? 'clipped out of view' : 'centred off the screen';
}

/**
 * The shared half: assert the device can answer at all, then poll the probe to a deadline.
 *
 * The capability check is D11, and it is the verb's **own first statement** rather than
 * something the first read happens to raise on its way past. `capabilityMethod` would
 * throw the same `MissingCapabilityError` from inside poll one today, but only because
 * every probe here goes through it — and a probe is exactly the part of this module that
 * changes. A backend that cannot read its screen can never answer either verb, so it is
 * told so before the loop starts rather than by a poll that happens to ask the right
 * question.
 */
async function pollScreen<T>(
	context: VerbContext,
	options: WaitVerbOptions,
	what: string,
	probe: () => Promise<Observation<T>>,
): Promise<T> {
	requireCapability(context.manifest, 'canReadScreen', context.serial);

	return waitForCondition<T>({
		what,
		timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
		pollIntervalMs: options.pollIntervalMs,
		now: options.now,
		delay: options.delay,
		probe,
	});
}
