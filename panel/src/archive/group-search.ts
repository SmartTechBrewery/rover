import type { ArchiveGroups } from './archive-groups.js';
import { groupsAddressOf, keyOf } from './archive-path.js';
import type { ArchiveSearchState } from './archive-search.js';
import { groupIdsByRun, RUN_PREFIX_DEPTH } from './group-tree.js';

/**
 * The tree card's search, **restricted to what the groups view can address** (#207, R38, R41,
 * `docs/DESIGN.md` §9).
 *
 * The groups view had no field, and the reason recorded in three places was about *addresses*:
 * `search_archive` answers addresses of the archive, which that arrangement does not own, so a hit
 * found from there would have nowhere in it to land. **That is reversed here, because an address
 * composes**: `archiveAddressOf` drops the group id on the way down and {@link groupsAddressOf} puts
 * it back on the way up, so a match under a grouped run has an address in this arrangement after
 * all. And it is the view where the work happens — the comparison card and the label badges live
 * here and nowhere else — so finding one screen in a nine-label group was browsing, every time.
 *
 * **Panel-side, and that is the whole shape of it.** The groups view already fetches
 * `list_archive_groups` for the tree it draws, so *which runs are grouped* is a question the panel
 * can already answer without asking the host anything new: this intersects the two answers it holds
 * and re-addresses the survivors. No `groupsOnly` key on `search_archive` — a caller-settable bound
 * is precisely the parameter D24 refused — no second method, and nothing on the wire changes.
 *
 * **Pure — no React, no session, no request**, like `group-tree.ts` and `search-tree.ts` beside it,
 * and unit-tested on its own.
 *
 * **What is drawn.** A match is an archive address, `[project, testName, run, serial, …]`. A match
 * at or below a run the grouping answer holds becomes `[project, groupId, …the rest]`; a match on a
 * run that named no group is dropped, and so is one shallower than a run — a test name lives under
 * any number of groups, so *which group* has no honest answer for it. A project with no grouped run
 * is therefore never on any surviving path, which is the same absence this view already has when
 * browsing.
 *
 * **The levels above a hit are not synthesised here.** `hitTree` (`search-tree.ts`) makes a node
 * exactly where a match's path runs through it, so re-addressing the matches *before* the tree is
 * built gives project → group → test name → run → … ancestors with no other change, and a branch
 * holding no match is still not drawn. The order stays the answer's own; nothing here re-sorts.
 *
 * **`truncated` is the OR of the two walks, and that is the binding criterion.** It keeps its one
 * meaning — *at least one directory that exists was not fully examined* — now across the two bounded
 * answers this is assembled from. Either being short sets it, so the definitive negative is never
 * said about an answer either walk cut short, and a hit whose run fell out of a truncated grouping
 * answer does not vanish silently: the flag is set and the sentence beside the hits says so
 * (`directory-tree.tsx`). One flag rather than two, because both causes lead to the same claim —
 * *this answer is short* — and what differs is the sentence, which is the view's.
 *
 * **The stated cost.** `search_archive` walks the whole archive and caps matches at 200, so some of
 * that cap is spent here on matches under runs that named no group and are then dropped: a host with
 * many ungrouped runs reaches `truncated` sooner in this view than in the `All` view. That is what
 * the narrowed sentences are for, and it is recorded in §9 rather than hidden. A host-side method
 * answering one bounded walk with the group already in the address is the recorded follow-up if it
 * ever becomes intolerable; it is deliberately not built here.
 *
 * **No fifth state and no new vocabulary.** The grouping answer's four states fold into the
 * search's four: the panel has not got the answer it needs to restrict (`loading`) is *searching*,
 * an unreadable grouping walk is the `failed` that already folds everything unusable, and an empty
 * grouping answer is *nothing matched* carrying its own truncation.
 */
export function groupedSearch(
	state: ArchiveSearchState,
	groups: ArchiveGroups,
): ArchiveSearchState {
	if (state.status !== 'searched') {
		// `idle`, `searching` and `failed` are about the search itself and say the same thing in both
		// views — there is nothing to restrict yet, or nothing usable to restrict.
		return state;
	}
	if (groups.status === 'loading') {
		/*
		 * The search has answered and the grouping walk has not, so the panel cannot yet say which of
		 * these matches this arrangement owns. It is still one quiet line and no spinner, and it is
		 * reachable: a deep group address draws the tree while the grouping walk is still out.
		 */
		return { status: 'searching' };
	}
	if (groups.status === 'unreadable') {
		// *The host could not search the archive* is true of this too — it is the state that folds
		// everything unusable, and one of the two answers this needs is unusable.
		return { status: 'failed' };
	}
	const truncated = state.truncated || groups.truncated;
	if (groups.status === 'empty') {
		// Nothing on this host named a group, so nothing in this arrangement contains that text.
		return { status: 'searched', matches: [], truncated };
	}
	const groupIds = groupIdsByRun(groups.groups);
	const matches = state.matches.flatMap((match) => {
		if (match.path.length < RUN_PREFIX_DEPTH) {
			return [];
		}
		const groupId = groupIds.get(keyOf(match.path.slice(0, RUN_PREFIX_DEPTH)));
		/*
		 * The `<serial>` is deliberately not checked, only the run: a group is a property of the run,
		 * and a stray entry beside the `<serial>` is still an address `archiveAddressOf` turns back
		 * into the archive's own.
		 */
		return groupId === undefined
			? []
			: [{ ...match, path: [...groupsAddressOf(groupId, match.path)] }];
	});
	return { status: 'searched', matches, truncated };
}
