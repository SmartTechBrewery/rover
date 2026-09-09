import type { Session } from '@panel/session/session-provider.js';
import { z } from 'zod';

/**
 * `delete_archived_group` — the panel's fifth operator action, and the Archive screen's third
 * (`docs/DESIGN.md` §9, D43, R51 phase 3, #277).
 *
 * **Re-declared rather than imported from `src/ipc/methods.ts`**, for `delete-archived-test.ts`'s
 * reason: the panel is a separate tree with its own `tsconfig.json` and its own `@panel` alias, and
 * the daemon's method table drags `core/device.ts`, `core/capabilities.ts` and the whole verb
 * neighbourhood into a browser bundle behind it. What that costs is pinned rather than hoped for —
 * `tests/fixtures/panel/delete-archived-group.json` is parsed by the host's own `.strict()` schemas
 * in `tests/unit/panel/delete-archived-group-fixture.test.ts` and by the mirror below in
 * `delete-archived-group.test.ts`, two projects that cannot import each other.
 *
 * **The `DeletedPart` enum is declared here too**, exactly as the test's mirror declares its own and
 * for that file's recorded reason: each mirror is pinned to the host's enum by its own fixture gate,
 * so neither can drift from the host and therefore neither can drift from the other. An archive
 * module reaching into a sibling wire file to borrow three strings would buy nothing those gates do
 * not already give.
 *
 * **`runsRemoved` is the one field this wire has that the test's does not**, and it is the figure
 * the group's own line is built on: a group has no directory whose size stands for it, so *how many
 * runs went* is what nobody can recover afterwards. The host puts it on the two arms that reached
 * the disk and nowhere else (`src/ipc/methods.ts`).
 *
 * **Nothing here is `.strict()`**, the same one deliberate difference from the host's copy every
 * other mirror makes: a browser refusing an answer because a newer daemon added a field would leave
 * the operator unable to tell a group whose runs went from one whose runs did not, over a compatible
 * change.
 *
 * **No host path, no `errno` and no `message` is on this wire and there is no field one would fit
 * in** (D19) — the host answers which halves went, how many runs, what they weighed and how many
 * exemptions went with them, and the diagnosis stays in a warning on the host.
 */

/**
 * What goes on the wire: the project component, the group id, and who is deleting the runs they
 * name between them.
 *
 * **The components and never a path** (D19), and the two are not the same *kind* of string. The
 * `project` is `list_archive`'s own first component; the `groupId` is the opaque string a lease
 * supplied (D22) and it names **no directory at all** — the archive has no level for a group (R41),
 * so the host matches it against what each run filed. That is why a group id holding a slash is
 * ordinary here.
 *
 * `actor` is **attribution and never authorisation**, exactly as `DeleteArchivedTestParamsSchema`'s
 * is: what authorises this call is reaching the surface at all, which took a token the host issued
 * (D20, D28). See {@link deleteArchivedGroup} for why the panel has something to put here that a
 * shell does not.
 */
export const DeleteArchivedGroupParamsSchema = z.object({
	project: z.string(),
	groupId: z.string(),
	actor: z.string(),
});
export type DeleteArchivedGroupParams = z.infer<typeof DeleteArchivedGroupParamsSchema>;

/**
 * Whether one half of the delete went, was never there, or would not go — the host's own three, and
 * an enum here for `delete-archived-test.ts`'s recorded reason.
 *
 * On this row the readings are about a *set of runs* rather than a subtree: `removed` is *at least
 * one run of the group went*, `absent` is *no run of it was reached*, and `failed` is *a run would
 * not go, or the walk that looked for them was cut short* — which is the reading only this scope
 * has, and the reason a truncated walk cannot render as a complete delete.
 */
export const DeletedPartSchema = z.enum(['removed', 'absent', 'failed']);
export type DeletedPart = z.infer<typeof DeletedPartSchema>;

/**
 * What every answer that reached the disk says — the two halves, the bytes, the exemptions, and the
 * run count.
 *
 * Shared by the `deleted` and `partial` arms rather than declared twice, for the host's own reason:
 * the two differ only in whether something would not go, and a `partial` reporting less than a
 * `deleted` would make the failure the least legible answer of the four.
 */
const DELETION_REPORT = {
	/** The runs of this group, as a set: at least one went, none was reached, or one would not go. */
	archive: DeletedPartSchema,
	/** The kept-tests entries of the tests **this deletion emptied**, and of no other test. */
	keptTests: DeletedPartSchema,
	/** What the runs that went weighed, measured immediately before each one. `0` when none did. */
	freedBytes: z.number(),
	/** How many kept entries went — the number D35's amendment exists to make sayable. */
	keptTestsRemoved: z.number(),
	/** How many run directories went. The figure only this scope can state. */
	runsRemoved: z.number(),
};

/**
 * Four answers, four next moves — the host's own union (`src/ipc/methods.ts`), mirrored whole.
 *
 * **`not-found` is a different arm rather than a delete of zero runs**, and **`partial` is where a
 * walk that was cut short lands**: *the runs of this group are gone* and *the runs of it that could
 * be found are gone* are two pieces of news, and the second must never be said as the first.
 */
export const DeleteArchivedGroupResultSchema = z.discriminatedUnion('outcome', [
	/** Every run the walk found went, and the walk was complete. */
	z.object({ outcome: z.literal('deleted'), ...DELETION_REPORT }),
	/** Something would not go, or the walk was cut short — the fields say which. */
	z.object({ outcome: z.literal('partial'), ...DELETION_REPORT }),
	/** No run filed under this project named that group. Nothing was reached. */
	z.object({ outcome: z.literal('not-found') }),
	/** A lease is filing into one of this group's runs, so nothing at all was touched. */
	z.object({ outcome: z.literal('refused'), reason: z.literal('lease-live') }),
]);
export type DeleteArchivedGroupResult = z.infer<typeof DeleteArchivedGroupResultSchema>;

/** The halves, the bytes and the two counts, as the outcome line reads them. */
export type GroupDeletionReport = Extract<DeleteArchivedGroupResult, { outcome: 'deleted' }>;

/**
 * What one `Remove` on a group's card is about — the group, and the facts the confirmation states.
 *
 * **Built by the screen and read by the card**, `TestRemoval`'s own arrangement and its rule:
 * `routes/archive.tsx` already owns the depth arithmetic and holds the grouping answer, so no card
 * works out whether it should carry a control and no card counts runs.
 *
 * **`kind` is what the control dispatches on.** A group's card and a test name's card sit at the
 * same depth in their respective views, so the depth alone cannot say which of the two a removal is
 * — and what the two do differ in is everything downstream: the method, the wording, the figures
 * and where the screen lands afterwards.
 */
export interface GroupRemoval {
	readonly kind: 'group';
	/** The archive's first component, and the `project` that goes on the wire. */
	readonly project: string;
	/** The group id a lease named — matched against file contents, never joined into a path. */
	readonly groupId: string;
	/**
	 * How many runs this group holds, **off the grouping answer the size badge also measures**.
	 *
	 * A number and never `null`, which is the one place this differs from `TestRemoval.runs`: the
	 * control exists only where the grouping answer lists the group's runs, so *the host cannot say*
	 * is not a state a group's confirmation can be opened in (`routes/archive.tsx`, `levelRemoval`).
	 */
	readonly runs: number;
}

/**
 * What one ask settled, as the screen has to act on it — the host's four outcomes plus the two
 * things that can happen to a request carrying a session.
 *
 * `delete-archived-test.ts`'s narrowing exactly, and its rule transfers unchanged: **the panel never
 * reports a deletion it did not get**, so everything unusable lands on `unanswered` and nothing
 * unusable lands on an arm that reads as a removal.
 */
export type DeleteArchivedGroupAnswer =
	/** Every run the host found went. The fields say how many, and what they came to. */
	| GroupDeletionReport
	/** Some of it may still be filed — a run that would not go, or a walk that was cut short. */
	| Extract<DeleteArchivedGroupResult, { outcome: 'partial' }>
	/** No run filed under this project named that group. */
	| { readonly outcome: 'not-found' }
	/** A lease is filing into one of its runs, so nothing was touched. */
	| { readonly outcome: 'refused'; readonly reason: 'lease-live' }
	/**
	 * **Nothing was deleted**, because nothing usable came back: no answer at all, an `error`
	 * envelope, or a result this panel cannot parse. Folded into one for `delete-archived-test.ts`'s
	 * reason — this is the one answer that is not an outcome, so the dialog stays open with the
	 * control usable again and the screen is left exactly as it was.
	 */
	| { readonly outcome: 'unanswered' }
	/**
	 * The host refused the session this request carried. `Session.call` has already fired
	 * `onRefusal`, so the router is coming down and *access ended* is the screen.
	 */
	| { readonly outcome: 'access-ended' };

/**
 * The four of those six that **settled** something — `SettledDeleteArchivedTest`'s alias one scope
 * over, and for its reason: the control promises never to hand up a request that reached nothing,
 * and the line above the content area is what that promise protects.
 */
export type SettledDeleteArchivedGroup = Extract<
	DeleteArchivedGroupAnswer,
	{ outcome: 'deleted' | 'partial' | 'not-found' | 'refused' }
>;

/**
 * Ask the host to delete one group's runs, and narrow every way that can go to six answers.
 *
 * **The actor is the signed-in user's identifier** (`SessionState.identity`), passed in by the
 * caller because this module has no session of its own — `delete-archived-test.ts`'s rule. D28
 * forbids *the host* deriving attribution from whoever authenticated; a client choosing what to say
 * about itself is the opposite of that, and it is what makes the daemon's audit line name a person
 * rather than a browser. The CLI requires `--actor` for the same reason and never derives it
 * (`src/cli/commands/delete-group.ts`).
 */
export async function deleteArchivedGroup(
	call: Session['call'],
	params: DeleteArchivedGroupParams,
): Promise<DeleteArchivedGroupAnswer> {
	const answer = await call('delete_archived_group', params);

	if (!answer.ok) {
		return { outcome: answer.refusal === 'refused' ? 'access-ended' : 'unanswered' };
	}
	if (answer.value.type !== 'result') {
		return { outcome: 'unanswered' };
	}

	const parsed = DeleteArchivedGroupResultSchema.safeParse(answer.value.result);
	return parsed.success ? parsed.data : { outcome: 'unanswered' };
}
