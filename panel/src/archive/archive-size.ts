import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { useSession } from '@panel/session/session-provider.js';
import { useEffect, useRef, useState } from 'react';
import { MeasureArchiveResultSchema } from './archive-listing.js';
import { keyOf } from './archive-path.js';

/**
 * How much disk one archive address takes — **one `measure_archive` per scope, and nothing summed
 * in the browser** (#261, R49, `docs/DESIGN.md` §9).
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
 * The size of one scope, or `loading` for `null` — **which asks for nothing at all**.
 *
 * `null` is how a caller says *this context has no scope to measure*, and the one context that says
 * it deliberately is an artifact: its figure is the `sizeBytes` the parent listing already carries,
 * so the deepest address on the screen costs no round trip (`routes/archive.tsx`, `fileSizeOf`).
 */
export function useArchiveSize(path: readonly string[] | null): ArchiveSize {
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

	// Keyed on the components themselves rather than on the array's identity, which is rebuilt every
	// render — `keyOf` is injective over what a listing can name (`archive-path.ts`).
	const key = path === null ? null : keyOf(path);
	// The same injective join, and what makes a re-render naming the same scope a no-op rather than
	// a second effect run.
	const wanted = JSON.stringify(path);

	useEffect(() => {
		live.current = true;
		const scope = JSON.parse(wanted) as string[] | null;
		if (scope !== null) {
			const scopeKey = keyOf(scope);
			if (!asked.current.has(scopeKey)) {
				asked.current.add(scopeKey);
				void (async () => {
					const answer = await call('measure_archive', { path: scope });
					if (!live.current) {
						return;
					}
					const state = read(answer);
					if (state === undefined) {
						return;
					}
					setSizes((previous) => new Map(previous).set(scopeKey, state));
				})();
			}
		}
		return () => {
			live.current = false;
		};
	}, [wanted, call]);

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
