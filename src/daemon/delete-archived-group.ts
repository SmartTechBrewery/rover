/**
 * The `delete_archived_group` handler — one operator action taking **the runs whose group id
 * matches, and nothing else** (D43, R51 phase 3, #277).
 *
 * **This is the one of the three named deletes that is not an address**, and that is the whole of
 * why it needs a module of its own. `./delete-project.ts` and `./delete-archived-test.ts` each name
 * a directory, so each is one `ArchiveSweeper.remove(address)`; a group is a *set of runs*, each
 * naming it in its own `group_id.json`, and the archive has no `<group_id>/` level at all (R41). So
 * this is a **walk** and not one `rm`, which is the cost D43 states rather than hides.
 *
 * **The surgical reading, and why the wider one was refused.** A test directory may hold runs of
 * other groups and of none — `test_name` is deliberately not unique (D22) — so *every test the
 * group touches* would destroy runs that were never part of it, and would make a group's `Remove`
 * mean something different from the group's `Keep` beside it. What goes is therefore run directory
 * by run directory: a test level the deletion empties is removed, and **only then** is its
 * kept-test entry pruned, while a test still holding runs from elsewhere keeps those runs *and its
 * `Keep` exemption* — which is #272's *a kept test that is not what was named keeps its exemption*
 * one scope over.
 *
 * **Its walk is `./list-archive-groups.ts`' walk with `./list-archive-groups.ts`' bounds**, exactly
 * as `./measure-archive-groups.ts`' is, and for that module's stated reason: what is genuinely
 * shared is {@link readGroupId}, so *which runs are in this group* stays **one fact** across the
 * three methods that ask it, and {@link MAX_ARCHIVE_GROUP_DIRECTORIES}, so one bound caps the disk
 * work whichever of them is asking. The bookkeeping is what differs — one drops a run from a
 * listing, one leaves its bytes out of a total, and this one deletes it.
 *
 * **Every deletion goes through the sweeper, one whole run at a time** (D34).
 * `ArchiveSweeper.remove([project, testName, run])` is the one deletion path a project, a test and
 * now a run go down, so this `rm` runs inside that module's per-root critical section and under the
 * same `settle()` that keeps a `process.exit` out of the middle of it — and the empty test level and
 * the empty project level it leaves behind are tidied by that module's own `removeIfEmpty` rather
 * than by a second idea of when a level is scaffolding.
 *
 * **A walk that was cut short must not answer as a complete delete.** The directory bound can
 * truncate, a level the host cannot read truncates, and a `group_id.json` that will not parse
 * truncates — and every one of those means *at least one directory that exists was not fully
 * examined*, so runs of this group may never have been reached. The answer is `partial` with the
 * runs that did go reported, never `deleted`: the operator's next move is to run it again, and a
 * `deleted` here would claim a group is gone when part of it may not be.
 *
 * **A live lease filing into any matched run refuses the call and nothing at all is touched.** That
 * run directory is what the lease is writing into right now, which D35 exempts absolutely. The
 * identity is the path `leaseRunDirectory(root, lease)` builds — the *exact* one the sweep already
 * compares against, and the same one the writer files under, so the two cannot drift. Every matched
 * run is checked before the first one is deleted, so this arm is all-or-nothing rather than a
 * refusal halfway through.
 *
 * **`groupId` is never joined into a path.** It is matched against the *contents* of each run's
 * `group_id.json`, so a group id carrying a separator, a NUL or a newline is ordinary data here —
 * `./measure-archive-groups.ts`'s own rule for the same pair. The one caller string that *is* a
 * path component is `project`, and it gets `./archive-sweep.ts`'s rule for a delete: resolved and
 * required **strictly under** the resolved root, because addressing the root is legitimate for a
 * read and deleting through it is not.
 *
 * **No host path, no `errno` and no `message` is on any answer, structurally** (D19).
 * `DeleteArchivedGroupResultSchema` has no field one would fit in, and `src/ipc/server.ts` parses
 * every handler's return value against that `.strict()` schema. The diagnosis goes where the path
 * already belongs: a warning here, on the host.
 *
 * **One audit line, in `force_release_device`'s key** (D28), naming the actor, the project, the
 * group id, how many runs went, the bytes, the kept entries removed and the ISO instant. Every
 * caller value through `JSON.stringify`, `./kept-tests-handlers.ts`'s reason: a newline would
 * otherwise end the line and start a fabricated one in the daemon's own record. No token is in
 * scope on this path at all (D20).
 */

import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type {
	DeleteArchivedGroupParams,
	DeleteArchivedGroupResult,
	DeletedPart,
	IpcHandlers,
} from '../ipc/methods.js';
import { leaseRunDirectory } from './archive-path.js';
import type { ArchiveSweeper } from './archive-sweep.js';
import { pruneKeptTests, withoutTest } from './kept-tests.js';
import type { Lease } from './leases.js';
import { MAX_ARCHIVE_GROUP_DIRECTORIES, readGroupId } from './list-archive-groups.js';

export interface DeleteArchivedGroupOptions {
	/** The archive root — `./archive-path.ts`'s `resolveArtifactsRoot`, resolved in `./main.ts`. */
	readonly root: string;
	/** The kept-tests store, read fresh and cached nowhere (D6). */
	readonly keptTestsPath: string;
	/** The one sweeper, whose per-root serialisation every one of these `rm`s runs inside. */
	readonly sweeper: ArchiveSweeper;
	/**
	 * Every live lease, **as a callback rather than a snapshot** — `ArchiveSweeperOptions`' own
	 * reason: the question is answered at the moment of the call, because a lease granted since
	 * construction is exactly the one this must refuse for.
	 */
	readonly liveLeases: () => readonly Lease[];
	/**
	 * Where the record of a delete is written. Defaults to `console.warn`, the daemon's own stderr
	 * — `./kept-tests-handlers.ts`'s `audit`, for its reasons.
	 */
	readonly audit?: (message: string) => void;
	/**
	 * Where something this delete could not read or remove is reported. Defaults to `console.warn`.
	 * This is the **only** place a path and a reason are said, for the reason the module header
	 * gives.
	 */
	readonly warn?: (message: string) => void;
	/**
	 * The directory bound, overridable so a test can assert the truncation without making five
	 * thousand directories. **A handler option with a default, never a wire parameter**, which is
	 * `./list-archive-groups.ts`'s own rule: a caller-settable bound is the parameter D24 refused.
	 */
	readonly maxDirectories?: number;
}

export type DeleteArchivedGroupHandler = Pick<IpcHandlers, 'delete_archived_group'>;

export function createDeleteArchivedGroupHandler(
	options: DeleteArchivedGroupOptions,
): DeleteArchivedGroupHandler {
	const audit = options.audit ?? ((message: string) => console.warn(message));
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const maxDirectories = options.maxDirectories ?? MAX_ARCHIVE_GROUP_DIRECTORIES;

	return {
		async delete_archived_group(
			params: DeleteArchivedGroupParams,
		): Promise<DeleteArchivedGroupResult> {
			/*
			 * The schema keeps `project` from being `.`, `..` or a separator, so this join cannot
			 * escape as a string; a symlink can, which is what {@link containedScope} is for.
			 * `groupId` is deliberately not here — it names no directory (the module header).
			 *
			 * The walk descends from the **requested** path rather than from its resolved twin, so
			 * every run it reaches is at `join(root, project, testName, run)`: the exact string
			 * `leaseRunDirectory` builds for the refusal below, and the exact address
			 * `ArchiveSweeper.remove` composes for the deletion. One idea of where a run is, rather
			 * than three.
			 */
			const requested = join(options.root, params.project);
			const scope = await containedScope(options.root, requested, warn);
			if (scope !== 'contained') {
				// Nothing was reached, and the two arms say which kind of nothing it was: a project
				// this host never filed, or one it will not delete through.
				if (scope === 'missing') {
					audit(nothingReachedLine(params));
					return { outcome: 'not-found' as const };
				}
				audit(auditLine(params, 'partial', EXAMINED_NOTHING));
				return { outcome: 'partial' as const, ...EXAMINED_NOTHING };
			}

			const walk: Walk = {
				maxDirectories,
				warn,
				directoriesRead: 1,
				matched: [],
				truncated: false,
			};
			await walkTestNames(walk, requested, params.groupId);

			const live = new Set(
				options.liveLeases().map((lease) => leaseRunDirectory(options.root, lease)),
			);
			if (walk.matched.some((run) => live.has(run.path))) {
				// Nothing is touched — not one run of the group — and no audit line claims
				// otherwise. Checked over every match before the first delete, so this arm cannot
				// be reached halfway through.
				audit(refusalLine(params));
				return { outcome: 'refused' as const, reason: 'lease-live' as const };
			}

			const taken = await deleteMatchedRuns(options.sweeper, params.project, walk.matched);
			const keptTests = await pruneEmptiedTests(options, params.project, requested, taken, warn);

			const report = {
				archive: archivePart(walk, taken),
				keptTests: keptTests.part,
				freedBytes: taken.bytes,
				keptTestsRemoved: keptTests.removed,
				runsRemoved: taken.removed.length,
			};

			/*
			 * **`not-found` only for a walk that finished**, which is where this parts company with
			 * `./delete-archived-test.ts`'s order: there, *both halves absent* cannot be a failure
			 * because an address either exists or does not. Here a walk that was cut short has not
			 * established that nothing named the group, so it is `partial` even with nothing found —
			 * the module header's rule, and the reason the flag is on the walk rather than derived
			 * from what was matched.
			 */
			if (report.archive === 'failed' || report.keptTests === 'failed') {
				audit(auditLine(params, 'partial', report));
				return { outcome: 'partial' as const, ...report };
			}
			if (report.archive === 'absent' && report.keptTests === 'absent') {
				audit(nothingReachedLine(params));
				return { outcome: 'not-found' as const };
			}
			audit(auditLine(params, 'deleted', report));
			return { outcome: 'deleted' as const, ...report };
		},
	};
}

/** One run of the group, as both of the things this module has to do with it need it named. */
interface MatchedRun {
	/** The archive's second component — the test directory this run was filed under. */
	readonly testName: string;
	/** The run directory's own name. */
	readonly run: string;
	/** **Host-only.** What a live lease is compared against. Never answered (D19). */
	readonly path: string;
}

/**
 * One walk in progress — what it has matched, and the counter the bound is read against.
 *
 * Mutable and passed by reference rather than threaded through return values, which is
 * `./list-archive-groups.ts`' own stance for its reason: every field is updated from more than one
 * place. It never leaves this module and no part of it reaches an answer.
 */
interface Walk {
	readonly maxDirectories: number;
	readonly warn: (message: string) => void;
	directoriesRead: number;
	/** The runs whose `group_id.json` named the group being deleted. */
	matched: MatchedRun[];
	/** At least one directory that exists was not fully examined — the module header's sentence. */
	truncated: boolean;
}

/** The report for a call that examined nothing at all, so nothing of the group can be claimed. */
const EXAMINED_NOTHING = {
	archive: 'failed' as const,
	keptTests: 'absent' as const,
	freedBytes: 0,
	keptTestsRemoved: 0,
	runsRemoved: 0,
};

/**
 * Whether the project this delete was pointed at may be walked and deleted from — or which kind of
 * nothing it is instead.
 *
 * **Strictly under the resolved root, which is the deletion path's rule and not the reads'.**
 * `./measure-archive-groups.ts` admits the root itself, because addressing the root is legitimate
 * for a read; `./archive-sweep.ts` refuses it, because deleting it would take every project on the
 * host. This is a delete, so it takes the sweep's rule — and the schema alone cannot give it, a
 * symlink escaping the root without a `.`, `..` or a separator anywhere being exactly what the
 * resolved comparison is for.
 *
 * The root's own absence is `missing` too: nothing has ever been archived here.
 */
async function containedScope(
	root: string,
	requested: string,
	warn: (message: string) => void,
): Promise<'contained' | 'missing' | 'unreadable'> {
	let resolvedRoot: string;
	let scope: string;
	try {
		resolvedRoot = await realpath(root);
		scope = await realpath(requested);
	} catch (error) {
		if (codeOf(error) === 'ENOENT') {
			return 'missing';
		}
		warn(unreadableWarning(requested, error));
		return 'unreadable';
	}
	if (!scope.startsWith(resolvedRoot + sep)) {
		// A link inside the root pointing out of it, or the root itself. Something *is* there, and
		// this host will not delete through it.
		warn(escapedWarning(requested, scope));
		return 'unreadable';
	}
	return 'contained';
}

/**
 * One project's test names, then each test name's runs — `./measure-archive-groups.ts`'s two
 * levels, in its shape and for its reason: the levels are named, and a reader who has to count
 * closing braces to work out which one a `continue` leaves is reading the wrong shape.
 *
 * No link is followed, because the descent tests `isDirectory()` on the dirent and never `stat`s it.
 */
async function walkTestNames(walk: Walk, projectDirectory: string, groupId: string): Promise<void> {
	const testNames = await readLevel(walk, projectDirectory);
	if (!testNames) {
		return;
	}
	for (const testName of testNames) {
		if (!testName.isDirectory()) {
			continue;
		}
		const directory = join(projectDirectory, testName.name);
		const runs = await readLevel(walk, directory);
		if (!runs) {
			continue;
		}
		for (const run of runs) {
			if (run.isDirectory()) {
				await examineRun(walk, groupId, testName.name, run.name, join(directory, run.name));
			}
		}
	}
}

/**
 * One run: whether it named the group being deleted.
 *
 * The order is `./list-archive-groups.ts`' own affordability argument: `group_id.json` is read
 * before anything is deleted, so an ungrouped run costs this one `readdir` — which is how the
 * `<serial>` is found — plus one `readFile`, and no deletion at all.
 *
 * **The shape rule is that module's, stated once there**: a run directory holds exactly one
 * *directory* by construction, and it is the `<serial>` (D7). A run holding none or two or more is
 * skipped and sets no `truncated` — it was examined, and that is a fact about the run rather than a
 * shortfall in the walk. A file beside the `<serial>` — a `.DS_Store` a file browser dropped in —
 * is ignored rather than fatal to the run.
 *
 * **A run that *is* grouped and whose claim the host cannot use truncates the walk**, which is the
 * sharpest of the three truncations: it may equally have belonged to this group, so a delete that
 * passed over it silently would report a complete removal of a group part of which is still filed.
 */
async function examineRun(
	walk: Walk,
	groupId: string,
	testName: string,
	run: string,
	runDirectory: string,
): Promise<void> {
	const entries = await readLevel(walk, runDirectory);
	if (!entries) {
		return;
	}
	const directories = entries.filter((entry) => entry.isDirectory());
	const serial = directories.length === 1 ? directories[0] : undefined;
	if (!serial) {
		return;
	}

	const read = await readGroupId(join(runDirectory, serial.name));
	if (read.outcome === 'ungrouped') {
		// This run named no group, so it is not this delete's at all. The common case on most
		// hosts, and not a shortfall in anything.
		return;
	}
	if (read.outcome !== 'grouped') {
		walk.warn(
			read.outcome === 'unparseable'
				? unparseableWarning(read.path)
				: unreadableWarning(read.path, read.error),
		);
		walk.truncated = true;
		return;
	}
	if (read.groupId !== groupId) {
		return;
	}
	walk.matched.push({ testName, run, path: runDirectory });
}

/**
 * One directory's entries, in code-unit name order — or `null` when the bound stopped the descent
 * or the host could not read it, both of which truncate the walk and neither of which fails the
 * call outright.
 *
 * `./list-archive-groups.ts`'s own function, and its rules: the bound is checked *before* the read
 * so it caps disk work rather than reporting it, and an `ENOENT` here is treated like any other
 * failure rather than passed over, because a level that vanished mid-walk is a level that was not
 * examined — which is what `truncated` says.
 */
async function readLevel(walk: Walk, directory: string): Promise<Dirent[] | null> {
	if (walk.directoriesRead >= walk.maxDirectories) {
		walk.truncated = true;
		return null;
	}
	try {
		const dirents = await readdir(directory, { withFileTypes: true });
		walk.directoriesRead += 1;
		return sortedByName(dirents);
	} catch (error) {
		walk.warn(unreadableWarning(directory, error));
		walk.truncated = true;
		return null;
	}
}

/** Ascending by name in code-unit order, `./list-archive.ts`'s one fixed order. */
function sortedByName(dirents: readonly Dirent[]): Dirent[] {
	return [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** What actually went, and what it came to. */
interface TakenRuns {
	readonly removed: readonly MatchedRun[];
	readonly bytes: number;
	/** At least one matched run the host would not remove — the sweeper wrote the warning. */
	readonly failed: boolean;
}

/**
 * Delete each matched run whole, in the order the walk found them, through the one deletion path.
 *
 * **Sequential**, `./archive-sweep.ts`'s `deleteRuns`' reason: the log is one line per run and
 * parallel deletes buy nothing against a record that has to be readable afterwards. Each call also
 * takes the sweeper's per-root lock, so they would serialise anyway.
 *
 * A run the sweeper answers `absent` for went between the walk and the delete — a sweep by the disk
 * budget is the ordinary way that happens — and is neither a removal nor a failure: nothing was
 * reached, so nothing refused to go.
 */
async function deleteMatchedRuns(
	sweeper: ArchiveSweeper,
	project: string,
	matched: readonly MatchedRun[],
): Promise<TakenRuns> {
	const removed: MatchedRun[] = [];
	let bytes = 0;
	let failed = false;
	for (const run of matched) {
		const removal = await sweeper.remove([project, run.testName, run.run]);
		if (removal.outcome === 'removed') {
			removed.push(run);
			bytes += removal.bytes;
		} else if (removal.outcome === 'failed') {
			failed = true;
		}
	}
	return { removed, bytes, failed };
}

/**
 * Prune the kept entry of every test this deletion **emptied**, and of no other test.
 *
 * **The filesystem is asked rather than inferred.** A test is pruned when its directory is no
 * longer there, which is the fact the exemption is about: `ArchiveSweeper.remove` removes a level
 * left holding nothing as part of the same critical section (D34), so *the test went with its last
 * run* is something to `stat` for, not something to derive from having matched every run this walk
 * happened to see. A test that still holds runs of another group or of none is therefore not pruned
 * at all, and its `Keep` is untouched — the whole of the surgical reading, in one guard.
 *
 * **One prune for however many tests were emptied**, through phase 1's shared
 * {@link pruneKeptTests}: it is the read-modify-write both other deletes run, under
 * `set_kept_tests`' own lock, so no two of the three can answer differently about that document. A
 * store with nothing to remove is `absent` and is not rewritten; one that will not read is `failed`
 * and is never overwritten.
 *
 * **Nothing was emptied is not a store visit at all.** The lock is not taken and the file is not
 * read, which matters for the arm below it: a call that matched no run must not be able to answer
 * `partial` because of a document it had no business opening.
 */
async function pruneEmptiedTests(
	options: DeleteArchivedGroupOptions,
	project: string,
	projectDirectory: string,
	taken: TakenRuns,
	warn: (message: string) => void,
): Promise<{ readonly part: DeletedPart; readonly removed: number }> {
	const emptied: string[] = [];
	for (const testName of new Set(taken.removed.map((run) => run.testName))) {
		if (!(await exists(join(projectDirectory, testName)))) {
			emptied.push(testName);
		}
	}
	if (emptied.length === 0) {
		return { part: 'absent' as const, removed: 0 };
	}

	return await pruneKeptTests(
		options.keptTestsPath,
		/*
		 * {@link withoutTest} folded over the emptied tests rather than one filter written here,
		 * which is the same reuse `pruneKeptTests` itself is: the pair matched exactly with no
		 * `pathSegment` near either component, the ordering the store is written in, and the count
		 * answered as a number are all that function's promises, and a second implementation of
		 * them is a second idea of what a kept test's identity is.
		 */
		(tests) => {
			let left = tests;
			let removed = 0;
			for (const testName of emptied) {
				const step = withoutTest(left, project, testName);
				left = step.tests;
				removed += step.removed;
			}
			return { tests: [...left], removed };
		},
		warn,
	);
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * What the archive half of this delete came to — the one field that has to carry *the walk may not
 * have reached everything* as well as *what was reached went*.
 *
 * `failed` for a truncated walk is the module header's rule made structural: the report's own
 * fields are what a client renders, so a walk cut short has to read as *some of it is still there*
 * rather than as a complete removal of what happened to be found.
 */
function archivePart(walk: Walk, taken: TakenRuns): DeletedPart {
	if (walk.truncated || taken.failed) {
		return 'failed';
	}
	return taken.removed.length > 0 ? 'removed' : 'absent';
}

/** The two components as the record names them, each through `JSON.stringify` (D19, D28). */
function named(params: DeleteArchivedGroupParams): string {
	return `${JSON.stringify(params.project)}/${JSON.stringify(params.groupId)}`;
}

/** How many runs went, in a sentence a person reads. */
function runsPhrase(runsRemoved: number): string {
	return `${runsRemoved} ${runsRemoved === 1 ? 'run' : 'runs'} removed`;
}

/**
 * The kept-tests half, as a fate **and** a count — `./delete-archived-test.ts`'s function and its
 * reason: a store the host could not read is left untouched and removes nothing, which reads
 * identically in a count to a group that emptied no kept test.
 */
function keptTestsPhrase(part: DeletedPart, removed: number): string {
	if (part === 'removed') {
		return `${removed} kept ${removed === 1 ? 'test' : 'tests'} removed`;
	}
	return part === 'absent' ? 'no kept tests' : 'kept tests NOT removed';
}

/**
 * The record D28 requires: what went, what it came to, who asked, and when.
 *
 * A `partial` says in as many words that some of the group may still be filed, because that is the
 * one answer whose next move is *look at this host's log, then ask again* rather than *done*.
 */
function auditLine(
	params: DeleteArchivedGroupParams,
	outcome: 'deleted' | 'partial',
	report: {
		readonly archive: DeletedPart;
		readonly keptTests: DeletedPart;
		readonly freedBytes: number;
		readonly keptTestsRemoved: number;
		readonly runsRemoved: number;
	},
): string {
	const halves = [
		`${runsPhrase(report.runsRemoved)} (${report.freedBytes} bytes)`,
		keptTestsPhrase(report.keptTests, report.keptTestsRemoved),
	].join(', ');
	// `Deleted group`, not `Deleted archived group`: the sweeper's own line for each run this took
	// opens with `Deleted archived`, and one prefix meaning two different records is what
	// `tests/helpers/daemon-socket.ts`'s sweep filter would then swallow. It is the distinction
	// `./delete-project.ts` and `./delete-archived-test.ts` already keep.
	const headline =
		outcome === 'deleted'
			? `Deleted group ${named(params)}`
			: `Partly deleted group ${named(params)}`;
	const tail =
		outcome === 'partial'
			? ` Some of it may still be on this host — the warnings above name what and why. Ask ` +
				`again once they are fixed.`
			: '';
	return (
		`${headline} — ${halves} — asked for by ${JSON.stringify(params.actor)} at ` +
		`${new Date().toISOString()}.${tail}`
	);
}

/** The record for a delete that reached nothing: no run of this group, and no kept entry with it. */
function nothingReachedLine(params: DeleteArchivedGroupParams): string {
	return (
		`Nothing was deleted for group ${named(params)} — no run filed under this project ` +
		`names that group — asked for by ${JSON.stringify(params.actor)} at ` +
		`${new Date().toISOString()}.`
	);
}

/** The record for the one branch that touches nothing on purpose. */
function refusalLine(params: DeleteArchivedGroupParams): string {
	return (
		`Refused to delete group ${named(params)}: a lease filing into one of its runs is live, ` +
		`so nothing was touched — that run directory is what the lease is writing into right now. ` +
		`Asked for by ${JSON.stringify(params.actor)} at ${new Date().toISOString()}.`
	);
}

/**
 * What the operator is told, on the host, about a level this walk could not read.
 *
 * Names the path and the errno, which is exactly what the answer may not carry: the wire says only
 * that some of the group may still be filed, and this is where the diagnosis lives instead (D19).
 */
function unreadableWarning(path: string, error: unknown): string {
	return (
		`The artifact archive could not be read at ${JSON.stringify(path)}: ` +
		`${codeOf(error) ?? 'unknown error'}. The group's delete answered as partial — no path ` +
		`or reason leaves this host.`
	);
}

/**
 * And what the operator is told about a run that claims a group in a file the host cannot make
 * sense of — the one case where a *readable* file leaves a group partly deleted.
 *
 * Says the path and no more of the file's contents: whatever is in there arrived from a lease, and
 * the daemon's stderr is not the place to echo it back.
 */
function unparseableWarning(path: string): string {
	return (
		`The artifact archive holds a group_id.json at ${JSON.stringify(path)} that is not ` +
		`{ "groupId": <string> }. That run is grouped and may be this group's, so it was left ` +
		`alone and the delete answered as partial — no path or contents leave this host.`
	);
}

/**
 * What the operator is told when the project a delete was pointed at resolved out of the archive
 * root.
 *
 * Both paths are stringified for {@link unreadableWarning}'s reason, and the target is named
 * because it is the only useful thing to know here: a link inside the root is something a host
 * process put there, so the operator has to see where it goes to decide whether it is theirs.
 */
function escapedWarning(requested: string, resolved: string): string {
	return (
		`The artifact archive was asked to delete a group's runs under ${JSON.stringify(requested)}, ` +
		`which resolves to ${JSON.stringify(resolved)} — not strictly inside this host's archive ` +
		`root. Nothing was deleted and the answer says only that the delete was partial.`
	);
}

function codeOf(error: unknown): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : null;
}
