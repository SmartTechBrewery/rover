import { type LeaseHolder, LeaseHolderSchema } from '@panel/devices/device-list.js';
import type { Session } from '@panel/session/session-provider.js';
import { z } from 'zod';

/**
 * `force_release_device` — the panel's one operator action, and the only request it makes that
 * changes anything on the host (`docs/DESIGN.md` §2, D27).
 *
 * **Re-declared rather than imported from `src/ipc/methods.ts`**, for `device-list.ts`'s reason:
 * the panel is a separate tree with its own `tsconfig.json`, and the daemon's method table drags
 * `core/device.ts`, `core/capabilities.ts` and the whole verb neighbourhood into a browser bundle
 * behind it. The holder projection is not re-declared a second time either — it is the very
 * schema the listing parses, imported, because the host answers both from one path
 * (`src/daemon/lease-holder.ts`).
 *
 * **Nothing here is `.strict()`**, the same one deliberate difference from the host's copy: a
 * browser refusing an answer because a newer daemon added a field would leave the operator unable
 * to tell a lease that ended from one that did not, over a compatible change.
 */

/**
 * What goes on the wire, and what deliberately does not.
 *
 * **No lease id, and that absence is the point of the method** (D20, D28). Force-releasing is by
 * definition ending somebody else's lease; the only credential that ends a lease is the id its
 * holder was handed, so the call is keyed on the serial — the one thing the operator can actually
 * see — and no listing has to disclose a credential for the panel to be able to act.
 *
 * `actor` is **attribution and never authorisation**: what authorises this call is reaching the
 * surface at all, which took a token the host issued (D28). See {@link forceReleaseDevice} for why
 * the panel has something to put here that the CLI does not.
 */
export const ForceReleaseDeviceParamsSchema = z.object({
	serial: z.string(),
	actor: z.string(),
});
export type ForceReleaseDeviceParams = z.infer<typeof ForceReleaseDeviceParamsSchema>;

/**
 * Why there was nothing to release — three named answers rather than one boolean, because they are
 * three different next moves for the operator staring at the screen (`src/ipc/methods.ts`).
 *
 * An enum here where `ListedDevice.state` is deliberately a string: a state this panel has never
 * heard of must not blank a working grid, but a *refusal* reason it has never heard of is a claim
 * about what happened to a lease, and the honest answer to one the panel cannot read is the same as
 * the honest answer to no reply at all — nothing was released (see {@link ForceReleaseAnswer}).
 */
export const ForceReleaseRefusalReasonSchema = z.enum(['not-held', 'gone', 'not-attached']);
export type ForceReleaseRefusalReason = z.infer<typeof ForceReleaseRefusalReasonSchema>;

/**
 * Released or refused, as **data**: "that device is already free" is an answer an operator acts on,
 * not a host that broke.
 *
 * The host's `message` is on the wire and is deliberately not mirrored. It is one sentence written
 * for a terminal; the panel says each outcome in its own words, in the vocabulary `docs/DESIGN.md`
 * §7 settles, and a screen rendering a host string would be a second vocabulary nothing keeps in
 * step with the first.
 */
export const ForceReleaseDeviceResultSchema = z.discriminatedUnion('outcome', [
	z.object({
		outcome: z.literal('released'),
		/** Who was holding it, as of the instant before the lease ended — never the lease id. */
		heldBy: LeaseHolderSchema,
	}),
	z.object({
		outcome: z.literal('refused'),
		reason: ForceReleaseRefusalReasonSchema,
	}),
]);
export type ForceReleaseDeviceResult = z.infer<typeof ForceReleaseDeviceResultSchema>;

/**
 * What one ask settled, as the control has to act on it — the host's two outcomes plus the two
 * things that can happen to a request carrying a session.
 */
export type ForceReleaseAnswer =
	/** The lease ended. The card is about to go free, and this names what was on it. */
	| { readonly outcome: 'released'; readonly heldBy: LeaseHolder }
	/** There was nothing to release, and `reason` is which of the three (`docs/DESIGN.md` §7). */
	| { readonly outcome: 'refused'; readonly reason: ForceReleaseRefusalReason }
	/**
	 * **Nothing was released**, because nothing usable came back: no answer at all, an `error`
	 * envelope, or a result this panel cannot parse.
	 *
	 * Folded into one for `device-list-provider.ts`'s reason, and it matters more here than it does
	 * there: §8's rule is that the panel never reports an ending it did not get, and every one of
	 * those three is a request that ended no lease. The host's error vocabulary is not shown —
	 * `invalid_params` is not news for the person looking at the card, and the news is that the
	 * lease is still open.
	 */
	| { readonly outcome: 'unanswered' }
	/**
	 * The host refused the session this request carried. `Session.call` has already fired
	 * `onRefusal`, so the router is coming down and *access ended* is the screen — nothing here may
	 * say anything over it, the way the poll deliberately does not.
	 */
	| { readonly outcome: 'access-ended' };

/**
 * Ask the host to end the lease on one device, and narrow every way that can go to four answers.
 *
 * **The actor is the signed-in user's identifier** (`SessionState.identity`), passed in by the
 * caller because this module has no session of its own. D28 forbids *the host* deriving
 * attribution from whoever authenticated; a client choosing what to say about itself is the
 * opposite of that, and it is what makes the daemon's audit line name a person rather than a
 * browser. The CLI requires `--actor` for the same reason and never derives it
 * (`src/cli/commands/force-release.ts`) — the panel simply has an identity to offer where a shell
 * does not, so there is no free-text field on the dialog and no constant like `panel` on the wire.
 */
export async function forceReleaseDevice(
	call: Session['call'],
	params: ForceReleaseDeviceParams,
): Promise<ForceReleaseAnswer> {
	const answer = await call('force_release_device', params);

	if (!answer.ok) {
		return { outcome: answer.refusal === 'refused' ? 'access-ended' : 'unanswered' };
	}
	if (answer.value.type !== 'result') {
		return { outcome: 'unanswered' };
	}

	const parsed = ForceReleaseDeviceResultSchema.safeParse(answer.value.result);
	return parsed.success ? parsed.data : { outcome: 'unanswered' };
}
