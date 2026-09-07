import { useState } from 'react';
import { keyOf, levelsOf } from './archive-path.js';

/**
 * Which branches of the Archive screen's tree are **open** — the state `docs/DESIGN.md` §9's
 * derived-expansion rule refused, and #198 put back with the guarantee that rule was protecting
 * kept intact.
 *
 * **Expansion was derived entirely from the selection**: a node was expanded exactly when it was a
 * prefix of the selected path, and the selected node too. One selection is one path, so only one
 * branch could be open at a time and opening a second top-level row closed the first — not a defect
 * in that rule but its exact consequence, and it made a reader comparing two projects rebuild the
 * tree they had every time they crossed between them.
 *
 * **So there is an open set now, and the derived rule survives as a floor under it** (#198):
 *
 * - a node is drawn expanded when it is **in the open set** *or* it is a **strict** ancestor of the
 *   selection ({@link expandedIn}). The open set can only ever *add* to what the old rule drew;
 * - so **the selection is always drawn in the tree.** Every ancestor of it is expanded whatever the
 *   set holds, which is the one thing #175 refused to give up and the whole reason the tree stands
 *   beside an open file (#160). A closed ancestor with the card still drawing the file underneath it
 *   is unreachable by construction rather than by care;
 * - and the set grows **only** by a click on a row, so the number of levels read stays bounded by
 *   the reader's gestures and never by what is in the archive.
 *
 * **A click on a row toggles that row's branch, and the target of the click is what makes closing
 * work** — the same trick #175 used, one node lower. A row always links to its **own** address, so
 * a click on an open row lands *on* it: it stops being a strict ancestor of the selection, the floor
 * stops applying to it, and the removal from the set is what the tree then draws. So closing an
 * ancestor of the selection still moves the selection — up to **that node**, whose own contents the
 * card beside the tree then draws, which is the cost §9 states rather than hides.
 *
 * **The set is component state and is deliberately not in the address** (§9), which is the exception
 * the tree card's search text already is (#146, `archive-search.ts`). A reload and a shared link land
 * on the *address*, without somebody else's browsing, and the tree they land on is the one the
 * derived rule drew — because that is exactly what {@link openedBy} seeds the set with.
 */
export type OpenNodes = ReadonlySet<string>;

/** What the tree is handed: whether a node is drawn open, and what a click on its row does. */
export interface OpenBranches {
	/** Whether this node's level is drawn under its row — the open set, over the floor. */
	readonly isOpen: (address: readonly string[]) => boolean;
	/** One click on a row: drawn shut, it opens; drawn open, it closes. */
	readonly toggle: (address: readonly string[]) => void;
}

/**
 * The set an address arrives with — every prefix of the selection **including the selection itself**,
 * which is the derived rule's own answer written down as state.
 *
 * So a reload and a shared link draw the tree #175 drew for that address: the branch the selection is
 * in open all the way down, and nothing else. Whether the set itself survives a reload is settled in
 * §9 and this is the settlement: it does not, and what stands in for it is that the address is enough
 * to rebuild the one branch the reader was in.
 *
 * The root is in it and drawing does not consult it there — the root's level is always drawn — but a
 * seed that named every prefix except one would be a rule with an exception in it.
 */
export function openedBy(selected: readonly string[]): OpenNodes {
	return new Set(levelsOf(selected).map(keyOf));
}

/**
 * Whether a node is **drawn** expanded: it is in the open set, or it is a strict ancestor of the
 * selection.
 *
 * *Strict* is the whole of the second clause. An ancestor of the selection has to be open for the
 * selection to be visible at all, so no gesture may leave one shut; the selected node itself has no
 * such obligation, which is what lets a second click close it (see {@link toggled}).
 *
 * The comparison is `keyOf` over a slice rather than a loop, exactly as the derived rule was: a
 * component is opaque (D22) and `keyOf` is injective over the components a listing can name.
 */
export function expandedIn(
	open: OpenNodes,
	selected: readonly string[],
	address: readonly string[],
): boolean {
	return (
		open.has(keyOf(address)) ||
		(address.length < selected.length &&
			keyOf(selected.slice(0, address.length)) === keyOf(address))
	);
}

/**
 * The set after one click on a row: what was drawn open closes, and what was drawn shut opens.
 *
 * **It turns on the *drawn* state and not on membership**, because the two differ on exactly the
 * rows a reader is most likely to close — an ancestor of a selection that arrived by a deep link or
 * a search hit is drawn open by the floor with nothing in the set to remove. Keying the toggle on
 * membership would *add* such a row and draw it open twice over.
 *
 * `maxDepth` is the deepest address this view's URL can carry (`componentsFromSplat`), and a row
 * past it is **not opened**: its click truncates to an address it is not, so it cannot be selected
 * either, and the level under it is one `list_archive` refuses (`MAX_ARCHIVE_PATH_DEPTH`). Drawing a
 * triangle over a level nobody can reach is the same class of claim as an invented `0`. Closing is
 * never capped — a set that cannot be emptied of a key would be worse than one that never took it.
 */
export function toggled(
	open: OpenNodes,
	selected: readonly string[],
	address: readonly string[],
	maxDepth: number,
): OpenNodes {
	if (expandedIn(open, selected, address)) {
		const next = new Set(open);
		next.delete(keyOf(address));
		return next;
	}
	if (address.length > maxDepth) {
		return open;
	}
	return new Set(open).add(keyOf(address));
}

/**
 * The open set as the Archive screen holds it — **above the tree card**, for the reason the search
 * text is held there (`routes/archive.tsx`): the levels asked for are the levels the tree draws, so
 * the thing that decides which those are has to be visible to `levelsWanted` and not only to the
 * component that draws them.
 *
 * Seeded from the address the screen mounted at and never re-seeded, so navigating within a view
 * accumulates rather than resets — that is the whole of what #198 changes for a reader. Switching
 * views remounts the screen (§9), which reseeds it from that view's own address.
 */
export function useOpenBranches(selected: readonly string[], maxDepth: number): OpenBranches {
	const [open, setOpen] = useState<OpenNodes>(() => openedBy(selected));
	return {
		isOpen: (address) => expandedIn(open, selected, address),
		toggle: (address) => setOpen((current) => toggled(current, selected, address, maxDepth)),
	};
}
