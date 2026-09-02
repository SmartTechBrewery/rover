import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { useSession } from '@panel/session/session-provider.js';
import { useEffect, useRef, useState } from 'react';
import { type ArchiveSearchMatch, SearchArchiveResultSchema } from './archive-listing.js';

/**
 * The tree card's search — one `search_archive` per settled text, and never one per keystroke
 * (#146, R38).
 *
 * **The text is component state and is deliberately not in the address.** It is the one piece of
 * this screen's state that is not (`archive-path.ts`, `routes/archive.tsx`): a reload and a shared
 * link land on the *address*, without somebody else's search, and the tree and the address still
 * cannot disagree about **where you are** — a hit navigates, and the address is what it navigates
 * to.
 *
 * **One request per settled text.** The debounce is a {@link SEARCH_DEBOUNCE_MS} timer in an
 * effect, so typing inside the window issues nothing; when it fires, the request that goes out
 * carries an id, and an answer whose id is no longer the current one is **dropped** rather than
 * rendered. That is `archive-levels.ts`'s `live` ref discipline with a counter instead of a
 * boolean, and it is the whole of *answers to superseded text are dropped*: a slow answer for `log`
 * must not land on top of a fast one for `login`.
 *
 * **Empty text is `idle` and issues nothing**, which is also what clearing the field does — the
 * tree goes straight back to the levels the URL describes, with no request spent saying so.
 *
 * **There is no polling and no refresh** (`docs/DESIGN.md` §9). The archive is finished data, so a
 * search is fetched when the text settles and not again.
 *
 * **No `AbortSignal`**, for the reason `host-client.ts` gives: a budget belongs to a repeating
 * caller with an interval to spend, and this caller has neither. A superseded answer is dropped on
 * arrival instead, which is what the id is for.
 *
 * **And no `live` ref beside it**, which is the one thing here that `archive-levels.ts` has and this
 * does not: the id already subsumes it. Unmounting clears the pending timer, and an answer that
 * outlives its own text is dropped whether the text moved on or the screen did. StrictMode's double
 * mount costs nothing either — the text starts empty, and the empty branch asks for nothing.
 */

/**
 * How long the text has to sit still before the host is asked.
 *
 * Long enough that a typed word is one request rather than five, short enough that it does not read
 * as a control that has stopped responding. It is a constant rather than an option: the panel has
 * one search field, and a caller-settable debounce would be a second place this decision lives.
 */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * What the search is, and it is four states rather than the host's three.
 *
 * - **`idle`** — no text, so nothing has been asked and the tree is the URL's own.
 * - **`searching`** — one request is out. One quiet line, no spinner (§5).
 * - **`searched`** — the host answered. `matches: []` is *nothing matched* and is not a failure,
 *   and **host `missing` folds into it**: nothing filed on this host is nothing matched, which is
 *   the same fold `archive-levels.ts` makes at a level.
 * - **`failed`** — everything unusable, folded: an `error` envelope, a result this panel cannot
 *   parse, a request nothing answered, and the host's own `unreadable`. What the card has to decide
 *   is narrower than why, and *the host could not search the archive* is true of every one of them.
 *
 * A **`refused`** sets nothing at all, because `Session.call` has already fired `onRefusal` and the
 * router is coming down — the panel's last word must not be a failed search.
 */
export type ArchiveSearchState =
	| { readonly status: 'idle' }
	| { readonly status: 'searching' }
	| {
			readonly status: 'searched';
			readonly matches: readonly ArchiveSearchMatch[];
			readonly truncated: boolean;
	  }
	| { readonly status: 'failed' };

export interface ArchiveSearch {
	/** What is in the field, verbatim — the panel neither trims it nor folds its case. */
	readonly text: string;
	readonly setText: (text: string) => void;
	readonly state: ArchiveSearchState;
}

const IDLE: ArchiveSearchState = { status: 'idle' };

export function useArchiveSearch(): ArchiveSearch {
	const { call } = useSession();
	const [text, setText] = useState('');
	const [state, setState] = useState<ArchiveSearchState>(IDLE);
	/*
	 * The id of the most recent request the field wants an answer for. It is a ref rather than
	 * state because an answer compares against it *after* an await, where a captured render's
	 * value would be the stale one — and because bumping it must not itself draw anything.
	 */
	const asked = useRef(0);

	useEffect(() => {
		// Clearing the field is not a search: back to the URL's own tree, with nothing asked. The
		// id still moves, so an answer already in flight lands on nothing.
		if (text === '') {
			asked.current += 1;
			setState(IDLE);
			return;
		}
		/*
		 * `setTimeout` in an effect, cleared when the text changes — so the timer that survives is
		 * the last keystroke's and there is exactly one request per settled text. The callback does
		 * work rather than resolving a bare promise, which is what keeps it a schedule and not a
		 * sleep (`tests/unit/no-sleep.test.ts`).
		 */
		const debounce = setTimeout(() => {
			asked.current += 1;
			const id = asked.current;
			setState({ status: 'searching' });
			void (async () => {
				const answer = await call('search_archive', { text });
				if (asked.current !== id) {
					// The text moved on while this was out. Its answer is about something nobody is
					// asking any more, and rendering it would put a stale hit list under new text.
					return;
				}
				const next = read(answer);
				if (next !== undefined) {
					setState(next);
				}
			})();
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(debounce);
		};
	}, [text, call]);

	return { text, setText, state };
}

/** One answer, mapped onto {@link ArchiveSearchState} — or nothing at all, for a `refused`. */
function read(answer: HostAnswer<RpcEnvelope>): ArchiveSearchState | undefined {
	if (!answer.ok) {
		return answer.refusal === 'unanswered' ? ({ status: 'failed' } as const) : undefined;
	}
	const parsed =
		answer.value.type === 'result'
			? SearchArchiveResultSchema.safeParse(answer.value.result)
			: undefined;
	if (parsed === undefined || !parsed.success) {
		return { status: 'failed' } as const;
	}
	if (parsed.data.outcome === 'unreadable') {
		return { status: 'failed' } as const;
	}
	if (parsed.data.outcome === 'missing') {
		// Nothing has ever been archived here, so no name in it contains that text. The screen only
		// draws this field where there is a tree beside it, so this is a race rather than a state a
		// reader arrives in — and *nothing matched* is the honest thing to say about it either way.
		return { status: 'searched', matches: [], truncated: false } as const;
	}
	return {
		status: 'searched',
		matches: parsed.data.matches,
		truncated: parsed.data.truncated,
	} as const;
}
