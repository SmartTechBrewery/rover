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
import { DeviceKeySchema } from '../core/device.js';
import { AppIdSchema, LeaseIdSchema } from '../core/ids.js';
import { VerbFailureSchema } from '../verbs/failure.js';
import { ScrollDirectionSchema } from '../verbs/input.js';
import { ReadLogsResultSchema } from '../verbs/logs.js';
import { MAX_RECORDING_MS } from '../verbs/record.js';
import { type ActionResult, ActionResultSchema } from '../verbs/result.js';
import { AbsenceTargetSchema, ScreenTargetSchema, TargetSchema } from '../verbs/target.js';

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
 * What every verb call carries, and it is one field: the credential.
 *
 * The two wait knobs used to live here and were moved down to {@link WaitCallBaseSchema},
 * because a base every row extends is a base every row *advertises*. A gesture verb that
 * accepted `timeoutMs` would be offering a wait it does not perform — the call returns when
 * the device is done — and a caller who sent one would be told nothing, which is the silent
 * answer this protocol is built to avoid.
 *
 * The same reasoning is why `type_text` and `press_key` extend this and add no `target`: they
 * address no element, and `.strict()` turns a target sent to one of them into `invalid_params`
 * rather than a field the host ignores.
 */
const VerbCallBaseSchema = z.object({
	leaseId: LeaseIdSchema,
});

/**
 * The base for the two rows that actually wait, and only those.
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
const WaitCallBaseSchema = VerbCallBaseSchema.extend({
	timeoutMs: z.number().int().nonnegative().max(MAX_VERB_TIMEOUT_MS).optional(),
	pollIntervalMs: z.number().int().positive().max(MAX_VERB_TIMEOUT_MS).optional(),
});

export const WaitForParamsSchema = WaitCallBaseSchema.extend({
	target: ScreenTargetSchema,
}).strict();
export type WaitForParams = z.infer<typeof WaitForParamsSchema>;

/**
 * `AbsenceTargetSchema` rather than `ScreenTargetSchema`, so a text target's `index` is
 * refused at the boundary instead of dropped — see that schema for why a dropped one would
 * report a row as gone while it is still on the screen.
 */
export const WaitUntilGoneParamsSchema = WaitCallBaseSchema.extend({
	target: AbsenceTargetSchema,
}).strict();
export type WaitUntilGoneParams = z.infer<typeof WaitUntilGoneParamsSchema>;

/**
 * How long a gesture takes on the device, when a caller wants something other than the verb's
 * own default (`src/verbs/input.ts`).
 *
 * **Zero is legal**: a drag with no duration is a flick, which is a thing a caller can
 * legitimately ask for. The upper bound is {@link MAX_VERB_TIMEOUT_MS} for the reason that
 * bound exists at all — the lease is renewed when the call *arrives*, so a call that outruns
 * the TTL could have its own lease expire underneath it and the sweep fire restoration on a
 * device a verb is still driving. Whether the time is spent waiting on a screen or held
 * against one makes no difference to the lease.
 */
const GestureDurationSchema = z.number().int().nonnegative().max(MAX_VERB_TIMEOUT_MS).optional();

/**
 * `TargetSchema` rather than the narrowed `ScreenTargetSchema` the waits take: a coordinate is
 * PROJECT.md §4's documented fallback for exactly this verb, and the result says which of the
 * two it was.
 */
export const TapParamsSchema = VerbCallBaseSchema.extend({
	target: TargetSchema,
}).strict();
export type TapParams = z.infer<typeof TapParamsSchema>;

export const LongPressParamsSchema = VerbCallBaseSchema.extend({
	target: TargetSchema,
	durationMs: GestureDurationSchema,
}).strict();
export type LongPressParams = z.infer<typeof LongPressParamsSchema>;

/** Two targets, because a drag has two ends; `from` is the one the result reports. */
export const SwipeParamsSchema = VerbCallBaseSchema.extend({
	from: TargetSchema,
	to: TargetSchema,
	durationMs: GestureDurationSchema,
}).strict();
export type SwipeParams = z.infer<typeof SwipeParamsSchema>;

/**
 * `target` is a `ScreenTargetSchema` and optional: it names the scrollable region, absent for
 * the screen as a whole, and a caller-supplied point has no extent to scroll within
 * (`src/verbs/input.ts`, `ScrollOptions`).
 */
export const ScrollParamsSchema = VerbCallBaseSchema.extend({
	direction: ScrollDirectionSchema,
	target: ScreenTargetSchema.optional(),
	durationMs: GestureDurationSchema,
}).strict();
export type ScrollParams = z.infer<typeof ScrollParamsSchema>;

/**
 * The longest string one `type_text` call may carry.
 *
 * Allocation hygiene rather than validation, in the style of `ATTRIBUTION_MAX_LENGTH`: the
 * host echoes none of this anywhere, but it does decode it on a peer's behalf before any
 * handler sees it, and an unbounded field is one a peer chooses the size of. Generous enough
 * that no real caller meets it — a long paragraph is a few hundred characters — and small
 * enough that a frame is a frame.
 *
 * It says nothing about what a device can type. That question has a different answer on every
 * device, only the backend knows it, and the answer arrives as an `unsupported-text` failure
 * naming the characters (`src/verbs/failure.ts`).
 */
export const TYPE_TEXT_MAX_LENGTH = 4_096;

/**
 * `z.string()` with a bound and **no `.trim()`**: leading and trailing spaces are content
 * here, not formatting, and a schema that quietly dropped them would type a different string
 * than the caller sent. The empty string is legal for the same reason the backend still calls
 * the device for it — typing nothing on a device that has gone away should report the device.
 *
 * No refinement over the characters, deliberately. See {@link TYPE_TEXT_MAX_LENGTH}.
 */
export const TypeTextParamsSchema = VerbCallBaseSchema.extend({
	text: z.string().max(TYPE_TEXT_MAX_LENGTH),
}).strict();
export type TypeTextParams = z.infer<typeof TypeTextParamsSchema>;

/**
 * `DeviceKeySchema` rather than a string, so the verb, the backend and the wire share one
 * vocabulary: a key nobody implements is `invalid_params` at the boundary instead of a press
 * that reports success and does nothing.
 */
export const PressKeyParamsSchema = VerbCallBaseSchema.extend({
	key: DeviceKeySchema,
}).strict();
export type PressKeyParams = z.infer<typeof PressKeyParamsSchema>;

/**
 * What all three app-lifecycle rows carry — `launch_app`, `stop_app` and `clear_app_data`.
 *
 * **One schema for three rows**, because the three verbs take exactly the same call and a
 * near-copy per row is a copy that drifts. A verb that later grows a field of its own forks
 * this rather than widening it, for the reason {@link WaitCallBaseSchema} records for not
 * putting the wait knobs on {@link VerbCallBaseSchema}: a base every row extends is a base
 * every row advertises.
 *
 * `AppIdSchema` rather than a bare `z.string()` is what makes the reverse-DNS shape a
 * **boundary** check. A malformed id is `invalid_params` on the wire, where the caller can
 * read it, instead of an `InvalidIdError` thrown deep inside a backend assembling a
 * device-side command line out of it (`src/core/ids.ts`, `AppId`).
 *
 * No `serial`, and `.strict()` is what keeps one out: the lease id is the credential and the
 * host derives the device from it (D20). A serial accepted beside it would be the one field
 * that lets the holder of one lease drive another device.
 */
export const AppVerbParamsSchema = VerbCallBaseSchema.extend({
	appId: AppIdSchema,
}).strict();
export type AppVerbParams = z.infer<typeof AppVerbParamsSchema>;

/**
 * The most log entries one `read_logs` call may ask for.
 *
 * A bound rather than a preference: the host reads this many entries out of a device,
 * parses them and encodes them into one response, all on a peer's behalf, so an unbounded
 * `maxEntries` is an allocation somebody else chose — the same reasoning
 * `ATTRIBUTION_MAX_LENGTH` applies to a string it never reads. Two thousand entries came
 * off a real device in 36 ms (2253 lines, 331 KB — PROJECT.md §6), so five thousand is
 * still a query, and it is far more than a crash investigation needs.
 *
 * **This bound is on entries and cannot bound the answer**, which is why it is not the only
 * one. An entry has no fixed size — logcat's own per-entry payload limit is about 4 KB, so
 * this many entries is a few hundred kilobytes of ordinary chatter and over 20 MB of
 * serialised HTTP bodies — while a response travels as one frame under `MAX_FRAME_BYTES`
 * (`src/ipc/framing.ts`), enforced on the *receiving* side, where going over it is not a
 * refusal the caller can read but a destroyed connection. The byte bound that actually
 * holds is `MAX_LOG_BYTES` in `src/verbs/logs.ts`. The next payload-carrying verb
 * (`pull_file`, R24) needs one too, and for the same reason: entries, elements and lines
 * are all counts of things whose size the caller chooses.
 */
export const MAX_LOG_ENTRIES = 5_000;

/**
 * The lease id and, optionally, how much of the log to read.
 *
 * `maxEntries` is **absent rather than defaulted** here, so the verb's own default
 * (`src/verbs/logs.ts`) applies to a caller who said nothing and there is no second
 * number that can disagree with it. `.strict()` keeps a `serial` out for the reason
 * {@link AppVerbParamsSchema} records: the lease id is the credential and the host derives
 * the device from it (D20).
 *
 * There is deliberately no `follow`, no `since` and no tag filter. A follow is a wait with
 * no condition and a stream over IPC; the other two are real requests and would each be a
 * row's worth of design rather than a flag smuggled in beside a bound.
 */
export const ReadLogsParamsSchema = VerbCallBaseSchema.extend({
	maxEntries: z.number().int().positive().max(MAX_LOG_ENTRIES).optional(),
}).strict();
export type ReadLogsParams = z.infer<typeof ReadLogsParamsSchema>;

/** What a `read_screen` call carries: the lease id, and nothing else. */
export const ReadScreenParamsSchema = VerbCallBaseSchema.strict();
export type ReadScreenParams = z.infer<typeof ReadScreenParamsSchema>;

/** What a `device_info` call carries — the same one field, for the same reasons. */
export const DeviceInfoParamsSchema = VerbCallBaseSchema.strict();
export type DeviceInfoParams = z.infer<typeof DeviceInfoParamsSchema>;

/**
 * What a `screenshot` call carries — again the lease id alone, and again its own schema for
 * the reason {@link DeviceInfoParamsSchema} gives.
 *
 * **No destination and no format.** A path would be the one field D19 rules out: the capture
 * happens on the host and the answer is read on the caller's machine, so a path sent here
 * either names nothing or names something on the wrong disk. What comes back is
 * `ActionResult.artifact` — the bytes, base64-encoded — and where they end up is the
 * client's own decision.
 */
export const ScreenshotParamsSchema = VerbCallBaseSchema.strict();
export type ScreenshotParams = z.infer<typeof ScreenshotParamsSchema>;

/**
 * What a `record_video` call carries: the lease id and, optionally, how long to record for.
 *
 * `durationMs` is **absent rather than defaulted**, so the verb's own default
 * (`src/verbs/record.ts`) applies to a caller who said nothing and there is no second number
 * that can disagree with it — {@link ReadLogsParamsSchema}'s reasoning exactly.
 *
 * The upper bound is {@link MAX_RECORDING_MS}, imported rather than restated: it is a bound
 * on what one answer can carry, and a copy of it here would be free to drift from the one
 * the verb enforces.
 *
 * **No destination path and no format**, for the sentence {@link ScreenshotParamsSchema}
 * already carries: the recording happens on the host and the answer is read on the caller's
 * machine, so a path sent here either names nothing or names something on the wrong disk
 * (D19). What comes back is `ActionResult.artifact` — the bytes, base64-encoded.
 *
 * **A caller asking for a long recording must also raise its own request timeout.**
 * `IpcRequestOptions.timeoutMs` defaults to 30 s (`./client.ts`), and a call that spends
 * fifteen of them recording before it begins transferring several megabytes can reach it.
 * That is the bound at the caller's end, and this module already documents the pair.
 */
export const RecordVideoParamsSchema = VerbCallBaseSchema.extend({
	durationMs: z.number().int().positive().max(MAX_RECORDING_MS).optional(),
}).strict();
export type RecordVideoParams = z.infer<typeof RecordVideoParamsSchema>;

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
 * A **factory** because one verb's answer now carries more than an `ActionResult`
 * (`read_logs`, and `pull_file` after it), and only the `ok` branch differs: the failure
 * and the refusal are the same two schemas whatever was asked, which is the point rather
 * than an economy — an agent learns one refusal vocabulary, not one per verb family. The `ok`
 * schema is always an `ActionResult` or an extension of one, so every verb's answer carries
 * the device, the target and the after-state in the same places; each row is parsed with its
 * own schema, because these are `.strict()` and an extension's extra field must be an error
 * on the row that does not declare it rather than data quietly dropped.
 *
 * `ActionResultSchema` is imported rather than restated, so the shape the verb layer
 * produces and the shape a client reads are one schema parsed twice.
 */
function verbCallResultOf<Ok extends z.ZodTypeAny>(ok: Ok) {
	return z.discriminatedUnion('outcome', [
		/** The verb ran and answered. */
		z.object({ outcome: z.literal('ok'), result: ok }).strict(),
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
}

/** What every verb whose answer is exactly an `ActionResult` replies with. */
export const VerbCallResultSchema = verbCallResultOf(ActionResultSchema);
export type VerbCallResult = z.infer<typeof VerbCallResultSchema>;

/**
 * `read_logs`, whose answer carries the log entries on top of the common shape
 * (`src/verbs/logs.ts`).
 */
export const ReadLogsCallResultSchema = verbCallResultOf(ReadLogsResultSchema);
export type ReadLogsCallResult = z.infer<typeof ReadLogsCallResultSchema>;

/**
 * The two answers that mean no verb result exists — the branches every row shares whatever
 * it was asked for, taken off {@link VerbCallResult} rather than written out again.
 */
export type VerbCallRefusal = Exclude<VerbCallResult, { outcome: 'ok' }>;

/**
 * One verb call's answer, generic in what the `ok` branch carries — what the daemon's
 * `runVerb` is typed on (`src/daemon/verb-handlers.ts`).
 *
 * The type-level statement of what the factory above does at runtime: only `ok` varies, so
 * a refusal is one vocabulary whatever was asked.
 */
export type VerbCallResultOf<Result extends ActionResult> =
	| { readonly outcome: 'ok'; readonly result: Result }
	| VerbCallRefusal;
