import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { useSession } from '@panel/session/session-provider.js';
import { useEffect, useRef, useState } from 'react';
import { type ArchiveEntry, ListArchiveResultSchema } from './archive-listing.js';
import { keyOf } from './archive-path.js';

/**
 * The Archive screen's data: one `list_archive` per level, and only for the levels being drawn.
 *
 * **The caller says which levels it wants; this answers with their states.** Those levels are the
 * prefixes of the selected path (`archive-path.ts`, `levelsOf`), so *lazily, one `readdir` at a
 * time* is structural — at most four requests at the deepest point, each one a level on the screen,
 * and no shape here can express a walk.
 *
 * **There is no polling and no refresh control** (`docs/DESIGN.md` §9). The archive is finished
 * data: a run directory is written while a lease is live and nothing is added once it ends, and
 * this screen makes no claim to show a run appearing. So a level is fetched once, on navigation,
 * and cached for the life of the screen. That is the one thing this hook does differently from
 * `device-list-provider.tsx`, which polls because *what is attached* changes under the reader.
 *
 * **No deadline either**, for the reason `host-client.ts` gives: a budget belongs to a repeating
 * caller with an interval to spend, and this caller has neither.
 */

/**
 * What one level is, and it is deliberately four states rather than the host's three.
 *
 * - **`missing` folds into `empty`.** At the root the daemon says so itself — the archive root's
 *   own absence is *nothing has ever been archived here*. Deeper down, a directory that is not
 *   there and a directory with nothing in it are the same sentence to a reader, and Rover writes a
 *   directory only when a verb produces bytes.
 * - **Everything unusable folds into `unreadable`** — an `error` envelope, a result this panel
 *   cannot parse, and a request nothing answered. This is the fold `device-list-provider.tsx`
 *   already makes and documents: what the screen has to decide is narrower than why, and it lands
 *   on the state whose copy is true either way — *runs may well be filed here*.
 * - **A `refused` sets nothing.** `Session.call` has already fired `onRefusal` and the router is
 *   coming down; *not readable* would be the panel's last word being the wrong one.
 */
export type ArchiveLevel =
	| { readonly status: 'loading' }
	| { readonly status: 'listed'; readonly entries: readonly ArchiveEntry[] }
	| { readonly status: 'empty' }
	| { readonly status: 'unreadable' };

const LOADING: ArchiveLevel = { status: 'loading' };

export type ArchiveLevels = ReadonlyMap<string, ArchiveLevel>;

/** One level's state. A level nothing has answered for yet is `loading`, never an empty listing. */
export function levelAt(levels: ArchiveLevels, path: readonly string[]): ArchiveLevel {
	return levels.get(keyOf(path)) ?? LOADING;
}

export function useArchiveLevels(paths: readonly (readonly string[])[]): ArchiveLevels {
	const { call } = useSession();
	const [levels, setLevels] = useState<ArchiveLevels>(() => new Map());
	/*
	 * Every key ever asked about, terminal or not — the in-flight guard and the cache in one.
	 * A ref rather than state because React 19's StrictMode runs an effect twice on mount and a
	 * guard that lived in state would not have been written back before the second run: the point
	 * of this hook is one `readdir` per level, and two would be visible in the daemon's own log.
	 */
	const asked = useRef<Set<string>>(new Set());
	const live = useRef(true);

	// Keyed on the paths themselves rather than on the array's identity, which is rebuilt every
	// render. `JSON.stringify` is injective over string arrays, which is all this needs to be.
	const wanted = JSON.stringify(paths);

	useEffect(() => {
		live.current = true;
		for (const path of JSON.parse(wanted) as string[][]) {
			const key = keyOf(path);
			if (asked.current.has(key)) {
				continue;
			}
			asked.current.add(key);
			void (async () => {
				const answer = await call('list_archive', { path });
				if (!live.current) {
					return;
				}
				const state = read(answer);
				if (state === undefined) {
					return;
				}
				setLevels((previous) => new Map(previous).set(key, state));
			})();
		}
		return () => {
			live.current = false;
		};
	}, [wanted, call]);

	return levels;
}

/** One answer, mapped onto {@link ArchiveLevel} — or nothing at all, for a `refused`. */
function read(answer: HostAnswer<RpcEnvelope>): ArchiveLevel | undefined {
	if (!answer.ok) {
		return answer.refusal === 'unanswered' ? ({ status: 'unreadable' } as const) : undefined;
	}
	const parsed =
		answer.value.type === 'result'
			? ListArchiveResultSchema.safeParse(answer.value.result)
			: undefined;
	if (parsed === undefined || !parsed.success) {
		return { status: 'unreadable' } as const;
	}
	if (parsed.data.outcome === 'unreadable') {
		return { status: 'unreadable' } as const;
	}
	if (parsed.data.outcome === 'missing' || parsed.data.entries.length === 0) {
		return { status: 'empty' } as const;
	}
	return { status: 'listed', entries: parsed.data.entries } as const;
}
