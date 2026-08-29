/**
 * The wait vocabulary: polling a condition with a deadline (D12(b), ai/RULES.md §2).
 *
 * **This is the only module in the repository that constructs a timer-backed delay**, and
 * `tests/unit/no-sleep.test.ts` is the gate that keeps it that way — a convention nobody is
 * forced onto is the one ai/RULES.md §2 says this must not be. Everywhere else, a wait is
 * this module's; if the condition you want is missing, add it here.
 *
 * {@link pause} is never awaited *instead of* a check, only **between two checks**. The
 * distinction is the whole rule: what ends a wait is the condition being met, and the timer
 * exists only to keep the loop from spinning a core in the meantime.
 */

import { WaitTimeoutError } from './errors.js';

/** The gap between checks when a caller does not name one. */
export const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * What one check saw.
 *
 * The unmet branch **requires** `found`, and that is the load-bearing decision in this
 * file: it makes "and what it found instead" impossible to forget rather than a rule a
 * probe author has to remember. ai/CODING_STANDARDS.md asks every timeout to carry it, and
 * a type is the only version of that ask nobody can skip.
 */
export type Observation<T> =
	| { readonly met: true; readonly value: T }
	| { readonly met: false; readonly found: string };

export interface WaitOptions<T> {
	/** What is being waited for, in the caller's words — the first half of the timeout message. */
	readonly what: string;
	readonly timeoutMs: number;
	readonly probe: () => Observation<T> | Promise<Observation<T>>;
	/** Defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
	readonly pollIntervalMs?: number;
	/**
	 * Defaults to `Date.now`. Injected so a test can move time by hand — a real clock and a
	 * five-second timeout cannot both be in the same unit test (mirrors `LeaseStoreOptions`).
	 */
	readonly now?: () => number;
	/** Defaults to {@link pause}. Injected by tests, not a configuration surface. */
	readonly delay?: (ms: number) => Promise<void>;
}

/**
 * Check `probe` until it reports the condition met, then answer with its value.
 *
 * Probes **before** any delay, so a condition that is already true costs one check and no
 * wait at all, and `timeoutMs: 0` still checks exactly once — zero milliseconds is a check,
 * not zero checks. The gap before the next check is clamped to what is left of the
 * deadline, so a wait never overshoots its own timeout by a poll interval.
 *
 * A probe that throws propagates **unchanged**. A device that broke is not a timeout, and
 * wrapping it would tell the agent the opposite of what happened.
 */
export async function waitForCondition<T>(options: WaitOptions<T>): Promise<T> {
	const { what, timeoutMs, probe } = options;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const now = options.now ?? Date.now;
	const delay = options.delay ?? pause;

	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new Error(`waitForCondition needs a finite, non-negative timeoutMs, got ${timeoutMs}`);
	}
	if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
		throw new Error(
			`waitForCondition needs a finite, positive pollIntervalMs, got ${pollIntervalMs}`,
		);
	}

	const deadline = now() + timeoutMs;
	let polls = 0;
	let found = 'nothing';

	for (;;) {
		const observation = await probe();
		polls += 1;
		if (observation.met) {
			return observation.value;
		}
		found = observation.found;

		const remainingMs = deadline - now();
		if (remainingMs <= 0) {
			throw new WaitTimeoutError(what, found, timeoutMs, polls);
		}
		await delay(Math.min(pollIntervalMs, remainingMs));
	}
}

/**
 * The gap between two checks. Never a wait *instead of* a check (ai/RULES.md §2, D12).
 *
 * The timer is deliberately **not** `unref()`ed: a wait in progress is work the process
 * owes, and an unreferenced poll gap would let the process exit mid-wait as if the
 * condition had been answered. (Contrast the deadline timers in `src/daemon/listen.ts` and
 * `src/daemon/restore.ts`, which *are* unreferenced — those exist to stop waiting.)
 */
export function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
