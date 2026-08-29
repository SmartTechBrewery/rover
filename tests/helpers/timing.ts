/**
 * Two primitives for tests that have to say *when* something happened without waiting on a
 * duration (ai/RULES.md §2, D12): a gate the test opens by hand, and a way to let the event
 * loop run itself dry.
 *
 * {@link createGate} is how a suite waits for the code under test to reach a point — the
 * first screen read, the restoration's first device step — rather than for a stretch of time
 * in which it probably got there. {@link drainEventLoop} is the other half: the claim "the
 * daemon has *not* answered that grant" is only worth making once everything that could have
 * answered it already ran, so what is still pending afterwards is pending on something the
 * test itself is holding — which is the assertion.
 */

import { pause } from '@/core/wait.js';

/**
 * How many turns to give the loop before concluding that what is left is genuinely blocked.
 * An order of magnitude more than the handful of filesystem calls and microtask hops any of
 * these suites has outstanding.
 */
const LOOP_DRAIN_TURNS = 50;

/** A promise the test resolves by hand, so nothing waits on a duration. */
export function createGate(): { reached: Promise<void>; reach: () => void } {
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	return { reached, reach };
}

/**
 * Yield until everything already scheduled has run — timers, I/O callbacks and the microtasks
 * they queue, repeatedly, because each turn can schedule the next.
 */
export async function drainEventLoop(): Promise<void> {
	for (let turn = 0; turn < LOOP_DRAIN_TURNS; turn += 1) {
		await new Promise((resolve) => setImmediate(resolve));
		await pause(0);
	}
}
