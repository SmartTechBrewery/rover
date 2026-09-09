import type { Session } from '@panel/session/session-provider.js';
import { z } from 'zod';

/**
 * `delete_project` — the panel's third operator action, after ending a stuck lease and setting the
 * `Keep` flag (`docs/DESIGN.md` §10, D42, D27).
 *
 * **Re-declared rather than imported from `src/ipc/methods.ts`**, for `force-release.ts`'s reason:
 * the panel is a separate tree with its own `tsconfig.json` and its own `@panel` alias, and the
 * daemon's method table drags `core/device.ts`, `core/capabilities.ts` and the whole verb
 * neighbourhood into a browser bundle behind it. What that costs is pinned rather than hoped for —
 * `tests/fixtures/panel/delete-project.json` is parsed by the host's own `.strict()` schemas in
 * `tests/unit/panel/delete-project-fixture.test.ts` and by the mirror below in
 * `delete-project.test.ts`, two projects that cannot import each other.
 *
 * **Nothing here is `.strict()`**, the same one deliberate difference from the host's copy every
 * other mirror makes: a browser refusing an answer because a newer daemon added a field would
 * leave the operator unable to tell a project that went from one that did not, over a compatible
 * change.
 *
 * **No host path, no `errno` and no `message` is on this wire and there is no field one would fit
 * in** (D19) — the host answers which halves went, what the archive weighed and how many
 * exemptions went with it, and the diagnosis stays in a warning on the host. So the panel is not
 * declining to show something it was sent; there is nothing to show.
 */

/**
 * What goes on the wire: the identifier `list_projects` answered with, and who is deleting it.
 *
 * **The identifier and never a path** (D19). It is the hook file's own name, the string a lease
 * carries as its `project` (D22) and the component the archive filed that project's subtree
 * under — one string for a registered project, and the host composes every path from its own
 * roots.
 *
 * `actor` is **attribution and never authorisation**, exactly as
 * `ForceReleaseDeviceParamsSchema`'s is: what authorises this call is reaching the surface at all,
 * which took a token the host issued (D20, D28). See {@link deleteProject} for why the panel has
 * something to put here that a shell does not.
 */
export const DeleteProjectParamsSchema = z.object({
	project: z.string(),
	actor: z.string(),
});
export type DeleteProjectParams = z.infer<typeof DeleteProjectParamsSchema>;

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
 * nothing is known to have gone (see {@link DeleteProjectAnswer}).
 */
export const DeletedPartSchema = z.enum(['removed', 'absent', 'failed']);
export type DeletedPart = z.infer<typeof DeletedPartSchema>;

/**
 * What every answer that reached the disk says — the three halves, the bytes and the count.
 *
 * Shared by the `deleted` and `partial` arms rather than declared twice, for the host's own
 * reason: the two differ only in whether one half would not go, and a `partial` reporting less
 * than a `deleted` would make the failure the least legible answer of the four.
 */
const DELETION_REPORT = {
	/** The hook file under the host's projects root. */
	registration: DeletedPartSchema,
	/** This project's own subtree of the artifact archive. */
	archive: DeletedPartSchema,
	/** This project's entries in the host's kept-tests store. */
	keptTests: DeletedPartSchema,
	/** What the archive subtree weighed, measured immediately before it went. `0` when absent. */
	freedBytes: z.number(),
	/** How many kept entries went — the number D35's amendment exists to make sayable. */
	keptTestsRemoved: z.number(),
};

/**
 * Four answers, four next moves — the host's own union (`src/ipc/methods.ts`), mirrored whole.
 *
 * **`not-registered` is a different arm rather than a delete of zero bytes**, and that is the one
 * property of this method the panel must not flatten: *there was no such registration* and *the
 * registration and its archive went* are two pieces of news, and the second must never be said
 * about the first.
 */
export const DeleteProjectResultSchema = z.discriminatedUnion('outcome', [
	/** At least one half went and none failed. */
	z.object({ outcome: z.literal('deleted'), ...DELETION_REPORT }),
	/** At least one half would not go. The others may still have gone — the fields say which. */
	z.object({ outcome: z.literal('partial'), ...DELETION_REPORT }),
	/** No hook file, no archive subtree and no kept entries. Nothing was reached. */
	z.object({ outcome: z.literal('not-registered') }),
	/** A lease on this project is live, so nothing at all was touched. */
	z.object({ outcome: z.literal('refused'), reason: z.literal('lease-live') }),
]);
export type DeleteProjectResult = z.infer<typeof DeleteProjectResultSchema>;

/** The three halves, the bytes and the count, as the dialog's outcome line reads them. */
export type DeletionReport = Extract<DeleteProjectResult, { outcome: 'deleted' }>;

/**
 * What one ask settled, as the screen has to act on it — the host's four outcomes plus the two
 * things that can happen to a request carrying a session.
 *
 * `force-release.ts`'s narrowing exactly, and its rule transfers unchanged: **the panel never
 * reports a deletion it did not get**, so everything unusable lands on `unanswered` and nothing
 * unusable lands on an arm that reads as a removal.
 */
export type DeleteProjectAnswer =
	/** At least one half went and none failed. The fields say which, and what it came to. */
	| DeletionReport
	/** Some of it would not go. The fields say which halves did, so this reports no less. */
	| Extract<DeleteProjectResult, { outcome: 'partial' }>
	/** There was no such registration — no hook file, no subtree, no kept entries. */
	| { readonly outcome: 'not-registered' }
	/** A lease on it is live, so nothing was touched. The next move is the operator's. */
	| { readonly outcome: 'refused'; readonly reason: 'lease-live' }
	/**
	 * **Nothing was deleted**, because nothing usable came back: no answer at all, an `error`
	 * envelope, or a result this panel cannot parse.
	 *
	 * Folded into one for `force-release.ts`'s reason, and it matters here for the same reason it
	 * matters there: this is the one answer that is not an outcome, so the dialog stays open with
	 * the control usable again and the list is left exactly as it was. The host's error vocabulary
	 * is not shown — `invalid_params` is not news for the person looking at the card, and the news
	 * is that the project is still registered.
	 */
	| { readonly outcome: 'unanswered' }
	/**
	 * The host refused the session this request carried. `Session.call` has already fired
	 * `onRefusal`, so the router is coming down and *access ended* is the screen — nothing here may
	 * say anything over it, the way the device poll deliberately does not.
	 */
	| { readonly outcome: 'access-ended' };

/**
 * Ask the host to delete one project, and narrow every way that can go to six answers.
 *
 * **The actor is the signed-in user's identifier** (`SessionState.identity`), passed in by the
 * caller because this module has no session of its own — `force-release.ts`'s rule and
 * `kept-tests.ts`'s. D28 forbids *the host* deriving attribution from whoever authenticated; a
 * client choosing what to say about itself is the opposite of that, and it is what makes the
 * daemon's audit line name a person rather than a browser. The CLI requires `--actor` for the same
 * reason and never derives it (`src/cli/commands/delete-project.ts`) — the panel simply has an
 * identity to offer where a shell does not, so there is no free-text field on the dialog and no
 * constant like `panel` on the wire.
 */
export async function deleteProject(
	call: Session['call'],
	params: DeleteProjectParams,
): Promise<DeleteProjectAnswer> {
	const answer = await call('delete_project', params);

	if (!answer.ok) {
		return { outcome: answer.refusal === 'refused' ? 'access-ended' : 'unanswered' };
	}
	if (answer.value.type !== 'result') {
		return { outcome: 'unanswered' };
	}

	const parsed = DeleteProjectResultSchema.safeParse(answer.value.result);
	return parsed.success ? parsed.data : { outcome: 'unanswered' };
}
