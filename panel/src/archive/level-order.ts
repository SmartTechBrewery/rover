import type { ArchiveEntry } from './archive-listing.js';

/**
 * The order a level's entries are drawn in — **the host's own, with two named departures from it**
 * — and the one place on this screen that decides it (`docs/DESIGN.md` §9).
 *
 * At the run level it is reversed, and inside a run every directory is lifted above every file.
 * Every other level is the host's answer untouched, in the order it arrived.
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
 * **And the exceptions are here too, rather than somewhere that could disagree with them**: the
 * comparison card reads oldest → newest left to right, which is {@link oldestFirst} (#199), and a
 * run's own directories lead their level, which is {@link directoriesFirst} (#208, stated over the
 * `kind` on the wire rather than over two of the archive's names since #235). Every direction this
 * screen has is this module's, so *the host's order stands* keeps a countable list of departures
 * rather than a rule some pane quietly reversed.
 */
export function orderedEntries(
	entries: readonly ArchiveEntry[],
	depth: number,
): readonly ArchiveEntry[] {
	if (depth === RUN_LEVEL_DEPTH) {
		return mostRecentFirst(entries);
	}
	return depth === RUN_CONTENTS_DEPTH ? directoriesFirst(entries) : entries;
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
 * A run's directories first, and **everything else in the order it arrived** — #208's outcome,
 * taken from `kind` on the wire rather than from a list of names (#235).
 *
 * A run's contents level holds the archive's per-kind directories beside the sidecar files a lease
 * writes, and the host's code-unit order put `device_info.json` and `group_id.json` above them — two
 * files whose contents the card beside the tree is already drawing, sitting over the rows that are
 * the only way to reach an artifact at all.
 *
 * **What #208 got wrong is its mechanism, not its outcome, and that is reversed in place rather
 * than deleted** (`ai/RULES.md` §1, `docs/DESIGN.md` §9). It lifted the two names `screenshots` and
 * `recordings`, which said *these two kinds of thing* by naming two particular directories — so
 * `logs/`, the archive's third kind (`src/daemon/archive.ts`), stayed below the sidecar files,
 * which is the exact complaint #208 was filed about surviving for one kind in three. And it made
 * this screen know two of the archive's words, against §9's *nothing on this screen knows the word
 * `unlabeled`* and against D22, which puts `kind` on the wire precisely so that no reader has to
 * work out what a row is from its name. Stated once over `kind`, **no name is read at all** and a
 * kind the archive files next year leads the level with no edit here.
 *
 * **Within each half the host's order stands**, which is the visible change: `logs`, `recordings`,
 * `screenshots` in the host's own code-unit order, rather than `screenshots` before `recordings`
 * because a list said so. That is one fewer departure rather than a new one — and if a fixed order
 * among the artifact directories is ever wanted, the honest version is the **host** answering it,
 * since it is the one that knows what it wrote.
 *
 * **A `kind: 'other'` entry is not a directory** and lands with the files. The host names a symlink
 * or a socket rather than dropping it, so that a short listing cannot pass for a complete one
 * (`archive-listing.ts`); promoting one would be this module deciding what the host declined to.
 *
 * **Stable by construction rather than by a comparator's tie-break** — two passes over the level in
 * its own order, which is the whole of *everything else unchanged*. Files keep the answer's order
 * among themselves, directories keep theirs, and a level holding no directory at all draws exactly
 * what it draws today.
 */
function directoriesFirst(entries: readonly ArchiveEntry[]): readonly ArchiveEntry[] {
	return [
		...entries.filter((entry) => entry.kind === 'directory'),
		...entries.filter((entry) => entry.kind !== 'directory'),
	];
}

/**
 * Whose rows are runs: 0 is the root, 1 a project, 2 a test name.
 *
 * **This is the only depth anything is reversed at, and that is unchanged by a run expanding**
 * (#159): below a run nothing is chronological the way a lease directory's leading timestamp is, so
 * the direction stays the host's — what {@link RUN_CONTENTS_DEPTH} does to one level below it lifts
 * that level's directories out of that order and re-sorts nothing else.
 */
const RUN_LEVEL_DEPTH = 2;

/**
 * Whose rows are a run's own contents: `<project>/<testName>/<run>/<serial>` is four components, so
 * the level listed at that address is depth 4 — the `<serial>` being part of an address rather than
 * a level of the tree (§9).
 *
 * **It is the archive's own depth, which is what makes one number answer for both views and both
 * addresses.** Every caller passes the depth of the path the level was *listed* at — the tree's
 * `archiveRows`, and the contents card through `archiveAddressOf` — so the groups view's extra group
 * id is already out of it, and a typed `<serial>` address is the same level with the same answer.
 */
const RUN_CONTENTS_DEPTH = 4;
