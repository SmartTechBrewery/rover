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
 * Whose rows are runs: 0 is the root, 1 a project, 2 a test name.
 *
 * **This is the only depth anything is reversed at, and that is unchanged by a run expanding**
 * (#159): below a run the host's own order stands, because the names in there are a verb's and
 * nothing about them is chronological the way a lease directory's leading timestamp is.
 */
const RUN_LEVEL_DEPTH = 2;
