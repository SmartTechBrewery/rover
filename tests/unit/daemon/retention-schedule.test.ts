/**
 * The clock trigger — one full pass at local midnight, one at daemon start, and neither trusted
 * to the timer (§9.4, D38, #246).
 *
 * **An injected `now` and an injected timer, so nothing here waits for anything.** The subject is
 * arithmetic over instants — is this fire the one it was armed for, and when is the next one — and
 * a suite that waited for a real midnight could assert none of it. That is `LeaseStoreOptions.now`'s
 * seam and `archive-sweep.test.ts`'s, one step further: the timer is a seam too, because *paced
 * rather than trusted* is only observable if the test is the thing that fires it.
 *
 * The claims are the ones the row was written for and a reviewer would otherwise take on trust: a
 * pass happens at start and asks for **both** bounds, unlike the budget-only pass a lease's end
 * runs; a fire that is not due sweeps nothing and still re-arms; a fire days late — the host that
 * was suspended — sweeps; a local day of twenty-five hours and one of twenty-three each produce
 * exactly one pass; a failed pass takes neither the daemon nor the schedule with it; `stop()`
 * leaves nothing armed; and the scheduled pass cannot overlap the one a lease's end starts.
 *
 * **The zone is asserted in two halves, because it cannot be moved from in here.** `Date`'s local
 * accessors read the process timezone and a `TZ` written at runtime does not take effect in a
 * Vitest worker thread, so pinning one zone is not available and letting the ambient one decide
 * would make every DST assertion vacuous on a UTC runner. So: {@link nextLocalMidnightMs} is
 * asserted directly, as properties that hold in *any* zone — a year of steps that land exactly on
 * the year's end, each one twenty-three, twenty-four or twenty-five hours — and the schedule's
 * behaviour on such a day is asserted with the day injected
 * (`RetentionScheduleOptions.nextMidnightMs`).
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	type ArchiveSweeper,
	createArchiveSweeper,
	sweepAfterLease,
} from '@/daemon/archive-sweep.js';
import {
	createRetentionSchedule,
	nextLocalMidnightMs,
	type RetentionSchedule,
} from '@/daemon/retention-schedule.js';
import { createMockLease } from '../../helpers/factories.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

/** A fixed instant, so no assertion here depends on the wall clock. */
const NOON_MS = Date.UTC(2026, 8, 8, 12, 0, 0);

/** What one pass asked the sweeper for. */
interface Request {
	readonly dryRun: boolean;
	readonly bounds: string;
}

/** The whole policy, which is what every pass this module starts must ask for. */
const WHOLE_POLICY: Request = { dryRun: false, bounds: 'both' };

/**
 * The timer the schedule is handed, as something a test fires by hand.
 *
 * Every arming is recorded rather than only the live one, so *re-armed after a fire that swept
 * nothing* is assertable: that claim is about a timer existing, and a handle nobody kept would
 * make it unobservable.
 */
function createTestTimer() {
	const armings: { readonly msFromNow: number; disarmed: boolean }[] = [];
	let live: { readonly onFire: () => void; readonly at: number } | undefined;

	return {
		armings,
		/** What the schedule is handed as `armTimer`. */
		armTimer(onFire: () => void, msFromNow: number): () => void {
			const at = armings.length;
			armings.push({ msFromNow, disarmed: false });
			live = { onFire, at };
			return () => {
				const arming = armings[at];
				if (arming) {
					arming.disarmed = true;
				}
				if (live?.at === at) {
					live = undefined;
				}
			};
		},
		/** Whether anything is armed right now. */
		get armed(): boolean {
			return live !== undefined;
		},
		/** The gap the live arming was made with. */
		get pendingMs(): number | undefined {
			return live === undefined ? undefined : armings[live.at]?.msFromNow;
		},
		/** Fire what is armed, as the platform would. */
		fire(): void {
			const firing = live;
			if (!firing) {
				throw new Error('nothing is armed — the schedule was expected to have armed a pass');
			}
			live = undefined;
			firing.onFire();
		},
	};
}

/** A sweeper that records what it was asked for and touches no disk. */
function recordingSweeper(asked: Request[]): ArchiveSweeper {
	return {
		sweep: async (request) => {
			asked.push({ dryRun: request.dryRun, bounds: request.bounds });
			return { outcome: 'missing' as const };
		},
		// This schedule asks for a sweep and nothing else — a project the operator deleted by name
		// is `./delete-project.ts`'s trigger on the same module (D42), never the clock's.
		removeProject: async () => ({ outcome: 'absent' as const }),
		settle: () => Promise.resolve(),
	};
}

describe('the pass at daemon start', () => {
	/*
	 * **The half of the row that covers a machine that was off.** A host asleep at midnight has a
	 * late timer at best and none at all if it was shut down, so coming up is itself the trigger —
	 * unconditionally, because there is nothing yet for a comparison to be about.
	 */
	it('runs immediately, and asks for both bounds', () => {
		const asked: Request[] = [];
		const timer = createTestTimer();

		createRetentionSchedule({
			sweeper: recordingSweeper(asked),
			now: () => NOON_MS,
			armTimer: timer.armTimer,
		}).start();

		// `bounds: 'both'` is the whole difference from the pass a lease's end runs (D37): this is
		// the age limit's trigger, and a budget-only pass here would leave it with none.
		expect(asked).toEqual([WHOLE_POLICY]);
		expect(timer.armed).toBe(true);
	});

	it('arms the next pass for the coming local midnight rather than a fixed day', () => {
		const timer = createTestTimer();

		createRetentionSchedule({
			sweeper: recordingSweeper([]),
			now: () => NOON_MS,
			armTimer: timer.armTimer,
		}).start();

		expect(timer.pendingMs).toBe(nextLocalMidnightMs(NOON_MS) - NOON_MS);
		// And that gap is inside a day whatever zone this suite runs in: a start pass at noon is
		// never a whole day away from the next midnight.
		expect(timer.pendingMs).toBeGreaterThan(0);
		expect(timer.pendingMs).toBeLessThanOrEqual(DAY_MS);
	});
});

describe('a fire the schedule does not trust', () => {
	/*
	 * **The comparison, which is what makes the timer's accuracy irrelevant.** A fire arriving
	 * before the midnight it was armed for — a wall clock the host adjusted under a monotonic
	 * timer, or a `00:00` that occurred twice — must not spend a walk of the archive, and must not
	 * leave the schedule unarmed either.
	 */
	it('sweeps nothing when the midnight it was armed for has not arrived, and re-arms anyway', () => {
		const asked: Request[] = [];
		const timer = createTestTimer();
		let nowMs = NOON_MS;

		createRetentionSchedule({
			sweeper: recordingSweeper(asked),
			now: () => nowMs,
			armTimer: timer.armTimer,
		}).start();
		expect(asked).toHaveLength(1);

		nowMs += HOUR_MS;
		timer.fire();

		expect(asked).toHaveLength(1);
		// Re-armed for what is left of the gap rather than for the midnight after it: an early
		// fire costs one more timer and never a skipped day.
		expect(timer.armed).toBe(true);
		expect(timer.pendingMs).toBe(nextLocalMidnightMs(NOON_MS) - nowMs);
	});

	/*
	 * **The suspended-host case, and the one this row exists for.** A developer's Mac with phones
	 * on it is asleep most nights and resumes with a timer late by however long the lid was shut.
	 * Whether a Node timer survives macOS sleep is deliberately **not** measured — this assertion
	 * is what makes the answer not matter.
	 */
	it('sweeps when the fire is days late', () => {
		const asked: Request[] = [];
		const timer = createTestTimer();
		let nowMs = NOON_MS;

		createRetentionSchedule({
			sweeper: recordingSweeper(asked),
			now: () => nowMs,
			armTimer: timer.armTimer,
		}).start();

		nowMs += 4 * DAY_MS;
		timer.fire();

		expect(asked).toEqual([WHOLE_POLICY, WHOLE_POLICY]);
		// Re-armed from *now* and not from the target it missed: a fire four days late must not
		// chain its lateness into every pass after it.
		expect(timer.pendingMs).toBe(nextLocalMidnightMs(nowMs) - nowMs);
	});
});

describe('the next local midnight', () => {
	/*
	 * **Zone resolution is the platform's, and this is what asserts it without naming a zone.**
	 * `TZ` cannot be moved from inside a Vitest worker thread (see `RetentionScheduleOptions`), so
	 * rather than pinning one zone this walks a whole year of local midnights and asserts the
	 * properties that hold in *every* zone: each answer is strictly later than its input, the steps
	 * land exactly on the year's end, and every step is a local day — twenty-three, twenty-four or
	 * twenty-five hours. Offset arithmetic done by hand, which is the one thing this function must
	 * not contain, breaks all three at once.
	 */
	it('steps one local day at a time and covers a year exactly', () => {
		const from = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();
		const until = new Date(2027, 0, 1, 0, 0, 0, 0).getTime();
		const spans = new Set<number>();
		let at = from;
		let days = 0;

		while (at < until) {
			const next = nextLocalMidnightMs(at);
			expect(next).toBeGreaterThan(at);
			spans.add(next - at);
			at = next;
			days += 1;
		}

		// Every step landed on a local midnight and none was invented or lost: 2026 is not a leap
		// year, and the spans add up to the year whatever the zone did in the middle of it.
		expect(days).toBe(365);
		expect(at).toBe(until);
		for (const span of spans) {
			expect([DAY_MS - HOUR_MS, DAY_MS, DAY_MS + HOUR_MS]).toContain(span);
		}
	});
});

describe('the two DST days', () => {
	/*
	 * **A zone injected as a calendar**, for the reason `RetentionScheduleOptions.nextMidnightMs`
	 * gives: the process timezone cannot be moved from inside a worker thread, and a DST assertion
	 * that quietly depends on the zone the suite happens to run in is vacuous on a UTC runner. So
	 * these two tests hand the schedule the two days themselves; that the *platform* produces such
	 * days is the assertion above.
	 */
	const MIDNIGHT = Date.UTC(2026, 10, 1, 0, 0, 0);

	/** A calendar whose one day out of the ordinary is `hours` long. */
	const calendarWithADayOf = (hours: number) => (fromMs: number) =>
		fromMs < MIDNIGHT
			? MIDNIGHT
			: MIDNIGHT + hours * HOUR_MS + Math.floor((fromMs - MIDNIGHT) / DAY_MS) * DAY_MS;

	/*
	 * **Fall back: the local day is twenty-five hours, and it gets one pass.** A flat
	 * `now - lastRun >= 86_400_000` would pass here too, so this is not the test that forced the
	 * local-day comparison — it is the one that proves the extra hour buys no second walk, which
	 * is the shape a zone shifting at `00:00` produces as a `00:00` that happens twice.
	 */
	it('produces one pass on the day that is twenty-five hours long', () => {
		const asked: Request[] = [];
		const timer = createTestTimer();
		let nowMs = MIDNIGHT - DAY_MS;

		createRetentionSchedule({
			sweeper: recordingSweeper(asked),
			now: () => nowMs,
			armTimer: timer.armTimer,
			nextMidnightMs: calendarWithADayOf(25),
		}).start();

		// The midnight that opens the long day.
		nowMs = MIDNIGHT;
		timer.fire();
		expect(asked).toEqual([WHOLE_POLICY, WHOLE_POLICY]);

		// A stray fire an hour into it sweeps nothing — the second `00:00` a zone shifting at
		// midnight hands out, which must not be a second pass.
		nowMs += HOUR_MS;
		timer.fire();
		expect(asked).toHaveLength(2);
		expect(timer.armed).toBe(true);

		// And the midnight that closes it, twenty-five hours on, does get its own.
		nowMs = MIDNIGHT + 25 * HOUR_MS;
		timer.fire();
		expect(asked).toHaveLength(3);
	});

	/*
	 * **Spring forward: the local day is twenty-three hours, and it still gets its pass.** This is
	 * the case that decided the comparison. A flat `now - lastRun >= ONE_DAY_MS` refuses here —
	 * the day is an hour short of a day — and the pass is then skipped until the midnight after
	 * it, which is the *none* half of what this row must not produce. Comparing against the next
	 * local midnight of the last run's own instant answers both days with one function.
	 */
	it('produces one pass on the day that is twenty-three hours long', () => {
		const asked: Request[] = [];
		const timer = createTestTimer();
		let nowMs = MIDNIGHT - DAY_MS;

		createRetentionSchedule({
			sweeper: recordingSweeper(asked),
			now: () => nowMs,
			armTimer: timer.armTimer,
			nextMidnightMs: calendarWithADayOf(23),
		}).start();

		nowMs = MIDNIGHT;
		timer.fire();
		expect(asked).toEqual([WHOLE_POLICY, WHOLE_POLICY]);

		// The short day, closed twenty-three hours later rather than twenty-four: the pass is
		// taken, and a comparison against a flat day would have skipped it.
		nowMs = MIDNIGHT + 23 * HOUR_MS;
		timer.fire();
		expect(asked).toHaveLength(3);
	});
});

describe('a pass that fails', () => {
	/*
	 * Every filesystem failure is already an outcome rather than a throw (`archive-sweep.ts`), so
	 * nothing is expected to reach this path. It is asserted because *a failed pass must take
	 * neither the daemon nor the schedule with it* is a promise about every way this could go
	 * wrong, including the ones nobody has written down yet.
	 */
	it('is one warning on the host log, and the schedule stays armed', async () => {
		const thrown = new Error('the archive volume went away');
		const warned: string[] = [];
		const timer = createTestTimer();

		createRetentionSchedule({
			sweeper: {
				sweep: () => Promise.reject(thrown),
				removeProject: async () => ({ outcome: 'absent' as const }),
				settle: () => Promise.resolve(),
			},
			now: () => NOON_MS,
			warn: (line) => warned.push(line),
			armTimer: timer.armTimer,
		}).start();

		// The rejection is handled inside the schedule — `start()` answers `void` and nothing
		// awaits the walk — so the warning lands a microtask later rather than synchronously.
		await Promise.resolve();
		await Promise.resolve();

		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain(thrown.message);
		expect(timer.armed).toBe(true);
	});
});

describe('stopping the schedule', () => {
	it('leaves nothing armed', () => {
		const timer = createTestTimer();
		const schedule: RetentionSchedule = createRetentionSchedule({
			sweeper: recordingSweeper([]),
			now: () => NOON_MS,
			armTimer: timer.armTimer,
		});

		schedule.start();
		expect(timer.armed).toBe(true);

		schedule.stop();

		expect(timer.armed).toBe(false);
		expect(timer.armings.every((arming) => arming.disarmed)).toBe(true);
		// Twice is safe: `closeServer` stops the schedule first and `close()` is safe to call twice.
		expect(() => schedule.stop()).not.toThrow();
	});
});

describe('the scheduled pass and a lease ending at the same moment', () => {
	let dir: string;
	let root: string;
	let keptTestsPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'rover-'));
		root = join(dir, 'artifacts');
		keptTestsPath = join(dir, 'kept-tests.json');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/*
	 * **They cannot overlap, and nothing in the schedule arranges that.** Sweeps of one tree are
	 * serialised by the root inside `archive-sweep.ts`, so what this asserts is the property the
	 * row depends on rather than a mechanism of its own: two walks at once would each answer about
	 * a tree the other had already altered.
	 *
	 * Observed at both of the two points where an overlap could show: `liveLeases` is resolved
	 * *inside* the walk, and `onDelete` brackets each deletion. So a lease's sweep beginning its
	 * walk before the scheduled pass has finished deleting would put a `lease:` entry among the
	 * `midnight:` ones — which is exactly the assertion.
	 */
	it('does not produce two concurrent sweeps of one archive', async () => {
		for (let index = 0; index < 4; index += 1) {
			await fileRun(`old-${index}`, runNameAt(NOON_MS - (90 + index) * DAY_MS));
		}

		const trace: string[] = [];
		const sweeperWith = (tag: string): ArchiveSweeper =>
			createArchiveSweeper({
				root,
				keptTestsPath,
				retention: { budgetMb: 1024, maxAgeDays: 30 },
				liveLeases: () => {
					trace.push(`${tag}:walk`);
					return [];
				},
				now: () => NOON_MS,
				log: () => undefined,
				warn: () => undefined,
				onDelete: async () => {
					trace.push(`${tag}:in`);
					await Promise.resolve();
					trace.push(`${tag}:out`);
				},
			});

		// The scheduled pass, started exactly as the daemon starts it, and a lease's end landing
		// while it is still walking — the two triggers `listen.ts` wires side by side.
		const scheduled = sweeperWith('midnight');
		createRetentionSchedule({
			sweeper: scheduled,
			now: () => NOON_MS,
			// Nothing is fired here: the start pass is the whole subject, so the next arming is a
			// handle this test never touches.
			armTimer: () => () => undefined,
		}).start();
		await sweepAfterLease(sweeperWith('lease'), createMockLease(), () => undefined);
		await scheduled.settle();

		// The scheduled pass, whole and uninterrupted, and only then the lease's.
		expect(trace).toEqual([
			'midnight:walk',
			'midnight:in',
			'midnight:out',
			'midnight:in',
			'midnight:out',
			'midnight:in',
			'midnight:out',
			'midnight:in',
			'midnight:out',
			'lease:walk',
		]);
		// And the age bound really acted, rather than the two passes cancelling each other out:
		// four runs from ninety days ago, in an archive nowhere near its budget.
		expect(await remainingRuns()).toEqual([]);
	});

	/** A run directory in the shape the archive writes (§10), so the walk measures a real subtree. */
	async function fileRun(testName: string, run: string): Promise<void> {
		const path = join(root, 'rover', testName, run, 'serial-1', 'screenshots');
		await mkdir(path, { recursive: true });
		await writeFile(join(path, '001_screenshot.png'), 'x'.repeat(1024));
	}

	/** Every run directory left on disk, as `<project>/<test>/<run>`. */
	async function remainingRuns(): Promise<string[]> {
		const found: string[] = [];
		for (const project of await readdir(root, { withFileTypes: true })) {
			for (const test of await readdir(join(root, project.name), { withFileTypes: true })) {
				for (const run of await readdir(join(root, project.name, test.name))) {
					found.push(`${project.name}/${test.name}/${run}`);
				}
			}
		}
		return found.sort();
	}
});

/** A run name for an instant, in the format `archive-path.ts` writes. */
function runNameAt(instantMs: number, owner = 'issue-1'): string {
	const timestamp = new Date(instantMs)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z');
	return `${timestamp}-${owner}-abcd1234`;
}
