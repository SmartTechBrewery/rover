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
	return depth === RUN_LEVEL_DEPTH ? [...entries].reverse() : entries;
}

/**
 * Whose rows are runs: 0 is the root, 1 a project, 2 a test name.
 *
 * **This is the only depth anything is reversed at, and that is unchanged by a run expanding**
 * (#159): below a run the host's own order stands, because the names in there are a verb's and
 * nothing about them is chronological the way a lease directory's leading timestamp is.
 */
const RUN_LEVEL_DEPTH = 2;
