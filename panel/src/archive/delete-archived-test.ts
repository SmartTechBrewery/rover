import type { Session } from '@panel/session/session-provider.js';
import { z } from 'zod';

/**
 * `delete_archived_test` — the panel's fourth operator action, after ending a stuck lease, setting
 * the `Keep` flag and deleting a registration (`docs/DESIGN.md` §9, D43, D42, D27).
 *
 * **Re-declared rather than imported from `src/ipc/methods.ts`**, for `delete-project.ts`'s
 * reason: the panel is a separate tree with its own `tsconfig.json` and its own `@panel` alias,
 * and the daemon's method table drags `core/device.ts`, `core/capabilities.ts` and the whole verb
 * neighbourhood into a browser bundle behind it. What that costs is pinned rather than hoped for —
 * `tests/fixtures/panel/delete-archived-test.json` is parsed by the host's own `.strict()` schemas
 * in `tests/unit/panel/delete-archived-test-fixture.test.ts` and by the mirror below in
 * `delete-archived-test.test.ts`, two projects that cannot import each other.
 *
 * **The two panel mirrors of `DeletedPart` are each pinned to the host's own enum**, which is why
 * this file declares its own rather than importing `projects/delete-project.ts`'. The host shares
 * one enum between the two deletes deliberately, so that a project and a test cannot come to
 * report the same two stores differently; on this side the two fixture gates hold each mirror to
 * that enum, so neither can drift from the host and therefore neither can drift from the other.
 * An archive module reaching into the Projects screen's wire file to borrow three strings would
 * buy nothing those gates do not already give.
 *
 * **Nothing here is `.strict()`**, the same one deliberate difference from the host's copy every
 * other mirror makes: a browser refusing an answer because a newer daemon added a field would
 * leave the operator unable to tell a test that went from one that did not, over a compatible
 * change.
 *
 * **No host path, no `errno` and no `message` is on this wire and there is no field one would fit
 * in** (D19) — the host answers which halves went, what the directory weighed and how many
 * exemptions went with it, and the diagnosis stays in a warning on the host. So the panel is not
 * declining to show something it was sent; there is nothing to show.
 */

/**
 * What goes on the wire: the two components a listing of the archive answered with, and who is
 * deleting the test they name.
 *
 * **The components and never a path** (D19). They are `<project>/<test_name>` exactly as
 * `set_kept_tests` takes them — the archive's own vocabulary, parsed by nothing (D22) — and the
 * host composes every path from its own roots. The pair is what identifies a test, because the
 * archive's top level partitions precisely so two projects may reuse one test name
 * (`pinned-tests.ts`).
 *
 * `actor` is **attribution and never authorisation**, exactly as `DeleteProjectParamsSchema`'s is:
 * what authorises this call is reaching the surface at all, which took a token the host issued
 * (D20, D28). See {@link deleteArchivedTest} for why the panel has something to put here that a
 * shell does not.
 */
export const DeleteArchivedTestParamsSchema = z.object({
	project: z.string(),
	testName: z.string(),
	actor: z.string(),
});
export type DeleteArchivedTestParams = z.infer<typeof DeleteArchivedTestParamsSchema>;

/**
 * Whether one half of the delete went, was never there, or would not go.
 *
 * Three values rather than a boolean, and the panel keeps all three because *there was nothing
 * here* and *the host would not remove it* are two different next moves — which is also what lets
 * the host promise that a request reaching nothing is never answered `deleted`
 * (`src/ipc/methods.ts`).
 *
 * An enum here, like `ForceReleaseRefusalReasonSchema` and unlike `ListedDevice.state`: a fate
 * this panel has never heard of is a claim about what happened to somebody's archive, and the
 * honest answer to one it cannot read is the same as the honest answer to no reply at all —
 * nothing is known to have gone (see {@link DeleteArchivedTestAnswer}).
 */
export const DeletedPartSchema = z.enum(['removed', 'absent', 'failed']);
export type DeletedPart = z.infer<typeof DeletedPartSchema>;

/**
 * What every answer that reached the disk says — the two halves, the bytes and the count.
 *
 * Shared by the `deleted` and `partial` arms rather than declared twice, for the host's own
 * reason: the two differ only in whether one half would not go, and a `partial` reporting less
 * than a `deleted` would make the failure the least legible answer of the four.
 *
 * **There is no third half.** A hook file is a project's, and a test is not a project — which is
 * also why a request that reached nothing is `not-found` here rather than `not-registered`.
 */
const DELETION_REPORT = {
	/** The test's own directory, with every run filed under it. */
	archive: DeletedPartSchema,
	/** This test's entry in the host's kept-tests store. */
	keptTests: DeletedPartSchema,
	/** What the directory weighed, measured immediately before it went. `0` when absent. */
	freedBytes: z.number(),
	/** How many kept entries went — the number D35's amendment exists to make sayable. */
	keptTestsRemoved: z.number(),
};

/**
 * Four answers, four next moves — the host's own union (`src/ipc/methods.ts`), mirrored whole.
 *
 * **`not-found` is a different arm rather than a delete of zero bytes**, and that is the one
 * property of this method the panel must not flatten: *there was nothing filed at that address*
 * and *the test and everything under it went* are two pieces of news, and the second must never be
 * said about the first.
 */
export const DeleteArchivedTestResultSchema = z.discriminatedUnion('outcome', [
	/** At least one half went and none failed. */
	z.object({ outcome: z.literal('deleted'), ...DELETION_REPORT }),
	/** At least one half would not go. The other may still have gone — the fields say which. */
	z.object({ outcome: z.literal('partial'), ...DELETION_REPORT }),
	/** No directory at that address and no kept entry for it. Nothing was reached. */
	z.object({ outcome: z.literal('not-found') }),
	/** A lease is filing into this test right now, so nothing at all was touched. */
	z.object({ outcome: z.literal('refused'), reason: z.literal('lease-live') }),
]);
export type DeleteArchivedTestResult = z.infer<typeof DeleteArchivedTestResultSchema>;

/** The two halves, the bytes and the count, as the outcome line reads them. */
export type ArchiveDeletionReport = Extract<DeleteArchivedTestResult, { outcome: 'deleted' }>;

/**
 * What one `Remove` control is about — the test, and the facts the confirmation states about it.
 *
 * **Built by the screen and read by the card**, which is `PinState`'s own arrangement
 * (`pinned-tests.ts`) and `force-release-control.tsx`'s rule: `routes/archive.tsx` already owns the
 * depth arithmetic, so no card works out whether it should carry a control, and no card counts
 * runs or looks up a `Keep` mark. A card that is handed one draws one.
 *
 * **The three facts are already on the screen, so the confirmation adds no host read** except its
 * own `measure_archive` — the run count is off a listing the tree needed anyway and the `Keep` mark
 * is off the set the ticks are drawn from (§9, §10's *the reads happen when the dialog opens*).
 */
export interface TestRemoval {
	/** The archive's first component, and the `project` that goes on the wire. */
	readonly project: string;
	/** The archive's second component — the test directory's own name, as the host filed it. */
	readonly testName: string;
	/**
	 * How many runs are filed under it, or `null` when nothing on screen can say.
	 *
	 * **`null` is *the host cannot say* and never `0`** — the distinction `childCount: null` carries
	 * one level up (`level-contents.tsx`), and the one this dialog must not flatten: a delete of *no
	 * runs* and a delete whose size nobody has counted are two different things to be told before
	 * confirming.
	 */
	readonly runs: number | null;
	/**
	 * Whether this test is marked `Keep`, or `null` while the kept set has not answered.
	 *
	 * `null` for the reason the tick is absent then (`pinned-tests.ts`): an answer of *no* about a
	 * set the panel cannot read would be a claim about the operator's own decision that nothing has
	 * established.
	 */
	readonly kept: boolean | null;
	/**
	 * Which of the two cards this control is on — and therefore whether the confirmation has to say
	 * that the run on screen goes with the rest (D43).
	 *
	 * A reader who pressed `Remove` on a run's `Run Details` is looking at one run, and the flag is
	 * per test: what goes is every run of it. That is the one sentence the two cards do not share,
	 * and the reason this is not derivable inside the card is that `Run Details` would then be
	 * asserting something about a depth it does not know.
	 */
	readonly card: 'test' | 'run';
}

/**
 * What one ask settled, as the screen has to act on it — the host's four outcomes plus the two
 * things that can happen to a request carrying a session.
 *
 * `delete-project.ts`'s narrowing exactly, and its rule transfers unchanged: **the panel never
 * reports a deletion it did not get**, so everything unusable lands on `unanswered` and nothing
 * unusable lands on an arm that reads as a removal.
 */
export type DeleteArchivedTestAnswer =
	/** At least one half went and none failed. The fields say which, and what it came to. */
	| ArchiveDeletionReport
	/** Some of it would not go. The fields say which half did, so this reports no less. */
	| Extract<DeleteArchivedTestResult, { outcome: 'partial' }>
	/** There was nothing filed at that address, and nothing kept it either. */
	| { readonly outcome: 'not-found' }
	/** A lease is filing into it, so nothing was touched. The next move is the operator's. */
	| { readonly outcome: 'refused'; readonly reason: 'lease-live' }
	/**
	 * **Nothing was deleted**, because nothing usable came back: no answer at all, an `error`
	 * envelope, or a result this panel cannot parse.
	 *
	 * Folded into one for `delete-project.ts`'s reason, and it matters here for the same reason it
	 * matters there: this is the one answer that is not an outcome, so the dialog stays open with
	 * the control usable again and the screen is left exactly as it was — no navigation and no
	 * re-read. The host's error vocabulary is not shown: `invalid_params` is not news for the
	 * person looking at the card, and the news is that the test is still filed.
	 */
	| { readonly outcome: 'unanswered' }
	/**
	 * The host refused the session this request carried. `Session.call` has already fired
	 * `onRefusal`, so the router is coming down and *access ended* is the screen — nothing here may
	 * say anything over it, the way the device poll deliberately does not.
	 */
	| { readonly outcome: 'access-ended' };

/**
 * Ask the host to delete one archived test, and narrow every way that can go to six answers.
 *
 * **The actor is the signed-in user's identifier** (`SessionState.identity`), passed in by the
 * caller because this module has no session of its own — `delete-project.ts`'s rule and
 * `kept-tests.ts`'s. D28 forbids *the host* deriving attribution from whoever authenticated; a
 * client choosing what to say about itself is the opposite of that, and it is what makes the
 * daemon's audit line name a person rather than a browser. The CLI requires `--actor` for the same
 * reason and never derives it (`src/cli/commands/delete-test.ts`) — the panel simply has an
 * identity to offer where a shell does not, so there is no free-text field on the dialog and no
 * constant like `panel` on the wire.
 */
export async function deleteArchivedTest(
	call: Session['call'],
	params: DeleteArchivedTestParams,
): Promise<DeleteArchivedTestAnswer> {
	const answer = await call('delete_archived_test', params);

	if (!answer.ok) {
		return { outcome: answer.refusal === 'refused' ? 'access-ended' : 'unanswered' };
	}
	if (answer.value.type !== 'result') {
		return { outcome: 'unanswered' };
	}

	const parsed = DeleteArchivedTestResultSchema.safeParse(answer.value.result);
	return parsed.success ? parsed.data : { outcome: 'unanswered' };
}
