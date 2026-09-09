/**
 * The `measure_archive_groups` handler — **how much disk the *grouped* runs of one scope take**
 * (R49, `PROJECT.md` §10, #262).
 *
 * **This is the archive's fifth read and the second that answers a number**, and it exists because
 * three of the Archive screen's group scopes describe a *subset* of the archive rather than an
 * address in it. `./archive-size.ts` sums a subtree, which is the honest answer for every scope
 * that **is** a directory; *everything grouped*, *everything grouped in one project* and *one
 * group* are none of them a directory — the archive has no `<group_id>/` level, which was
 * considered and not taken (R41) — so no address walk can answer them. A second method beside the
 * first is the `list_archive` / `list_archive_groups` precedent exactly, and a `scope` parameter on
 * the first would be the parameter D24 refuses.
 *
 * **Its walk is `./list-archive-groups.ts`' walk with `./list-archive-groups.ts`' bounds**, and
 * that is a deliberate copy of an *idiom* rather than of code: project, then test name, then run,
 * then the run's single `<serial>` directory; sequential reads; and no link followed, because the
 * descent tests `isDirectory()` on the dirent and never `stat`s it. What is genuinely shared is the
 * pair of functions the two answers must not disagree about — {@link readGroupId}, so *which runs
 * are in this group* is one fact, and {@link sizeOfTree}, so *what this run weighs* is one fact
 * across this method, `measure_archive` and the sweep. Extracting a bounded-walk framework out of
 * the two was considered and not done: the bookkeeping is what differs, and the shape that stayed
 * behind is three short functions per module rather than one parameterised walk neither module owns.
 *
 * **A run adds the bytes of its whole run directory, not of its `<serial>`.** That is the same
 * subtree `sweepAfterLease` weighs and the same one `measure_archive` answers for a run's own
 * address, so the three figures are one walk with one bound rather than three ideas of a run.
 *
 * **`truncated` means what it means everywhere else in this archive: at least one directory that
 * exists was not fully examined**, so `bytes` is a lower bound. Four things set it here — the
 * directory bound, a level the host could not read, a `group_id.json` that will not parse, and a
 * run whose own subtree walk came back incomplete. The third is the one that is specific to this
 * method and it is the sharpest: a run with an unusable `group_id.json` **is** grouped, so leaving
 * its bytes out silently would render an incomplete total as a complete one. A bounded walk is
 * *why* this badge can exist at all where the count badge cannot — a count of a set cannot be
 * honestly cut short, and a total can, because `truncated` says *at least*.
 *
 * **The scope's own root gets the archive's three outcomes; every level below it is a truncation.**
 * For `all` that root is the archive root — absent is `missing`, unreadable is `unreadable`, which
 * is what a host that has never archived anything and a host whose archive cannot be opened
 * respectively say. For `project` and `group` it is that project's directory, on exactly the same
 * terms and for `./archive-size.ts`'s stated reason: `readdir` succeeds on nothing a sealed
 * directory holds, so answering `bytes: 0` there would read as *nothing grouped in this project*
 * when the truth is *the host cannot say*. **A scope that matches no run answers `measured` with
 * `bytes: 0`** — that is a true claim about zero bytes, and it is the answer for a project full of
 * ungrouped runs and for a group id nothing on this host ever named.
 *
 * **Containment is nearly free and is still checked.** This handler composes exactly one
 * caller-supplied component onto the root — `project` — and `groupId` names no directory at all:
 * it is matched against the *contents* of each run's `group_id.json` and is never joined into a
 * path. But a `project` off the wire is a path component like any other, and while
 * `ArchivePathSegmentSchema` keeps any string from escaping the root, a symlink escapes it without
 * `.`, `..` or a separator — so the resolved scope is compared against the resolved root before
 * anything is read, exactly as `./list-archive.ts` and `./archive-size.ts` do.
 *
 * **No host path and no `errno` is on any answer, structurally rather than by habit.**
 * `MeasureArchiveResultSchema` has no field either would fit in — not even a `message` — and
 * `src/ipc/server.ts` parses every handler's return value against that `.strict()` schema, so a
 * path smuggled onto a result would be `invalid_result` on the host (D19). Every diagnosis is a
 * warning *here*, where the path already belongs, with each path through `JSON.stringify` for
 * `./list-archive.ts`'s reason: a component may legally carry a newline, and the daemon's stderr is
 * the host's only accountability trail.
 *
 * **There is still no index and nothing is cached between requests** (D6, D23, D24). The walk *is*
 * the measurement, which is what makes the bound and the flag necessary rather than optional.
 */

import type { Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
	type IpcHandlers,
	MAX_ARCHIVE_PATH_DEPTH,
	type MeasureArchiveGroupsParams,
	type MeasureArchiveResult,
} from '../ipc/methods.js';
import { sizeOfTree } from './archive-size.js';
import { MAX_ARCHIVE_GROUP_DIRECTORIES, readGroupId } from './list-archive-groups.js';

export interface MeasureArchiveGroupsOptions {
	/** The archive root — `./archive-path.ts`'s `resolveArtifactsRoot`, resolved in `./main.ts`. */
	readonly root: string;
	/**
	 * Where something this measurement could not read is reported. Defaults to `console.warn`;
	 * injected by tests. This is the **only** place the reason and the path are said, for the
	 * reason the module header gives.
	 */
	readonly warn?: (message: string) => void;
	/**
	 * The directory bound, overridable so a test can assert the truncation without making five
	 * thousand directories. **A handler option with a default, never a wire parameter**, which is
	 * `./list-archive-groups.ts`'s own rule: a caller-settable bound is the parameter D24 refused.
	 */
	readonly maxDirectories?: number;
}

export type MeasureArchiveGroupsHandler = Pick<IpcHandlers, 'measure_archive_groups'>;

export function createMeasureArchiveGroupsHandler(
	options: MeasureArchiveGroupsOptions,
): MeasureArchiveGroupsHandler {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const maxDirectories = options.maxDirectories ?? MAX_ARCHIVE_GROUP_DIRECTORIES;
	// Resolved on the first request that finds it rather than in this constructor, for
	// `./list-archive.ts`'s reason: the root does not exist on a host that has archived nothing.
	let resolvedRoot: string | null = null;

	/**
	 * The scope's own directory, resolved, contained and read — or **the answer**, for the one read
	 * whose failure is the answer rather than a shortfall in it (the module header's three
	 * outcomes).
	 *
	 * A closure rather than a module function because {@link resolvedRoot} is memoised per handler,
	 * and it does three things that belong together: resolve, compare against the root, and read.
	 * The read is also the readability probe `./archive-size.ts` spends a separate syscall on, and
	 * it costs nothing extra here because the walk wants these entries anyway.
	 */
	async function openScope(requested: string): Promise<OpenedScope | MeasureArchiveResult> {
		let scopeDirectory: string;
		try {
			resolvedRoot ??= await realpath(options.root);
			scopeDirectory = await realpath(requested);
		} catch (error) {
			// The root's own absence is this case too: nothing has ever been archived here.
			if (codeOf(error) === 'ENOENT') {
				return { outcome: 'missing' as const };
			}
			warn(unmeasurableWarning(requested, error));
			return { outcome: 'unreadable' as const };
		}
		if (scopeDirectory !== resolvedRoot && !scopeDirectory.startsWith(resolvedRoot + sep)) {
			// A link inside the root pointing out of it. `unreadable` rather than `missing`,
			// because something *is* there — this host will not size it through this method.
			warn(escapedWarning(requested, scopeDirectory));
			return { outcome: 'unreadable' as const };
		}
		try {
			const entries = await readdir(scopeDirectory, { withFileTypes: true });
			return { outcome: 'opened' as const, directory: scopeDirectory, entries };
		} catch (error) {
			if (codeOf(error) === 'ENOENT') {
				return { outcome: 'missing' as const };
			}
			warn(unmeasurableWarning(requested, error));
			return { outcome: 'unreadable' as const };
		}
	}

	return {
		async measure_archive_groups(
			params: MeasureArchiveGroupsParams,
		): Promise<MeasureArchiveResult> {
			// The schema keeps `project` from being `.`, `..` or a separator, so this join cannot
			// escape as a string. A symlink can, which is what {@link openScope}'s comparison is
			// for. `groupId` is deliberately not here: it names no directory (the module header).
			const requested = params.scope === 'all' ? options.root : join(options.root, params.project);
			const opened = await openScope(requested);
			if (opened.outcome !== 'opened') {
				return opened;
			}

			const walk: Walk = {
				maxDirectories,
				warn,
				directoriesRead: 1,
				bytes: 0,
				truncated: false,
			};
			await walkScope(walk, params, opened);

			return {
				outcome: 'measured' as const,
				bytes: walk.bytes,
				truncated: walk.truncated,
			};
		},
	};
}

/** One scope's directory and its own level, once both are known to be readable and contained. */
interface OpenedScope {
	readonly outcome: 'opened';
	readonly directory: string;
	readonly entries: readonly Dirent[];
}

/**
 * Which level the walk starts at, which is the only thing the three scopes differ in.
 *
 * The `all` scope starts at the archive root, whose entries are projects; the other two start at
 * one project, whose entries are test names. And only the `group` scope carries a group id to match
 * against — for the other two, *any* group is the subset being measured.
 */
async function walkScope(
	walk: Walk,
	params: MeasureArchiveGroupsParams,
	scope: OpenedScope,
): Promise<void> {
	const entries = sortedByName(scope.entries);
	if (params.scope === 'all') {
		await walkProjects(walk, scope.directory, entries, null);
		return;
	}
	await walkTestNames(
		walk,
		scope.directory,
		entries,
		params.scope === 'group' ? params.groupId : null,
	);
}

/**
 * One walk in progress — what it has added up, and the counter the bound is read against.
 *
 * Mutable and passed by reference rather than threaded through return values, which is
 * `./list-archive-groups.ts`' own stance for its reason: every field is updated from more than one
 * place and the alternative is a tuple nobody can read. It never leaves this module and no part of
 * it reaches an answer.
 */
interface Walk {
	readonly maxDirectories: number;
	readonly warn: (message: string) => void;
	directoriesRead: number;
	/** The bytes of every matching run's whole directory, so far. */
	bytes: number;
	/** At least one directory that exists was not fully examined — the module header's sentence. */
	truncated: boolean;
}

/**
 * The archive's top level, for the `all` scope: every project directory, in name order.
 *
 * Three functions rather than three nested loops, `./list-archive-groups.ts`'s shape for its
 * reason: the levels are named, and a reader who has to count closing braces to work out which one
 * a `continue` leaves is reading the wrong shape.
 */
async function walkProjects(
	walk: Walk,
	root: string,
	projects: readonly Dirent[],
	groupId: string | null,
): Promise<void> {
	for (const project of projects) {
		if (project.isDirectory()) {
			const directory = join(root, project.name);
			const testNames = await readLevel(walk, directory);
			if (testNames) {
				await walkTestNames(walk, directory, testNames, groupId);
			}
		}
	}
}

/** One project's test names — the level the `project` and `group` scopes start at. */
async function walkTestNames(
	walk: Walk,
	projectDirectory: string,
	testNames: readonly Dirent[],
	groupId: string | null,
): Promise<void> {
	for (const testName of testNames) {
		if (testName.isDirectory()) {
			const directory = join(projectDirectory, testName.name);
			const runs = await readLevel(walk, directory);
			if (runs) {
				await walkRuns(walk, directory, runs, groupId);
			}
		}
	}
}

/** One test name's runs. */
async function walkRuns(
	walk: Walk,
	testNameDirectory: string,
	runs: readonly Dirent[],
	groupId: string | null,
): Promise<void> {
	for (const run of runs) {
		if (run.isDirectory()) {
			await examineRun(walk, join(testNameDirectory, run.name), groupId);
		}
	}
}

/**
 * One run: whether it named the group being measured, and — only then — what it weighs.
 *
 * The order is `./list-archive-groups.ts`' own affordability argument: `group_id.json` is read
 * before a single byte is measured, so an ungrouped run costs this one `readdir` — which is how the
 * `<serial>` is found — plus one `readFile`, and no subtree walk at all. An archive with nothing
 * grouped in it is therefore walked at the cost of its run directories alone.
 *
 * **The shape rule is that module's, stated once there**: a run directory holds exactly one
 * *directory* by construction, and it is the `<serial>` (D7). A run holding none or two or more is
 * skipped and sets no `truncated` — it was examined, and that is a fact about the run rather than a
 * shortfall in the total. A file beside the `<serial>` — a `.DS_Store` a file browser dropped in —
 * is ignored rather than fatal to the run, because merely looking at this tree (D24) must not
 * change what it weighs.
 */
async function examineRun(walk: Walk, runDirectory: string, groupId: string | null): Promise<void> {
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
		// This run named no group, so it is not in this measurement's subset at all. The common
		// case on most hosts, and not a shortfall in anything.
		return;
	}
	if (read.outcome !== 'grouped') {
		/*
		 * A run that **is** grouped and whose claim the host cannot use — the file is unreadable,
		 * or it is not `{ "groupId": <string> }`. Its bytes cannot be attributed, so the total is
		 * short and has to say so, even for a `group` scope this run may not have belonged to: it
		 * may equally have belonged to it, and a total that might be short is a lower bound.
		 */
		walk.warn(
			read.outcome === 'unparseable'
				? unparseableWarning(read.path)
				: unreadableWarning(read.path, read.error),
		);
		walk.truncated = true;
		return;
	}
	if (groupId !== null && read.groupId !== groupId) {
		return;
	}

	/*
	 * **The run's whole directory**, and through the primitive `measure_archive` and the sweep
	 * already share — so a group's total, an address's total and the sweep's own log cannot hold
	 * three differently-bounded ideas of what one run weighs. The depth budget is the same one
	 * every other scope gets.
	 */
	const measured = await sizeOfTree(runDirectory, MAX_ARCHIVE_PATH_DEPTH, walk.warn);
	walk.bytes += measured.bytes;
	walk.truncated ||= !measured.complete;
}

/**
 * One directory's entries, in code-unit name order — or `null` when the bound stopped the descent
 * or the host could not read it, both of which truncate the total and neither of which fails it.
 *
 * `./list-archive-groups.ts`'s own function, and its rules: the bound is checked *before* the read
 * so it caps disk work rather than reporting it, and an `ENOENT` here is treated like any other
 * failure rather than passed over, because a level that vanished mid-walk is a level that was not
 * examined — which is what `truncated` says. (`sizeOfTree` draws that line the other way for a
 * *file*, where a race between the `readdir` and the `stat` is the ordinary case in a tree written
 * to while it is read.)
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

/**
 * What the operator is told, on the host, about a level this walk could not read.
 *
 * Names the path and the errno, which is exactly what the answer may not carry: the wire says only
 * that the total is short, and this is where the diagnosis lives instead (D19).
 */
function unreadableWarning(path: string, error: unknown): string {
	return (
		`The artifact archive could not be read at ${JSON.stringify(path)}: ` +
		`${codeOf(error) ?? 'unknown error'}. The grouped total answered as truncated — no path ` +
		`or reason leaves this host.`
	);
}

/**
 * And what the operator is told about a run that claims a group in a file the host cannot make
 * sense of — the one case where a *readable* file still shortens the total.
 *
 * Says the path and no more of the file's contents: whatever is in there arrived from a lease, and
 * the daemon's stderr is not the place to echo it back.
 */
function unparseableWarning(path: string): string {
	return (
		`The artifact archive holds a group_id.json at ${JSON.stringify(path)} that is not ` +
		`{ "groupId": <string> }. That run is grouped and its bytes are in no group total, which ` +
		`answered as truncated — no path or contents leave this host.`
	);
}

/**
 * What the operator is told when the scope a measurement was asked about could not be read at all
 * — so the answer is `unreadable` and carries no path and no reason (D19).
 */
function unmeasurableWarning(path: string, error: unknown): string {
	return (
		`The artifact archive's grouped runs could not be measured at ${JSON.stringify(path)}: ` +
		`${codeOf(error) ?? 'unknown error'}. The answer says only that the host could not size ` +
		`them — no path or reason leaves this host.`
	);
}

/**
 * What the operator is told when a scope resolved out of the archive root.
 *
 * Both paths are stringified for {@link unreadableWarning}'s reason, and the target is named
 * because it is the only useful thing to know here: a link inside the root is something a host
 * process put there, so the operator has to see where it goes to decide whether it is theirs.
 */
function escapedWarning(requested: string, resolved: string): string {
	return (
		`The artifact archive was asked to measure the grouped runs under ` +
		`${JSON.stringify(requested)}, which resolves to ${JSON.stringify(resolved)} — outside ` +
		`the archive root. The measurement refused it; nothing about it leaves this host.`
	);
}

/** The errno of a filesystem failure, or `null` for anything that is not one. */
function codeOf(error: unknown): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : null;
}
