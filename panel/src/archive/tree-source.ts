import type { ArchiveGroups } from './archive-groups.js';
import { type ArchiveLevels, levelAt, runContentsLevel } from './archive-levels.js';
import type { ArchiveEntry } from './archive-listing.js';
import { archiveAddressOf, keyOf } from './archive-path.js';
import { type ArtifactLabel, labelledArtifactsOf, NO_LABELS } from './group-labels.js';
import { groupRowsAt } from './group-tree.js';
import { mostRecentFirst, orderedEntries } from './level-order.js';

/**
 * Where the Archive screen's tree gets its rows — **the one thing the two views differ in** (#181).
 *
 * `directory-tree.tsx` draws one tree, with one row anatomy and one set of rules about what a row
 * may carry, how it expands and how clicking an open row closes it (#175). A second tree
 * implementation for the groups view is the failure mode the source exists to prevent: what a view
 * gets to decide is *which rows sit under which node* and *which route a row's address is on*, and
 * nothing else about a tree is a view's to choose.
 *
 * The interface is deliberately tiny, and every part of it is a question the component was already
 * asking `ArchiveLevels` directly:
 *
 * - **the rows at this node**, in the four states a level has — the same fold `archive-levels.ts`
 *   documents, so a source that has not answered yet says `loading` and never an empty listing;
 * - **the level a row opens**, which is what the run's `<serial>` hop was already expressed as;
 * - **the route a row's address is on**, which is the whole of the row's `<Link>` and the one thing
 *   in `Row` that could not stay literally untouched: it hardcoded `to="/archive/$"`.
 * - **the label an artifact was filed under**, and the letter its group gives it (#182) — the one
 *   addition since, and it is here rather than in the component for the reason the route is: a
 *   letter is defined only inside a group, so the `All` view's rows carry none by construction.
 *
 * **A node is an address in the tree's own space, never a host path.** In the `All` view the two
 * coincide. In the groups view a node is `<project>/<groupId>/<testName>/<run>/<serial>/<…>`, and
 * {@link archiveAddressOf} is the only thing that knows the archive address underneath it.
 */

/** The two route families a row's address can be on — a splat each, one screen component. */
export type TreeRoute = '/archive/$' | '/groups/$';

/**
 * One row, as a source answers it — and nothing more than the row is allowed to draw.
 *
 * No count, no measure, no status: `Row` refuses those unconditionally, and this shape is what
 * makes the refusal structural rather than a rule each source has to remember.
 */
export interface TreeRow {
	readonly name: string;
	/** What this row **is**, in the host's own words: a directory, a file, or *unclassified*. */
	readonly kind: ArchiveEntry['kind'];
	/** The address that selects it — a splat on {@link TreeSource.route}. */
	readonly address: readonly string[];
	/** The node it opens, or `null` when it opens nothing at all. */
	readonly opens: readonly string[] | null;
	/**
	 * The label this artifact was filed under and the letter its group gives it, or `undefined` on
	 * every row that has neither (#182).
	 *
	 * **The one thing on a row that is not true of it in both views**, and it is a *source*'s answer
	 * for the reason `route` is: a letter is defined only inside a group, so only the groups source
	 * ever sets it and the `All` view's rows are `undefined` here by construction rather than by a
	 * condition in the component. An artifact with no label is `undefined` too, so the tree of an
	 * archive that never used labels is byte for byte the tree it is today.
	 */
	readonly label?: ArtifactLabel;
}

/**
 * One node's rows, in the four states {@link ArchiveLevels} has — and for the same reasons: a node
 * nothing has answered for is `loading` and never an empty listing, and *empty* and *not readable*
 * may never render alike (D6).
 */
export type TreeLevel =
	| { readonly status: 'loading' }
	| { readonly status: 'listed'; readonly rows: readonly TreeRow[] }
	| { readonly status: 'empty' }
	| { readonly status: 'unreadable' };

export interface TreeSource {
	readonly route: TreeRoute;
	/** The rows at one node of this tree. */
	readonly rowsAt: (node: readonly string[]) => TreeLevel;
	/**
	 * Whether a node is a **run's own contents** — the one level whose two empty-handed answers are
	 * drawn in the tree rather than in the card beside it (#161), because a run's card lists
	 * nothing and the pair may never render alike.
	 */
	readonly isRunContents: (node: readonly string[]) => boolean;
	/**
	 * Whether the answer these rows come out of was cut short, so a branch may be missing.
	 *
	 * Always `false` for the `All` view: `list_archive` answers a whole level, so a level is either
	 * listed or it is not. It is the groups answer that is a bounded walk with a `truncated` flag.
	 */
	readonly truncated: boolean;
}

/** The level whose rows are runs in the `All` view — 0 is a project, 1 a test name, 2 a run. */
const RUN_ROW_DEPTH = 2;

/**
 * The first level whose listing is a run's **own** — `[…run, <serial>]`, reached by hopping the
 * serial at {@link RUN_ROW_DEPTH} rather than by descending into it.
 *
 * At and below it every entry is a row, whatever its `kind`: a file is what a reader selects in
 * order to preview it. Above it only a directory is a row, because a stray file at a project or a
 * test-name level is not something this tree can take you into.
 */
const SERIAL_DEPTH = 4;

/** The groups view's own two, which are the archive's with the group id in front of them. */
const GROUP_RUN_ROW_DEPTH = 3;
const GROUP_SERIAL_DEPTH = 5;

/**
 * The `All` view's rows: the archive's own directory levels, one `list_archive` at a time.
 *
 * This is the tree exactly as it was before there was a source — the same order, the same filter,
 * the same hop over a run's `<serial>` — expressed as an answer rather than read out of
 * `ArchiveLevels` by the component.
 */
export function allRowSource(levels: ArchiveLevels): TreeSource {
	return {
		route: '/archive/$',
		truncated: false,
		isRunContents: (node) => node.length === SERIAL_DEPTH,
		rowsAt: (node) => archiveRows(levels, node, node),
	};
}

/**
 * The groups view's rows: `group-tree.ts`'s arrangement above a run, and the `All` view's own
 * levels at and below the run's `<serial>`.
 *
 * **The delegation is the point.** Below a group the arrangement is the standard one and unchanged,
 * so the rows inside a run are the same rows the `All` view draws, listed by the same method at the
 * same address — only the splat they link to differs, which is what re-addressing them does.
 */
export function groupRowSource(groups: ArchiveGroups, levels: ArchiveLevels): TreeSource {
	return {
		route: '/groups/$',
		truncated: groups.status === 'listed' && groups.truncated,
		isRunContents: (node) => node.length === GROUP_SERIAL_DEPTH,
		rowsAt: (node) => {
			if (node.length >= GROUP_SERIAL_DEPTH) {
				/*
				 * **The badges, and they are drawn nowhere else** (#182). The letters are assigned per
				 * group, so which group this node is in is what decides them — and it is the first two
				 * components of a groups address, which is why no other source can ask for them.
				 */
				return archiveRows(levels, archiveAddressOf(node), node, labelsIn(groups, node));
			}
			if (groups.status !== 'listed') {
				// One answer feeds every level above a run, so its three other states are this
				// node's three other states — including at the root, where they are the view's own
				// empty-handed answers and the screen draws them instead of the tree.
				return groups;
			}
			const found = groupRowsAt(groups.groups, node);
			if (found === null || found.length === 0) {
				return { status: 'empty' };
			}
			/*
			 * **Most recent first at the run level, through `level-order.ts`** — the helper the `All`
			 * view's two panes already share, so the direction is decided in one place for all four.
			 * `group-tree.ts` answers in the host's own order and holds no opinion about it.
			 */
			const rows = node.length === GROUP_RUN_ROW_DEPTH ? mostRecentFirst(found) : found;
			return {
				status: 'listed',
				rows: rows.map((row) => {
					const address = [...node, row.name];
					return {
						name: row.name,
						/*
						 * **A folder, because that is what these rows are to a reader**: something
						 * with runs in it. A project is a directory on disk; a group id and — here —
						 * a test name are levels of an arrangement rather than of the filesystem,
						 * and inventing a glyph for them is what §9 forbids. Nothing about a row
						 * says which it was, because nothing about a row may say anything but its
						 * name and what opens under it.
						 */
						kind: 'directory' as const,
						address,
						/*
						 * A run opens its `<serial>` directory, which is not a level of this tree
						 * either — the same hop the `All` view makes, off a field the answer
						 * already carries rather than off a second listing's `onlyChild`.
						 */
						opens:
							node.length === GROUP_RUN_ROW_DEPTH
								? row.serial === null
									? null
									: [...address, row.serial]
								: address,
					};
				}),
			};
		},
	};
}

/**
 * The labelled artifacts of whichever group a groups-view node is in, keyed by their **archive**
 * addresses — or nothing at all, at a node no answer covers.
 *
 * A groups address leads with `<project>/<groupId>`, which is exactly the pair a group is keyed on
 * (`archive-listing.ts`), so the group is read off the node by position and never parsed out of
 * what a component says (D22).
 */
function labelsIn(
	groups: ArchiveGroups,
	node: readonly string[],
): ReadonlyMap<string, ArtifactLabel> {
	const [project, groupId] = node;
	if (groups.status !== 'listed' || project === undefined || groupId === undefined) {
		return NO_LABELS;
	}
	return labelledArtifactsOf(groups.groups, project, groupId);
}

/**
 * One `list_archive` level's rows, **addressed in whichever tree is drawing them**.
 *
 * `path` is where the level is in the archive; `node` is where it is in the tree. They are the same
 * array in the `All` view and differ by the group id in the groups view, which is why the addresses
 * are composed from `node` and the entries read at `path`.
 *
 * The level a row opens comes back from {@link levelUnder} in the archive's own addresses, so it is
 * re-addressed by the same rule: whatever it added below `path` is what it adds below `node`. That
 * is one component for an ordinary directory and two for a run — its name and its `<serial>` — and
 * neither depth is written down here.
 *
 * `labels` is keyed by the **archive** address for the same reason the entries are read at `path`:
 * the grouping answer names an artifact the way a `list_archive` walk would have reached it, so the
 * group id is not in it and a row matches by the address it is listed at rather than by the one it
 * links to. It is {@link NO_LABELS} in the `All` view, which is how that tree gains no badge without
 * anything having to say so.
 */
function archiveRows(
	levels: ArchiveLevels,
	path: readonly string[],
	node: readonly string[],
	labels: ReadonlyMap<string, ArtifactLabel> = NO_LABELS,
): TreeLevel {
	const level = levelAt(levels, path);
	if (level.status !== 'listed') {
		return level;
	}
	const depth = path.length;
	return {
		status: 'listed',
		rows: orderedEntries(level.entries, depth)
			.filter((entry) => depth >= SERIAL_DEPTH || entry.kind === 'directory')
			.map((entry) => {
				const below = levelUnder(levels, path, entry);
				return {
					name: entry.name,
					kind: entry.kind,
					address: [...node, entry.name],
					opens: below === null ? null : [...node, ...below.slice(depth)],
					label: labels.get(keyOf([...path, entry.name])),
				};
			}),
	};
}

/**
 * The level a row opens, or `null` when it opens nothing — a file, and **a run whose parent named
 * no single child**.
 *
 * A run's is the entries of its `<serial>` directory, which is not a level of this tree
 * ({@link runContentsLevel}); everywhere else a directory's is its own. This is the whole of the
 * hop, and it is what makes the recursion below a run ordinary rather than special-cased at every
 * depth under it.
 */
function levelUnder(
	levels: ArchiveLevels,
	path: readonly string[],
	entry: ArchiveEntry,
): readonly string[] | null {
	if (entry.kind !== 'directory') {
		return null;
	}
	const childPath = [...path, entry.name];
	return path.length === RUN_ROW_DEPTH ? runContentsLevel(levels, childPath) : childPath;
}
