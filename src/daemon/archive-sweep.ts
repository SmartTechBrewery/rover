/**
 * The archive sweep — which runs the retention policy takes, and taking them (§9.4, §10, D23,
 * D24, D33).
 *
 * **One walk, two bounds, one deletion routine.** `./archive-retention.ts` holds the two numbers;
 * this module is the whole of what they mean: walk the tree, answer which run directories go and
 * by which bound, delete those whole, and remove any test name and project left holding nothing.
 * The budget and the age share the walk, the ordering rule, the exemption set and the deletion,
 * so they are one module — split apart they would be two readers of one tree that could disagree
 * about it.
 *
 * **Nothing schedules this.** There is no timer here, no per-lease hook and no start-up pass: the
 * only trigger in this phase is an operator, through `sweep_archive` and `rover sweep`. That is
 * deliberate rather than unfinished — pointing a deletion routine at a real archive for the first
 * time is survivable only while a human is the one asking, and only because they can ask what it
 * *would* do first (`dryRun`).
 *
 * **The unit of deletion is a run directory, taken whole with its `<serial>` subtree.** Never a
 * file, never a `screenshots/` folder, never a level above the run: a half-deleted run is a run
 * whose sidecars no longer describe what is beside them, and the archive's whole claim is that it
 * is what past leases wrote (D24). A test name or a project left holding nothing afterwards is
 * removed, because an empty level is scaffolding rather than a record; **the root is never
 * removed**.
 *
 * **Oldest first, by code-unit order of the run directory name — never `localeCompare`, and no
 * `Date` is constructed from a directory name.** The name leads with a fixed-width UTC basic-format
 * timestamp precisely so text order *is* chronological order (`./archive-path.ts`), and
 * `runDirectoryPrecedes` is the entirety of the age comparison. A locale-aware fold would make one
 * host sweep differently from another, which is `./list-archive.ts`'s reason for refusing the same
 * call.
 *
 * **A test's age is the age of its newest run.** A test holding a run from yesterday is not thirty
 * days old whatever else it holds, so the age bound looks at the last run name in code-unit order
 * and takes the whole test or none of it. Deleting the old runs of an active test would quietly
 * destroy exactly the before/after pair `test_name`'s non-uniqueness exists to give (§10).
 *
 * **Two exemptions, and they are absolute.** A test the operator has said to keep (D33) and a run
 * whose lease is **live** are never touched by either bound. The kept-tests store is re-read on
 * every sweep and cached nowhere (D6, `./kept-tests.ts`'s own promise), and a store that will not
 * parse **aborts the sweep and deletes nothing** — the exemption list being unreadable is
 * precisely the case in which nothing may be deleted. A live lease's run is matched by *path*,
 * built by the same `leaseRunDirectory` the writer files under, so the two cannot drift.
 *
 * **An archive still over budget with only exempt runs left is a refusal, not a fallback.**
 * `stillOverBudget` says so, one log line says so on the host, and no kept test and no live run is
 * ever taken to get under the limit. The archive can therefore sit over its budget indefinitely;
 * that is the instruction, and the log line is the whole of the remedy (D28's model — a record on
 * the host's own stderr, nothing extra in the answer).
 *
 * **No host path is on any answer.** `./sweep-handlers.ts` answers three directory *names* per
 * run, the same components `list_archive` already answers, and `SweepArchiveResultSchema` has no
 * field a path would fit in (D19). {@link ArchivedRun.path} is host-only, used to delete and to
 * compare against a lease, and never returned.
 *
 * **Nothing here throws at its caller.** A root that is not there is `missing`, a root the host
 * cannot walk or a kept-tests store it cannot read is `unreadable`, and every other filesystem
 * failure is one warning on the host naming the path with that subtree contributing nothing. An
 * `ENOENT` mid-walk is ordinary rather than exceptional: the archive is written to while it is
 * being read, which is what `./list-archive.ts` already says about its own `stat`.
 *
 * **One sweep at a time per tree**, in `./kept-tests-handlers.ts`'s `serialised()` shape and for
 * its reasons — keyed by the root so two sweepers on one tree share the queue and two on different
 * trees do not wait on each other. Requests **chain** rather than coalesce: a sweep that started
 * before this lease's bytes landed did not see them, so joining it would answer about a tree that
 * no longer exists.
 *
 * **There is still no index.** The walk *is* the measurement — no cached total, no catalogue, no
 * memo of a previous sweep (D6, D24, and the three existing readers all say so).
 */

import type { Dirent } from 'node:fs';
import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_ARCHIVE_PATH_DEPTH } from '../ipc/methods.js';
import { leaseRunDirectory, runDirectoryPrecedes } from './archive-path.js';
import { ageCutoffMs, budgetBytesOf, type RetentionPolicy } from './archive-retention.js';
import { keptTestKey, readKeptTests } from './kept-tests.js';
import type { Lease } from './leases.js';

/** One run directory, addressed the way `list_archive` addresses a level — plus its host path. */
export interface ArchivedRun {
	/** The project directory's name, as the archive filed it. Parsed by nothing (D22). */
	readonly project: string;
	/** The test directory's name, as the archive filed it. */
	readonly testName: string;
	/** The run directory's name — `<timestamp>-<owner>-<hash>`. */
	readonly run: string;
	/** **Host-only.** What is deleted, and what a live lease is compared against. Never answered. */
	readonly path: string;
	/** The whole `<serial>` subtree, summed by the walk. */
	readonly sizeBytes: number;
}

/** Which bound took a run. Exactly two, because there are exactly two bounds. */
export type RetentionBound = 'age' | 'budget';

/** A run the policy selected, and the bound that selected it. */
export interface DoomedRun extends ArchivedRun {
	readonly bound: RetentionBound;
}

/**
 * What one sweep answers.
 *
 * `missing` and `unreadable` are two arms rather than one for `ListArchiveResultSchema`'s reason:
 * *nothing has ever been filed here* and *the host cannot say what is in its own archive* render
 * differently and must never be confused. Neither carries a path or a reason — both go to the
 * host's own log, where a path already belongs (D19).
 */
export type SweepOutcome =
	| {
			readonly outcome: 'swept';
			/** Whether this was a question. A dry run deletes nothing at all. */
			readonly dryRun: boolean;
			/** The runs taken, oldest first. On a dry run, the runs that would be taken. */
			readonly runs: readonly DoomedRun[];
			/** The archive as walked, before anything was deleted. */
			readonly totalBytesBefore: number;
			/** What the runs above accounted for. */
			readonly freedBytes: number;
			/** `totalBytesBefore` less `freedBytes`. On a dry run, what it would become. */
			readonly totalBytesAfter: number;
			/** Over budget with nothing left that may be deleted — the operator's problem. */
			readonly stillOverBudget: boolean;
	  }
	| { readonly outcome: 'missing' }
	| { readonly outcome: 'unreadable' };

export interface ArchiveSweeper {
	/**
	 * Walk, select, and — unless `dryRun` — delete. Serialised: one sweep at a time per tree.
	 *
	 * `bounds` is `'both'` or `'budget'`. The second exists so a future caller can ask for the
	 * size bound alone without a second entry point; nothing in this phase passes it, and the
	 * *age* bound alone is deliberately not offered, because a size check that skipped the age
	 * would be the one combination that lets an archive sit inside its budget for a year.
	 */
	sweep(options: {
		readonly dryRun: boolean;
		readonly bounds: 'both' | 'budget';
	}): Promise<SweepOutcome>;
}

export interface ArchiveSweeperOptions {
	/** The archive root — the same `artifactsRoot` the writer and the three readers use. */
	readonly root: string;
	/**
	 * The kept-tests store (D33), read fresh on every sweep and cached nowhere (D6). A store that
	 * will not parse aborts the sweep — see the module header.
	 */
	readonly keptTestsPath: string;
	readonly retention: RetentionPolicy;
	/**
	 * Every live lease, **as a callback rather than a snapshot or the store itself.**
	 *
	 * Resolved at the moment of the walk, because a lease granted between construction and the
	 * sweep is exactly the run that must not be deleted; and lazy so a caller can construct the
	 * sweeper before the lease store exists in its own ordering.
	 */
	readonly liveLeases: () => readonly Lease[];
	/**
	 * Defaults to `Date.now`. Injected so a test can move a month by hand, which is
	 * `LeaseStoreOptions.now`'s reason: a real clock and a thirty-day window cannot both be in
	 * the same unit test.
	 */
	readonly now?: () => number;
	/**
	 * Where the record of what this sweep did is written. Defaults to `console.warn`, which is
	 * the daemon's own stderr — `./kept-tests-handlers.ts`'s `audit`, for its reasons.
	 */
	readonly log?: (message: string) => void;
	/**
	 * Where a tree the host could not fully walk is reported. Defaults to `console.warn`. This is
	 * the **only** place a path and a reason are said, for the reason the module header gives.
	 */
	readonly warn?: (message: string) => void;
	/**
	 * Called just before each run directory is removed. A test seam and nothing else — it is how
	 * `tests/unit/daemon/archive-sweep.test.ts` proves two sweeps do not interleave, which cannot
	 * be observed after the fact from a tree that is already gone.
	 */
	readonly onDelete?: (run: DoomedRun) => void | Promise<void>;
}

/**
 * The in-flight sweep chain per archive root. See the module header for why sweeps chain rather
 * than coalesce, and why the key is the tree rather than the sweeper instance.
 */
const sweeps = new Map<string, Promise<unknown>>();

function serialised<T>(root: string, work: () => Promise<T>): Promise<T> {
	const previous = sweeps.get(root) ?? Promise.resolve();
	// `then(work, work)` because a rejected predecessor must not cancel the queue — nothing here
	// rejects today (every failure is answered as an outcome), and a future one that did would
	// otherwise leave the archive unsweepable until a restart.
	const run = previous.then(work, work);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	sweeps.set(root, tail);
	void tail.then(() => {
		if (sweeps.get(root) === tail) {
			sweeps.delete(root);
		}
	});
	return run;
}

export function createArchiveSweeper(options: ArchiveSweeperOptions): ArchiveSweeper {
	const now = options.now ?? Date.now;
	const log = options.log ?? ((message: string) => console.warn(message));
	const warn = options.warn ?? ((message: string) => console.warn(message));

	return {
		sweep(request: { dryRun: boolean; bounds: 'both' | 'budget' }): Promise<SweepOutcome> {
			return serialised(options.root, async (): Promise<SweepOutcome> => {
				// The exemption list first, and the sweep is abandoned if it will not read: a
				// store the host cannot parse is precisely the case in which nothing may go.
				let kept: Set<string>;
				try {
					kept = new Set((await readKeptTests(options.keptTestsPath)).map(keptTestKey));
				} catch (error) {
					warn(unreadableKeptTestsWarning(options.keptTestsPath, error));
					return { outcome: 'unreadable' as const };
				}

				const walked = await walkArchive(options.root, warn);
				if (walked.outcome !== 'walked') {
					return { outcome: walked.outcome };
				}

				// Resolved here rather than at construction: a lease granted since is exactly the
				// run that must not go. Path identity, built by the writer's own function.
				const live = new Set(
					options.liveLeases().map((lease) => leaseRunDirectory(options.root, lease)),
				);
				const plan = planSweep({
					runs: walked.runs,
					totalBytes: walked.totalBytes,
					kept,
					live,
					retention: options.retention,
					nowMs: now(),
					bounds: request.bounds,
				});

				const taken = request.dryRun
					? plan.doomed
					: await deleteRuns(plan.doomed, options.root, warn, options.onDelete);
				const freedBytes = taken.reduce((sum, run) => sum + run.sizeBytes, 0);

				for (const run of taken) {
					log(deletionLine(run, request.dryRun));
				}
				log(summaryLine(taken.length, freedBytes, walked.totalBytes, request.dryRun));

				// Measured against what actually went, not against what was planned to go. On a dry
				// run and on a sweep where every deletion landed the two agree; where one did not,
				// this is the honest one — an archive whose runs would not delete is still over its
				// budget, and answering otherwise would hide the warning the failure already wrote.
				const budgetBytes = budgetBytesOf(options.retention);
				const totalBytesAfter = walked.totalBytes - freedBytes;
				const stillOverBudget = totalBytesAfter > budgetBytes;
				if (stillOverBudget) {
					log(refusalLine(totalBytesAfter, budgetBytes));
				}

				return {
					outcome: 'swept' as const,
					dryRun: request.dryRun,
					runs: taken,
					totalBytesBefore: walked.totalBytes,
					freedBytes,
					totalBytesAfter,
					stillOverBudget,
				};
			});
		},
	};
}

/** What the walk found, or which of the two failures it was. */
type WalkResult =
	| { readonly outcome: 'walked'; readonly runs: ArchivedRun[]; readonly totalBytes: number }
	| { readonly outcome: 'missing' }
	| { readonly outcome: 'unreadable' };

/**
 * Every run directory in the tree, with the size of its whole subtree, and the archive's total.
 *
 * Three fixed levels — project, test name, run — because the tree is always four levels and
 * anything walking it counts on that (§10, #129). Descends only into a dirent whose
 * `isDirectory()` is true, which is `false` for a symlink under `withFileTypes`: that is what
 * keeps the walk inside the root with no second `realpath` per level, exactly as
 * `./search-archive.ts` earns containment. A reader "fixing" that with a `stat` would take
 * containment with it — and would let a link decide what this deletes.
 *
 * A level below the run that the host cannot read is one warning and contributes nothing, which
 * is the benign direction for a budget: an under-measured archive deletes *less*.
 */
async function walkArchive(root: string, warn: (message: string) => void): Promise<WalkResult> {
	let projects: Dirent[];
	try {
		projects = await readdir(root, { withFileTypes: true });
	} catch (error) {
		// The root's own absence is not a failure: nothing has ever been archived here.
		if (codeOf(error) === 'ENOENT') {
			return { outcome: 'missing' as const };
		}
		warn(unreadableWarning(root, error));
		return { outcome: 'unreadable' as const };
	}

	const runs: ArchivedRun[] = [];
	let totalBytes = 0;
	for (const project of projects.filter((dirent) => dirent.isDirectory())) {
		const projectPath = join(root, project.name);
		for (const test of await directoriesIn(projectPath, warn)) {
			const testPath = join(projectPath, test.name);
			for (const run of await directoriesIn(testPath, warn)) {
				const path = join(testPath, run.name);
				const sizeBytes = await sizeOfTree(path, MAX_ARCHIVE_PATH_DEPTH, warn);
				runs.push({
					project: project.name,
					testName: test.name,
					run: run.name,
					path,
					sizeBytes,
				});
				totalBytes += sizeBytes;
			}
		}
	}
	return { outcome: 'walked' as const, runs, totalBytes };
}

/** The subdirectories of one level, or none at all when the host cannot read it. */
async function directoriesIn(
	directory: string,
	warn: (message: string) => void,
): Promise<Dirent[]> {
	try {
		return (await readdir(directory, { withFileTypes: true })).filter((dirent) =>
			dirent.isDirectory(),
		);
	} catch (error) {
		if (codeOf(error) !== 'ENOENT') {
			warn(unreadableWarning(directory, error));
		}
		return [];
	}
}

/**
 * The bytes under one directory, files only, following no link.
 *
 * `depth` is a floor under `MAX_ARCHIVE_PATH_DEPTH` and the tree never reaches it (§10): a run's
 * subtree is `<serial>/<kind>/<file>`. It is here so a hand-made loop of directories under a run
 * cannot make one sweep walk forever, which is the one failure a measurement must not have.
 */
async function sizeOfTree(
	directory: string,
	depth: number,
	warn: (message: string) => void,
): Promise<number> {
	if (depth <= 0) {
		return 0;
	}
	let dirents: Dirent[];
	try {
		dirents = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (codeOf(error) !== 'ENOENT') {
			warn(unreadableWarning(directory, error));
		}
		return 0;
	}

	let bytes = 0;
	for (const dirent of dirents) {
		const child = join(directory, dirent.name);
		if (dirent.isDirectory()) {
			bytes += await sizeOfTree(child, depth - 1, warn);
		} else if (dirent.isFile()) {
			bytes += await fileSizeOf(child, warn);
		}
		// Anything else — a symlink, a socket, a device node — contributes nothing and is not
		// followed. `readdir`'s dirent type answers that with no `stat` at all.
	}
	return bytes;
}

/**
 * One file's size, or nothing.
 *
 * A file removed between the `readdir` and the `stat` is ordinary here rather than exceptional —
 * the archive is written to while it is being read, which is what `./list-archive.ts` already says
 * about its own `sizeOf`.
 */
async function fileSizeOf(path: string, warn: (message: string) => void): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if (codeOf(error) !== 'ENOENT') {
			warn(unreadableWarning(path, error));
		}
		return 0;
	}
}

interface SweepPlan {
	/** Oldest first, by code-unit order of the run directory name. */
	readonly doomed: readonly DoomedRun[];
}

/**
 * Which runs go, and by which bound. **Pure** — it takes the walk and answers, touching no disk,
 * which is what makes the dry run and the real sweep provably the same selection rather than two
 * code paths that agree today.
 *
 * Age first, then budget on what age left, because that is the order that makes the budget cheap
 * on a healthy host: the age bound is the one that acts on an archive nobody is filling, and the
 * budget loop stops the moment the remainder is within the limit.
 */
function planSweep(input: {
	readonly runs: readonly ArchivedRun[];
	readonly totalBytes: number;
	readonly kept: ReadonlySet<string>;
	readonly live: ReadonlySet<string>;
	readonly retention: RetentionPolicy;
	readonly nowMs: number;
	readonly bounds: 'both' | 'budget';
}): SweepPlan {
	const exempt = (run: ArchivedRun): boolean =>
		input.kept.has(keptTestKey({ project: run.project, testName: run.testName })) ||
		input.live.has(run.path);

	const doomed = new Map<string, DoomedRun>();
	if (input.bounds === 'both') {
		for (const run of agedOut(input.runs, ageCutoffMs(input.retention, input.nowMs), exempt)) {
			doomed.set(run.path, { ...run, bound: 'age' as const });
		}
	}

	const budgetBytes = budgetBytesOf(input.retention);
	let remaining = input.totalBytes;
	for (const run of doomed.values()) {
		remaining -= run.sizeBytes;
	}

	// Code-unit order of the run directory name across the whole archive — chronological, because
	// the name leads with a UTC basic-format timestamp. The two components after it only break a
	// tie, so the order is total and one host answers the same as another.
	const eligible = input.runs
		.filter((run) => !exempt(run) && !doomed.has(run.path))
		.sort(byRunName);
	for (const run of eligible) {
		if (remaining <= budgetBytes) {
			break;
		}
		doomed.set(run.path, { ...run, bound: 'budget' as const });
		remaining -= run.sizeBytes;
	}

	// Nothing kept and nothing live is ever taken to get under the limit, so an archive with only
	// those left stays over it. Whether it *did* is the caller's to measure, against what actually
	// went rather than against this selection.
	return { doomed: [...doomed.values()].sort(byRunName) };
}

/**
 * Every run of every test whose **newest** run is older than the cutoff, exemptions removed.
 *
 * A test is old or it is not, and its runs go together: a test holding a run from yesterday is
 * not thirty days old whatever else it holds, and deleting the old runs of an active test would
 * destroy exactly the before/after pair `test_name`'s non-uniqueness exists to give (§10).
 * *Newest* is the last name in code-unit order, and nothing parses one (D22).
 */
function agedOut(
	runs: readonly ArchivedRun[],
	cutoffMs: number,
	exempt: (run: ArchivedRun) => boolean,
): ArchivedRun[] {
	const doomed: ArchivedRun[] = [];
	for (const test of byTest(runs).values()) {
		const newest = test.reduce((latest, run) => (run.run > latest ? run.run : latest), '');
		if (runDirectoryPrecedes(newest, cutoffMs)) {
			doomed.push(...test.filter((run) => !exempt(run)));
		}
	}
	return doomed;
}

/** The runs of each `<project>/<test_name>`, so the age bound can ask about a test as a whole. */
function byTest(runs: readonly ArchivedRun[]): Map<string, ArchivedRun[]> {
	const grouped = new Map<string, ArchivedRun[]>();
	for (const run of runs) {
		const key = keptTestKey({ project: run.project, testName: run.testName });
		const held = grouped.get(key);
		if (held) {
			held.push(run);
		} else {
			grouped.set(key, [run]);
		}
	}
	return grouped;
}

/** Code-unit comparison, never `localeCompare` — see the module header. */
function byRunName(left: ArchivedRun, right: ArchivedRun): number {
	return (
		compare(left.run, right.run) ||
		compare(left.project, right.project) ||
		compare(left.testName, right.testName)
	);
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Delete each doomed run whole, in the given order, and tidy up the levels they emptied.
 *
 * **Sequential.** The order is the record — one log line per deleted run, oldest first — and
 * parallel deletes buy nothing against a log that has to be readable afterwards.
 *
 * A run that could not be deleted is one warning and is **left out of the answer**, so
 * `freedBytes` is what actually went rather than what was hoped for.
 */
async function deleteRuns(
	doomed: readonly DoomedRun[],
	root: string,
	warn: (message: string) => void,
	onDelete: ((run: DoomedRun) => void | Promise<void>) | undefined,
): Promise<DoomedRun[]> {
	const deleted: DoomedRun[] = [];
	const touchedTests = new Set<string>();
	const touchedProjects = new Set<string>();

	for (const run of doomed) {
		try {
			await onDelete?.(run);
			await rm(run.path, { recursive: true, force: true });
		} catch (error) {
			warn(undeletedWarning(run.path, error));
			continue;
		}
		deleted.push(run);
		touchedTests.add(join(root, run.project, run.testName));
		touchedProjects.add(join(root, run.project));
	}

	// Tests first, then the projects they may have emptied — the only order in which a project
	// can be observed empty. `ENOTEMPTY` and `ENOENT` are both ordinary: a lease that filed a new
	// run between the walk and this cleanup is the common case, not a failure. **The root is
	// never a candidate**: `touchedProjects` only ever holds a level below it.
	for (const directory of [...touchedTests, ...touchedProjects]) {
		await removeIfEmpty(directory, warn);
	}
	return deleted;
}

async function removeIfEmpty(directory: string, warn: (message: string) => void): Promise<void> {
	try {
		await rmdir(directory);
	} catch (error) {
		const code = codeOf(error);
		if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
			warn(unreadableWarning(directory, error));
		}
	}
}

/**
 * One line per run, naming the three components, the bytes and the bound that took it.
 *
 * Every component through `JSON.stringify`, which is the daemon's convention for caller text in a
 * log line (`./list-archive.ts`'s header says why): a name may legally carry a newline, and the
 * daemon's stderr is the host's only accountability trail.
 */
function deletionLine(run: DoomedRun, dryRun: boolean): string {
	const named = `${JSON.stringify(run.project)}/${JSON.stringify(run.testName)}/${JSON.stringify(run.run)}`;
	return (
		`${dryRun ? 'Would delete' : 'Deleted'} archived run ${named} — ${run.sizeBytes} bytes, ` +
		`over the ${run.bound} bound.`
	);
}

/** One line per sweep, and a dry run says in as many words that nothing was deleted. */
function summaryLine(
	count: number,
	freedBytes: number,
	totalBytes: number,
	dryRun: boolean,
): string {
	const runs = `${count} ${count === 1 ? 'run' : 'runs'}`;
	if (dryRun) {
		return (
			`Swept the artifact archive as a dry run: ${runs} totalling ${freedBytes} bytes would ` +
			`go, taking it from ${totalBytes} to ${totalBytes - freedBytes} bytes. ` +
			`Nothing was deleted.`
		);
	}
	return (
		`Swept the artifact archive: deleted ${runs} totalling ${freedBytes} bytes, taking it ` +
		`from ${totalBytes} to ${totalBytes - freedBytes} bytes.`
	);
}

/**
 * The refusal — the one thing about this sweep that only an operator can resolve.
 *
 * D28's model: a record on the host's own stderr, and nothing extra on the answer beyond the flag
 * that says a refusal happened.
 */
function refusalLine(remainingBytes: number, budgetBytes: number): string {
	return (
		`The artifact archive is still ${remainingBytes} bytes, over its budget of ${budgetBytes} ` +
		`bytes, and every run left is either kept or held by a live lease. Nothing kept and ` +
		`nothing live was deleted to get under the limit, so the budget cannot be met without ` +
		`you: untick a kept test, raise the budget, or wait for a lease to end.`
	);
}

/** What the operator is told, on the host, about something this sweep could not read. */
function unreadableWarning(path: string, error: unknown): string {
	return (
		`The artifact archive could not be read at ${JSON.stringify(path)}: ` +
		`${codeOf(error) ?? 'unknown error'}. The sweep went on without it — that subtree ` +
		`counted for nothing and nothing in it was deleted.`
	);
}

/** A run the sweep selected and the host would not remove. It stays, and the answer says so. */
function undeletedWarning(path: string, error: unknown): string {
	return (
		`The archived run at ${JSON.stringify(path)} was not deleted: ` +
		`${codeOf(error) ?? 'unknown error'}. It is still there and is not counted as freed.`
	);
}

/** The store the exemptions live in, unreadable — so the sweep deleted nothing at all. */
function unreadableKeptTestsWarning(path: string, error: unknown): string {
	return (
		`The kept-tests store at ${JSON.stringify(path)} could not be read: ${messageOf(error)} ` +
		`The sweep was abandoned and nothing was deleted — the list of what the operator ` +
		`asked to keep is exactly what a deletion may not proceed without.`
	);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The errno of a filesystem failure, or `null` for anything that is not one. */
function codeOf(error: unknown): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : null;
}
