import type { ArchiveEntry } from './archive-listing.js';

/**
 * The order a level's entries are drawn in — **the host's own, reversed at the run level** — and the
 * one place on this screen that decides it (`docs/DESIGN.md` §9).
 *
 * **Reversing is not parsing.** The order is chronological by construction, because a lease
 * directory leads with a UTC basic-format timestamp precisely so that it sorts chronologically as
 * text (`src/daemon/archive-path.ts`, `archiveTimestamp`), and the daemon sorts in code-unit order
 * for exactly that reason (`src/daemon/list-archive.ts`). Above the run level the order stays the
 * host's, which is alphabetical.
 *
 * **Both halves of the screen call this, because they list the same directories side by side.** The
 * tree drew the host's order while the contents card reversed, so at `/archive/<project>/<test>` the
 * expanded branch and the rows beside it disagreed about which run was first — two panes a reader
 * takes for two different lists. One helper rather than a rule each pane remembers.
 *
 * **And the one exception is here too, rather than somewhere that could disagree with it**
 * (#199): the comparison card reads oldest → newest left to right, which is {@link oldestFirst}.
 * Two directions, one module, so *most recent first* stays a fact about this screen with a single
 * named departure from it and not a rule some pane quietly reversed.
 */
export function orderedEntries(
	entries: readonly ArchiveEntry[],
	depth: number,
): readonly ArchiveEntry[] {
	return depth === RUN_LEVEL_DEPTH ? mostRecentFirst(entries) : entries;
}

/**
 * The host's own order, reversed — **the whole of *most recent first*, in one place** (#181).
 *
 * The `All` view reaches it through {@link orderedEntries}, which knows the one depth a level is
 * runs at; the groups view reaches it directly, because *which level is runs* is a different
 * question there and the answer it arranges is not a listing at all. What must not differ between
 * the two is what *most recent first* means, and that is this function.
 *
 * Generic over what it is ordering for exactly that reason: the two callers hold different things,
 * and neither of them may re-decide the direction.
 */
export function mostRecentFirst<Entry>(entries: readonly Entry[]): readonly Entry[] {
	return [...entries].reverse();
}

/**
 * The other direction, and **it is the one exception to *most recent first* on this screen**
 * (#199, `docs/DESIGN.md` §9): oldest run first, so a before/after reads left to right as one.
 *
 * It exists for the comparison card and for nothing else. The tree and every level listing keep
 * {@link mostRecentFirst} unchanged, and the reason both live here is the reason `orderedEntries`
 * does: the direction is this module's to decide, so a pane that wanted the other one asks for it
 * by name rather than reversing something itself.
 *
 * **A sort rather than a reversal**, because a *group's* runs are not in chronological order to
 * begin with. `list_archive_groups` walks a group's test names in name order and each test name's
 * runs chronologically inside it (`src/daemon/list-archive-groups.ts`, `group-tree.ts`), and a
 * group's whole point is that its arms are sibling test names — so `mostRecentFirst` reversed
 * would order the arms by name and only then by time.
 *
 * **Sorting is not parsing** (D22). The key is the run directory's own name in **code-unit** order,
 * which is chronological by construction for the reason stated above: a lease directory leads with
 * a UTC basic-format timestamp precisely so that it sorts chronologically as text. No component is
 * decomposed and no `Date` is constructed. **Never `localeCompare`** — the order must not depend on
 * the reader's locale, and code-unit order is the one the host itself sorts in. `Array.sort` is
 * stable, so two items whose keys compare equal keep the answer's own order.
 */
export function oldestFirst<Item>(
	items: readonly Item[],
	nameOf: (item: Item) => string,
): readonly Item[] {
	return [...items].sort((left, right) => {
		const a = nameOf(left);
		const b = nameOf(right);
		return a < b ? -1 : a > b ? 1 : 0;
	});
}

/**
 * Whose rows are runs: 0 is the root, 1 a project, 2 a test name.
 *
 * **This is the only depth anything is reversed at, and that is unchanged by a run expanding**
 * (#159): below a run the host's own order stands, because the names in there are a verb's and
 * nothing about them is chronological the way a lease directory's leading timestamp is.
 */
const RUN_LEVEL_DEPTH = 2;
