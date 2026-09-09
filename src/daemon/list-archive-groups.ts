/**
 * The `list_archive_groups` handler — one bounded walk of the artifact archive, answering **which
 * runs share a group and which of their artifacts share a label** (R41, `PROJECT.md` §10).
 *
 * **This is the read side of the grouping `./archive.ts` files, and it needs nothing new on
 * disk.** A lease's `groupId` is written as `group_id.json` inside the run's `<serial>` directory
 * and an artifact's `label` goes into the artifact's own file name; both were deliberately kept
 * out of the tree's *shape*, so `leaseArchiveDirectory` is still always four levels (#129) and
 * `list_archive`'s three levels are untouched. What that costs is exactly this module: *which runs
 * share a group* is a walk at request time rather than a directory listing, which is the same
 * trade `./search-archive.ts` already makes.
 *
 * **There is no index, no catalogue and no cache, and that half of D23/D24 is not reversed.**
 * Nothing here is memoised, nothing is warmed on start, and no answer is derived from a previous
 * one. That is a deliberate cost, and the bounds below are how it is paid rather than discovered.
 *
 * **Five bounds, and one meaning of `truncated`.** Directories read are capped at
 * {@link MAX_ARCHIVE_GROUP_DIRECTORIES}, because that is the bound that caps disk work when
 * *nothing* is grouped; groups, runs per group and artifacts per run are capped structurally by
 * the schemas, enforced here by dropping the overflow so an over-large answer is a *truncated*
 * one and never an `invalid_result` on the host. Those three are structural and do **not** bound
 * their own product, so the fifth bound is on the answer as a whole:
 * {@link MAX_ARCHIVE_GROUP_ENTRIES} counts every run and every artifact this walk puts on the
 * answer, because an answer over `MAX_FRAME_BYTES` reaches its caller as a *malformed frame* and
 * not as a large one — a healthy host misdiagnosed, and the cost
 * `MAX_ARCHIVE_SEARCH_MATCHES` exists to avoid. And `truncated` means exactly one thing, the
 * sentence `search_archive` already carries: **at least one directory that exists was not fully
 * examined**, so a group, a run or an artifact may be missing. Any of the five bounds does it, so
 * does a level the host could not read mid-walk, and so does a run whose `group_id.json` will not
 * parse — that last one because such a run *is* grouped, so an incomplete group would otherwise
 * render as a complete one.
 *
 * **What a group id *is* on disk is {@link readGroupId}'s, and it is shared** (R49, #262).
 * `./measure-archive-groups.ts` answers how much disk a group takes from a walk of its own, and it
 * reads each run's `group_id.json` through that one function rather than through a second copy of
 * the read and the parse — the same argument the size badge makes for `sizeOfTree`, because two
 * answers about which runs are in a group disagreeing about which runs are in a group is the one
 * failure sharing it prevents. What is *not* shared is this walk's bookkeeping: a run whose claim
 * the host cannot read drops out of a listing here and leaves its bytes out of a total there, so
 * each caller warns in its own words and sets its own `truncated`.
 *
 * **An ungrouped run costs one `readFile` and no artifact directory at all.** The walk reads
 * `group_id.json` before it reads a single artifact directory, so the archive of a caller who
 * never grouped anything is walked at the cost of its run directories alone — one `readdir` per
 * run, which is how the `<serial>` is found, and nothing below it. That ordering is the whole
 * reason this method is affordable on a host with a large archive and no groups in it.
 *
 * **The depth is the archive's own known shape rather than a counter.** Four levels down to a
 * run's `<serial>`, then that directory and one level below it — `screenshots/`, `recordings/`,
 * `logs/` in practice, though nothing here hard-codes those three names — and **no further**: a
 * frame inside a `_frames` directory carries no label of its own, so descending into one would be
 * disk work that could not change the answer.
 *
 * **One shape rule, stated once.** A run directory holds exactly one *directory* by construction
 * — one lease is one device (D7) — and that directory is the `<serial>`. A run holding two or more
 * is **skipped and does not set `truncated`**: it was examined, and it is a fact about that run
 * rather than a shortfall in the answer. `./list-archive.ts`'s `onlyChild` is the same rule from
 * the other side.
 *
 * **A file beside the `<serial>` is ignored rather than fatal to the run**, and that is the
 * decision rather than an accident: this tree is meant to be opened by a human (D24), and a
 * `.DS_Store` a file browser drops into a run directory must not delete that run from every
 * answer — silently, since a run skipped for its shape sets no `truncated`. Only directories are
 * counted, so looking at the archive cannot change what it says.
 *
 * **Every component is opaque and nothing here parses one** (D22) — with one exception that is
 * named rather than smuggled: an artifact's *file name* is decoded by `filedLabelOf`, because the
 * archive wrote the label into that name and this is the inverse of the writer's own function
 * (`./archive-path.ts`, which owns both halves). A directory name is never split, and no level's
 * meaning is read out of what its components say.
 *
 * **Containment comes free here, for `./search-archive.ts`'s reason.** This handler takes no
 * caller-supplied path, so there is no `join(root, ...path)` to escape and no counterpart to
 * `./list-archive.ts`'s resolved-root check to earn. The walk descends only into a dirent whose
 * `isDirectory()` is true, and **that is `false` for a symlink under `withFileTypes`** — so no
 * link is followed and the walk cannot leave the root.
 *
 * **No host path is on any answer, structurally rather than by habit.**
 * `ListArchiveGroupsResultSchema` has no field a path would fit in — not even a `message` — and
 * `src/ipc/server.ts` parses every handler's return value against that `.strict()` schema, so a
 * path smuggled onto a result is `invalid_result` on the host (D19). A level the host cannot read
 * is therefore warned about *here*, where the path already belongs, with every path through
 * `JSON.stringify` for the reason `./list-archive.ts`'s header gives: a component may legally
 * carry a newline, and the daemon's stderr is the host's only accountability trail.
 *
 * **Reads are sequential**, for `./search-archive.ts`'s reason: the directory bound is what caps
 * the cost of a walk, so speculative concurrency would buy latency on the answers that are already
 * cheap and nothing on the ones that are not.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
	type ArchiveGroup,
	type ArchiveGroupArtifact,
	type ArchiveGroupRun,
	GroupIdSchema,
	type IpcHandlers,
	MAX_ARCHIVE_GROUP_ARTIFACTS,
	MAX_ARCHIVE_GROUP_ENTRIES,
	MAX_ARCHIVE_GROUP_RUNS,
	MAX_ARCHIVE_GROUPS,
} from '../ipc/methods.js';
import { filedLabelOf } from './archive-path.js';

/**
 * How many directories one walk may read.
 *
 * The bound that caps disk work when nothing is grouped: the structural caps stop a walk that is
 * *finding* groups, but an archive of ten thousand ungrouped runs is bounded by neither them nor
 * anything else. Five thousand `readdir`s matches `MAX_ARCHIVE_SEARCH_DIRECTORIES` on purpose —
 * one number for what a bounded walk of this archive costs — and is well past any archive an
 * operator is reading by hand.
 */
export const MAX_ARCHIVE_GROUP_DIRECTORIES = 5_000;

/**
 * `group_id.json` as this reader parses it.
 *
 * The wire's own key (D26), so one spelling of the field is parsed wherever it is met — on a
 * grant, on a holder, or here weeks after the lease ended. Deliberately **not** `.strict()`: a
 * key added to that file later must not make every group already on disk vanish, which is the
 * opposite failure from the one strictness protects against on the wire.
 */
const GroupIdFileSchema = z.object({ groupId: GroupIdSchema });

export interface ListArchiveGroupsOptions {
	/** The archive root — `./archive-path.ts`'s `resolveArtifactsRoot`, resolved in `./main.ts`. */
	readonly root: string;
	/**
	 * Where something the host cannot read is reported. Defaults to `console.warn`; injected by
	 * tests. This is the **only** place the reason and the path are said, for the reason the
	 * module header gives.
	 */
	readonly warn?: (message: string) => void;
	/**
	 * The directory bound, overridable so a test can assert the truncation without making five
	 * thousand directories. **A handler option with a default, never a wire parameter**: a
	 * caller-settable bound is the parameter D24 refused.
	 */
	readonly maxDirectories?: number;
	/**
	 * The three answer bounds, on {@link maxDirectories}' terms exactly — overridable so a suite
	 * can reach each cap without writing two hundred groups, and **never** reachable from the
	 * wire. Lowering one is what a test does; raising one past the schema's own `.max()` would
	 * make an over-large answer `invalid_result` on the host, which is what the caps prevent.
	 */
	readonly maxGroups?: number;
	readonly maxRuns?: number;
	readonly maxEntries?: number;
}

export type ListArchiveGroupsHandler = Pick<IpcHandlers, 'list_archive_groups'>;

export function createListArchiveGroupsHandler(
	options: ListArchiveGroupsOptions,
): ListArchiveGroupsHandler {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const maxDirectories = options.maxDirectories ?? MAX_ARCHIVE_GROUP_DIRECTORIES;
	const maxGroups = options.maxGroups ?? MAX_ARCHIVE_GROUPS;
	const maxRuns = options.maxRuns ?? MAX_ARCHIVE_GROUP_RUNS;
	const maxEntries = options.maxEntries ?? MAX_ARCHIVE_GROUP_ENTRIES;

	return {
		async list_archive_groups() {
			let rootDirents: Dirent[];
			try {
				rootDirents = await readdir(options.root, { withFileTypes: true });
			} catch (error) {
				// The root's own absence: nothing has ever been archived on this host.
				if (codeOf(error) === 'ENOENT') {
					return { outcome: 'missing' as const };
				}
				warn(unreadableWarning(options.root, error, UNREADABLE_ANSWER));
				return { outcome: 'unreadable' as const };
			}

			const walk: Walk = {
				root: options.root,
				maxDirectories,
				maxGroups,
				maxRuns,
				maxEntries,
				warn,
				groups: new Map(),
				directoriesRead: 1,
				entries: 0,
				truncated: false,
			};
			await walkProjects(walk, sortedByName(rootDirents));

			return {
				outcome: 'listed' as const,
				groups: ordered(walk.groups),
				truncated: walk.truncated,
			};
		},
	};
}

/**
 * One walk in progress — what it has found, and the counters the bounds are read against.
 *
 * Mutable and passed by reference rather than threaded through return values, for
 * `./search-archive.ts`'s reason: every field is updated from more than one place and the
 * alternative is a tuple nobody can read. It never leaves this module and no part of it reaches
 * an answer.
 */
interface Walk {
	/** The absolute path of the archive root on the host — never on an answer. */
	readonly root: string;
	readonly maxDirectories: number;
	readonly maxGroups: number;
	readonly maxRuns: number;
	readonly maxEntries: number;
	readonly warn: (message: string) => void;
	/** Groups so far, keyed by {@link keyOf} — a `(project, groupId)` pair and never one of them. */
	readonly groups: Map<string, ArchiveGroup>;
	directoriesRead: number;
	/** Runs plus artifacts on the answer so far — what {@link MAX_ARCHIVE_GROUP_ENTRIES} bounds. */
	entries: number;
	/** At least one directory that exists was not fully examined — the module header's sentence. */
	truncated: boolean;
}

/**
 * The archive's top level: every project directory, in name order.
 *
 * Three functions rather than three nested loops on purpose — the levels are named
 * (`<project>/<test_name>/<run>`), and a reader who has to count closing braces to work out which
 * one a `continue` leaves is reading the wrong shape.
 */
async function walkProjects(walk: Walk, projects: readonly Dirent[]): Promise<void> {
	for (const project of projects) {
		if (project.isDirectory()) {
			await walkTestNames(walk, [project.name]);
		}
	}
}

/** One project's test names. */
async function walkTestNames(walk: Walk, projectPath: readonly string[]): Promise<void> {
	const testNames = await readLevel(walk, join(walk.root, ...projectPath));
	if (!testNames) {
		return;
	}
	for (const testName of testNames) {
		if (testName.isDirectory()) {
			await walkRuns(walk, [...projectPath, testName.name]);
		}
	}
}

/** One test name's runs. */
async function walkRuns(walk: Walk, testNamePath: readonly string[]): Promise<void> {
	const runs = await readLevel(walk, join(walk.root, ...testNamePath));
	if (!runs) {
		return;
	}
	for (const run of runs) {
		if (run.isDirectory()) {
			await examineRun(walk, [...testNamePath, run.name]);
		}
	}
}

/**
 * One run: whether it named a group, and — only then — which of its artifacts carry a label.
 *
 * The order is the affordability of this whole method: `group_id.json` is read before any artifact
 * directory is, so an ungrouped run costs this one `readdir` — which is how the `<serial>` is
 * found — plus one `readFile`, and no artifact directory at all.
 */
async function examineRun(walk: Walk, runPath: readonly string[]): Promise<void> {
	const runDirectory = join(walk.root, ...runPath);
	const entries = await readLevel(walk, runDirectory);
	if (!entries) {
		return;
	}
	// The shape rule, stated in the module header: exactly one *directory*, and it is the
	// `<serial>`. A file beside it — a `.DS_Store` from a file browser, an editor's swap file — is
	// ignored, because merely looking at this tree may not drop a run from every answer. Two or
	// more directories is a fact about this run and not a shortfall, so still no `truncated`.
	const directories = entries.filter((entry) => entry.isDirectory());
	const serial = directories.length === 1 ? directories[0] : undefined;
	if (!serial) {
		return;
	}

	const serialDirectory = join(runDirectory, serial.name);
	const groupId = await groupIdOf(walk, serialDirectory);
	if (groupId === null) {
		return;
	}

	// The whole-answer bound, checked before the group is created so no group is ever left with
	// zero runs — which `ArchiveGroupSchema.runs`' `.min(1)` relies on.
	if (walk.entries >= walk.maxEntries) {
		walk.truncated = true;
		return;
	}

	const path = [...runPath, serial.name];
	const group = groupFor(walk, runPath[0] ?? '', groupId);
	if (!group) {
		return;
	}
	if (group.runs.length >= walk.maxRuns) {
		walk.truncated = true;
		return;
	}
	walk.entries += 1;
	group.runs.push({ path, artifacts: await labelledArtifactsOf(walk, serialDirectory, path) });
}

/**
 * The group this run named, or `null` for a run that named none **and** for one whose claim the
 * host could not read.
 *
 * The two are the same to the caller and are not the same on the host: an absent file is the
 * ordinary case and sets nothing, while a file that will not parse warns and sets `truncated`,
 * because a run that *is* grouped is then missing from a group that would otherwise look whole.
 */
async function groupIdOf(walk: Walk, serialDirectory: string): Promise<string | null> {
	const read = await readGroupId(serialDirectory);
	if (read.outcome === 'grouped') {
		return read.groupId;
	}
	if (read.outcome === 'ungrouped') {
		// This run named no group. Not a shortfall, and the common case on most hosts.
		return null;
	}
	walk.warn(
		read.outcome === 'unparseable'
			? unparseableWarning(read.path)
			: unreadableWarning(read.path, read.error, TRUNCATED_ANSWER),
	);
	walk.truncated = true;
	return null;
}

/**
 * What one run's `group_id.json` says, or why the host cannot tell — **the four cases a caller has
 * to keep apart**, and the reason this is a type rather than a `string | null`.
 *
 * `ungrouped` and the two failures are all *no group id* to whoever asked, and they are not the
 * same fact about the host: an absent file is the ordinary case and shortens nothing, while a file
 * that is there and unusable means a run that **is** grouped is missing from whatever was counted.
 * Each carries the `path` it was read from, because the diagnosis belongs on the host's own log and
 * a caller writes that line in its own words (D19).
 */
export type GroupIdRead =
	| { readonly outcome: 'grouped'; readonly groupId: string }
	/** No `group_id.json` at all: this run named no group. */
	| { readonly outcome: 'ungrouped' }
	/** The file is there and the host could not read it. */
	| { readonly outcome: 'unreadable'; readonly path: string; readonly error: unknown }
	/** It read, and it is not `{ "groupId": <string> }`. */
	| { readonly outcome: 'unparseable'; readonly path: string };

/**
 * **The one function that reads a group id off disk**, shared by this walk and by
 * `./measure-archive-groups.ts` (R49, #262).
 *
 * Exported for that module and for that module alone, and it is deliberately the **narrow** half
 * of what {@link groupIdOf} used to be: the file read and the parse, with none of the walk's own
 * bookkeeping — no `warn`, no `truncated`, no `Walk`. Two answers about which runs are in a group
 * must not be able to disagree about what a group id *is* on disk, which is the same argument the
 * issue makes for `sizeOfTree`; and the bookkeeping is exactly what the two callers do differently
 * — one drops a run from a listing, the other leaves its bytes out of a total.
 *
 * Nothing about the file's shape is this function's to decide either: {@link GroupIdFileSchema} is
 * the wire's own key (D26) and is deliberately not `.strict()`, so a key added to that file later
 * does not make every group already on disk vanish.
 */
export async function readGroupId(serialDirectory: string): Promise<GroupIdRead> {
	const path = join(serialDirectory, 'group_id.json');
	let contents: string;
	try {
		contents = await readFile(path, 'utf8');
	} catch (error) {
		return codeOf(error) === 'ENOENT'
			? { outcome: 'ungrouped' as const }
			: { outcome: 'unreadable' as const, path, error };
	}

	const parsed = GroupIdFileSchema.safeParse(parseJson(contents));
	return parsed.success
		? { outcome: 'grouped' as const, groupId: parsed.data.groupId }
		: { outcome: 'unparseable' as const, path };
}

/**
 * The labelled artifacts under one run's `<serial>` directory, each at its own address.
 *
 * Two levels: the `<serial>` directory itself — where `device_info.json`, `group_id.json` and
 * `test_description.json` live, none of which decodes to a label — and one level inside each
 * directory it holds, which is where the archive files a screenshot, a recording and a log. A
 * recording's `_frames` directory is answered as one labelled artifact of its own and is not
 * descended into: a frame carries no label, so there is nothing below it to find.
 */
async function labelledArtifactsOf(
	walk: Walk,
	serialDirectory: string,
	runPath: readonly string[],
): Promise<ArchiveGroupRun['artifacts']> {
	const artifacts: ArchiveGroupArtifact[] = [];

	function record(path: readonly string[], label: string): void {
		if (artifacts.length >= MAX_ARCHIVE_GROUP_ARTIFACTS || walk.entries >= walk.maxEntries) {
			walk.truncated = true;
			return;
		}
		walk.entries += 1;
		artifacts.push({ path: [...path], label });
	}

	const entries = await readLevel(walk, serialDirectory);
	if (!entries) {
		return artifacts;
	}
	for (const entry of entries) {
		const label = filedLabelOf(entry.name);
		if (label !== null) {
			record([...runPath, entry.name], label);
		}
		if (!entry.isDirectory()) {
			continue;
		}
		const children = await readLevel(walk, join(serialDirectory, entry.name));
		if (!children) {
			continue;
		}
		for (const child of children) {
			const childLabel = filedLabelOf(child.name);
			if (childLabel !== null) {
				record([...runPath, entry.name, child.name], childLabel);
			}
		}
	}
	return artifacts;
}

/**
 * The group this `(project, groupId)` pair belongs to, created on first sight — or `undefined`
 * when the cap has no room for a new one, which truncates the answer and drops this run.
 *
 * Which groups survive the cap therefore follows the walk's own order, which is project order:
 * the first {@link MAX_ARCHIVE_GROUPS} projects to name a group keep theirs. That is arbitrary
 * but deterministic, which is the property that matters — and `truncated` is what says the answer
 * is short.
 */
function groupFor(walk: Walk, project: string, groupId: string): ArchiveGroup | undefined {
	const key = keyOf(project, groupId);
	const held = walk.groups.get(key);
	if (held) {
		return held;
	}
	if (walk.groups.size >= walk.maxGroups) {
		walk.truncated = true;
		return undefined;
	}
	const created: ArchiveGroup = { project, groupId, runs: [] };
	walk.groups.set(key, created);
	return created;
}

/**
 * One key for the pair, with a NUL between the two halves.
 *
 * A NUL, because it cannot occur in the half that comes **first**: `project` is a directory name
 * off `readdir` and no filesystem holds a NUL in one. `groupId` is an opaque caller string that
 * may hold anything at all (`GroupIdSchema`), which is exactly why the unambiguous half leads —
 * the first NUL is the separator whatever follows it. Without a separator, project `a` with group
 * `b-c` and project `a-b` with group `c` would be one group.
 */
function keyOf(project: string, groupId: string): string {
	return `${project}\u0000${groupId}`;
}

/**
 * The groups in the one fixed order this method answers in — by project, then by group id, both
 * ascending in code-unit order.
 *
 * Determinism rather than a sort option, and code-unit order rather than `localeCompare`, for
 * `./list-archive.ts`'s reason: a locale-dependent comparison would make one host answer
 * differently from another. Runs keep the order the walk found them in, which within one
 * `<test_name>` is chronological, because a lease directory leads with a UTC basic-format
 * timestamp precisely so it sorts that way as text (`./archive-path.ts`).
 */
function ordered(groups: Map<string, ArchiveGroup>): ArchiveGroup[] {
	return [...groups.values()].sort((a, b) =>
		a.project === b.project ? compare(a.groupId, b.groupId) : compare(a.project, b.project),
	);
}

/**
 * One directory's entries, in code-unit name order — or `null` when a bound stopped the descent
 * or the host could not read it, both of which truncate the answer and neither of which fails it.
 *
 * The bound is checked *before* the read, so it caps disk work rather than reporting it. Past it
 * the walk keeps going through names it has already read: dropping those would cost the one
 * archive large enough to reach the bound its whole answer for no disk saved, which is the
 * argument `./search-archive.ts`'s `descend` makes.
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
		// `EACCES`, `EPERM`, `ENOTDIR`, `ELOOP`, `EIO`, a run removed between two reads — never a
		// failed answer. The path and the reason stay on the host, and the answer says it is short.
		walk.warn(unreadableWarning(directory, error, TRUNCATED_ANSWER));
		walk.truncated = true;
		return null;
	}
}

/** JSON, or `null` for text that is not JSON at all — a throw here would fail the whole answer. */
function parseJson(contents: string): unknown {
	try {
		return JSON.parse(contents);
	} catch {
		return null;
	}
}

/** Ascending by name in code-unit order, `./list-archive.ts`'s one fixed order. */
function sortedByName(dirents: Dirent[]): Dirent[] {
	return [...dirents].sort((a, b) => compare(a.name, b.name));
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * How the two callers of {@link unreadableWarning} differ, because the answers differ: a level the
 * walk could not read mid-way is a *truncated* listing, while the root itself is `unreadable` —
 * an arm with no `truncated` field at all. One message telling the operator the answer was
 * truncated when it was not is a log that misdescribes what the caller got, and the daemon's
 * stderr is the host's only account of either.
 */
const TRUNCATED_ANSWER = 'The group walk answered as truncated';
const UNREADABLE_ANSWER = 'The group walk answered as unreadable';

/**
 * What the operator is told, on the host, about something this walk could not read.
 *
 * Names the path and the errno, which is exactly what the answer may not carry: the wire says
 * only that the answer is short — or that the root is unreadable — and this is where the diagnosis
 * lives instead (D19). What the caller was actually told is the `answered` clause, so the log and
 * the wire cannot disagree.
 *
 * The path goes through `JSON.stringify`, never plain interpolation — it ends in names read off
 * disk, and a newline in one of those would otherwise end this line and start a fabricated one in
 * the daemon's log (`./lease-handlers.ts` renders the force-release audit record the same way).
 */
function unreadableWarning(path: string, error: unknown, answered: string): string {
	const code = codeOf(error);
	return (
		`The artifact archive could not be read at ${JSON.stringify(path)}: ` +
		`${code ?? 'unknown error'}. ` +
		`${answered} — no path or reason leaves this host.`
	);
}

/**
 * And what the operator is told about a run that claims a group in a file the host cannot make
 * sense of — the one case where a *readable* file still shortens the answer.
 *
 * Says the path and no more of the file's contents: whatever is in there arrived from a lease and
 * the daemon's stderr is not the place to echo it back.
 */
function unparseableWarning(path: string): string {
	return (
		`The artifact archive holds a group_id.json at ${JSON.stringify(path)} that is not ` +
		`{ "groupId": <string> }. That run is absent from the group listing, which answered as ` +
		`truncated — no path or contents leave this host.`
	);
}

/** The errno of a filesystem failure, or `null` for anything that is not one. */
function codeOf(error: unknown): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : null;
}
