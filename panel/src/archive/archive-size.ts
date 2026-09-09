import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { useSession } from '@panel/session/session-provider.js';
import { useEffect, useRef, useState } from 'react';
import { MeasureArchiveResultSchema } from './archive-listing.js';
import { keyOf } from './archive-path.js';

/**
 * How much disk one archive scope takes — **one host call per scope, and nothing summed in the
 * browser** (#261, #262, R49, `docs/DESIGN.md` §9).
 *
 * **Two entry points over one implementation** (#262). {@link useArchiveSize} takes an *address*
 * and asks `measure_archive`; {@link useGroupedArchiveSize} takes one of the groups view's three
 * *scopes* and asks `measure_archive_groups`, because *everything grouped*, *everything grouped in
 * one project* and *one group* describe a subset of the archive rather than a directory in it.
 * {@link useMeasurement} is the whole of both — the cache, the in-flight guard and the fold of the
 * host's answer — written **once** rather than twice, which is `useArchiveLevels`' *one instance,
 * not two* lesson: two implementations of this cache would each re-read what the other held. The
 * two key spaces are prefixed apart on top of that, so no answer either entry point holds is one
 * the other could have asked for.
 *
 * `useArchiveLevels`'s discipline in miniature, and for the same reasons. The caller names the one
 * scope it wants measured, this answers with its state, and the answer is cached for the life of
 * the screen: a walk of the archive is the host's to do once, and adding up the levels the tree
 * happens to have listed would produce a figure that grew as a reader browsed and was wrong at
 * every point before the last.
 *
 * **There is no polling, no deadline and no refresh control** (`docs/DESIGN.md` §9). The archive is
 * finished data — a run directory is written while a lease is live and nothing is added once it
 * ends — so a scope is measured when a navigation first draws its badge and never again. No
 * `signal` either, for the reason `host-client.ts` gives: a budget belongs to a repeating caller
 * with an interval to spend, and this caller has neither.
 */

/**
 * What one scope's size is, and it is deliberately four states rather than the host's three.
 *
 * - **`loading` is also *nothing was asked*.** A `null` path asks for nothing — the artifact case,
 *   whose figure is already on the parent listing, and every state with no scope at all — and the
 *   badge is absent either way, so the two need not be told apart.
 * - **`absent` is the host's `missing`**: there is nothing at that address to have a size. It draws
 *   no badge rather than `0 B`, which is a true claim about an empty directory (D6).
 * - **Everything unusable folds into `unmeasurable`** — `unreadable`, an `error` envelope, a result
 *   this panel cannot parse, and a request nothing answered. This is `useArchiveLevels`'s own fold:
 *   what the screen has to decide is narrower than why, and it lands on the state whose sentence is
 *   true either way — *the host could not measure what this takes on disk*.
 * - **A `refused` sets nothing.** `Session.call` has already fired `onRefusal` and the router is
 *   coming down; a badge claiming the host could not measure would be the panel's last word being
 *   the wrong one.
 */
export type ArchiveSize =
	| { readonly status: 'loading' }
	| { readonly status: 'measured'; readonly bytes: number; readonly truncated: boolean }
	| { readonly status: 'absent' }
	| { readonly status: 'unmeasurable' };

const LOADING: ArchiveSize = { status: 'loading' };

/**
 * The size of one **address**, or `loading` for `null` — **which asks for nothing at all**.
 *
 * `null` is how a caller says *this context has no scope to measure*, and the one context that says
 * it deliberately is an artifact: its figure is the `sizeBytes` the parent listing already carries,
 * so the deepest address on the screen costs no round trip (`routes/archive.tsx`, `fileSizeOf`).
 */
export function useArchiveSize(path: readonly string[] | null): ArchiveSize {
	return useMeasurement(
		path === null
			? null
			: { key: `path\u0000${keyOf(path)}`, method: 'measure_archive', params: { path } },
	);
}

/**
 * One of the groups view's three scopes, as `measure_archive_groups` takes it (#262).
 *
 * The host's own params shape, read straight off the selected address rather than translated —
 * `project` is the archive's top-level component and `groupId` is the opaque string a lease named,
 * which is a level of *this arrangement* and no directory at all (R41, D22).
 */
export type GroupedSizeScope =
	| { readonly scope: 'all' }
	| { readonly scope: 'project'; readonly project: string }
	| { readonly scope: 'group'; readonly project: string; readonly groupId: string };

/**
 * The size of the **grouped** runs of one scope, or `loading` for `null` — which asks for nothing,
 * exactly as {@link useArchiveSize}'s `null` does.
 *
 * The groups view's three shallow depths are the callers; everything at a group's depth and below
 * is an address of the archive's own once the group id is dropped, so it goes through
 * {@link useArchiveSize} and no second address vocabulary appears (`routes/archive.tsx`).
 */
export function useGroupedArchiveSize(scope: GroupedSizeScope | null): ArchiveSize {
	return useMeasurement(
		scope === null
			? null
			: { key: keyOfScope(scope), method: 'measure_archive_groups', params: scope },
	);
}

/**
 * One scope's key, in the one space {@link useArchiveSize}'s addresses are not in.
 *
 * **The opaque half comes last**, which is `src/daemon/list-archive-groups.ts`'s own rule for the
 * same join: `scope` and `project` cannot carry a NUL — one is a literal and the other is an
 * archive path component — so the first NUL after them is the separator whatever follows it, and a
 * `groupId` holding anything at all still cannot collide with another pair.
 */
function keyOfScope(scope: GroupedSizeScope): string {
	if (scope.scope === 'all') {
		return 'grouped\u0000all';
	}
	return scope.scope === 'project'
		? `grouped\u0000project\u0000${scope.project}`
		: `grouped\u0000group\u0000${scope.project}\u0000${scope.groupId}`;
}

/**
 * One measurement this screen wants: the method that answers it, the params it takes, and the key
 * both caches are read by. Never seen by a caller — the two entry points above build it.
 */
interface Measurement {
	readonly key: string;
	readonly method: 'measure_archive' | 'measure_archive_groups';
	readonly params: unknown;
}

/**
 * **The cache, the in-flight guard and the fold, once** — whichever of the two questions is being
 * asked.
 *
 * The two entry points differ in the method they name and in nothing else: an answer is an answer
 * about one scope, it is kept for the life of the screen, and it is never asked for twice.
 */
function useMeasurement(wanted: Measurement | null): ArchiveSize {
	const { call } = useSession();
	const [sizes, setSizes] = useState<ReadonlyMap<string, ArchiveSize>>(() => new Map());
	/*
	 * Every scope ever asked about, terminal or not — the in-flight guard and the cache in one.
	 * A ref rather than state because React 19's StrictMode runs an effect twice on mount and a
	 * guard that lived in state would not have been written back before the second run: this is
	 * `useArchiveLevels`'s guard verbatim, and two walks of the archive for one screen would be
	 * visible in the daemon's own log. It is also what makes navigating back to a scope free.
	 */
	const asked = useRef<Set<string>>(new Set());
	const live = useRef(true);

	// Keyed on what was asked about rather than on the object's identity, which is rebuilt every
	// render — the two key spaces above are injective over what either question can name.
	const key = wanted?.key ?? null;
	// The same join as a string, and what makes a re-render naming the same scope a no-op rather
	// than a second effect run.
	const request = JSON.stringify(wanted);

	useEffect(() => {
		live.current = true;
		const measurement = JSON.parse(request) as Measurement | null;
		if (measurement !== null && !asked.current.has(measurement.key)) {
			asked.current.add(measurement.key);
			void (async () => {
				const answer = await call(measurement.method, measurement.params);
				if (!live.current) {
					return;
				}
				const state = read(answer);
				if (state === undefined) {
					return;
				}
				setSizes((previous) => new Map(previous).set(measurement.key, state));
			})();
		}
		return () => {
			live.current = false;
		};
	}, [request, call]);

	return key === null ? LOADING : (sizes.get(key) ?? LOADING);
}

/** One answer, mapped onto {@link ArchiveSize} — or nothing at all, for a `refused`. */
function read(answer: HostAnswer<RpcEnvelope>): ArchiveSize | undefined {
	if (!answer.ok) {
		return answer.refusal === 'unanswered' ? ({ status: 'unmeasurable' } as const) : undefined;
	}
	const parsed =
		answer.value.type === 'result'
			? MeasureArchiveResultSchema.safeParse(answer.value.result)
			: undefined;
	if (parsed === undefined || !parsed.success) {
		return { status: 'unmeasurable' } as const;
	}
	if (parsed.data.outcome === 'unreadable') {
		return { status: 'unmeasurable' } as const;
	}
	if (parsed.data.outcome === 'missing') {
		return { status: 'absent' } as const;
	}
	return {
		status: 'measured',
		bytes: parsed.data.bytes,
		truncated: parsed.data.truncated,
	} as const;
}
