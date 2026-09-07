import type { ArchiveGroup } from './archive-listing.js';
import { keyOf } from './archive-path.js';

/**
 * The groups view's arrangement, as pure functions over **one** `list_archive_groups` answer
 * (#181, R41, `docs/DESIGN.md` §9).
 *
 * The `All` view's levels are the archive's own directories, one `readdir` at a time. This view's
 * upper levels are not directories at all: a lease's group id is filed inside a run as
 * `group_id.json` and never as a level of the tree (`PROJECT.md` R41, #129), so *which groups
 * exist* is a rearrangement of one answer rather than a walk. That is why the whole arrangement
 * lives here, in functions with no React and no host in them, and why it is unit-tested on its own.
 *
 * | depth | the level | a row is |
 * | --- | --- | --- |
 * | 0 | the root | a project that has at least one group |
 * | 1 | a project | a `groupId` a lease under it named |
 * | 2 | a group | a test name a run in that group was filed under |
 * | 3 | a test name in a group | a run |
 * | 4 | a run | not a level — its contents are its `<serial>` directory's, as in the `All` view |
 *
 * **A run that named no group is not here, and neither is a project with none.** Nothing invents an
 * *ungrouped* bucket: this view answers *what groups exist*, the `All` view still lists every run,
 * and a made-up level would be the one thing that made a run unreachable by filing it under a name
 * no lease chose.
 *
 * **Nothing parses a component** (D22). A run's test name and its `<serial>` are read off the
 * position they occupy in the run's own four-component address — the archive is always four levels
 * deep — and never out of what a name says. A run whose address is not four components is skipped
 * rather than placed by guesswork; the host cannot answer one today, and placing it would mean
 * inventing which of its components was the test name. One skipped everywhere rather than in one
 * level and not another is why the counts below are counts of *placed* runs.
 *
 * **Every level here is in the answer's own order**, and *most recent first* is not decided in this
 * module. The host sorts groups by project then by group id, and the runs inside one group come out
 * of a walk that reads test names in name order and each test name's runs chronologically. The
 * reversal at the run level is `level-order.ts`'s, applied by each pane that draws those runs — the
 * tree and the card beside it — exactly as the `All` view's two panes already reverse through it.
 * A second opinion about the direction, held here, is what would let the two panes disagree.
 */

/**
 * One row of a level this view owns.
 *
 * `runs` is how many runs of the answer the row stands over — the figure the card beside the tree
 * draws as `RUNS`, and the one measure this view has that costs no second request. It is `1` on a
 * run row, where it counts the row itself and nothing reads it.
 *
 * `serial` is the run's `<serial>`, **on a run row alone** and `null` on every other. The answer
 * carries a run's full four-component address, so unlike the `All` view this view needs no
 * `onlyChild` off a second listing to know where a run's contents are.
 */
export interface GroupRow {
	readonly name: string;
	readonly runs: number;
	readonly serial: string | null;
}

/** How deep a run's own address is in the archive: `[project, test_name, run, serial]` (#129). */
const RUN_ADDRESS_DEPTH = 4;

/**
 * A run's address **without its `<serial>`** — `[project, test_name, run]`, which is exactly the
 * prefix a `search_archive` match at or below a run carries (#207).
 *
 * Exported because {@link groupIdsByRun} is read from outside this module and the depth is the whole
 * of what the two sides have to agree about. It is stated here, beside the address depth it comes
 * off, rather than being arithmetic at the caller.
 */
export const RUN_PREFIX_DEPTH = 3;

/**
 * Which group each grouped run is in, keyed by that run's `[project, test_name, run]` (#207).
 *
 * **This is the whole of *which runs are grouped*, and it is a question the panel can already
 * answer**: the groups view holds this answer for the tree it draws, so restricting a search to
 * this arrangement costs no request and no host change (`group-search.ts`).
 *
 * A run whose address is not {@link RUN_ADDRESS_DEPTH} components is skipped, which is the module
 * header's own rule rather than a second one — a run this module will not place is a run this
 * arrangement cannot draw a hit under either. **First placement wins**, so the answer's own order
 * decides for a run two groups somehow name, exactly as every level here is the answer's order.
 *
 * The key is built from the run's *own* `path` rather than from `group.project`, so it is by
 * construction the same string a match's prefix produces.
 */
export function groupIdsByRun(groups: readonly ArchiveGroup[]): ReadonlyMap<string, string> {
	const byRun = new Map<string, string>();
	for (const group of groups) {
		for (const run of group.runs) {
			if (run.path.length !== RUN_ADDRESS_DEPTH) {
				continue;
			}
			const key = keyOf(run.path.slice(0, RUN_PREFIX_DEPTH));
			if (!byRun.has(key)) {
				byRun.set(key, group.groupId);
			}
		}
	}
	return byRun;
}

/** The projects that have at least one group, in the answer's own order. */
export function groupedProjects(groups: readonly ArchiveGroup[]): readonly GroupRow[] {
	return counted(groups, (group) => group.project);
}

/** One project's group ids, in the answer's own order. */
export function groupsOfProject(
	groups: readonly ArchiveGroup[],
	project: string,
): readonly GroupRow[] {
	return counted(
		groups.filter((group) => group.project === project),
		(group) => group.groupId,
	);
}

/**
 * The test names a group's runs were filed under, deduplicated, in the answer's own order.
 *
 * A group spanning two test names is the ordinary case rather than the exception: `_variant`
 * suffixes are exactly what R41's worked example asks a caller to write, so the arms of one
 * investigation are sibling `<test_name>` directories held together by the group id.
 */
export function testNamesOfGroup(
	groups: readonly ArchiveGroup[],
	project: string,
	groupId: string,
): readonly GroupRow[] {
	const tally = new Map<string, number>();
	for (const run of runsIn(groups, project, groupId)) {
		tally.set(run.testName, (tally.get(run.testName) ?? 0) + 1);
	}
	return rowsFrom(tally);
}

/**
 * One `(project, group, test name)`'s runs, **in the answer's own order** — which is chronological,
 * oldest first, because a lease directory leads with a UTC basic-format timestamp and the host
 * sorts in code-unit order for exactly that reason.
 *
 * Whoever draws them reverses, through `level-order.ts`. See the module header.
 */
export function runsOfTestName(
	groups: readonly ArchiveGroup[],
	project: string,
	groupId: string,
	testName: string,
): readonly GroupRow[] {
	return runsIn(groups, project, groupId)
		.filter((run) => run.testName === testName)
		.map((run) => ({ name: run.run, runs: 1, serial: run.serial }));
}

/**
 * The `<serial>` of one run of one group, or `null` when the answer does not hold that run.
 *
 * **This is where a run's contents are, and it is one field of the answer rather than a
 * derivation.** The `All` view reads the same fact off the level above the run as `onlyChild`
 * (`archive-levels.ts`, `runContentsLevel`) because a listing is all it has; here the run's own
 * four-component address is on the wire, so nothing has to be listed to find it.
 */
export function groupRunSerial(
	groups: readonly ArchiveGroup[],
	project: string,
	groupId: string,
	testName: string,
	run: string,
): string | null {
	const found = runsIn(groups, project, groupId).find(
		(candidate) => candidate.testName === testName && candidate.run === run,
	);
	return found?.serial ?? null;
}

/**
 * The rows of whichever of this view's levels a node names, or `null` at a depth this view does not
 * own — a run and everything under it, which are the `All` view's levels reached through the
 * archive address (`archive-path.ts`, `archiveAddressOf`).
 *
 * One dispatcher rather than a `switch` at the call site, so the depths this view has are written
 * down once and the component drawing them holds no depth arithmetic of its own.
 */
export function groupRowsAt(
	groups: readonly ArchiveGroup[],
	node: readonly string[],
): readonly GroupRow[] | null {
	const [project, groupId, testName] = node;
	if (project === undefined) {
		return groupedProjects(groups);
	}
	if (groupId === undefined) {
		return groupsOfProject(groups, project);
	}
	if (testName === undefined) {
		return testNamesOfGroup(groups, project, groupId);
	}
	return node.length === 3 ? runsOfTestName(groups, project, groupId, testName) : null;
}

/** One run of the answer, placed: which test name it was filed under and where its contents are. */
interface PlacedRun {
	readonly testName: string;
	readonly run: string;
	readonly serial: string;
}

/**
 * Every run of one `(project, groupId)`, in the answer's own order and with its address read by
 * position.
 *
 * A run whose address is not the archive's four levels is skipped — see the module header.
 */
function runsIn(
	groups: readonly ArchiveGroup[],
	project: string,
	groupId: string,
): readonly PlacedRun[] {
	const group = groups.find(
		(candidate) => candidate.project === project && candidate.groupId === groupId,
	);
	return group === undefined ? [] : placedRunsOf(group);
}

function placedRunsOf(group: ArchiveGroup): readonly PlacedRun[] {
	return group.runs.flatMap((run) => {
		const [, testName, name, serial] = run.path;
		if (
			run.path.length !== RUN_ADDRESS_DEPTH ||
			testName === undefined ||
			name === undefined ||
			serial === undefined
		) {
			return [];
		}
		return [{ testName, run: name, serial }];
	});
}

/**
 * The distinct names one projection of the answer gives, each carrying how many **placed** runs it
 * stands over — and a name standing over none is not a row at all.
 *
 * A `Map` rather than a `Set` and a second pass, because the count and the deduplication are the
 * same walk; insertion order is what keeps the answer's own order, which is the host's fixed one
 * (`src/daemon/list-archive-groups.ts`).
 */
function counted(
	groups: readonly ArchiveGroup[],
	nameOf: (group: ArchiveGroup) => string,
): readonly GroupRow[] {
	const tally = new Map<string, number>();
	for (const group of groups) {
		const name = nameOf(group);
		tally.set(name, (tally.get(name) ?? 0) + placedRunsOf(group).length);
	}
	return rowsFrom(tally);
}

function rowsFrom(tally: ReadonlyMap<string, number>): readonly GroupRow[] {
	return [...tally]
		.filter(([, runs]) => runs > 0)
		.map(([name, runs]) => ({ name, runs, serial: null }));
}
