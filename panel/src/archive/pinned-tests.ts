import { useCallback, useMemo, useState } from 'react';
import { keyOf } from './archive-path.js';

/**
 * Which tests the reader has marked to be kept — the `Keep` checkbox's state, and **nothing
 * outside this browser tab knows about it**.
 *
 * There is no retention mechanism yet: nothing sweeps the archive, so nothing can exempt a test
 * from being swept. This module is the UI half landing first, deliberately, and the honest shape
 * for a half is one that cannot be mistaken for the whole — so the set lives in React state and
 * ends with the mount. A reload clears it, and so does leaving the Archive screen.
 *
 * **Not `localStorage`, and that is the load-bearing choice.** Retention is a fact about the
 * *host's* disk, and a flag kept per browser would survive a reload while remaining invisible to
 * the sweep it claims to prevent — *I marked it on my laptop and the run was deleted anyway* is a
 * failure this cannot have while it is only a picture of a control. Ephemeral state is obviously
 * provisional, which is the property wanted until the host has a place to put this.
 *
 * **The flag is per *test*, never per run** — the checkbox on a run's card is the same flag as the
 * one on its test's card, so ticking either lights both. A run is one lease's output and a test
 * name is what a reader recognises across runs; pinning the run and leaving its siblings sweepable
 * is a granularity nobody asked for, and a checkbox that meant different things on two cards would
 * have to say so on each.
 *
 * **A group's tick is the same flag over several tests, and not a flag of its own.** In the groups
 * view a group's card carries one, and it keeps every test in that group — which is why there is no
 * *group is kept* state anywhere here: the truth is which tests are kept, and the group's tick both
 * reads and writes exactly that. Two things follow, and both are deliberate. A reader may untick a
 * single test afterwards — nothing locks a test to its group's tick — and the group's own tick then
 * has to say *some*, which is what {@link PinState.mixed} is for.
 */

/**
 * How many leading components of an archive address name a test: `<project>/<test_name>`.
 *
 * `project` is in the key because `test_name` alone is not an identity — the tree's top level
 * partitions exactly so that two projects may reuse one test name (`PROJECT.md` §10), and a key
 * that dropped it would pin `statistics-deliveries` in every project at once.
 */
export const TEST_NAME_DEPTH = 2;

/**
 * Which test a control is about: the two leading components of an **archive** address.
 *
 * A tuple rather than a `readonly string[]`, so *this control is about a test* is a fact the type
 * carries. A shorter path cannot be passed, which is what removes the `null` this used to return —
 * and with it the branch in each card for a checkbox that cannot exist (the rule
 * `force-release-control.tsx` records: no branch for a control that cannot be there). The screen
 * decides where a test exists, because the screen already owns the depth arithmetic (`depthsOf`).
 *
 * **An archive address**, never a groups-view one: the group id is a level of an arrangement rather
 * than a directory, so `[project, groupId]` would key a test under a name that does not identify
 * it. `routes/archive.tsx` already works in the archive's own vocabulary (`archiveAddressOf`), and
 * this asks for what every byte read and every listing on that screen asks for.
 */
export type TestPath = readonly [project: string, testName: string];

/**
 * The key one test is held under.
 *
 * `keyOf` rather than a `/` join, reused from `./archive-path.js` for the reason recorded there: it
 * joins on NUL, which is one of the two characters an archive path component cannot contain, so no
 * two different tests can collide on one key.
 */
export function testKeyOf(test: TestPath): string {
	return keyOf(test);
}

/**
 * One card's half of the checkbox: whether it is ticked, and what ticking it does.
 *
 * A card is handed this already bound to the test it is about, so neither card component knows
 * what a key is, which depth it is drawn at, or that the two cards share one set. The screen owns
 * that arithmetic because the screen already owns the depths (`depthsOf`).
 */
export interface PinState {
	readonly checked: boolean;
	/**
	 * Some of what this tick stands for is kept and some is not — **a group's tick only**, where it
	 * is the honest third state rather than a rounding of two.
	 *
	 * A group's tick stands over several tests and a reader may untick one of them afterwards, which
	 * is deliberately not prevented. Drawing that as *off* would say nothing in the group is kept and
	 * drawing it as *on* would say all of it is; the platform has the answer already, in a
	 * checkbox's `indeterminate`, so the control says *some* and neither of the two lies is needed.
	 */
	readonly mixed?: boolean;
	readonly toggle: () => void;
}

/** The whole set, as the screen holds it. */
export interface PinnedTests {
	stateFor(test: TestPath): PinState;
	/**
	 * One tick standing over several tests — a **group's**, in the groups view.
	 *
	 * `checked` only when every one of them is kept, `mixed` when some are, and the toggle is a bulk
	 * action: it keeps all of them, or, from `checked`, stops keeping all of them. It does **not**
	 * lock the tests underneath it — ticking a group is a way of ticking its tests, not a claim that
	 * outranks them, so a reader may untick one afterwards and the group's tick goes `mixed`.
	 *
	 * The caller passes the tests; this module never reads the grouping answer. Which tests are in a
	 * group is a fact about that answer (`group-tree.ts`), and a set of keys is all this needs.
	 */
	stateForAll(tests: readonly TestPath[]): PinState;
}

export function usePinnedTests(): PinnedTests {
	const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());

	// A new `Set` per change rather than a mutation: React compares by identity, and the two cards
	// sharing this state re-render off that comparison.
	const toggle = useCallback((key: string): void => {
		setPinned((current) => {
			const next = new Set(current);
			if (!next.delete(key)) {
				next.add(key);
			}
			return next;
		});
	}, []);

	/** One write for a whole group, so ticking one does not re-render per test. */
	const setAll = useCallback((keys: readonly string[], kept: boolean): void => {
		setPinned((current) => {
			const next = new Set(current);
			for (const key of keys) {
				if (kept) {
					next.add(key);
				} else {
					next.delete(key);
				}
			}
			return next;
		});
	}, []);

	return useMemo(
		() => ({
			stateFor: (test) => {
				const key = testKeyOf(test);
				return { checked: pinned.has(key), toggle: () => toggle(key) };
			},
			stateForAll: (tests) => {
				const keys = tests.map(testKeyOf);
				const kept = keys.filter((key) => pinned.has(key)).length;
				/*
				 * An empty list is `false` and a toggle that writes nothing. The screen does not draw
				 * this control for a group with no tests in it — there would be nothing to keep — so
				 * this is the shape of an unreachable case rather than a state anybody sees, and
				 * `kept === keys.length` would otherwise read *all of nothing is kept* as `checked`.
				 */
				return {
					checked: keys.length > 0 && kept === keys.length,
					mixed: kept > 0 && kept < keys.length,
					toggle: () => setAll(keys, kept < keys.length),
				};
			},
		}),
		[pinned, setAll, toggle],
	);
}
