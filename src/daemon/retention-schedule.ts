/**
 * The clock trigger: one full pass of the retention policy at local midnight, and one at daemon
 * start (§9.4, D38, `./archive-sweep.ts`).
 *
 * **Both bounds**, unlike the budget-only pass a lease's end runs (D37): this is the trigger the
 * *age* limit was waiting for, and a host nobody types a command on now enforces the whole policy
 * by itself.
 *
 * **Pure scheduling.** It holds when the pass last ran and the timer handle, and nothing else —
 * what a pass *does* is entirely `./archive-sweep.ts`'s, which is what lets the clock arithmetic
 * below be a unit test with an injected `now` and an injected timer rather than a suite that waits
 * for a day to pass.
 *
 * **The pass does not trust the timer to have fired on time, and that is the load-bearing
 * decision.** Before sweeping it compares the clock against when it last ran, and a fire that
 * arrives with less than a local day behind it re-arms without sweeping. Two things make that
 * necessary rather than defensive: a host suspended over midnight resumes with a timer that is
 * late by however long the lid was shut, and a machine that was switched off has no timer at all —
 * which is what the **start pass** answers, because a developer's Mac with phones on it is asleep
 * most nights. **Whether a Node timer survives macOS sleep is deliberately not measured**: the
 * comparison is what makes the answer not matter, and measuring it would only tell us which of two
 * paths this module already handles was the one taken.
 *
 * **DST produces neither two passes nor none**, and it takes both halves of the arrangement to get
 * that. Arming is always *from now to the next local midnight*, resolved by `Date`'s own local-time
 * accessors, so the zone's rules — including a shift — decide the instant rather than any offset
 * arithmetic here. And the guard is a **local** day rather than 24 hours: the day a zone springs
 * forward is 23 hours long, so `now - lastRun >= 86_400_000` would refuse the pass that day and
 * skip it, while the day it falls back holds `00:00` twice and a naive re-arm would take both.
 * Comparing against {@link nextLocalMidnightMs} of the last run's own instant is one function
 * answering both, and it is the same function the arming uses.
 *
 * **No sleep** (`ai/RULES.md` §2, D12(b)). A timer handed a callback that does the next thing is a
 * deadline, which is the opposite of a delay awaited *instead of* a check — `src/core/wait.ts` is
 * still the only module here that constructs one of those, and this needs no entry on
 * `NO_SLEEP_EXEMPT_FILES` or `NO_SLEEP_PAUSE_CALLERS`.
 *
 * **The two triggers cannot overlap**, and nothing here arranges that: sweeps of one tree are
 * serialised by the root inside `./archive-sweep.ts`, so a lease ending in the middle of a
 * scheduled pass queues behind it and answers about the tree that pass left.
 */

import type { ArchiveSweeper } from './archive-sweep.js';

/** The clock trigger, started by the winner of the bind and stopped first on the way out. */
export interface RetentionSchedule {
	/**
	 * Run the start pass and arm the next one. Called once, by `./listen.ts`'s `running()`.
	 *
	 * The pass is **not** awaited — nothing about a daemon coming up waits for a walk of the
	 * archive, exactly as nothing about a release does (D37). A shutdown does wait for it, through
	 * the sweeper's own `settle()`.
	 */
	start(): void;
	/** Disarm. Safe to call without a {@link RetentionSchedule.start}, and safe to call twice. */
	stop(): void;
}

export interface RetentionScheduleOptions {
	/**
	 * The one sweeper this host has (`./listen.ts`), so the scheduled pass, the pass a lease's end
	 * runs and a `sweep_archive` an operator called all share the serialisation that keeps two
	 * sweeps off one tree.
	 */
	readonly sweeper: ArchiveSweeper;
	/**
	 * Defaults to `Date.now`. Injected so a test can move a midnight — or a suspended weekend —
	 * by hand, which is `LeaseStoreOptions.now`'s reason: a real clock and a daily pass cannot
	 * both be in the same unit test.
	 */
	readonly now?: () => number;
	/**
	 * Where a pass that failed is reported. Defaults to `console.warn`, the daemon's own stderr —
	 * `./archive-sweep.ts`'s own default, and for its reason.
	 */
	readonly warn?: (message: string) => void;
	/**
	 * How the next pass is armed, answering the function that disarms it. Defaults to an
	 * `unref()`ed `setTimeout` ({@link armUnrefedTimer}).
	 *
	 * A seam for the unit test and not a configuration surface: it is the only way to assert what
	 * this module is actually about — that a fire is *paced* rather than trusted — without a
	 * suite that waits for midnight.
	 */
	readonly armTimer?: (onFire: () => void, msFromNow: number) => () => void;
	/**
	 * The local calendar this schedule paces itself by. Defaults to {@link nextLocalMidnightMs}.
	 *
	 * The second half of the same seam, and it exists because the zone cannot be moved from
	 * inside a test: `Date`'s local accessors read the process's timezone, and a `TZ` assigned at
	 * runtime does **not** take effect in a Vitest worker thread — the reset Node performs when
	 * `process.env.TZ` is written is not installed there. So a suite that has to prove a
	 * twenty-three-hour local day gets one pass rather than none injects the day; the zone
	 * resolution itself is asserted on {@link nextLocalMidnightMs} directly, as properties that
	 * hold in whatever zone the suite happens to run in.
	 */
	readonly nextMidnightMs?: (fromMs: number) => number;
}

/**
 * The next local midnight strictly after `fromMs`.
 *
 * `Date`'s local-time accessors and nothing else: the platform resolves `00:00` tomorrow through
 * the local zone's own rules, so a day that is 23 or 25 hours long needs no special case, and a
 * `00:00` that does not exist at all (a zone springing forward at midnight) resolves forward to
 * the instant that would have been it. **No zone maths by hand and no offset arithmetic** — every
 * bug this function could have is one of those two.
 */
export function nextLocalMidnightMs(fromMs: number): number {
	const from = new Date(fromMs);
	return new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, 0, 0, 0, 0).getTime();
}

/**
 * A `setTimeout` that does not hold the process open, which is every timer in the daemon's own
 * rule (`./listen.ts`): this exists to notice a midnight while the host is serving, never to keep
 * a process alive that is otherwise finished.
 */
function armUnrefedTimer(onFire: () => void, msFromNow: number): () => void {
	const timer = setTimeout(onFire, msFromNow);
	timer.unref();
	return () => clearTimeout(timer);
}

export function createRetentionSchedule(options: RetentionScheduleOptions): RetentionSchedule {
	const now = options.now ?? Date.now;
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const armTimer = options.armTimer ?? armUnrefedTimer;
	const nextMidnightMs = options.nextMidnightMs ?? nextLocalMidnightMs;

	/** When the last pass *started*, or `undefined` until the start pass has. */
	let lastRunMs: number | undefined;
	let disarm: (() => void) | undefined;

	// Host state that dies with the host, deliberately (D6, D38): a stamp on disk would be state
	// the daemon cannot re-derive, and what covers a restart is the start pass rather than a
	// memory of the last one.

	function arm(msFromNow: number): void {
		// Disarmed first, so a second `start()` — or an `onFire` that re-armed twice — can never
		// leave a handle nothing holds. `Math.max(1, …)` because a target already behind us is a
		// fire on the next turn, not a negative timer.
		disarm?.();
		disarm = armTimer(onFire, Math.max(1, msFromNow));
	}

	function armFromNow(): void {
		const at = now();
		arm(nextMidnightMs(at) - at);
	}

	function pass(): void {
		// Recorded when the pass *starts* rather than when it finishes, so a walk that takes a
		// second cannot let the next fire through as though nothing had run.
		lastRunMs = now();
		// `bounds: 'both'` — the whole policy, which is what makes this the age limit's trigger.
		// Every filesystem failure is already an outcome rather than a throw (`./archive-sweep.ts`),
		// so nothing is expected to reach this `catch`; it is here because a pass that failed must
		// take neither the daemon nor the schedule with it. One line on the host's log, and the next
		// midnight tries again.
		void options.sweeper.sweep({ dryRun: false, bounds: 'both' }).catch((error: unknown) => {
			warn(
				`The artifact archive was not swept on this host's scheduled pass: ` +
					`${error instanceof Error ? error.message : String(error)}. Nothing else about the ` +
					`daemon failed and the schedule is unchanged — the archive is one pass behind, and ` +
					`the next local midnight, the next lease to end here, or 'rover sweep' will take it.`,
			);
		});
	}

	function onFire(): void {
		disarm = undefined;
		// The instant this fire is *for*: the first local midnight after the last pass. Before the
		// start pass there is nothing to be late for, so any fire is due.
		const dueAtMs = lastRunMs === undefined ? now() : nextMidnightMs(lastRunMs);
		if (now() >= dueAtMs) {
			pass();
			// From *now*, not from the target: a fire hours late must not chain its lateness into
			// every pass after it, and re-arming from now is half of what keeps DST to one pass.
			armFromNow();
			return;
		}
		// Not due — and this is the whole reason the comparison exists rather than an assertion.
		// A fire can arrive early because `setTimeout` counts on a monotonic clock while this
		// compares a wall clock the host may have adjusted under it, and a wall-clock `00:00` can
		// occur twice on one local day. Re-armed for what is left of the gap rather than for the
		// midnight after it, so an early fire costs one more timer and never a skipped day.
		arm(dueAtMs - now());
	}

	return {
		start(): void {
			// Unconditional, and it is the point of this half: a host that was asleep or switched
			// off at midnight has no late timer to arrive at all, so coming up *is* the trigger.
			pass();
			armFromNow();
		},
		stop(): void {
			disarm?.();
			disarm = undefined;
		},
	};
}
