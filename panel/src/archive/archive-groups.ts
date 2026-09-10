import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { useSession } from '@panel/session/session-provider.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ArchiveGroup, ListArchiveGroupsResultSchema } from './archive-listing.js';

/**
 * The groups view's data: **one `list_archive_groups` call, and the whole arrangement above a run
 * comes out of it** (#181, R41).
 *
 * `useArchiveLevels` asks the host once per level because `list_archive` answers one directory at a
 * time. This method answers the grouping of the whole archive in one bounded walk, so there is one
 * request here and no shape in which a second could be made: no key, no filter, no page. The levels
 * are `group-tree.ts`'s pure functions over the answer, and only *inside* a run does the groups
 * view fall back to `useArchiveLevels`, at and below the `<serial>`.
 *
 * **This walk is deliberately not on the clock the levels are now on** (#287, `docs/DESIGN.md`
 * §9) — rewritten in place with its reason rewritten (`ai/RULES.md` §1), the old one having been
 * *there is no polling, no refresh and no deadline, because the archive is finished data: a run
 * directory is written while a lease is live and nothing is added once it ends*. That premise was
 * false for exactly the window #287 is about, and `archive-levels.ts` re-reads its drawn levels
 * while a lease is live. This answer still does not, and the reason is now its own: it is a
 * **bounded walk of the whole archive** rather than one `readdir`, so its cadence is a decision
 * with its own cost — and *a poll must never walk the archive* is the one thing #287's criteria
 * forbid outright. So the answer is fetched once, on the view being opened, and cached for the life
 * of the screen.
 *
 * **The cost, stated rather than hidden, and it is a known gap**: while a lease is live the groups
 * view's arrangement above a run goes stale, and a run that lands is seen there on the reader's
 * next navigation. Giving this walk a cadence of its own is #287's phase 2, and nothing here should
 * be given one before that decision is made.
 *
 * **`wanted` is what keeps the `All` view from paying for it.** Both views are one component, so
 * the hook is mounted in both; a hook that fetched on mount would spend a walk of the whole archive
 * on every reader who never opens the groups view. `false` asks for nothing and answers `loading`,
 * which nothing draws, because the `All` view reads none of this.
 *
 * **And it walks again when this screen has itself changed what is filed** (#277) — amended in
 * place, exactly as `archive-levels.ts` was amended for the same reason (`ai/RULES.md` §1).
 * {@link ArchiveGroupsHook.reread} is **not** a refresh control and is not reachable as one: it has
 * one caller and one trigger, a settled `Remove` on a group's card (`routes/archive.tsx`). The
 * groups view draws its whole arrangement above a run out of this one answer, so a delete that took
 * a group's runs has changed every level of it — and asking the host again is the same *re-read
 * rather than assume* rule the level cache keeps, for the same reason: editing the answer in hand
 * would draw an arrangement nothing on the host ever answered with, and it would be wrong in both
 * directions, a `partial` having possibly left runs exactly where they were and a `not-found`
 * proving the answer being edited was already stale.
 */

/**
 * What the answer is, and it is four states rather than the host's three — `archive-levels.ts`'s
 * fold, applied to this method.
 *
 * - **`missing` folds into `empty`.** *Nothing has ever been archived on this host* and *nothing on
 *   this host named a group* are the same sentence to a reader standing in a view that draws
 *   groups: there is no group here, and what would change it is the same thing.
 * - **`listed` with no groups is `empty` too**, for that reason — but **`truncated` rides on it**,
 *   because a walk that was cut short has not established that nothing named a group. *No lease
 *   named a group* and *no lease named a group in the part of the archive that could be examined*
 *   are two different claims, and only the first is a definitive one. There is no arrangement to
 *   draw a truncation line beside in this state, so the flag changes the sentence instead — which
 *   is exactly what `Searched` in `directory-tree.tsx` already does for an empty search result
 *   (#189 review).
 * - **Everything unusable folds into `unreadable`** — an `error` envelope, a result this panel
 *   cannot parse, and a request nothing answered. The state whose copy is true either way.
 * - **A `refused` sets nothing.** `Session.call` has already fired `onRefusal` and the router is
 *   coming down; *not readable* would be the panel's last word being the wrong one.
 *
 * `truncated` rides on `listed` and on `empty` alike because it is a claim about the answer, not
 * about the arrangement: at least one directory that exists was not fully examined, so a group, a
 * run or a labelled artifact may be missing. On `listed` that makes a partial arrangement say so
 * above its rows; on `empty` it makes the screen stop short of a negative nobody established.
 */
export type ArchiveGroups =
	| { readonly status: 'loading' }
	| {
			readonly status: 'listed';
			readonly groups: readonly ArchiveGroup[];
			readonly truncated: boolean;
	  }
	| { readonly status: 'empty'; readonly truncated: boolean }
	| { readonly status: 'unreadable' };

const LOADING: ArchiveGroups = { status: 'loading' };

/** What the screen has, and the one way it asks for the whole arrangement again. */
export interface ArchiveGroupsHook {
	readonly groups: ArchiveGroups;
	/**
	 * Walk the archive's groupings once more, because this screen has changed what is filed.
	 *
	 * **The whole answer and not one group**, which is what a delete of a group's runs needs: the
	 * group that went is not the only level it appears in — its project's row counts it, and a test
	 * name it emptied is a row of its own. One request is the whole arrangement here, so asking
	 * again is both the cheapest and the only correct shape.
	 *
	 * A re-read that answers `unreadable` **replaces the answer**, and that is correct rather than a
	 * regression: it is the host's answer to the question the screen just asked, and holding on to
	 * an arrangement the host will no longer confirm would draw groups it has no current evidence
	 * for.
	 */
	readonly reread: () => void;
}

export function useArchiveGroups(wanted: boolean): ArchiveGroupsHook {
	const { call } = useSession();
	const [groups, setGroups] = useState<ArchiveGroups>(LOADING);
	/*
	 * **How many walks have been asked for**, which is deliberately a nonce in the effect's
	 * dependency list rather than a mutation of the guard below — `archive-levels.ts`' shape
	 * verbatim, and for its reason: a re-read implemented by clearing the guard would depend on a
	 * re-render arriving between the clear and the next effect run, and it would put the guard's own
	 * meaning in two places.
	 */
	const [nonce, setNonce] = useState(0);
	/*
	 * Which nonce the one call has been made for. A ref rather than state for `archive-levels.ts`'s
	 * reason: React 19's StrictMode runs an effect twice on mount, and a guard that lived in state
	 * would not have been written back before the second run — two walks of the whole archive,
	 * visible in the daemon's own log.
	 */
	const asked = useRef<number | null>(null);
	const live = useRef(true);

	useEffect(() => {
		live.current = true;
		if (!wanted || asked.current === nonce) {
			return () => {
				live.current = false;
			};
		}
		asked.current = nonce;
		void (async () => {
			const answer = await call('list_archive_groups', {});
			/*
			 * A superseded answer lands on nothing, `archive-levels.ts`' rule: the answers of two
			 * walks are not ordered by the requests that asked for them, so the later request's
			 * answer arriving first would otherwise let the earlier one overwrite it — an
			 * arrangement from before the delete, drawn after the one from after it.
			 */
			if (!live.current || asked.current !== nonce) {
				return;
			}
			const state = read(answer);
			if (state !== undefined) {
				setGroups(state);
			}
		})();
		return () => {
			live.current = false;
		};
	}, [wanted, call, nonce]);

	/*
	 * Stable across renders, and the updater form is what makes that stability safe —
	 * `archive-levels.ts`' recorded reason: `nonce + 1` inside a callback with an empty dependency
	 * list would read the nonce of the render that built it, so every re-read after the first would
	 * set a value the state already held and the effect would never run again.
	 */
	const reread = useCallback(() => {
		setNonce((previous) => previous + 1);
	}, []);

	return { groups, reread };
}

/** One answer, mapped onto {@link ArchiveGroups} — or nothing at all, for a `refused`. */
function read(answer: HostAnswer<RpcEnvelope>): ArchiveGroups | undefined {
	if (!answer.ok) {
		return answer.refusal === 'unanswered' ? ({ status: 'unreadable' } as const) : undefined;
	}
	const parsed =
		answer.value.type === 'result'
			? ListArchiveGroupsResultSchema.safeParse(answer.value.result)
			: undefined;
	if (parsed === undefined || !parsed.success) {
		return { status: 'unreadable' } as const;
	}
	if (parsed.data.outcome === 'unreadable') {
		return { status: 'unreadable' } as const;
	}
	if (parsed.data.outcome === 'missing') {
		// Nothing has ever been archived here, so nothing was cut short either.
		return { status: 'empty', truncated: false } as const;
	}
	if (parsed.data.groups.length === 0) {
		return { status: 'empty', truncated: parsed.data.truncated } as const;
	}
	return {
		status: 'listed',
		groups: parsed.data.groups,
		truncated: parsed.data.truncated,
	} as const;
}
