import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { useSession } from '@panel/session/session-provider.js';
import { useEffect, useRef, useState } from 'react';
import { ListProjectsResultSchema, type ProjectRegistration } from './project-list.js';

/**
 * The Projects screen's data: **one `list_projects`, on navigation, cached for the life of the
 * screen** (`docs/DESIGN.md` §10).
 *
 * **There is no polling and no refresh control**, which is the Archive's rule rather than the
 * Devices screen's, and for the Archive's reason: `list_devices` polls because *what is attached*
 * changes under the reader, and a registration changes when a person runs `rover init` or edits a
 * file on the host — something this screen makes no claim to see happen. Nothing here holds an
 * interval, and there is nothing to refresh with.
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

export function useRegisteredProjects(): RegisteredProjects {
	const { call } = useSession();
	const [state, setState] = useState<RegisteredProjects>(LOADING);
	/*
	 * A ref rather than state, because React 19's StrictMode runs a mount effect twice and a guard
	 * that lived in state would not have been written back before the second run. One request is
	 * the whole point of this hook, and two would be visible in the daemon's own log.
	 */
	const asked = useRef(false);
	const live = useRef(true);

	useEffect(() => {
		live.current = true;
		if (!asked.current) {
			asked.current = true;
			void (async () => {
				// No parameter at all — there is no filter, no sort and no page on this method.
				const answer = await call('list_projects', {});
				if (!live.current) {
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
	}, [call]);

	return state;
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
