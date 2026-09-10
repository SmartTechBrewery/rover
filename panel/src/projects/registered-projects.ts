import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { useSession } from '@panel/session/session-provider.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ListProjectsResultSchema, type ProjectRegistration } from './project-list.js';

/**
 * The Projects screen's data: **one `list_projects`, on navigation, cached for the life of the
 * screen — and read again when this screen has itself changed what is registered** (#273,
 * `docs/DESIGN.md` §10).
 *
 * **There is still no polling and no refresh control, and the reason is this screen's own** —
 * rewritten in place, because it used to be *the Archive's rule, for the Archive's reason*, and the
 * Archive's rule changed under it (#287, `ai/RULES.md` §1). Nothing about this screen's behaviour
 * changes: a registration changes when a person runs `rover init` or edits a hook file on the host,
 * which is not something this screen makes a claim to see happen, and there is no lease that writes
 * one — which is exactly the gate the Archive's clock runs behind, so there would be nothing here
 * for such a clock to be gated on. `list_devices` polls because *what is attached* changes under
 * the reader; nothing here does. Nothing holds an interval, and there is nothing for a reader to
 * press.
 *
 * **{@link RegisteredProjectsHook.reload} is not a refresh control and is not reachable as one.**
 * It has exactly one caller and one trigger: a delete this screen settled (`routes/projects.tsx`).
 * The screen has just changed what is registered, so it asks the host what is registered — and the
 * list afterwards is **`list_projects`' answer** rather than the panel's own edit of what it had,
 * which is the whole point. Filtering the deleted identifier out of the array in hand would draw a
 * list nothing on the host ever answered with, and it would be wrong in both directions: a
 * `partial` may have left the registration exactly where it was, and a `not-registered` means the
 * list being filtered was already out of date.
 *
 * **One request, not one per level.** `list_projects` answers the whole root in a single call and
 * takes no parameter at all, so this is `archive-levels.ts` minus the cache of levels: there is
 * one answer, so there is one state.
 *
 * **No deadline either**, for the reason `host-client.ts` gives: a budget belongs to a repeating
 * caller with an interval to spend, and this caller has neither.
 */

/**
 * What the screen has, and it is deliberately four states rather than the host's three.
 *
 * - **`missing` folds into `empty`.** A host with no projects root and a host whose root holds
 *   nothing are the same sentence to a reader, and the same next step: `rover init` in a
 *   project's own directory. §10 settles that fold, and it is the one the Archive already makes
 *   at its root.
 * - **Everything unusable folds into `unreadable`** — an `error` envelope, a result this panel
 *   cannot parse, and a request nothing answered. The fold `device-list-provider.tsx` and
 *   `archive-levels.ts` both already make: what the screen has to decide is narrower than why,
 *   and it lands on the state whose copy is true either way — *registrations may well be here*.
 * - **A `refused` sets nothing.** `Session.call` has already fired `onRefusal` and the router is
 *   coming down; *not readable* would be the panel's last word being the wrong one.
 */
export type RegisteredProjects =
	| { readonly status: 'loading' }
	| { readonly status: 'listed'; readonly projects: readonly ProjectRegistration[] }
	| { readonly status: 'empty' }
	| { readonly status: 'unreadable' };

const LOADING: RegisteredProjects = { status: 'loading' };

/** What the screen has, and the one way it asks for it again. */
export interface RegisteredProjectsHook {
	readonly state: RegisteredProjects;
	/**
	 * Ask `list_projects` once more, because this screen has changed what is registered.
	 *
	 * A reload that answers `unreadable` **replaces the list**, and that is correct rather than a
	 * regression: it is the host's answer to the question the screen just asked, and a screen
	 * holding on to a listing the host will no longer confirm would be showing registrations it has
	 * no current evidence for.
	 */
	readonly reload: () => void;
}

export function useRegisteredProjects(): RegisteredProjectsHook {
	const { call } = useSession();
	const [state, setState] = useState<RegisteredProjects>(LOADING);
	/*
	 * **How many reads have been asked for**, which is deliberately a nonce in the effect's
	 * dependency list rather than a mutation of the guard below.
	 *
	 * A reload implemented by clearing `asked` would depend on a re-render arriving between the
	 * clear and the next effect run, and it would put the guard's own meaning in two places. A
	 * nonce makes a reload *one more request* by construction: the effect body runs once per value
	 * of it, and StrictMode's double mount is still one because the guard is keyed on the nonce it
	 * has already served.
	 */
	const [nonce, setNonce] = useState(0);
	/*
	 * The nonce whose request has been made. A ref rather than state, because React 19's StrictMode
	 * runs a mount effect twice and a guard that lived in state would not have been written back
	 * before the second run. One request per nonce is the whole point of this hook, and two would
	 * be visible in the daemon's own log.
	 */
	const asked = useRef<number | null>(null);
	const live = useRef(true);

	useEffect(() => {
		live.current = true;
		if (asked.current !== nonce) {
			asked.current = nonce;
			void (async () => {
				// No parameter at all — there is no filter, no sort and no page on this method.
				const answer = await call('list_projects', {});
				/*
				 * A superseded read lands on nothing. The answers of two reads are not ordered by the
				 * requests that asked for them, so the later request's answer arriving first would
				 * otherwise let the earlier one overwrite it — a list from before the delete, drawn
				 * after the one from after it.
				 */
				if (!live.current || asked.current !== nonce) {
					return;
				}
				const next = read(answer);
				if (next === undefined) {
					return;
				}
				setState(next);
			})();
		}
		return () => {
			live.current = false;
		};
	}, [call, nonce]);

	/*
	 * Stable across renders, so a screen may hand it to an effect or a callback without it becoming
	 * a dependency that changes every time. And **the updater form is what makes that stability
	 * safe**: `nonce + 1` inside a callback with an empty dependency list would read the nonce of
	 * the render that built it — `0`, for the life of the screen — so the second reload and every
	 * one after it would set a value the state already held, and the effect would never run again.
	 * No increment can be lost to a stale closure this way. It is deliberately *not* a claim about
	 * request counts: two deletes settling in one tick are one read either way, because React
	 * batches and the effect body runs once per value the nonce settles on — and one fresh
	 * `list_projects` after them is exactly what is wanted.
	 */
	const reload = useCallback(() => {
		setNonce((previous) => previous + 1);
	}, []);

	return { state, reload };
}

/** One answer, mapped onto {@link RegisteredProjects} — or nothing at all, for a `refused`. */
function read(answer: HostAnswer<RpcEnvelope>): RegisteredProjects | undefined {
	if (!answer.ok) {
		return answer.refusal === 'unanswered' ? ({ status: 'unreadable' } as const) : undefined;
	}
	const parsed =
		answer.value.type === 'result'
			? ListProjectsResultSchema.safeParse(answer.value.result)
			: undefined;
	if (parsed === undefined || !parsed.success) {
		return { status: 'unreadable' } as const;
	}
	if (parsed.data.outcome === 'unreadable') {
		return { status: 'unreadable' } as const;
	}
	if (parsed.data.outcome === 'missing' || parsed.data.projects.length === 0) {
		return { status: 'empty' } as const;
	}
	return { status: 'listed', projects: parsed.data.projects } as const;
}
