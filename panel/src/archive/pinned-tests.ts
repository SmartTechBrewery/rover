import { useSession } from '@panel/session/session-provider.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keyOf } from './archive-path.js';
import { type KeptTestRef, listKeptTests, setKeptTests } from './kept-tests.js';

/**
 * Which tests the reader has marked to be kept — the `Keep` checkbox's state, and **the host's
 * answer rather than this browser's** (D33, #234, #237).
 *
 * It lives in `~/.rover/kept-tests.json` on the host, a document of the host's own beside
 * `users.json` and deliberately outside the artifact tree, and this screen reaches it through the
 * two methods on the panel's transport: `list_kept_tests` for the whole set, `set_kept_tests` for
 * one press however many tests it stood over (`kept-tests.ts`). So a tick survives a reload, is
 * there in a different browser, and is there after a daemon restart — and `rover keep list` shows
 * the same test, because it is one decision the host holds rather than one per client.
 *
 * **Nothing is written optimistically, and that is what makes a failure harmless.** Each press is
 * one call, and the set this module holds is replaced with the `tests` the host answered with
 * (R29: the client renders what it was sent). A press the host did not make therefore leaves the
 * tick exactly where it was, with nothing to unwind.
 *
 * **The set is read once, on mount, and never polled or refreshed** — `archive-groups.ts`'s
 * discipline exactly, and for its reason: it only changes when this screen changes it, and this
 * screen is told the whole set every time it does. What the set has *not* done yet is a state the
 * cards have to draw, and the honest drawing of it is **no checkbox at all** — see
 * {@link PinnedTests}.
 *
 * **The flag is per *test*, never per run** — the checkbox on a run's card is the same flag as the
 * one on its test's card, so ticking either lights both. A run is one lease's output and a test
 * name is what a reader recognises across runs; pinning the run and leaving its siblings sweepable
 * is a granularity nobody asked for, and a checkbox that meant different things on two cards would
 * have to say so on each.
 *
 * **A group's tick is the same flag over several tests, and not a flag of its own.** In the groups
 * view a group's card carries one, and it keeps every test in that group — which is why there is no
 * *group is kept* state anywhere here, and none on the wire either: the truth is which tests are
 * kept, and the group's tick both reads and writes exactly that. Two things follow, and both are
 * deliberate. A reader may untick a single test afterwards — nothing locks a test to its group's
 * tick — and the group's own tick then has to say *some*, which is what {@link PinState.mixed} is
 * for.
 */

/**
 * How many leading components of an archive address name a test: `<project>/<test_name>`.
 *
 * `project` is in the key because `test_name` alone is not an identity — the tree's top level
 * partitions exactly so that two projects may reuse one test name (`PROJECT.md` §10), and a key
 * that dropped it would pin `statistics-deliveries` in every project at once. It is the same pair
 * the host's own `KeptTestRef` is, for that same reason.
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

/** The pair the host names a test by, out of the pair this screen addresses one by. */
function refOf(test: TestPath): KeptTestRef {
	return { project: test[0], testName: test[1] };
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

/**
 * The whole set, as the screen holds it — **or the fact that it does not hold it yet**.
 *
 * Both members answer `null` while the host has not answered, and for an answer the panel could
 * not read: `list_kept_tests` is still out, the store is `unreadable`, or nothing came back at all
 * (`kept-tests.ts`). The cards draw **no checkbox** there, which is this screen's own established
 * rule — a group whose tests are not listed carries no tick (`docs/DESIGN.md` §9) — applied to the
 * set itself, and the honest one: an unticked box for a test the panel cannot ask about says *this
 * is not kept*, which is a claim about the operator's own decision that nothing has established.
 */
export interface PinnedTests {
	stateFor(test: TestPath): PinState | null;
	/**
	 * One tick standing over several tests — a **group's**, in the groups view.
	 *
	 * `checked` only when every one of them is kept, `mixed` when some are, and the toggle is a bulk
	 * action: it keeps all of them, or, from `checked`, stops keeping all of them — in **one**
	 * request carrying every test in the group, never one per test. It does **not** lock the tests
	 * underneath it — ticking a group is a way of ticking its tests, not a claim that outranks them,
	 * so a reader may untick one afterwards and the group's tick goes `mixed`.
	 *
	 * The caller passes the tests; this module never reads the grouping answer. Which tests are in a
	 * group is a fact about that answer (`group-tree.ts`), and a set of keys is all this needs.
	 */
	stateForAll(tests: readonly TestPath[]): PinState | null;
}

export function usePinnedTests(): PinnedTests {
	/*
	 * The session is taken from the context rather than handed in, exactly as every other hook on
	 * this screen takes it (`archive-groups.ts`, `archive-levels.ts`) — and the **actor** with it,
	 * because attribution is a fact about who is signed in and not about which route is mounted.
	 * It is the identity the host reported (`SessionState.identity`), which is what
	 * `force-release-control.tsx` attributes its own call with: the panel derives nothing from the
	 * credential, and the host derives nothing from whoever authenticated (D20, D28).
	 *
	 * The router only exists inside a live session (`app.tsx`), so the other branch narrows a type
	 * rather than describing a state anybody can reach. A press with nobody to attribute it to is
	 * not sent, which leaves the tick where it was — the same thing a press the host refuses does.
	 */
	const { state, call } = useSession();
	const actor = state.status === 'signed-in' ? state.identity.identifier : null;
	/** The host's set, and `null` until it has answered one this screen can read. */
	const [kept, setKept] = useState<ReadonlySet<string> | null>(null);
	/*
	 * Whether the one read has been made. A ref rather than state for `archive-groups.ts`'s reason:
	 * React 19's StrictMode runs an effect twice on mount, and a guard that lived in state would not
	 * have been written back before the second run — two reads of the store, visible in the daemon's
	 * own log.
	 */
	const asked = useRef(false);
	const live = useRef(true);

	useEffect(() => {
		live.current = true;
		if (asked.current) {
			return () => {
				live.current = false;
			};
		}
		asked.current = true;
		void (async () => {
			const answer = await listKeptTests(call);
			// Every other answer leaves the set unanswered, which is what draws no checkbox: an
			// `unreadable` store and a host that said nothing are both *the panel cannot say*.
			if (live.current && answer.outcome === 'listed') {
				setKept(keysOf(answer.tests));
			}
		})();
		return () => {
			live.current = false;
		};
	}, [call]);

	/**
	 * One press, whatever it stood over — **one call, and the answer is the new set.**
	 *
	 * A group of nine tests is one request, one write of the host's document and one authoritative
	 * answer; nine calls would leave a partly-written group visible between them and nine audit
	 * lines for one decision. Nothing is written here before the answer arrives, so a press the
	 * host did not make leaves the tick exactly where it was.
	 */
	const write = useCallback(
		async (tests: readonly TestPath[], keep: boolean): Promise<void> => {
			if (actor === null) {
				return;
			}
			const answer = await setKeptTests(call, { tests: tests.map(refOf), kept: keep, actor });
			if (live.current && answer.outcome === 'set') {
				setKept(keysOf(answer.tests));
			}
		},
		[actor, call],
	);

	return useMemo(
		() => ({
			stateFor: (test) => {
				if (kept === null) {
					return null;
				}
				const checked = kept.has(testKeyOf(test));
				return {
					checked,
					toggle: () => {
						void write([test], !checked);
					},
				};
			},
			stateForAll: (tests) => {
				if (kept === null) {
					return null;
				}
				const keep = tests.filter((test) => kept.has(testKeyOf(test))).length;
				/*
				 * An empty list is `false` and a toggle that writes nothing. The screen does not draw
				 * this control for a group with no tests in it — there would be nothing to keep — so
				 * this is the shape of an unreachable case rather than a state anybody sees, and
				 * `keep === tests.length` would otherwise read *all of nothing is kept* as `checked`.
				 */
				return {
					checked: tests.length > 0 && keep === tests.length,
					mixed: keep > 0 && keep < tests.length,
					toggle: () => {
						void write(tests, keep < tests.length);
					},
				};
			},
		}),
		[kept, write],
	);
}

/** The host's set as the keys the two cards ask by. */
function keysOf(tests: readonly KeptTestRef[]): ReadonlySet<string> {
	return new Set(tests.map((test) => testKeyOf([test.project, test.testName])));
}
