import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { useSession } from '@panel/session/session-provider.js';
import { useEffect, useRef, useState } from 'react';
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
 * **There is no polling, no refresh and no deadline** (`docs/DESIGN.md` §9). The archive is
 * finished data — a run directory is written while a lease is live and nothing is added once it
 * ends — so the answer is fetched once, on the view being opened, and cached for the life of the
 * screen. That is `archive-levels.ts`'s discipline exactly, and for its reason.
 *
 * **`wanted` is what keeps the `All` view from paying for it.** Both views are one component, so
 * the hook is mounted in both; a hook that fetched on mount would spend a walk of the whole archive
 * on every reader who never opens the groups view. `false` asks for nothing and answers `loading`,
 * which nothing draws, because the `All` view reads none of this.
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

export function useArchiveGroups(wanted: boolean): ArchiveGroups {
	const { call } = useSession();
	const [groups, setGroups] = useState<ArchiveGroups>(LOADING);
	/*
	 * Whether the one call has been made. A ref rather than state for `archive-levels.ts`'s reason:
	 * React 19's StrictMode runs an effect twice on mount, and a guard that lived in state would not
	 * have been written back before the second run — two walks of the whole archive, visible in the
	 * daemon's own log.
	 */
	const asked = useRef(false);
	const live = useRef(true);

	useEffect(() => {
		live.current = true;
		if (!wanted || asked.current) {
			return () => {
				live.current = false;
			};
		}
		asked.current = true;
		void (async () => {
			const answer = await call('list_archive_groups', {});
			if (!live.current) {
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
	}, [wanted, call]);

	return groups;
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
