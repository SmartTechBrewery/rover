/**
 * The archive sweep — what it takes, what it never takes, and that a dry run takes nothing
 * (§9.4, §10, #238).
 *
 * Over a real temp tree built by hand with known sizes and timestamped run names, with `now`
 * injected so a thirty-day window can be crossed in a unit test (`LeaseStoreOptions.now`'s
 * reason). Nothing here goes near `~/.rover`: the archive root and the kept-tests store are both
 * under one `mkdtemp` directory, which is `ai/TESTING.md`'s rule and, for a suite whose subject
 * is **deletion**, not one to bend.
 *
 * The claims that matter are the ones a reviewer would otherwise have to take on trust: the order
 * is code units and not a locale, a test's age is its newest run, the budget stops the moment it
 * is met, both exemptions hold against both bounds, an archive that cannot be brought under
 * budget is a refusal rather than a kept test deleted, and a sweep in flight can be **waited
 * out** — which is what a shutdown does with the one no caller is holding (#245).
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Observation, waitForCondition } from '@/core/wait.js';
import { leaseDirectoryName, leaseRunDirectory } from '@/daemon/archive-path.js';
import type { RetentionPolicy } from '@/daemon/archive-retention.js';
import { type ArchiveSweeper, createArchiveSweeper } from '@/daemon/archive-sweep.js';
import { writeKeptTests } from '@/daemon/kept-tests.js';
import type { Lease } from '@/daemon/leases.js';
import { createMockLease } from '../../helpers/factories.js';
import { createGate, drainEventLoop } from '../../helpers/timing.js';

/** A fixed instant to measure ages against, so no assertion here depends on the wall clock. */
const NOW_MS = Date.UTC(2026, 8, 8, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1_000;

/** One MiB, the unit the budget is counted in. */
const MB = 1024 * 1024;

/** How long the one condition in this file may stay unmet before the test gives up on it. */
const CONDITION_TIMEOUT_MS = 5_000;
const CONDITION_POLL_MS = 5;

let dir: string;
let root: string;
let keptTestsPath: string;
let logged: string[];
let warned: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'rover-'));
	root = join(dir, 'artifacts');
	keptTestsPath = join(dir, 'kept-tests.json');
	logged = [];
	warned = [];
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * A run directory holding one file of `sizeBytes` under a `<serial>` level, which is the shape
 * the archive actually writes (§10) — never a bare directory, so what the walk measures is what
 * a real run's subtree would measure.
 */
async function fileRun(
	project: string,
	testName: string,
	run: string,
	sizeBytes: number,
): Promise<string> {
	const path = join(root, project, testName, run);
	await mkdir(join(path, 'serial-1', 'screenshots'), { recursive: true });
	await writeFile(
		join(path, 'serial-1', 'screenshots', '001_screenshot.png'),
		'x'.repeat(sizeBytes),
	);
	return path;
}

function sweeperFor(
	retention: RetentionPolicy,
	leases: readonly Lease[] = [],
	nowMs = NOW_MS,
): ArchiveSweeper {
	return createArchiveSweeper({
		root,
		keptTestsPath,
		retention,
		liveLeases: () => leases,
		now: () => nowMs,
		log: (line) => logged.push(line),
		warn: (line) => warned.push(line),
	});
}

/** A run name for an instant, in the format `./archive-path.ts` writes. */
function runNameAt(instantMs: number, owner = 'issue-1'): string {
	const timestamp = new Date(instantMs)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z');
	return `${timestamp}-${owner}-abcd1234`;
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

describe('the two outcomes that are not a sweep', () => {
	it('answers missing for a host that has never filed anything', async () => {
		const outcome = await sweeperFor({ budgetMb: 1, maxAgeDays: 30 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome).toBe('missing');
	});

	/*
	 * **The exemption list being unreadable is precisely the case in which nothing may go.** A
	 * store that will not parse aborts the sweep outright rather than sweeping as if the operator
	 * had kept nothing, which would delete exactly the tests they had every reason to think were
	 * safe (D33).
	 */
	it('abandons the sweep and deletes nothing when the kept-tests store will not parse', async () => {
		await fileRun('rover', 'home', runNameAt(NOW_MS - 90 * DAY_MS), 8 * MB);
		await writeFile(keptTestsPath, '{ not json');

		const outcome = await sweeperFor({ budgetMb: 1, maxAgeDays: 30 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome).toBe('unreadable');
		expect(await remainingRuns()).toEqual([`rover/home/${runNameAt(NOW_MS - 90 * DAY_MS)}`]);
		expect(warned.join('\n')).toContain('nothing was deleted');
	});
});

describe('the age bound', () => {
	it('takes a test whose newest run is past the window, whole', async () => {
		await fileRun('rover', 'old', runNameAt(NOW_MS - 90 * DAY_MS), 1024);
		await fileRun('rover', 'old', runNameAt(NOW_MS - 40 * DAY_MS), 1024);

		const outcome = await sweeperFor({ budgetMb: 1024, maxAgeDays: 30 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome === 'swept' && outcome.runs.map((run) => run.bound)).toEqual([
			'age',
			'age',
		]);
		expect(await remainingRuns()).toEqual([]);
	});

	/*
	 * **A test's age is the age of its newest run.** A test with a run from yesterday is not
	 * thirty days old whatever else it holds — deleting its old runs would destroy exactly the
	 * before/after pair `test_name`'s non-uniqueness exists to give (§10).
	 */
	it('leaves a test with an old run and a recent one entirely alone', async () => {
		const ancient = runNameAt(NOW_MS - 40 * DAY_MS);
		const yesterday = runNameAt(NOW_MS - 1 * DAY_MS);
		await fileRun('rover', 'active', ancient, 1024);
		await fileRun('rover', 'active', yesterday, 1024);

		const outcome = await sweeperFor({ budgetMb: 1024, maxAgeDays: 30 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome === 'swept' && outcome.runs).toEqual([]);
		expect(await remainingRuns()).toEqual([`rover/active/${ancient}`, `rover/active/${yesterday}`]);
	});

	it('leaves a test inside the window alone', async () => {
		const recent = runNameAt(NOW_MS - 29 * DAY_MS);
		await fileRun('rover', 'recent', recent, 1024);

		const outcome = await sweeperFor({ budgetMb: 1024, maxAgeDays: 30 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome === 'swept' && outcome.runs).toEqual([]);
		expect(await remainingRuns()).toEqual([`rover/recent/${recent}`]);
	});
});

describe('the budget bound', () => {
	/*
	 * **The oldest go first**, which is what the leading timestamp exists to make true as text
	 * (`./archive-path.ts`) — and the budget stops the moment the remainder is inside the limit
	 * rather than clearing the archive.
	 */
	it('takes the oldest run first and stops the moment the budget is met', async () => {
		const oldest = runNameAt(NOW_MS - 10 * DAY_MS, 'issue-1');
		const newest = runNameAt(NOW_MS - 9 * DAY_MS, 'issue-2');
		await fileRun('rover', 'home', oldest, 2 * MB);
		await fileRun('rover', 'home', newest, 2 * MB);

		// Three megabytes of budget over four megabytes of archive: one run puts it inside.
		const outcome = await sweeperFor({ budgetMb: 3, maxAgeDays: 3650 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome === 'swept' && outcome.runs.map((run) => [run.run, run.bound])).toEqual([
			[oldest, 'budget'],
		]);
		expect(await remainingRuns()).toEqual([`rover/home/${newest}`]);
	});

	/*
	 * **The order is code units and never `localeCompare`.** These two names share a timestamp to
	 * the second, so the owner is what decides — and it is the one pair where the two comparisons
	 * disagree: `B` (0x42) is below `a` (0x61) in code units, while almost every locale folds case
	 * and puts `aardvark` first. A locale-aware sort would take the other run, which is how one
	 * host would come to sweep differently from another (`./list-archive.ts`'s own reason).
	 */
	it('orders by code units rather than by a locale', async () => {
		const sameSecond = NOW_MS - 10 * DAY_MS;
		const first = runNameAt(sameSecond, 'Bison');
		const second = runNameAt(sameSecond, 'aardvark');
		await fileRun('rover', 'home', first, 2 * MB);
		await fileRun('rover', 'home', second, 2 * MB);
		expect([second, first].sort((a, b) => a.localeCompare(b))).toEqual([second, first]);

		const outcome = await sweeperFor({ budgetMb: 3, maxAgeDays: 3650 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome === 'swept' && outcome.runs.map((run) => run.run)).toEqual([first]);
		expect(await remainingRuns()).toEqual([`rover/home/${second}`]);
	});

	it('takes nothing at all from an archive inside its budget', async () => {
		const run = runNameAt(NOW_MS - 1 * DAY_MS);
		await fileRun('rover', 'home', run, 1024);

		const outcome = await sweeperFor({ budgetMb: 1024, maxAgeDays: 30 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome === 'swept' && outcome.runs).toEqual([]);
		expect(outcome.outcome === 'swept' && outcome.stillOverBudget).toBe(false);
		expect(await remainingRuns()).toEqual([`rover/home/${run}`]);
	});
});

describe('the two exemptions', () => {
	it('never takes a kept test, by either bound', async () => {
		const old = runNameAt(NOW_MS - 90 * DAY_MS);
		await fileRun('rover', 'kept', old, 8 * MB);
		await writeKeptTests(keptTestsPath, [
			{
				project: 'rover',
				testName: 'kept',
				keptBy: 'alice',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
		]);

		// Both bounds are wide open on it: a megabyte of budget against eight, and ninety days
		// against a thirty-day window.
		const outcome = await sweeperFor({ budgetMb: 1, maxAgeDays: 30 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome === 'swept' && outcome.runs).toEqual([]);
		expect(await remainingRuns()).toEqual([`rover/kept/${old}`]);
	});

	/*
	 * **A run whose lease is live is being written into right now**, so it is exempt from both
	 * bounds — and matched by *path*, built by the same `leaseRunDirectory` the writer files
	 * under, so the exemption and the writer cannot drift.
	 */
	it('never takes a run whose lease is live, by either bound', async () => {
		const lease = createMockLease({
			project: 'rover',
			testName: 'live',
			createdAtMs: NOW_MS - 90 * DAY_MS,
		});
		const path = leaseRunDirectory(root, lease);
		await mkdir(join(path, 'serial-1'), { recursive: true });
		await writeFile(join(path, 'serial-1', '001_screenshot.png'), 'x'.repeat(8 * MB));

		const outcome = await sweeperFor({ budgetMb: 1, maxAgeDays: 30 }, [lease]).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome === 'swept' && outcome.runs).toEqual([]);
		expect(await remainingRuns()).toEqual([`rover/live/${leaseDirectoryName(lease)}`]);
	});

	/*
	 * **A refusal, not a fallback.** No kept test and no live run is taken to satisfy the budget,
	 * so the archive sits over its limit and one log line says only the operator can resolve it
	 * (D28).
	 */
	it('reports an archive it cannot bring under budget, and deletes nothing for it', async () => {
		const old = runNameAt(NOW_MS - 90 * DAY_MS);
		await fileRun('rover', 'kept', old, 8 * MB);
		await writeKeptTests(keptTestsPath, [
			{
				project: 'rover',
				testName: 'kept',
				keptBy: 'alice',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
		]);

		const outcome = await sweeperFor({ budgetMb: 1, maxAgeDays: 3650 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome === 'swept' && outcome.stillOverBudget).toBe(true);
		expect(outcome.outcome === 'swept' && outcome.runs).toEqual([]);
		expect(await remainingRuns()).toEqual([`rover/kept/${old}`]);
		expect(logged.join('\n')).toContain('over its budget');
	});
});

describe('what a deletion leaves behind', () => {
	it('removes a test and a project the sweep emptied, and never the root', async () => {
		await fileRun('emptied', 'gone', runNameAt(NOW_MS - 90 * DAY_MS), 1024);
		await fileRun('kept-project', 'stays', runNameAt(NOW_MS - 1 * DAY_MS), 1024);

		await sweeperFor({ budgetMb: 1024, maxAgeDays: 30 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(await readdir(root)).toEqual(['kept-project']);
	});

	it('leaves a test that still holds another run', async () => {
		const old = runNameAt(NOW_MS - 10 * DAY_MS, 'aardvark');
		const newer = runNameAt(NOW_MS - 9 * DAY_MS, 'bison');
		await fileRun('rover', 'home', old, 2 * MB);
		await fileRun('rover', 'home', newer, 2 * MB);

		await sweeperFor({ budgetMb: 3, maxAgeDays: 3650 }).sweep({ dryRun: false, bounds: 'both' });

		expect(await readdir(join(root, 'rover', 'home'))).toEqual([newer]);
	});
});

describe('the dry run', () => {
	/*
	 * **The plan is identical and the tree is untouched.** That is the whole reason the dry run
	 * exists — pointing a deletion routine at a real archive for the first time is survivable
	 * only if it can be asked what it would do.
	 */
	it('answers exactly what a real sweep would take, and deletes nothing', async () => {
		const old = runNameAt(NOW_MS - 90 * DAY_MS);
		await fileRun('rover', 'old', old, 4 * MB);
		const before = await remainingRuns();

		const asked = await sweeperFor({ budgetMb: 1024, maxAgeDays: 30 }).sweep({
			dryRun: true,
			bounds: 'both',
		});

		expect(asked.outcome === 'swept' && asked.dryRun).toBe(true);
		expect(asked.outcome === 'swept' && asked.runs.map((run) => run.run)).toEqual([old]);
		expect(await remainingRuns()).toEqual(before);
		expect(logged.join('\n')).toContain('Nothing was deleted');

		// And the real sweep takes precisely what the question answered.
		const swept = await sweeperFor({ budgetMb: 1024, maxAgeDays: 30 }).sweep({
			dryRun: false,
			bounds: 'both',
		});
		expect(swept.outcome === 'swept' && swept.runs.map((run) => run.run)).toEqual([old]);
		expect(await remainingRuns()).toEqual([]);
	});
});

describe('the totals', () => {
	it('reports the archive before, what went, and what is left', async () => {
		const old = runNameAt(NOW_MS - 90 * DAY_MS);
		const recent = runNameAt(NOW_MS - 1 * DAY_MS);
		await fileRun('rover', 'old', old, 2 * MB);
		await fileRun('rover', 'recent', recent, 1 * MB);

		const outcome = await sweeperFor({ budgetMb: 1024, maxAgeDays: 30 }).sweep({
			dryRun: false,
			bounds: 'both',
		});

		expect(outcome.outcome === 'swept' && outcome.totalBytesBefore).toBe(3 * MB);
		expect(outcome.outcome === 'swept' && outcome.freedBytes).toBe(2 * MB);
		expect(outcome.outcome === 'swept' && outcome.totalBytesAfter).toBe(1 * MB);
	});
});

describe('two sweeps of one tree', () => {
	/*
	 * **They do not interleave.** A sweep is a walk, a selection and a deletion over a tree the
	 * other one is changing; two of them at once would each answer about an archive the other had
	 * already altered. The hook records entry and exit around each deletion, which is the only
	 * place overlap could be observed at all — afterwards the tree is gone.
	 */
	it('run one after the other rather than at once', async () => {
		for (let index = 0; index < 4; index += 1) {
			await fileRun('rover', `old-${index}`, runNameAt(NOW_MS - (90 + index) * DAY_MS), 1024);
		}

		const trace: string[] = [];
		const sweeperWith = (tag: string): ArchiveSweeper =>
			createArchiveSweeper({
				root,
				keptTestsPath,
				retention: { budgetMb: 1024, maxAgeDays: 30 },
				liveLeases: () => [],
				now: () => NOW_MS,
				log: () => undefined,
				warn: (line) => warned.push(line),
				onDelete: async () => {
					trace.push(`${tag}:in`);
					await Promise.resolve();
					trace.push(`${tag}:out`);
				},
			});

		await Promise.all([
			sweeperWith('a').sweep({ dryRun: false, bounds: 'both' }),
			sweeperWith('b').sweep({ dryRun: false, bounds: 'both' }),
		]);

		// Every `in` is immediately followed by its own `out`: nothing from the other sweep is
		// ever between them.
		for (let index = 0; index < trace.length; index += 2) {
			expect(trace[index + 1]).toBe(`${trace[index]?.split(':')[0]}:out`);
		}
		// And the second sweep really ran on the tree the first one left, rather than joining it.
		expect(await remainingRuns()).toEqual([]);
	});
});

describe('settling the sweeps of one tree', () => {
	/*
	 * **What a shutdown waits on.** `sweepAfterLease` is `void`-ed onto the tail of every lease's
	 * end, so the only thing standing between a walk in progress and the `process.exit` behind
	 * `RunningDaemon.close()` is this method — and the unit of deletion being a whole run
	 * directory is what makes that matter (`src/daemon/archive-sweep.ts`'s header). Asserted
	 * through the `onDelete` seam, because "the deletion had not finished" is not observable
	 * afterwards from a tree that is already gone.
	 */
	it('does not resolve while a run is still being deleted', async () => {
		await fileRun('rover', 'checkout flow', runNameAt(NOW_MS - 90 * DAY_MS), 1024);
		const held = createGate();
		let deleting = false;
		const sweeper = createArchiveSweeper({
			root,
			keptTestsPath,
			retention: { budgetMb: 1024, maxAgeDays: 30 },
			liveLeases: () => [],
			now: () => NOW_MS,
			log: (line) => logged.push(line),
			warn: (line) => warned.push(line),
			onDelete: async () => {
				deleting = true;
				await held.reached;
			},
		});

		// `void`-ed exactly as the lease path does it, then settled exactly as `closeServer` does.
		const sweeping = sweeper.sweep({ dryRun: false, bounds: 'both' });
		let settled = false;
		const settling = sweeper.settle().then(() => {
			settled = true;
		});

		await waitForCondition({
			what: 'the sweep to reach its first deletion',
			timeoutMs: CONDITION_TIMEOUT_MS,
			pollIntervalMs: CONDITION_POLL_MS,
			probe: (): Observation<void> =>
				deleting ? { met: true, value: undefined } : { met: false, found: 'nothing deleting' },
		});
		await drainEventLoop();
		// Nothing but the held deletion is left to run, so a `settle()` that was not waiting for
		// it would have resolved by now.
		expect(settled).toBe(false);

		held.reach();
		await sweeping;
		await settling;
		expect(await remainingRuns()).toEqual([]);
	});

	it('resolves at once when no sweep of the tree is in flight', async () => {
		await fileRun('rover', 'checkout flow', runNameAt(NOW_MS - 90 * DAY_MS), 1024);
		const sweeper = sweeperFor({ budgetMb: 1024, maxAgeDays: 30 });

		// The ordinary shutdown: nothing was sweeping, so this is a `close()` that waits for
		// nothing rather than one that has to look for a reason not to wait.
		await sweeper.settle();
		await sweeper.sweep({ dryRun: false, bounds: 'both' });
		await sweeper.settle();

		expect(await remainingRuns()).toEqual([]);
	});
});
