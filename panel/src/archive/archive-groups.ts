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
 * **This walk is on a clock of its own, and deliberately not the one the listings are on** (#288,
 * `docs/DESIGN.md` §9) — rewritten in place with its reason rewritten (`ai/RULES.md` §1), twice
 * over now. It first read *there is no polling, no refresh and no deadline, because the archive is
 * finished data*; #287 replaced that with *the levels are on a clock and this answer still is not,
 * because it is a bounded walk of the whole archive rather than one `readdir`*, and named the gap
 * it left. That second reason was a reason for a **different cadence**, not for none: every level
 * of the groups view above a run — project, group, test name, and the run rows under them — is
 * `group-tree.ts`'s pure function over this one answer, so a walk taken once per screen is a run
 * landing under the group the reader is looking at and never appearing. So the walk is taken when
 * the view is opened and taken again every {@link GROUPS_WALK_MS} for as long as `writing` says a
 * lease is live (`live-writes.ts`) — six times the listings' interval, because the two answers cost
 * different things.
 *
 * **The clock is the nonce, not a second mechanism** — `archive-levels.ts`' shape verbatim. A tick
 * is *walk the archive's groupings again*, which is precisely what {@link ArchiveGroupsHook.reread}
 * already means, so incrementing the same nonce keeps StrictMode's double mount at one walk and
 * keeps a superseded answer landing on nothing. No second cache, and nothing that clears `asked`.
 *
 * **And a walk is invisible until it lands.** The arrangement is untouched until an answer arrives,
 * so a view that has one never falls back to *Reading the testing groups on this host's archive.*,
 * and the selection, the open branches, the search text and the scroll position are state no answer
 * writes. See the `unanswered` branch in the effect for what a missed budget does and does not
 * replace.
 *
 * **`wanted` is what keeps the `All` view from paying for it.** Both views are one component, so
 * the hook is mounted in both; a hook that fetched on mount would spend a walk of the whole archive
 * on every reader who never opens the groups view. `false` asks for nothing, runs no clock and
 * answers `loading`, which nothing draws, because the `All` view reads none of this.
 *
 * **And it walks again when this screen has itself changed what is filed** (#277) — amended in
 * place, exactly as `archive-levels.ts` was amended for the same reason (`ai/RULES.md` §1).
 * {@link ArchiveGroupsHook.reread} is **not** a refresh control and is not reachable as one, and
 * neither is the clock: the re-read has one caller and one trigger, a settled `Remove` on a group's
 * card (`routes/archive.tsx`), and the tick has no caller at all. The groups view draws its whole
 * arrangement above a run out of this one answer, so a delete that took a group's runs has changed
 * every level of it — and asking the host again is the same *re-read rather than assume* rule the
 * level cache keeps, for the same reason: editing the answer in hand would draw an arrangement
 * nothing on the host ever answered with, and it would be wrong in both directions, a `partial`
 * having possibly left runs exactly where they were and a `not-found` proving the answer being
 * edited was already stale.
 */

/**
 * How often the archive's groupings are walked again while it is being written (#288).
 *
 * **Thirty seconds — six times the listings' `ARCHIVE_POLL_MS`, and the asymmetry is the point.**
 * `list_archive` is one `readdir` of one directory the reader is looking at; this method is a
 * **bounded walk of the whole archive** (R41, `src/daemon/list-archive-groups.ts`), which is
 * exactly what #287's *a poll must never walk the archive* was about. Two answers that cost
 * different things cannot share a cadence, so they do not: the listings buy *a run appears within
 * five seconds* cheaply, and this buys *a run appears in its group's arrangement* at a price that
 * has to be paid rarely.
 *
 * **The cost, stated rather than hidden**: one bounded whole-archive walk per thirty seconds, and
 * only while a lease is live **and** the groups view is open — against one `readdir` per drawn
 * level per five seconds for the listings. A reader in the `All` view pays nothing at all, and so
 * does a reader in either view while no lease is live. What that leaves is stated too: the groups
 * view's arrangement is up to thirty seconds behind the `All` view's, so a run that has already
 * appeared in a listing can be a few ticks away from appearing under its group.
 *
 * **The alternative considered and rejected**: a host method answering *one group's runs*, which
 * would make the refresh proportional to what the reader has open rather than to the archive, and
 * would carry a cadence closer to the listings'. That is **a new host method**, and a new host
 * method was out of #287's scope by the issue's own words — so it is a second issue and not a
 * decision to take here. Nothing about this constant precludes it: the cadence is a panel-side
 * decision that gets cheaper if the method it asks ever does.
 *
 * **No leading tick and no trailing one**, for `ARCHIVE_POLL_MS`' own reasons. The first fire is
 * one cadence after the gate opens, because opening the view has just walked the archive. And the
 * gate follows a `list_devices` answer that lags the host by up to one device-poll interval, so the
 * clock runs a few seconds past the real end of a lease, which covers the last writes; a grouping
 * that changes after that is seen on the reader's next navigation.
 */
export const GROUPS_WALK_MS = 30_000;

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

/**
 * @param wanted whether this view reads the arrangement at all — `false` in the `All` view, which
 *   asks for nothing and runs no clock.
 * @param writing whether anything is being written into the archive, which is what runs the clock
 *   (`live-writes.ts`). **Required, with no default**, so no call site is silently opted out and the
 *   tests that pin *one walk per screen* have to say `false` out loud.
 */
export function useArchiveGroups(wanted: boolean, writing: boolean): ArchiveGroupsHook {
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
	/*
	 * **Whether a *budgeted* walk is still out**, which is what a tick is dropped for (#125, #288).
	 * A tick arriving while the last walk has not answered is dropped rather than queued, so a host
	 * slower than the interval cannot have whole-archive walks stacked on it — and this guard is
	 * **bounded**, by the deadline that walk carries. An unbounded one is what #125 was on the
	 * Devices screen: one request the host accepted and never answered held it for the life of the
	 * tab.
	 *
	 * A boolean rather than `archive-levels.ts`' count, because a tick here is exactly one request:
	 * the whole arrangement is one answer, which is this method's own shape (#181).
	 *
	 * Only a gated walk enters it, because only a gated walk has a deadline (#289 review). A walk
	 * issued while no lease was live has none — nothing was going to ask again when it went out — so
	 * counting it would let one such walk, still out when a lease starts, drop every tick for the
	 * rest of the tab: the same unbounded guard, reached through the gate opening rather than
	 * through the clock.
	 */
	const outstanding = useRef(false);

	useEffect(() => {
		live.current = true;
		if (!wanted || asked.current === nonce) {
			return () => {
				live.current = false;
			};
		}
		asked.current = nonce;
		if (writing) {
			outstanding.current = true;
		}
		void (async () => {
			const budget = budgetFor(writing);
			try {
				const answer = await call('list_archive_groups', {}, budget.signal);
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
				if (state === undefined) {
					return;
				}
				/*
				 * **A walk nothing answered inside its budget leaves an arrangement that already has
				 * one exactly where it is** (#288), and it is asked again on the next tick. That is not
				 * news about the archive: what is drawn is still the last thing the host confirmed, and
				 * replacing it with *not readable* over a walk that timed out would make a refresh
				 * visible as a regression — and this answer is the whole arrangement, so it would take
				 * the tree, the card and the reader's place with it. A view with nothing yet still
				 * lands on `unreadable`, which is where it landed before there was a clock. The host's
				 * **own** `unreadable` still replaces in either case — that is the host answering the
				 * question the screen asked (#277). `!answer.ok` here is exactly
				 * `refusal === 'unanswered'`, a `refused` having already returned `undefined` above,
				 * and an abort arrives as an `unanswered` by contract (`host-client.ts`).
				 */
				const unanswered = !answer.ok;
				setGroups((previous) => (unanswered && previous.status !== 'loading' ? previous : state));
			} finally {
				/*
				 * The budget is released in `finally` and **nowhere else**: releasing it when the
				 * deadline fires would let the abandoned walk's answer land after the next tick's good
				 * one. Aborting is enough, because an aborted `fetch` rejects promptly.
				 */
				budget.release();
				if (writing) {
					outstanding.current = false;
				}
			}
		})();
		return () => {
			live.current = false;
		};
		// `writing` is here because it decides whether the walk this run makes carries a budget
		// (#289 review), not because the gate is a reason to walk anything: a run triggered by the
		// gate alone asks for nothing, this nonce already being the one `asked` has served.
	}, [wanted, call, nonce, writing]);

	/*
	 * Stable across renders, and the updater form is what makes that stability safe —
	 * `archive-levels.ts`' recorded reason: `nonce + 1` inside a callback with an empty dependency
	 * list would read the nonce of the render that built it, so every re-read after the first would
	 * set a value the state already held and the effect would never run again.
	 */
	const reread = useCallback(() => {
		setNonce((previous) => previous + 1);
	}, []);

	/**
	 * One turn of the clock — **the same walk `reread` makes**, which is why it moves the same nonce
	 * and there is no second mechanism (#288).
	 *
	 * A tick arriving while the last walk is still out is **dropped rather than queued** (#125): the
	 * nonce does not move, so nothing is asked, and a host slower than thirty seconds is never
	 * walking the archive twice at once. What makes that safe is the deadline that walk carries — it
	 * is only ever as temporary as its own budget, so a host that stops answering costs one tick and
	 * then recovers on its own.
	 */
	const tick = useCallback(() => {
		if (outstanding.current) {
			return;
		}
		setNonce((previous) => previous + 1);
	}, []);

	/*
	 * **Two gates, and both of them shut is the common case.** No lease live is no interval, so the
	 * idle cost of this hook is exactly what it was before there was a clock; and the `All` view is
	 * no interval either, which is `wanted`'s own rule extended to the clock — a reader who never
	 * opens the groups view must not spend a walk of the whole archive on it, and a tick they cannot
	 * see is exactly such a walk.
	 */
	useEffect(() => {
		if (!wanted || !writing) {
			return;
		}
		const walking = setInterval(tick, GROUPS_WALK_MS);
		return () => clearInterval(walking);
	}, [wanted, writing, tick]);

	return { groups, reread };
}

/**
 * **A budget only where a clock will retry** (#125, #288): `writing` is what the tick is gated on,
 * so it is what the deadline is gated on too — `archive-levels.ts`' rule, at this method's own
 * cadence.
 *
 * With the gate open a walk is abandoned after one tick's length, which is what keeps the
 * outstanding-walk guard bounded. With it shut there is no signal at all — the behaviour this hook
 * had before #288, and the behaviour every other one-shot read on this screen has — because
 * abandoning a walk the host was merely slow to produce would cache *not readable* over the whole
 * arrangement with nothing left to ask again. Thirty seconds is a generous budget for a walk of the
 * archive on purpose: it is the cadence, and a deadline shorter than the interval would abandon
 * walks a slower host would have finished.
 *
 * `setTimeout` rather than `AbortSignal.timeout`, so the panel suite's fake timers can advance to
 * the deadline instead of waiting it out — `device-list-provider.tsx`'s own recorded reason, and
 * `tests/unit/no-sleep.test.ts`'s.
 */
function budgetFor(writing: boolean): {
	readonly signal?: AbortSignal;
	readonly release: () => void;
} {
	if (!writing) {
		return { release: () => undefined };
	}
	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), GROUPS_WALK_MS);
	return { signal: controller.signal, release: () => clearTimeout(deadline) };
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
