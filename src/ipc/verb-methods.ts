/**
 * The verb rows' schemas — what a verb call carries, and what it answers with.
 *
 * Verb calls travel on the **same** surface as lease operations (R6, D19): these schemas go
 * on the one `IPC_METHODS` table in `./methods.ts`, and nothing about the envelope, the
 * framing, the server or the client changes to carry them. A verb is a row and a handler,
 * which is the whole point of this row landing before the verb families.
 *
 * **A call carries the lease id and no serial.** The lease id is the credential (D20, and
 * `ReleaseDeviceParamsSchema` says the same in fewer words); the host derives the serial
 * from it. A serial beside it would be either redundant or a way for the holder of one
 * device to drive another.
 *
 * **This module imports from `src/verbs/`, and that is the intended direction.** It is the
 * same schema reuse `./methods.ts` already does for `DeviceSchema` and `CapabilitiesSchema`:
 * a client parses an `ActionResult` with the schema the host produced it from, rather than
 * with a copy that can drift. The verb layer reaches `src/core/` and nothing else, so this
 * drags no device backend into a client's module graph —
 * `tests/unit/no-backend-in-a-client.test.ts` is what keeps that a fact rather than a claim.
 */

import { z } from 'zod';
import { LeaseIdSchema } from '../core/ids.js';
import { VerbFailureSchema } from '../verbs/failure.js';
import { ActionResultSchema } from '../verbs/result.js';
import { AbsenceTargetSchema, ScreenTargetSchema } from '../verbs/target.js';

/**
 * The longest a verb call may be asked to wait — five minutes, far below the lease TTL.
 *
 * The bound exists because the lease is renewed when the call **arrives**: a verb allowed to
 * run longer than the TTL could have its own lease expire underneath it, and the sweep would
 * then fire restoration on a device a verb is actively driving. Capping the wait well under
 * the TTL makes that unreachable rather than merely unlikely.
 *
 * A caller that wants a genuinely long verb also has to raise its own
 * `IpcRequestOptions.timeoutMs` past `DEFAULT_REQUEST_TIMEOUT_MS` (30 s) — the client
 * already takes one per request and says so. Two bounds, one at each end, and neither is a
 * configuration surface.
 */
export const MAX_VERB_TIMEOUT_MS = 5 * 60_000;

/**
 * What every verb call carries: the credential, and the two knobs a wait understands.
 *
 * `timeoutMs` is **non-negative** rather than positive because zero is meaningful and the
 * wait vocabulary defines it: `waitForCondition` probes before any delay, so `timeoutMs: 0`
 * is exactly one check rather than no checks — "is it there right now" without a wait.
 *
 * `WaitVerbOptions`' `now` and `delay` are deliberately absent. They are test seams the verb
 * module already says nothing on the wire will ever carry, and `.strict()` below turns an
 * attempt to send one into `invalid_params` rather than a host that quietly takes its clock
 * from a client.
 */
const VerbCallBaseSchema = z.object({
	leaseId: LeaseIdSchema,
	timeoutMs: z.number().int().nonnegative().max(MAX_VERB_TIMEOUT_MS).optional(),
	pollIntervalMs: z.number().int().positive().max(MAX_VERB_TIMEOUT_MS).optional(),
});

export const WaitForParamsSchema = VerbCallBaseSchema.extend({
	target: ScreenTargetSchema,
}).strict();
export type WaitForParams = z.infer<typeof WaitForParamsSchema>;

/**
 * `AbsenceTargetSchema` rather than `ScreenTargetSchema`, so a text target's `index` is
 * refused at the boundary instead of dropped — see that schema for why a dropped one would
 * report a row as gone while it is still on the screen.
 */
export const WaitUntilGoneParamsSchema = VerbCallBaseSchema.extend({
	target: AbsenceTargetSchema,
}).strict();
export type WaitUntilGoneParams = z.infer<typeof WaitUntilGoneParamsSchema>;

/**
 * Why a call never reached a verb at all.
 *
 * Deliberately the same words as `AcquireRefusalReasonSchema` for the three they share, so
 * an agent learns one vocabulary. `'held'` is absent — a live lease id *is* the holder — and
 * `'no-lease'` is here in its place.
 *
 * `'no-lease'` has no sub-reasons for the same reason `ReleaseDeviceResultSchema` has none:
 * an id that was never granted, one released a moment ago and one the store dropped on
 * expiry are indistinguishable to the store, and a distinction it cannot make reliably must
 * not be modelled as though it could. Its message names all three and says what to do.
 */
export const VerbRefusalReasonSchema = z.enum([
	/** The id is not a live lease — never granted, already released, or expired. */
	'no-lease',
	/** The device is no longer attached to this host (D6) — re-verification found nothing. */
	'gone',
	/** Visible to the host but not physically attached to it, so never driven (D18). */
	'not-attached',
	/** Attached, and in a state no verb could run against. */
	'not-ready',
]);
export type VerbRefusalReason = z.infer<typeof VerbRefusalReasonSchema>;

/**
 * What a verb call answers with — three branches, all data, mirroring
 * `AcquireDeviceResultSchema`.
 *
 * A refusal and a failure are **not** IPC errors, and that is the load-bearing decision
 * here: `IpcErrorCodeSchema` is a closed vocabulary in which the nearest code is
 * `internal_error` — "the host broke" — which is the wrong thing to tell an agent whose
 * element is simply not on screen yet. Anything outside these three branches still throws
 * out of the handler and arrives as `internal_error`, which keeps that code meaning what it
 * says.
 *
 * `ActionResultSchema` is imported rather than restated, so the shape the verb layer
 * produces and the shape a client reads are one schema parsed twice.
 */
export const VerbCallResultSchema = z.discriminatedUnion('outcome', [
	/** The verb ran and answered. */
	z.object({ outcome: z.literal('ok'), result: ActionResultSchema }).strict(),
	/** The verb ran and the answer is no. */
	z.object({ outcome: z.literal('failed'), failure: VerbFailureSchema }).strict(),
	/** No verb ran: the lease or the device was not in a state to run one. */
	z
		.object({
			outcome: z.literal('refused'),
			reason: VerbRefusalReasonSchema,
			message: z.string().min(1),
		})
		.strict(),
]);
export type VerbCallResult = z.infer<typeof VerbCallResultSchema>;
