import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { useSession } from '@panel/session/session-provider.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ArchiveEntry, ListArchiveResultSchema } from './archive-listing.js';
import { keyOf } from './archive-path.js';

/**
 * The Archive screen's data: one `list_archive` per level, and only for the levels being drawn.
 *
 * **The caller says which levels it wants; this answers with their states.** Those levels are the
 * prefixes of the selected path (`archive-path.ts`, `levelsOf`) **and the levels the reader has
 * opened** (`tree-source.ts`, `drawnLevels`) — amended in place, because before #198 the first half
 * was the whole of it. So *lazily, one `readdir` at a time* is still structural, but what bounds it
 * is no longer this hook's shape: the selector **can** now express a walk, of the **drawn** tree,
 * and what keeps that finite is that the open set grows only by a click or by an address the reader
 * navigated to. Every level asked for is still a level on the screen, which is the rule that did not
 * change; a walk of the *archive* is still not something any caller here can ask for.
 *
 * **It asks as a function of what it already knows, which is why there is one instance of it and not
 * two** (#140 review). Some of the Archive screen's levels are addressed by a path *derived from* an
 * answer — a run's `<serial>` is the level above's `onlyChild` — and expressing that as a second
 * `useArchiveLevels` call gave the screen two caches and two `asked` guards, so navigating from a run
 * into a file made the first instance re-`readdir` a directory the second was already holding. The
 * caller passes a **selector over the levels so far** instead: the URL-derived and the answer-derived
 * paths are then one list against one cache, and a level asked for at one depth is not asked for
 * again at the next.
 *
 * **Every drawn level re-reads itself while something is being written, and nothing else does**
 * (#287, `docs/DESIGN.md` §9) — this paragraph is **rewritten in place with its reason rewritten**
 * rather than deleted (`ai/RULES.md` §1). It read *there is no polling and no refresh control*,
 * because *the archive is finished data: a run directory is written while a lease is live and
 * nothing is added once it ends, and this screen makes no claim to show a run appearing.* That
 * premise is true of a run whose lease has ended and **false for the window this hook is now
 * about**: while a lease is live the archive grows under the reader, the listings went stale, and
 * only a browser reload corrected them — which also threw away the reader's place. So a level is
 * still fetched when a navigation **or a click** first draws it (#198), and it is now asked again
 * every {@link ARCHIVE_POLL_MS} for as long as `writing` says a lease is live
 * (`live-writes.ts`). What has *not* changed is which levels: a tick asks for exactly the drawn
 * ones, so the laziness rule bounds the clock as it bounds the mount.
 *
 * **The clock is the nonce, not a second mechanism.** A tick is *ask for every drawn level again*,
 * which is precisely what {@link ArchiveLevelsHook.reread} already means, so incrementing the same
 * nonce gives *never twice for one level within one tick* and *never a level nobody drew* for free,
 * and StrictMode's double mount stays one request per level. No second cache, and nothing that
 * clears `asked`.
 *
 * **And a refresh is invisible until it lands.** The levels map is untouched until an answer
 * arrives, so no level that has an answer ever falls back to *Reading this level.* — see the
 * `unanswered` branch in the effect for what a missed budget does and does not replace.
 *
 * **And it reads again when this screen has itself changed what is filed** (#276) — amended in
 * place, exactly as `registered-projects.ts` was amended for the same reason (`ai/RULES.md` §1).
 * {@link ArchiveLevelsHook.reread} is **not** a refresh control and is not reachable as one: it has
 * one caller and one trigger, a settled `Remove` that took a test (`routes/archive.tsx`). The
 * screen has just changed what is filed, so it asks the host what is filed — and every level it
 * still draws is `list_archive`'s answer again rather than the panel's own edit of what it had
 * (§9's *the screen re-reads rather than assuming*). Editing the listing in hand would draw a
 * level nothing on the host ever answered with, and it would be wrong in both directions: a
 * `partial` may have left the directory exactly where it was, and a `not-found` means the listing
 * being edited was already stale.
 *
 * **Every request carries the tick as its deadline** (#125) — rewritten in place too, the old
 * clause having been *no deadline either, because a budget belongs to a repeating caller with an
 * interval to spend and this caller has neither* (`host-client.ts`). This caller now has an
 * interval, and the deadline is what bounds the tick guard below: without one, a single request the
 * host accepted and never answered would hold that guard for the life of the tab, every tick after
 * it dropped and the screen frozen on the last good listing with nothing saying so. That is what
 * #125 actually was, on the other screen.
 */

/**
 * How often a drawn level is read again while the archive is being written (#287).
 *
 * Five seconds, matching the device poll's interval — and **a separate constant rather than an
 * import of `POLL_MS`**, because these are two decisions that happen to agree: one about how soon
 * a run that has just landed should appear, one about how fresh a lease countdown must be. The
 * agreement is not a coincidence worth deleting either: the gate is derived from `list_devices`,
 * whose answer is already up to one `POLL_MS` old, so a faster archive tick would be refreshing
 * against knowledge that is stale anyway.
 *
 * **The cost, stated rather than hidden**: while a lease is live, one `readdir` per **drawn** level
 * every five seconds — a reader sitting on a run costs four to six per tick, a reader with several
 * branches open one per open row. It is bounded by #198's laziness rule and by nothing else, and it
 * is nothing at all while no lease is live. A poll never walks the archive: `measure_archive` and
 * `list_archive_groups` are deliberately **not** on this clock (`docs/DESIGN.md` §9).
 *
 * **No leading tick and no trailing one.** The first fire is one cadence after the gate opens,
 * because the mount has just read every drawn level and the clock's job is what happens after that.
 * Nothing is added for the end of a lease either, and nothing needs to be: the gate follows an
 * answer that lags the host by up to one device-poll interval, so the clock keeps running for a few
 * seconds past the real end of the lease, which covers the last writes. What that leaves is stated:
 * a write landing after the gate closes is seen on the reader's next navigation, and so is a
 * `rover sweep` deletion made while no lease is live — the archive can shrink unasked, and this
 * hook makes no claim about noticing that.
 */
export const ARCHIVE_POLL_MS = 5_000;

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

/**
 * Where a run's contents are listed — `[…run, onlyChild]`, and `null` when the level above has not
 * answered or the run names no single child.
 *
 * **The `<serial>` is a fact about the run rather than a level of the tree** (`docs/DESIGN.md` §9):
 * one lease is one device, so a run directory holds exactly one child and the host publishes its
 * name as `onlyChild` on the run's own entry. This is the one place that knows it — the tree hops
 * it at the run's depth and the screen composes the same address for the run's own card, so the two
 * cannot disagree about where a run's contents are and neither of them re-derives it.
 *
 * **It must only ever be called on a run's path.** Every level above a run may hold exactly one
 * child too — a project with one test name, a test name with one run — and each of those carries an
 * `onlyChild` this would happily compose an address out of. That address is a level nothing draws
 * and a file nobody asked for, so every call site guards on the depth first.
 */
export function runContentsLevel(
	levels: ArchiveLevels,
	run: readonly string[],
): readonly string[] | null {
	const parent = levelAt(levels, run.slice(0, -1));
	if (parent.status !== 'listed') {
		return null;
	}
	const entry = parent.entries.find((candidate) => candidate.name === run.at(-1));
	if (entry === undefined || entry.kind !== 'directory' || entry.onlyChild === null) {
		return null;
	}
	return [...run, entry.onlyChild];
}

/**
 * Which levels the caller wants read, given every level read so far.
 *
 * A function rather than an array because a path may be *derived from* an answer, and a caller
 * holding its own copy of the answers to derive them from is the duplicate cache this signature
 * exists to remove. It runs on every render and must be pure — it is only ever read for the paths it
 * names.
 */
export type WantedLevels = (known: ArchiveLevels) => readonly (readonly string[])[];

/** What the screen has, and the one way it asks for all of it again. */
export interface ArchiveLevelsHook {
	readonly levels: ArchiveLevels;
	/**
	 * Ask `list_archive` once more for every level the screen still draws, because this screen has
	 * changed what is filed.
	 *
	 * **Every level, and not one named address**, which is what a delete of a whole test subtree
	 * needs: the address that went is not the only listing it appears in — its parent named it as a
	 * row, and the tree may have its own listing open beside it. Clearing the cache and asking again
	 * for whatever the selector still wants is the shape that cannot leave a stale row behind, and
	 * it costs exactly the levels still on screen because the selector is what bounds it.
	 *
	 * A re-read that answers `unreadable` **replaces the level**, and that is correct rather than a
	 * regression: it is the host's answer to the question the screen just asked, and a screen
	 * holding on to a listing the host will no longer confirm would be showing runs it has no
	 * current evidence for.
	 *
	 * **Still not a refresh control, and neither is the clock** (#287): this has one caller and one
	 * trigger, and the tick has no caller at all — neither is reachable by a press, and nothing on
	 * the Archive screen offers one.
	 */
	readonly reread: () => void;
}

/**
 * @param want which levels the caller wants read, evaluated against every level read so far.
 * @param writing whether anything is being written into the archive, which is what runs the clock
 *   (`live-writes.ts`). **Required, with no default**, so no call site is silently opted out and the
 *   tests that pin *once per level* have to say `false` out loud.
 */
export function useArchiveLevels(want: WantedLevels, writing: boolean): ArchiveLevelsHook {
	const { call } = useSession();
	const [levels, setLevels] = useState<ArchiveLevels>(() => new Map());
	/*
	 * **How many reads have been asked for**, which is deliberately a nonce in the effect's
	 * dependency list rather than a mutation of the guard below — `registered-projects.ts`'s shape
	 * verbatim, and for its reason. A re-read implemented by clearing `asked` would depend on a
	 * re-render arriving between the clear and the next effect run, and it would put the guard's own
	 * meaning in two places. A nonce makes a re-read *one more request per drawn level* by
	 * construction: the effect body runs once per value of it, and StrictMode's double mount is
	 * still one because the guard is keyed on the nonce it has already served.
	 */
	const [nonce, setNonce] = useState(0);
	/*
	 * Every key ever asked about, terminal or not — the in-flight guard and the cache in one, keyed
	 * on the nonce that asked. A ref rather than state because React 19's StrictMode runs an effect
	 * twice on mount and a guard that lived in state would not have been written back before the
	 * second run: the point of this hook is one `readdir` per level, and two would be visible in the
	 * daemon's own log.
	 */
	const asked = useRef<Map<string, number>>(new Map());
	const live = useRef(true);
	/*
	 * **How many `list_archive` requests this hook has out**, which is what a tick is dropped for
	 * (#125, #287). A tick arriving while the last one's requests are still in flight is dropped
	 * rather than queued, so a host slower than the interval cannot have requests stacked on it —
	 * and this guard is **bounded**, by the deadline every request below carries. An unbounded one
	 * is what #125 was on the Devices screen: one request the host accepted and never answered held
	 * it for the life of the tab.
	 *
	 * A count rather than a boolean because a tick is *n* requests, one per drawn level, and they
	 * answer independently: the next tick is due once they all have.
	 */
	const outstanding = useRef(0);

	// Keyed on the paths themselves rather than on the array's identity, which is rebuilt every
	// render. `JSON.stringify` is injective over string arrays, which is all this needs to be — and
	// it is what makes an answer that names no new path a no-op rather than a second effect run.
	const wanted = JSON.stringify(want(levels));

	useEffect(() => {
		live.current = true;
		for (const path of JSON.parse(wanted) as string[][]) {
			const key = keyOf(path);
			if (asked.current.get(key) === nonce) {
				continue;
			}
			asked.current.set(key, nonce);
			outstanding.current += 1;
			void (async () => {
				/*
				 * `setTimeout` rather than `AbortSignal.timeout`, so the panel suite's fake timers can
				 * advance to the deadline instead of waiting it out — `device-list-provider.tsx`'s own
				 * recorded reason, and `tests/unit/no-sleep.test.ts`'s.
				 *
				 * The guard is released in `finally` and **nowhere else**: releasing it when the
				 * deadline fires would let the abandoned request's answer land after the next tick's
				 * good one. Aborting is enough, because an aborted `fetch` rejects promptly.
				 */
				const controller = new AbortController();
				const deadline = setTimeout(() => controller.abort(), ARCHIVE_POLL_MS);
				try {
					const answer = await call('list_archive', { path }, controller.signal);
					/*
					 * A superseded answer lands on nothing. The answers of two reads of one level are not
					 * ordered by the requests that asked for them, so the later request's answer arriving
					 * first would otherwise let the earlier one overwrite it — a listing from before the
					 * delete, drawn after the one from after it.
					 */
					if (!live.current || asked.current.get(key) !== nonce) {
						return;
					}
					const state = read(answer);
					if (state === undefined) {
						return;
					}
					/*
					 * **Nothing answered inside the budget leaves a level that has an answer exactly where
					 * it is** (#287), and it is asked again on the next tick. That is not news about the
					 * archive: the listing on screen is still the last thing the host confirmed, and
					 * replacing it with *not readable* over a request that timed out would make a refresh
					 * visible as a regression. A level with nothing yet still lands on `unreadable`,
					 * which is what it landed on before there was a clock, and the host's **own**
					 * `unreadable` still replaces in either case — that is the host answering the question
					 * the screen asked. `!answer.ok` here is exactly `refusal === 'unanswered'`, a
					 * `refused` having already returned `undefined` above, and an abort arrives as an
					 * `unanswered` by contract (`host-client.ts`).
					 */
					const unanswered = !answer.ok;
					setLevels((previous) =>
						unanswered && previous.has(key) ? previous : new Map(previous).set(key, state),
					);
				} finally {
					clearTimeout(deadline);
					outstanding.current -= 1;
				}
			})();
		}
		return () => {
			live.current = false;
		};
	}, [wanted, call, nonce]);

	/*
	 * Stable across renders, so a screen may hand it to a callback without it becoming a dependency
	 * that changes every time. And **the updater form is what makes that stability safe**:
	 * `nonce + 1` inside a callback with an empty dependency list would read the nonce of the render
	 * that built it — `0`, for the life of the screen — so the second re-read and every one after it
	 * would set a value the state already held, and the effect would never run again. No increment
	 * can be lost to a stale closure this way. It is deliberately *not* a claim about request
	 * counts: two deletes settling in one tick are one pass either way, because React batches and
	 * the effect body runs once per value the nonce settles on — and one fresh listing per drawn
	 * level after them is exactly what is wanted.
	 */
	const reread = useCallback(() => {
		setNonce((previous) => previous + 1);
	}, []);

	/**
	 * One tick of the clock — **the same request `reread` makes**, which is why it moves the same
	 * nonce and there is no second mechanism (#287).
	 *
	 * A tick arriving while this hook's own requests are still out is **dropped rather than
	 * queued** (#125): the nonce does not move, so nothing is asked, and the level that has not
	 * answered is not asked a second time on top of the first. What makes that safe is the deadline
	 * every request carries — the guard is only ever as temporary as the requests behind it, so a
	 * host that stops answering costs one tick and then recovers on its own.
	 */
	const tick = useCallback(() => {
		if (outstanding.current > 0) {
			return;
		}
		setNonce((previous) => previous + 1);
	}, []);

	/*
	 * **No lease live, no interval** — the idle cost of this hook is exactly what it was before
	 * there was a clock, which is the decision #287 asked to be recorded rather than left implicit.
	 * `writing` is `false` for a device list that has not answered yet as well as for one that names
	 * no lease (`live-writes.ts`), and the mount has just read every drawn level either way.
	 */
	useEffect(() => {
		if (!writing) {
			return;
		}
		const ticking = setInterval(tick, ARCHIVE_POLL_MS);
		return () => clearInterval(ticking);
	}, [writing, tick]);

	return { levels, reread };
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
