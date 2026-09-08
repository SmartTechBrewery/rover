import type { Session } from '@panel/session/session-provider.js';
import { z } from 'zod';

/**
 * `list_kept_tests` and `set_kept_tests` — the `Keep` flag's two directions on the wire (D33,
 * #234), and the panel's second operator action after force-releasing a lease (`docs/DESIGN.md`
 * §2, D27).
 *
 * **Re-declared rather than imported from `src/ipc/methods.ts`**, for `force-release.ts`'s reason:
 * the panel is a separate tree with its own `tsconfig.json` and its own `@panel` alias, and the
 * daemon's method table drags `core/device.ts`, `core/capabilities.ts` and the whole verb
 * neighbourhood into a browser bundle behind it. What that costs is pinned rather than hoped for —
 * `tests/fixtures/panel/kept-tests.json` is parsed by the host's own `.strict()` schemas in
 * `tests/unit/panel/kept-tests-fixture.test.ts` and by the mirror below in `kept-tests.test.ts`,
 * two projects that cannot import each other.
 *
 * **Nothing here is `.strict()`**, the same one deliberate difference from the host's copy every
 * other mirror makes: a browser that blanked the screen because a newer daemon added a field would
 * cost the operator the whole set over a compatible change. **And no bound is re-declared either**
 * — the host's `MAX_KEPT_TESTS` is what refuses a write, and a `.max()` here would turn a store
 * the host had already accepted into a set the panel refuses to draw.
 *
 * **A name is not validated beyond being a string**, exactly as `archive-listing.ts` states: the
 * host bounded both components on the way in (`ArchivePathSegmentSchema`) and this panel parses
 * neither of them to decide what a level *is* (D22).
 */

/**
 * Which test a flag is about: `<project>/<test_name>`, the archive's own two leading components as
 * `list_archive` answered them.
 *
 * `project` is in the pair because a test name alone is not an identity — the archive's top level
 * partitions precisely so two projects may reuse one name (`PROJECT.md` §10). It is the same pair
 * `pinned-tests.ts` keys a tick on, and that module is where a screen address becomes one.
 */
export const KeptTestRefSchema = z.object({
	project: z.string(),
	testName: z.string(),
});
export type KeptTestRef = z.infer<typeof KeptTestRefSchema>;

/**
 * The whole set in one answer, or the fact that the host cannot read its own store.
 *
 * **There is deliberately no `missing` arm**, which is the host's own decision and not a narrowing
 * made here: a store that does not exist is *nothing is kept*, which is honestly `listed` with
 * `[]`. Two answers that would render identically are not two arms.
 *
 * `keptBy` and `keptAt` are on the file and on the host's audit line and deliberately not on this
 * wire — nothing needs either to draw a tick.
 */
export const ListKeptTestsResultSchema = z.discriminatedUnion('outcome', [
	/** The store was read. `tests: []` is **this host keeps nothing**, and is not a failure. */
	z.object({ outcome: z.literal('listed'), tests: z.array(KeptTestRefSchema) }),
	/** It is there and the host **cannot say what is in it** — it will not parse, or will not read. */
	z.object({ outcome: z.literal('unreadable') }),
]);
export type ListKeptTestsResult = z.infer<typeof ListKeptTestsResultSchema>;

/**
 * What one press produced — **the whole set after the write**, not an acknowledgement.
 *
 * That is what makes a group's press of nine tests one request and one authoritative answer, and
 * it is why nothing here writes optimistically: the panel renders what it was sent (R29), so the
 * answer *is* the new state and a press that did not land changes nothing.
 *
 * `refused: 'too-many'` is the host's cap being reached, as data: the write did not happen and the
 * store is exactly as it was. `unwritable` is *the host did not write it* — including a malformed
 * store, which is never overwritten with whatever one call happened to name.
 */
export const SetKeptTestsResultSchema = z.discriminatedUnion('outcome', [
	z.object({ outcome: z.literal('set'), tests: z.array(KeptTestRefSchema) }),
	z.object({ outcome: z.literal('refused'), reason: z.literal('too-many') }),
	z.object({ outcome: z.literal('unwritable') }),
]);
export type SetKeptTestsResult = z.infer<typeof SetKeptTestsResultSchema>;

/**
 * What the read settled, as the screen has to act on it — the host's two outcomes plus the two
 * things that can happen to a request carrying a session.
 *
 * `force-release.ts`'s narrowing rules apply verbatim, and the reason they transfer is that this
 * pair has the same asymmetry: an answer the panel cannot read must never be drawn as a fact about
 * the operator's own decisions.
 */
export type ListKeptTestsAnswer =
	/** The host's whole set, and `tests: []` is a host that keeps nothing. */
	| { readonly outcome: 'listed'; readonly tests: readonly KeptTestRef[] }
	/** The store is there and the host cannot say what is in it. **No tick is drawn from this.** */
	| { readonly outcome: 'unreadable' }
	/**
	 * **Nothing came back**, so nothing is known: no answer at all, an `error` envelope, or a
	 * result this panel cannot parse. Folded into one for `force-release.ts`'s reason — the host's
	 * error vocabulary is not this screen's news, and every one of the three leaves the panel
	 * unable to say which tests are kept.
	 */
	| { readonly outcome: 'unanswered' }
	/**
	 * The host refused the session this request carried. `Session.call` has already fired
	 * `onRefusal`, so the router is coming down and *access ended* is the screen — nothing here may
	 * say anything over it.
	 */
	| { readonly outcome: 'access-ended' };

/**
 * What one press settled — the read's four answers with `set` in place of `listed`.
 *
 * **`refused: 'too-many'` folds into `unwritable`**, and the fold is deliberate rather than lazy:
 * both mean the write did not happen and the store is exactly as it was, which is the only fact a
 * tick renders, and this screen has nowhere to say either (`docs/DESIGN.md` §9 — a failed write
 * leaves the tick where it was). The day the screen earns a line for *the host keeps as many as it
 * will*, that is an arm added back here and a branch added at the one caller, rather than a reason
 * carried through a union nothing reads.
 */
export type SetKeptTestsAnswer =
	/** The write landed, and this is the host's whole set afterwards. */
	| { readonly outcome: 'set'; readonly tests: readonly KeptTestRef[] }
	/** **The host did not write it** — it could not, or its cap refused this press. */
	| { readonly outcome: 'unwritable' }
	/** Nothing came back, so nothing was recorded — {@link ListKeptTestsAnswer}'s own arm. */
	| { readonly outcome: 'unanswered' }
	/** The session was refused; the router is coming down and this says nothing. */
	| { readonly outcome: 'access-ended' };

/** Ask the host which tests it keeps, and narrow every way that can go to four answers. */
export async function listKeptTests(call: Session['call']): Promise<ListKeptTestsAnswer> {
	const answer = await call('list_kept_tests', {});

	if (!answer.ok) {
		return { outcome: answer.refusal === 'refused' ? 'access-ended' : 'unanswered' };
	}
	if (answer.value.type !== 'result') {
		return { outcome: 'unanswered' };
	}

	const parsed = ListKeptTestsResultSchema.safeParse(answer.value.result);
	return parsed.success ? parsed.data : { outcome: 'unanswered' };
}

/**
 * Tell the host what one press decided — **however many tests it stood for, in one call**.
 *
 * A group's tick keeps every test in that group, so nine tests ticked together are one request and
 * one authoritative answer; nine calls would leave a partly-written group visible between them and
 * nine audit lines for one decision. `kept` is what the press decided, in both directions, because
 * the two are the same write of the same file with the same attribution.
 *
 * **The actor is the signed-in user's identifier** (`SessionState.identity`), passed in by the
 * caller because this module has no session of its own — `force-release.ts`'s rule exactly. It is
 * attribution and never authorisation: what authorises this call is reaching the surface at all,
 * which took a token the host issued (D20, D28), and it is what makes the host's record name a
 * person rather than a browser.
 */
export async function setKeptTests(
	call: Session['call'],
	params: {
		readonly tests: readonly KeptTestRef[];
		readonly kept: boolean;
		readonly actor: string;
	},
): Promise<SetKeptTestsAnswer> {
	const answer = await call('set_kept_tests', params);

	if (!answer.ok) {
		return { outcome: answer.refusal === 'refused' ? 'access-ended' : 'unanswered' };
	}
	if (answer.value.type !== 'result') {
		return { outcome: 'unanswered' };
	}

	const parsed = SetKeptTestsResultSchema.safeParse(answer.value.result);
	if (!parsed.success) {
		return { outcome: 'unanswered' };
	}
	return parsed.data.outcome === 'set'
		? { outcome: 'set', tests: parsed.data.tests }
		: { outcome: 'unwritable' };
}
