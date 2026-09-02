/**
 * The method table — one place mapping a method name to the schema its params are parsed
 * with and the schema its result is parsed with.
 *
 * Both directions go through this table, which is what makes "every message is parsed,
 * never cast" true on the response path too: the server parses `params` before calling a
 * handler and parses the handler's return value before writing it.
 *
 * The surface carries **verb calls**, not just lease operations (PROJECT.md R6, D19) — the
 * two waits below are on it, and adding `tap` or `read_screen` is a row here plus its
 * handler. The envelope, the framing, the server and the client do not change.
 * {@link IpcHandlers} is a complete mapped type over this table's keys, so adding a row
 * without a handler is a compile error rather than an `unknown_method` an agent discovers at
 * runtime.
 *
 * The verb rows' schemas live in `./verb-methods.ts` and are re-exported below; the **table**
 * stays single, because a second table is a second place a method can exist.
 */

import { z } from 'zod';
import { CapabilitiesSchema } from '../core/capabilities.js';
import { DeviceSchema } from '../core/device.js';
import { AppIdSchema, DeviceSerialSchema, LeaseIdSchema } from '../core/ids.js';
import { ProtocolVersionSchema } from './protocol.js';
import {
	AppVerbParamsSchema,
	DeviceInfoParamsSchema,
	EnvironmentVerbParamsSchema,
	InstallAppParamsSchema,
	LongPressParamsSchema,
	PressKeyParamsSchema,
	PullFileParamsSchema,
	PushFileParamsSchema,
	ReadLogsCallResultSchema,
	ReadLogsParamsSchema,
	ReadScreenParamsSchema,
	RecordVideoCallResultSchema,
	RecordVideoParamsSchema,
	ScreenshotParamsSchema,
	ScrollParamsSchema,
	SwipeParamsSchema,
	TapParamsSchema,
	TypeTextParamsSchema,
	VerbCallResultSchema,
	WaitForParamsSchema,
	WaitUntilGoneParamsSchema,
} from './verb-methods.js';

export {
	type AppVerbParams,
	AppVerbParamsSchema,
	ARTIFACT_LABEL_MAX_LENGTH,
	ArtifactLabelSchema,
	Base64PayloadSchema,
	type DeviceInfoParams,
	DeviceInfoParamsSchema,
	DevicePathSchema,
	type EnvironmentVerbParams,
	EnvironmentVerbParamsSchema,
	type InstallAppParams,
	InstallAppParamsSchema,
	type LongPressParams,
	LongPressParamsSchema,
	MAX_DEVICE_PATH_LENGTH,
	MAX_LOG_ENTRIES,
	MAX_TRANSFER_BYTES,
	MAX_VERB_TIMEOUT_MS,
	type PressKeyParams,
	PressKeyParamsSchema,
	type PullFileParams,
	PullFileParamsSchema,
	type PushFileParams,
	PushFileParamsSchema,
	type ReadLogsCallResult,
	ReadLogsCallResultSchema,
	type ReadLogsParams,
	ReadLogsParamsSchema,
	type ReadScreenParams,
	ReadScreenParamsSchema,
	type RecordVideoCallResult,
	RecordVideoCallResultSchema,
	type RecordVideoParams,
	RecordVideoParamsSchema,
	type ScreenshotParams,
	ScreenshotParamsSchema,
	type ScrollParams,
	ScrollParamsSchema,
	type SwipeParams,
	SwipeParamsSchema,
	type TapParams,
	TapParamsSchema,
	TYPE_TEXT_MAX_LENGTH,
	type TypeTextParams,
	TypeTextParamsSchema,
	type VerbCallRefusal,
	type VerbCallResult,
	type VerbCallResultOf,
	VerbCallResultSchema,
	type VerbRefusalReason,
	VerbRefusalReasonSchema,
	type WaitForParams,
	WaitForParamsSchema,
	type WaitUntilGoneParams,
	WaitUntilGoneParamsSchema,
} from './verb-methods.js';

/** What one row of {@link IPC_METHODS} must provide. */
export interface IpcMethodDefinition {
	readonly params: z.ZodTypeAny;
	readonly result: z.ZodTypeAny;
}

/** `.strict()` so a typo'd argument is `invalid_params`, not a silently ignored key. */
export const StatusParamsSchema = z.object({}).strict();
export type StatusParams = z.infer<typeof StatusParamsSchema>;

/**
 * `uptimeMs` is a **duration, not an instant** — the caller may be on another machine and
 * shares no clock with the host, so a `startedAt` would be a number only the host can
 * interpret (D17).
 */
export const StatusResultSchema = z
	.object({
		protocolVersion: ProtocolVersionSchema,
		pid: z.number().int().positive(),
		uptimeMs: z.number().int().nonnegative(),
	})
	.strict();
export type StatusResult = z.infer<typeof StatusResultSchema>;

/** `.strict()` for the same reason as {@link StatusParamsSchema}: this method takes nothing. */
export const ListDevicesParamsSchema = z.object({}).strict();
export type ListDevicesParams = z.infer<typeof ListDevicesParamsSchema>;

/**
 * What a caller who is *not* the holder is told about a lease — the same attribution
 * {@link GrantedLeaseSchema} carries, minus the credential and **plus** the grant instant.
 * It is what a refusal names and what a listed device names, because both are readable by
 * anyone who can reach the host.
 *
 * Anyone may ask for a busy device, so anything in this shape is public to strangers. The
 * lease id ends the lease, so including it would let whoever was refused release the holder
 * and take the device. The owner, project and test name are here because "held by
 * `pr-127-review` for another eleven minutes" is what makes a refusal actionable.
 *
 * The holder's `testDescription` is here for the same reason and carries the same absence
 * (`GrantedLeaseSchema`): it is what an operator reads before deciding a lease is worth ending,
 * and a refusal and a listing must not disagree about it — which is why there is one projection
 * that builds this shape (`src/daemon/lease-holder.ts`) rather than a field added at each caller.
 * The holder's `groupId` rides on the same projection for the same reason: "this device is held
 * by the other half of a before/after comparison" is a different thing to read than "this device
 * is held", and a listing that said so where a refusal did not would be two answers.
 *
 * The grant instant is here and *not* on `GrantedLeaseSchema` for the opposite reason: the
 * winner of an acquire already knows when it was granted, because it asked. A stranger
 * reading a list has no other way to find out.
 */
export const LeaseHolderSchema = z
	.object({
		serial: DeviceSerialSchema,
		owner: z.string(),
		project: z.string(),
		testName: z.string(),
		/** As the holder supplied it, or absent. Optional for `GrantedLeaseSchema`'s reason. */
		testDescription: z.string().optional(),
		/**
		 * The holder's group, or absent — carried here so a refusal and a listing cannot disagree
		 * about it, which is the whole reason one projection builds this shape
		 * (`src/daemon/lease-holder.ts`). It attributes and authorizes nothing: knowing which
		 * investigation holds a device is not a way to join it.
		 */
		groupId: z.string().optional(),
		/**
		 * When this lease was **granted**, as an ISO-8601 instant with a `Z`. The one field on
		 * this schema that is an instant rather than a duration, and so the one deliberate
		 * exception to D17 — which is why it says here what it gives up.
		 *
		 * It answers a different question from `expiresInMs`, and **neither is derivable from
		 * the other**: activity renews the TTL (D8), so the expiry moves and this does not.
		 * "How long has `pr-127-review` had this device" is what an operator asks before
		 * deciding a lease is stuck, and subtracting `expiresInMs` from the TTL answers it only
		 * for a lease nothing has renewed — the rare case, not the normal one.
		 *
		 * **What the encoding gives up is clock-skew independence, not JSON.** A string
		 * survives JSON where a `Date` would not, so every client reads one shape. But it is
		 * the *host's* clock: a client renders it as given — which is why it is UTC, and why
		 * nothing truncates it — and must not difference it against its own `Date.now()`,
		 * because that difference is the skew plus the answer. Anything relative still comes
		 * from `expiresInMs`, which is a duration for exactly that reason.
		 *
		 * ISO-8601 rather than epoch milliseconds, and the trade is deliberate: it costs a
		 * `Date.parse` to compute with, and it is unambiguous to read in a log, in
		 * `rover list --json` and in the panel's `GRANTED` field. In an object whose other
		 * numbers are durations, a bare epoch number is the one that gets subtracted from one
		 * of them by accident. `UserRecordSchema.createdAt` is the same encoding for the same
		 * kind of value.
		 */
		grantedAt: z.string().datetime(),
		expiresInMs: z.number().int().nonnegative(),
	})
	.strict();
export type LeaseHolder = z.infer<typeof LeaseHolderSchema>;

/**
 * One device as a client sees it in a list: what the host knows about the hardware, plus who
 * is holding it — `heldBy: null` for a free device, never an absent key, because `undefined`
 * does not survive JSON and would make "free" something every client has to special-case.
 *
 * `.extend()` rather than a restatement, for the reason recorded on
 * {@link ListDevicesResultSchema} below: the shape a backend produces and the shape a client
 * reads stay one schema parsed twice.
 *
 * A list reply is public to whoever can reach the host, exactly like a refusal — so it
 * carries the holder's attribution and never the lease id (D20). Including the id would let
 * anyone who can list devices end somebody else's lease. {@link LeaseHolderSchema} is
 * `.strict()` and the server parses every handler's return value against it, so a leaked
 * `leaseId` is `invalid_result` on the host rather than a credential on the wire.
 *
 * {@link LeaseHolder} repeats the `serial` the device already carries; that is the price of
 * reusing the one holder schema instead of forking a near-copy, and it costs a client
 * nothing.
 */
export const ListedDeviceSchema = DeviceSchema.extend({
	heldBy: LeaseHolderSchema.nullable(),
});
export type ListedDevice = z.infer<typeof ListedDeviceSchema>;

/**
 * `DeviceSchema` is imported rather than restated, so the shape a backend produces and the
 * shape a client reads are one schema parsed twice — once on the way out of the handler,
 * once on the way into the client — instead of two that drift.
 *
 * `stale` earns its place next to the list: a view of the devices presented as current
 * when the host is not in a position to know is exactly the stale-state failure D6 is
 * about, and no client can infer it from the list itself — a host that has gone blind, a
 * host that has not heard yet and a host with nothing attached all answer with an empty
 * array.
 */
export const ListDevicesResultSchema = z
	.object({
		devices: z.array(ListedDeviceSchema),
		/**
		 * The list is **not known to be current** — the host's view was interrupted, has not
		 * arrived yet, or is not running. Treat it as "the last thing seen", never as "what is
		 * attached"; an empty list with this set means *no view*, not *no devices*.
		 */
		stale: z.boolean(),
	})
	.strict();
export type ListDevicesResult = z.infer<typeof ListDevicesResultSchema>;

/**
 * The three caller-supplied attribution strings — `owner` (D16), `project` and `test_name`
 * (D22) — share one schema because the host validates them identically: it stores them, echoes
 * them back, and never checks their content against a vocabulary. No `.trim()` (that would
 * modify a caller's string), no default synthesized from a branch, a pull request or a process,
 * and no value here is ever refused for what it says.
 *
 * **`project` is the one the host also *looks up*.** `owner` and `test_name` stay opaque, but
 * when a lease ends the daemon resolves `project` to a hook file on the host and runs the
 * teardown it declares (`src/daemon/project-hooks.ts`, D13) — so a daemon-side behaviour does
 * depend on that string, and it is worth knowing before writing code that assumes otherwise.
 * The wire contract is nevertheless unchanged, which is the distinction to hold on to: a
 * lookup, not validation. A string that is not a hook-file identifier names no hook file, and
 * is still stored and echoed back verbatim exactly like the other two. `project-hooks.ts`
 * says the same thing from the other side of that seam.
 *
 * The upper bound is allocation hygiene of the kind `RequestIdSchema` and `MethodNameSchema`
 * already apply, not validation: the host echoes these back in a refusal, so an unbounded
 * one is a response it allocates and encodes on a peer's behalf. It looks at the length and
 * never at the meaning.
 */
export const ATTRIBUTION_MAX_LENGTH = 256;
export const AttributionStringSchema = z.string().min(1).max(ATTRIBUTION_MAX_LENGTH);

/**
 * The lease's fourth caller-supplied string — `test_description` (D22, as amended #148) — and
 * **the one that may be absent**. One or two sentences saying what this run is checking, in the
 * agent's own words, beside the short identifier-shaped `testName` that names it.
 *
 * It is attribution like the other three: opaque, stored as given, parsed by nothing, derived
 * from nothing and authorizing nothing (D20). What separates it is that **it is not a path
 * segment and never becomes one** — `testName` remains the only caller string the archive tree
 * is shaped from (`src/daemon/archive-path.ts`, untouched by this field) — which is also why
 * absent is a legitimate answer here and is not one for `testName`: the tree's shape cannot
 * depend on a field the tree does not use.
 *
 * **A separate bound rather than {@link ATTRIBUTION_MAX_LENGTH}, deliberately.** The 256 above
 * exists because the host echoes those strings back inside a refusal *message* it allocates on a
 * peer's behalf; nothing echoes a description into a message, and 256 characters is short for two
 * sentences. 1024 is still allocation hygiene of the same kind — a bound, looked at for its length
 * and never for its meaning — set where prose fits rather than where an identifier does.
 *
 * `.min(1)`, so **absent is the only way to say nothing**: an empty string is `invalid_params`
 * rather than a description that renders as a blank field, which is #129's lesson applied to the
 * field that is genuinely optional. Nothing anywhere substitutes a placeholder for a caller who
 * supplied none.
 */
export const TEST_DESCRIPTION_MAX_LENGTH = 1024;
export const TestDescriptionSchema = z.string().min(1).max(TEST_DESCRIPTION_MAX_LENGTH);

/**
 * The lease's fifth caller-supplied string — `group_id` (D22, as amended #150) — and **the one
 * that spans leases**. Several leases carrying one `groupId` are one investigation: the run
 * before a change and the run after it, and nothing stops there being a third and a fourth.
 *
 * {@link AttributionStringSchema}'s bound and shape, because that is what it is: an identifier
 * the caller chose, opaque, stored as given, parsed by nothing, derived from nothing and
 * authorizing nothing (D20). It is deliberately **not** {@link TestDescriptionSchema}'s — this is
 * a name to match on, not prose to read.
 *
 * **Nothing enforces arity, uniqueness or membership.** One lease may be the only member of its
 * group and a group may have seven; nothing checks that a second member ever arrives, nothing
 * refuses a group id another lease already used, and nothing anywhere counts them. A group is a
 * claim the caller makes, and the host records it.
 *
 * **Optional, and absent stays absent** — no empty string standing in and no group invented for a
 * caller who supplied none (#129's lesson). What it costs a caller to leave it out is stated
 * exactly once, on the wire: an artifact `label` is then refused, because a label only means
 * something inside a group (`ArtifactLabelSchema`, `src/daemon/verb-handlers.ts`).
 */
export const GroupIdSchema = AttributionStringSchema;

/**
 * `.strict()` so a typo'd key is `invalid_params` rather than a lease granted with an
 * attribution string silently missing — which the archive would only discover later, with
 * the device already handed out. That holds for the optional keys too: `testDescriptoin` is a
 * refusal, not a lease quietly granted with no description, and `groupID` is a refusal rather
 * than a lease that silently lost its grouping and a comparison that can never be recovered.
 *
 * `testName` is **required** — a lease always names what it is checking, because that name is
 * this lease's directory in the host's artifact archive and a fallback the approved designs do
 * not have is a directory the code would invent for nobody (D22, as amended #129; PROJECT.md
 * §10). It stays deliberately **not unique**: the same named check run before and after a
 * change is two leases carrying one name, which is the expected shape and what puts the two
 * runs side by side for the comparison (D24).
 */
export const AcquireDeviceParamsSchema = z
	.object({
		serial: DeviceSerialSchema,
		/** Who this lease is for. Attribution only — it authorizes nothing (D20). */
		owner: AttributionStringSchema,
		/**
		 * What this lease is for. Attribution, and the name the host looks up to find this
		 * project's hook file (D13) — see {@link AttributionStringSchema}. It still authorizes
		 * nothing: naming a project is not a claim to it.
		 */
		project: AttributionStringSchema,
		/**
		 * What this lease is checking. Attribution, and the name the archive files this lease's
		 * artifacts under (D22, D24) — opaque here, parsed by nothing, and not unique.
		 */
		testName: AttributionStringSchema,
		/**
		 * What this run is *about*, in the caller's own sentences — optional, and never a path
		 * segment. See {@link TestDescriptionSchema} for why this one may be absent when
		 * {@link AcquireDeviceParams.testName} may not.
		 */
		testDescription: TestDescriptionSchema.optional(),
		/**
		 * Which investigation this lease is part of — optional, and shared with every other lease
		 * that belongs to the same one. See {@link GroupIdSchema}; it is the field an artifact
		 * `label` needs, and the only thing a caller gives up by leaving it out.
		 */
		groupId: GroupIdSchema.optional(),
	})
	.strict();
export type AcquireDeviceParams = z.infer<typeof AcquireDeviceParamsSchema>;

/**
 * What the winner of an acquire is handed. `leaseId` is the **credential**: it is the only
 * thing that releases the lease, because the owner string attributes and never authorizes
 * (D20).
 *
 * `expiresInMs` is a duration, not an instant, for the same reason `uptimeMs` is: the caller
 * may be on another machine and shares no clock with the host (D17).
 *
 * `testDescription` is `.optional()` and **absent is absent**: a caller who supplied none gets no
 * key back rather than an empty string or an invented placeholder, so a client can tell "there is
 * no description" from "the description is blank" without a convention. `undefined` does not
 * survive JSON, which is exactly the encoding wanted here — unlike `heldBy`, where absence had to
 * be a `null` because *free* is a state every client branches on.
 */
export const GrantedLeaseSchema = z
	.object({
		leaseId: LeaseIdSchema,
		serial: DeviceSerialSchema,
		owner: z.string(),
		project: z.string(),
		testName: z.string(),
		/** As the caller supplied it, or absent. Never derived and never defaulted. */
		testDescription: z.string().optional(),
		/**
		 * The group this lease was put in, or absent — echoed back for `testDescription`'s reason
		 * and one of its own: it is what the *next* lease in the comparison has to be given, so a
		 * caller reading this answer is reading the string it will pass again.
		 */
		groupId: z.string().optional(),
		expiresInMs: z.number().int().nonnegative(),
	})
	.strict();
export type GrantedLease = z.infer<typeof GrantedLeaseSchema>;

/** Why a device was not granted. Each is a different next move for the caller. */
export const AcquireRefusalReasonSchema = z.enum([
	/** Someone else holds it. `heldBy` says who, and for how much longer. */
	'held',
	/** The device is no longer attached to this host (D6) — re-verification found nothing. */
	'gone',
	/** Visible to the host but not physically attached to it, so never leased (D18). */
	'not-attached',
	/** Attached, but in a state no verb could run against — granting it would be a false yes. */
	'not-ready',
	/**
	 * A helper service the lease's project declares did not start, so the grant was undone
	 * (D13, R17 phase 4). The `message` names the service.
	 *
	 * One more reason rather than a second way to say no: granting a device whose helper
	 * services are down is the same class of false yes as `not-ready`, and an agent's next move
	 * is the same shape too — this device is not usable for this project right now, and the
	 * sentence says which service to go and look at. The lease is released before the answer
	 * travels, so the device is free for the next caller rather than held by a grant that
	 * failed.
	 */
	'service-failed',
	/**
	 * Every helper-service slot on this host is in use, so there are no ports to give this
	 * lease (R18) — release a lease and ask again. Granting without them would be the silent
	 * degradation ai/RULES.md §2 forbids, and `internal_error` would say the host broke when
	 * it is simply full.
	 */
	'no-slot',
]);
export type AcquireRefusalReason = z.infer<typeof AcquireRefusalReasonSchema>;

/**
 * Granted or refused, as **data**. A refusal is not an IPC error: `IpcErrorCodeSchema` is a
 * closed vocabulary in which the nearest code is `internal_error` — "the host broke" — which
 * is exactly the wrong thing to tell an agent whose device is simply busy
 * (ai/CODING_STANDARDS.md "Error handling").
 *
 * Discriminated on a string field, the way `ResponseSchema` discriminates on `type`.
 */
export const AcquireDeviceResultSchema = z.discriminatedUnion('outcome', [
	z
		.object({
			outcome: z.literal('granted'),
			lease: GrantedLeaseSchema,
			/** The device as re-verified at grant time, never as last cached (D6). */
			device: DeviceSchema,
			/**
			 * What this device's backend declares it can do (PROJECT.md §4). The same schema the
			 * manifest is parsed with, so a client reads one shape rather than a copy of it.
			 */
			capabilities: CapabilitiesSchema,
		})
		.strict(),
	z
		.object({
			outcome: z.literal('refused'),
			reason: AcquireRefusalReasonSchema,
			message: z.string().min(1),
			/** Non-null only for `'held'` — the other reasons have no holder to name. */
			heldBy: LeaseHolderSchema.nullable(),
		})
		.strict(),
]);
export type AcquireDeviceResult = z.infer<typeof AcquireDeviceResultSchema>;

/** The lease id and nothing else: it is the credential, and the owner string is not. */
export const ReleaseDeviceParamsSchema = z.object({ leaseId: LeaseIdSchema }).strict();
export type ReleaseDeviceParams = z.infer<typeof ReleaseDeviceParamsSchema>;

/**
 * Whether there was a live lease to end.
 *
 * No reason code, deliberately: an id that never existed, one released a moment ago and one
 * whose lease expired and was dropped by an earlier read are indistinguishable to the store,
 * and a distinction it cannot make reliably must not be modelled as though it could.
 */
export const ReleaseDeviceResultSchema = z.object({ released: z.boolean() }).strict();
export type ReleaseDeviceResult = z.infer<typeof ReleaseDeviceResultSchema>;

/**
 * Ending a lease you do **not** hold, keyed on the serial — the one row on this surface that
 * names a device instead of presenting a credential.
 *
 * There is deliberately no `leaseId` here, and that absence is the whole point of the row.
 * Force-releasing is by definition ending somebody else's lease, and the only credential that
 * ends a lease is the id its holder was handed (D20) — so the alternatives were to give the
 * operator the holder's id, which means putting it in a listing and undoing the reason
 * {@link ListedDeviceSchema} does not carry one, or to key the call on the thing an operator
 * can actually see. This is the second. The serial is public in every listing already, and
 * naming it discloses nothing the caller could not read a moment earlier.
 *
 * **What authorizes the call is reaching this surface** (D28): the local socket is a shell on
 * the host, which already has every device, and a network caller is a named user in the host's
 * own store (D25, R28). No new tier is invented here — every named user has the same reach
 * today, and `docs/WEB_PANEL.md` keeps tiering an open question rather than an assumed one.
 * `actor` is **attribution and not authorisation**, exactly like `acquire_device`'s `owner`:
 * the host records who said they were doing this and derives it from nothing, because deriving
 * attribution from whoever authenticated is what D20 forbids — and the identity of the acting
 * user is not their token, which never reaches a record.
 *
 * `.strict()` for {@link AcquireDeviceParamsSchema}'s reason: a typo'd key is `invalid_params`
 * rather than a lease ended with the record of who ended it silently missing.
 */
export const ForceReleaseDeviceParamsSchema = z
	.object({
		serial: DeviceSerialSchema,
		/** Who is ending it. Attribution only — it authorizes nothing (D20, D28). */
		actor: AttributionStringSchema,
	})
	.strict();
export type ForceReleaseDeviceParams = z.infer<typeof ForceReleaseDeviceParamsSchema>;

/**
 * Why there was nothing to force-release. Each is a different thing for the operator staring
 * at the screen to do next, which is why they are three named answers and not one boolean.
 */
export const ForceReleaseRefusalReasonSchema = z.enum([
	/** The device is attached to this host and nobody holds it — there was nothing to end. */
	'not-held',
	/** The device is no longer attached to this host (D6) — re-verification found nothing. */
	'gone',
	/** Visible to the host but not physically attached to it, so never leased (D18). */
	'not-attached',
]);
export type ForceReleaseRefusalReason = z.infer<typeof ForceReleaseRefusalReasonSchema>;

/**
 * Released or refused, as **data** — {@link AcquireDeviceResultSchema}'s reasoning applies
 * verbatim: "that device is already free" is an answer an operator acts on, not a host that
 * broke.
 */
export const ForceReleaseDeviceResultSchema = z.discriminatedUnion('outcome', [
	z
		.object({
			outcome: z.literal('released'),
			/**
			 * Who was holding it, as of the instant before the lease ended, and how much longer
			 * they would have had. The same public projection a listing and a refusal carry
			 * ({@link LeaseHolderSchema}, `src/daemon/lease-holder.ts`) — so, like both of those,
			 * **never** the lease id: force-releasing a device must not be a way to obtain the
			 * credential for the next one.
			 */
			heldBy: LeaseHolderSchema,
		})
		.strict(),
	z
		.object({
			outcome: z.literal('refused'),
			reason: ForceReleaseRefusalReasonSchema,
			message: z.string().min(1),
		})
		.strict(),
]);
export type ForceReleaseDeviceResult = z.infer<typeof ForceReleaseDeviceResultSchema>;

/**
 * The longest one archive path component may be.
 *
 * 255 is the per-component limit of every filesystem this runs on, so a name `readdir` can
 * actually produce is always inside it. On the way *in* it is allocation hygiene of the kind
 * {@link ATTRIBUTION_MAX_LENGTH} already applies, not validation.
 */
export const MAX_ARCHIVE_PATH_SEGMENT_LENGTH = 255;

/**
 * How many levels one request may name.
 *
 * The archive is four levels plus a run's own contents
 * (`<project>/<test_name>/<lease>/<serial>/recordings/<n>_frames`), so six is the deepest
 * anything the archive writes reaches. Eight is headroom — a bound rather than a rule.
 */
export const MAX_ARCHIVE_PATH_DEPTH = 8;

/**
 * One component of an archive path — a single directory name, as a previous listing named it.
 *
 * Six things here are decisions rather than details:
 *
 * - **`.refine`, never `.transform`.** A throw inside a `.transform()` escapes `safeParse` past
 *   a caller that had every reason to expect a returned failure (ai/CODING_STANDARDS.md).
 * - **This bounds the path as a *string*, and that is not the whole containment guarantee.**
 *   `join(root, ...path)` cannot escape `root` once no component is `.`, `..`, or carries a
 *   separator — but a symlink resolves out of the root without any of those, and `readdir`
 *   follows the one in its own argument. So `src/daemon/list-archive.ts` compares the resolved
 *   directory against the resolved root before it reads anything, and that check, not this
 *   schema, is what makes containment true.
 * - **A component may carry a control character, so it must never reach host output
 *   unescaped.** `\n`, `\r` and ESC are all legal in a filename and are all accepted here on
 *   purpose, for the same reason a backslash is (below). Anything that renders one into a log
 *   line or a table stringifies or escapes it first — `src/daemon/list-archive.ts` uses
 *   `JSON.stringify` as `src/daemon/lease-handlers.ts` does, and the CLI uses
 *   `escapeControlCharacters` — or a caller forges a line in the host's own record.
 * - **A backslash is deliberately not refused.** On the platforms Rover hosts devices on it is
 *   an ordinary filename character that `join` treats as one, so refusing it would make a name
 *   the host itself answered with un-addressable on the next request. The archive's *writer*
 *   strips it (`pathSegment`) because it invents names; this reads names that already exist.
 * - **Nothing is sanitised on the way in.** Not `pathSegment`, not `.trim()`: these came out of
 *   a previous answer and are the on-disk names. Validate the shape and use them verbatim (D22)
 *   — nothing here parses a component to infer anything about what it says.
 * - `DevicePathSchema` is not reused: that is one absolute string naming a path on a *device*,
 *   and this is one relative component on the *host*.
 */
export const ArchivePathSegmentSchema = z
	.string()
	.min(1)
	.max(MAX_ARCHIVE_PATH_SEGMENT_LENGTH)
	.refine(
		(segment) =>
			segment !== '.' && segment !== '..' && !segment.includes('/') && !segment.includes('\u0000'),
		{
			message:
				"an archive path component is one directory name — never '.', '..', a separator or a NUL",
		},
	);

/**
 * `.strict()` so a typo'd key is `invalid_params` rather than the root listed for a caller who
 * asked about something else, and `path` is required rather than optional so that promise holds
 * for the only key there is.
 *
 * **There is deliberately no second key.** No `filter`, `search`, `sortBy`, `depth`, `limit` or
 * `offset`: D24's point is that listing a directory *is* the query, and a parameter that turns
 * this into a query is how an index gets built by accident.
 */
export const ListArchiveParamsSchema = z
	.object({
		/** The level to list, as the components a previous answer returned. `[]` is the root. */
		path: z.array(ArchivePathSegmentSchema).max(MAX_ARCHIVE_PATH_DEPTH),
	})
	.strict();
export type ListArchiveParams = z.infer<typeof ListArchiveParamsSchema>;

/**
 * One entry of one level — what a single `readdir`, plus a `stat` or one `readdir` of a child,
 * can honestly answer, and nothing more.
 *
 * `name` reuses {@link ArchivePathSegmentSchema} on purpose: a name this method answers with is
 * by construction a component the *next* request may carry, which is what "the path as the
 * components a previous answer returned" means structurally rather than by convention.
 */
export const ArchiveEntrySchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('directory'),
			name: ArchivePathSegmentSchema,
			/**
			 * How many entries this directory holds — one `readdir` of it and no deeper. `null`
			 * when its own contents could not be read, which is the distinction `unreadable`
			 * draws one level up: a `0` here would say *empty* about a directory the host cannot
			 * see into.
			 */
			childCount: z.number().int().nonnegative().nullable(),
			/**
			 * The name of the one entry this directory holds, when it holds exactly one; `null`
			 * otherwise. Free — it comes out of the very `readdir` that produced `childCount`.
			 *
			 * It is here for the `<serial>` level: one lease is one device
			 * (`src/daemon/leases.ts` keeps `bySerial` one-to-one), so a run directory always
			 * holds exactly one child, and that is a fact about the run rather than a level worth
			 * a round trip. Nothing here knows it is a serial — a rule about shape, never about
			 * what a component says (D22).
			 */
			onlyChild: ArchivePathSegmentSchema.nullable(),
		})
		.strict(),
	z
		.object({
			kind: z.literal('file'),
			name: ArchivePathSegmentSchema,
			/** Its size in bytes, from one `stat`. `null` when the file could not be stat'd. */
			sizeBytes: z.number().int().nonnegative().nullable(),
		})
		.strict(),
	z
		.object({
			/**
			 * Neither a directory nor a regular file — a symlink, a socket, a device node. Named
			 * rather than dropped: silently omitting an entry would make a listing that is short
			 * look exactly like one that is complete.
			 */
			kind: z.literal('other'),
			name: ArchivePathSegmentSchema,
		})
		.strict(),
]);
export type ArchiveEntry = z.infer<typeof ArchiveEntrySchema>;

/**
 * Three answers, never two: the pair that must never render alike — *the archive is empty*
 * versus *the host cannot say what is in the archive* — is two arms of a discriminated union
 * rather than two readings of one array, which is the distinction `stale` already draws on the
 * device list (D6, `docs/DESIGN.md` §7).
 *
 * **No `message` field anywhere, and that absence is load-bearing.** `messageOf(error)` — the
 * helper every other daemon handler uses — would put `ENOENT: no such file or directory,
 * scandir '/Users/…/artifacts/…'` on the wire, which is exactly the host path D19 forbids and
 * which `src/ipc/server.ts` could not catch, because a `message: string` is a field a path fits
 * in. Diagnosis for the operator goes where the path already belongs: a warning on the host.
 */
export const ListArchiveResultSchema = z.discriminatedUnion('outcome', [
	/** The level was read. `entries: []` is **the archive is empty**, and is not a failure. */
	z.object({ outcome: z.literal('listed'), entries: z.array(ArchiveEntrySchema) }).strict(),
	/** Nothing is at that path. Never conflated with either of the other two. */
	z.object({ outcome: z.literal('missing') }).strict(),
	/** It is there and the host **cannot say what is in it** — no permission, or not a directory. */
	z.object({ outcome: z.literal('unreadable') }).strict(),
]);
export type ListArchiveResult = z.infer<typeof ListArchiveResultSchema>;

/**
 * The longest needle {@link SearchArchiveParamsSchema} accepts.
 *
 * Mirrors {@link MAX_ARCHIVE_PATH_SEGMENT_LENGTH} because a component is what is matched: a
 * needle longer than the longest component a filesystem can hold matches nothing, so this is
 * allocation hygiene of the kind {@link ATTRIBUTION_MAX_LENGTH} already applies, not validation.
 */
export const MAX_ARCHIVE_SEARCH_TEXT_LENGTH = 255;

/**
 * How many matches one answer may carry.
 *
 * A structural bound rather than a caller's: it is in the schema, so an answer over it is
 * `invalid_result` on the host (D19) rather than a large frame somebody has to notice. Two
 * hundred is more than an operator reads and small enough that the frame stays ordinary; going
 * over it is `truncated: true`, which is the whole reason that flag exists.
 */
export const MAX_ARCHIVE_SEARCH_MATCHES = 200;

/**
 * `.strict()` and one key, for {@link ListArchiveParamsSchema}'s reason — and here the closed
 * shape is the decision rather than a habit.
 *
 * **There is deliberately no second key.** No `path` to start from, no `limit`, no `depth`, no
 * `kind`, no `offset`, no `sortBy`. The bounds on this walk are the **host's** — depth, match
 * count and directories read (`src/daemon/search-archive.ts`) — because a caller-settable bound
 * is precisely the parameter D24 refused, and it is how an index gets built by accident. What the
 * caller gets instead is `truncated`, so a bounded answer says it is bounded.
 *
 * **The matching rule, written down here because this is where the schema is.** A component is
 * matched **whole and verbatim**: `text` is tested as a substring of an entire directory or file
 * name, and nothing decomposes that name — no split on a hyphen, no timestamp, owner or hash read
 * out of it, no inference about what a level *is* (D22). And matching is **case-insensitive**,
 * folded with `toLowerCase` rather than `toLocaleLowerCase`, for the reason `list_archive` refuses
 * `localeCompare`: a locale-dependent fold would make one host answer differently from another.
 *
 * **The answer is derived from the filesystem at request time.** There is no index, no database
 * and no catalogue kept in sync with the files — that half of D23/D24 is not reversed, and it is
 * what makes the bounds and `truncated` necessary rather than optional.
 */
export const SearchArchiveParamsSchema = z
	.object({
		/** The text to look for in a component. Never a path, never a pattern — see above. */
		text: z.string().min(1).max(MAX_ARCHIVE_SEARCH_TEXT_LENGTH),
	})
	.strict();
export type SearchArchiveParams = z.infer<typeof SearchArchiveParamsSchema>;

/**
 * One match — **where** in the archive the text appears, and nothing about what is in it.
 *
 * `path` is an array of {@link ArchivePathSegmentSchema}, so every match is by construction an
 * address `list_archive` and `GET /artifact/…` already accept: the archive has **one path
 * vocabulary** (R37's rule restated), and no host path is on any answer nor any field one would
 * fit in (D19). The depth bound is {@link MAX_ARCHIVE_PATH_DEPTH}, the same one
 * {@link ListArchiveParamsSchema} accepts, so a match is always addressable.
 *
 * `kind` is {@link ArchiveEntrySchema}'s own three words, and it is here because the alternative
 * is a reader guessing from a name whether an address is a directory — which is exactly the
 * parsing D22 forbids. It is free: the dirent that produced the match already says so. It is
 * **not** a filter and there is no parameter to select on it.
 *
 * **Nothing a listing measures joins a match** — no `childCount`, no `onlyChild`, no `sizeBytes`.
 * A search answers *where*; *what is in it* is `list_archive`'s question, and the address here is
 * what to ask it about.
 */
export const ArchiveSearchMatchSchema = z
	.object({
		path: z.array(ArchivePathSegmentSchema).min(1).max(MAX_ARCHIVE_PATH_DEPTH),
		kind: z.enum(['directory', 'file', 'other']),
	})
	.strict();
export type ArchiveSearchMatch = z.infer<typeof ArchiveSearchMatchSchema>;

/**
 * Three answers, `list_archive`'s own three so the archive keeps one vocabulary across all of its
 * reads, and **no `message` field anywhere** for {@link ListArchiveResultSchema}'s stated reason:
 * a `message: string` is a field a host path fits in, and `src/ipc/server.ts` could not catch one
 * put there.
 *
 * `matches: []` with `truncated: false` is **nothing matched**, and is not a failure.
 *
 * **`truncated` has exactly one meaning: at least one directory that exists was not fully
 * examined**, so matches may be missing. Any of the host's three bounds does it — depth, match
 * count, directories read — and so does a level the host could not read mid-walk. An unreadable level
 * does not fail the search; the reason and the path stay in the host's own log, exactly as
 * `list_archive` already warns, and this flag is what keeps a partial answer from rendering like
 * a complete one.
 */
export const SearchArchiveResultSchema = z.discriminatedUnion('outcome', [
	z
		.object({
			outcome: z.literal('searched'),
			matches: z.array(ArchiveSearchMatchSchema).max(MAX_ARCHIVE_SEARCH_MATCHES),
			truncated: z.boolean(),
		})
		.strict(),
	/** Nothing has ever been archived on this host. Never conflated with an empty result set. */
	z.object({ outcome: z.literal('missing') }).strict(),
	/** The root is there and the host **cannot read it** — no permission, or not a directory. */
	z.object({ outcome: z.literal('unreadable') }).strict(),
]);
export type SearchArchiveResult = z.infer<typeof SearchArchiveResultSchema>;

/** `.strict()` and no key at all, for {@link ListDevicesParamsSchema}'s reason. */
export const ListProjectsParamsSchema = z.object({}).strict();
export type ListProjectsParams = z.infer<typeof ListProjectsParamsSchema>;

/**
 * One registration under the projects root — **either what the host read, or the fact that it
 * could not**, as a discriminated union rather than one shape with empty fields.
 *
 * That is the load-bearing part. A project that declares nothing at all is the common, correct
 * case (`apps: []`, `services: []`, no `install`, no `teardown` — `src/daemon/project-hooks.ts`),
 * so a hook file that will not parse must not arrive as *a project declaring nothing*: the two
 * render differently, and D13's whole cost today is that a file which stopped tearing a project
 * down is invisible until somebody reads the daemon's stderr.
 *
 * **`env` is structurally absent, and so is every host path.** There is no field a `cwd`, a
 * program name, an `args` entry or an `env` value would fit in — this answer reaches a browser
 * and a hook file's `env` may hold anything an operator put there — which is the way
 * {@link ListArchiveResultSchema} has no `message` for a path to arrive in (D19). `install` and
 * `teardown` are therefore **booleans**: whether the host has one, never which program it is.
 */
export const ProjectRegistrationSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('registered'),
			/**
			 * The identifier, which is the file's own name (`src/daemon/project-hooks.ts` refuses a
			 * file whose `project` field disagrees with it, so for a registered entry the two are
			 * the same string). {@link AttributionStringSchema} because that is the wire's existing
			 * project vocabulary: what this answers is a string a lease may carry as its `project`
			 * (D22). The identifier *shape* stays a property of the host's lookup, where the path
			 * is built, and this method builds none from a caller's string — it takes none.
			 */
			project: AttributionStringSchema,
			/** The applications a lease on this project drives, as the hook file declares them. */
			apps: z.array(AppIdSchema),
			/** Whether an `install` is declared — never what it runs. */
			hasInstall: z.boolean(),
			/**
			 * Its helper services **by name**, in declaration order — the order the host starts
			 * them in and the reverse of the order it stops them in. Names only: a `start`/`stop`
			 * pair is a program, a `cwd` and an `env`, and none of the three is on this surface.
			 *
			 * Plain `z.string().min(1)` rather than the host's own service-name shape, for the
			 * reason {@link ATTRIBUTION_MAX_LENGTH} is stated with: a bound is what matters on the
			 * way *in*, and nothing comes in here — this method takes no parameter, so no answered
			 * value ever comes back.
			 */
			services: z.array(z.string().min(1)),
			/** Whether a `teardown` is declared — never what it runs. */
			hasTeardown: z.boolean(),
		})
		.strict(),
	z
		.object({
			/**
			 * The file is there and the host **cannot say what this project declares** — it is not
			 * JSON, it does not match the hook schema, its `project` field disagrees with its own
			 * name, or it could not be read at all. `list_archive`'s own word, for the same meaning
			 * one level down, so the host keeps one vocabulary across its reads.
			 *
			 * **Which of those it was is deliberately not here** (D19): the diagnosis names a path
			 * and belongs in a warning on the host, which is where `src/daemon/list-projects.ts`
			 * puts it. What a caller needs is that this registration will not parse — that is the
			 * fact that is invisible today.
			 */
			kind: z.literal('unreadable'),
			/** The file's own name, without `.json`. Never a field read out of a file that will not parse. */
			project: AttributionStringSchema,
		})
		.strict(),
]);
export type ProjectRegistration = z.infer<typeof ProjectRegistrationSchema>;

/**
 * Three answers, `list_archive`'s own three, and the distinction is a criterion rather than
 * tidiness: **a host where nobody has ever registered a project is the ordinary state**, and it
 * must not render like a root the host cannot read (D6, `docs/DESIGN.md` §7).
 *
 * `projects: []` is *this host has no registrations*. `missing` is *there is no projects root* —
 * also ordinary, and also not a failure. `unreadable` is *the root is there and the host cannot
 * say what is in it*.
 *
 * **No `message` field anywhere**, for {@link ListArchiveResultSchema}'s stated reason: a
 * `message: string` is a field a host path fits in, and `src/ipc/server.ts` could not catch one
 * put there.
 */
export const ListProjectsResultSchema = z.discriminatedUnion('outcome', [
	/** The root was read. `projects: []` is **nobody has registered one here**, and is not a failure. */
	z.object({ outcome: z.literal('listed'), projects: z.array(ProjectRegistrationSchema) }).strict(),
	/** There is no projects root. Ordinary on a host whose operator never made one. */
	z.object({ outcome: z.literal('missing') }).strict(),
	/** It is there and the host **cannot say what is in it** — no permission, or not a directory. */
	z.object({ outcome: z.literal('unreadable') }).strict(),
]);
export type ListProjectsResult = z.infer<typeof ListProjectsResultSchema>;

/**
 * `status` and `list_devices` exist in the *protocol* rather than in the MCP layer because
 * D16 requires daemon state to be answerable to something that is not an agent: whatever
 * Swarm asks, it asks here, the same way a local caller does. Nothing device-shaped may
 * exist only in a local path.
 *
 * The names follow the verb table in PROJECT.md §4 (`list_devices`), not a camelCase
 * variant of it.
 *
 * **`force_release_device` is the one row keyed on a serial rather than on a lease id**, and it
 * is the exception that says why every other one is not. A verb call names the lease id because
 * that id is the credential the caller was handed (D20); force-release ends a lease the caller
 * never held, so there is no credential for it to present and the id must not be handed out to
 * make one — that is the disclosure {@link ListedDeviceSchema} exists to refuse. It is a third
 * trigger on the release path rather than a second release path: see `src/daemon/lease-handlers.ts`.
 *
 * **`list_archive` is the read side of the artifact archive** (`PROJECT.md` §10, D24), and the
 * one row that is about the host's own disk rather than about a device. It answers **one
 * directory level** at a time; its path is the components a previous answer returned and never
 * a host path, and it is a **listing rather than a query** — there is no index to consult
 * because listing the directory *is* the query, and a parameter that made it one is how an
 * index gets built by accident. No result of it carries a path, and there is no field one
 * would fit in (D19).
 *
 * **`search_archive` is the archive's second read, and it reverses half of D24 at the operator's
 * instruction** (R38). D24 said listing a directory *is* the whole query; that half is overruled,
 * and this row answers *where in the whole archive does this text appear* — matching entries as
 * component arrays, the same path vocabulary `list_archive` answers with, with no host path on any
 * result and no field one would fit in. **The half that stands is the one that matters most**:
 * there is still no index, no database and no catalogue kept in sync with the files, because the
 * answer is derived from the filesystem at request time. That is what makes the walk bounded — by
 * depth, by match count and by directories read — and what makes a truncated answer say so.
 * `list_archive` keeps its shape exactly: a new capability is a new method, never a parameter
 * bolted onto the one that exists, which is the form D24's warning about a parameter always
 * pointed to. It is on `PANEL_METHODS` (D29) and is deliberately **not** an MCP tool, for
 * `list_archive`'s reason with more force — a search would hand every agent the run names of every
 * other agent on the host in one call.
 *
 * **`list_projects` is the read side of D31**, and the one row that answers what the *host
 * operator* configured rather than what is attached to the host or what a run left behind. It
 * takes nothing and answers every registration under the projects root — the identifier, the
 * `apps`, whether there is an `install`, the helper services by name, whether there is a
 * `teardown` — and, for a file that will not parse, **that it will not parse** rather than
 * nothing at all, because a hook file that stopped tearing a project down is invisible today
 * until somebody reads the daemon's stderr. **Nothing about it writes**: no method creates,
 * edits, renames or deletes a hook file, and none takes a path into that directory — D31 narrows
 * D13's never-over-the-wire clause to the *write* and does not repeal it, because every command
 * in such a file is a program the host spawns as the daemon's user. No `env` value and no host
 * path is on any answer, and there is no field either would fit in (D19). It is on
 * `PANEL_METHODS` (D29) and deliberately **not** an MCP tool, the asymmetry `list_archive`,
 * `search_archive` and `force_release_device` already have: this surface serves the operator's
 * own browser, and what the host is configured to run is not something every agent on it needs
 * to enumerate.
 *
 * The verb rows are the two waits, the six input verbs, the three read verbs, the three
 * app-lifecycle verbs, the log read, the screen recording, the two environment verbs and the
 * three file transfers; each further verb family is one more row beside them and one more
 * entry in `src/daemon/verb-handlers.ts`. All but two answer with `VerbCallResultSchema`,
 * because "what happened on the device" is one shape whatever was asked of it. `read_screen`
 * and `device_info` answer with the state every other verb already reports, while
 * `screenshot`, `record_video` and `pull_file` carry their bytes on `ActionResult.artifact` —
 * which is why no path of any kind is in a transfer's result. The verbs that address no
 * element — those two reads, `type_text`, `press_key`, and both environment rows because a
 * radio is not something on the screen — answer with a null `target`. The three app rows
 * share one params schema, and the two environment rows share a lease id and boolean schema.
 *
 * `read_logs` and `record_video` are the exceptions that prove the rule: their answers are
 * that same shape with one field added — the log entries on one, the frames sliced out of the
 * recording on the other — built by the same factory in `./verb-methods.ts`, so their refusals
 * are word for word every other verb's.
 *
 * The two rows that carry bytes **into** the host — `install_app` and `push_file` — are the
 * only ones whose params are bounded in bytes (`MAX_TRANSFER_BYTES`), and going over that is
 * `invalid_params` naming the limit rather than a frame the host allocates.
 */
export const IPC_METHODS = {
	status: { params: StatusParamsSchema, result: StatusResultSchema },
	list_devices: { params: ListDevicesParamsSchema, result: ListDevicesResultSchema },
	acquire_device: { params: AcquireDeviceParamsSchema, result: AcquireDeviceResultSchema },
	release_device: { params: ReleaseDeviceParamsSchema, result: ReleaseDeviceResultSchema },
	force_release_device: {
		params: ForceReleaseDeviceParamsSchema,
		result: ForceReleaseDeviceResultSchema,
	},
	list_archive: { params: ListArchiveParamsSchema, result: ListArchiveResultSchema },
	search_archive: { params: SearchArchiveParamsSchema, result: SearchArchiveResultSchema },
	list_projects: { params: ListProjectsParamsSchema, result: ListProjectsResultSchema },
	wait_for: { params: WaitForParamsSchema, result: VerbCallResultSchema },
	wait_until_gone: { params: WaitUntilGoneParamsSchema, result: VerbCallResultSchema },
	tap: { params: TapParamsSchema, result: VerbCallResultSchema },
	long_press: { params: LongPressParamsSchema, result: VerbCallResultSchema },
	swipe: { params: SwipeParamsSchema, result: VerbCallResultSchema },
	scroll: { params: ScrollParamsSchema, result: VerbCallResultSchema },
	type_text: { params: TypeTextParamsSchema, result: VerbCallResultSchema },
	press_key: { params: PressKeyParamsSchema, result: VerbCallResultSchema },
	read_screen: { params: ReadScreenParamsSchema, result: VerbCallResultSchema },
	device_info: { params: DeviceInfoParamsSchema, result: VerbCallResultSchema },
	screenshot: { params: ScreenshotParamsSchema, result: VerbCallResultSchema },
	launch_app: { params: AppVerbParamsSchema, result: VerbCallResultSchema },
	stop_app: { params: AppVerbParamsSchema, result: VerbCallResultSchema },
	clear_app_data: { params: AppVerbParamsSchema, result: VerbCallResultSchema },
	read_logs: { params: ReadLogsParamsSchema, result: ReadLogsCallResultSchema },
	install_app: { params: InstallAppParamsSchema, result: VerbCallResultSchema },
	push_file: { params: PushFileParamsSchema, result: VerbCallResultSchema },
	pull_file: { params: PullFileParamsSchema, result: VerbCallResultSchema },
	record_video: { params: RecordVideoParamsSchema, result: RecordVideoCallResultSchema },
	set_airplane_mode: { params: EnvironmentVerbParamsSchema, result: VerbCallResultSchema },
	set_wifi: { params: EnvironmentVerbParamsSchema, result: VerbCallResultSchema },
} as const satisfies Record<string, IpcMethodDefinition>;

export type IpcMethodName = keyof typeof IPC_METHODS;

export type IpcParams<Method extends IpcMethodName> = z.infer<
	(typeof IPC_METHODS)[Method]['params']
>;

export type IpcResult<Method extends IpcMethodName> = z.infer<
	(typeof IPC_METHODS)[Method]['result']
>;

/**
 * Complete over {@link IPC_METHODS} on purpose — see this module's header.
 */
export type IpcHandlers = {
	[Method in IpcMethodName]: (
		params: IpcParams<Method>,
	) => IpcResult<Method> | Promise<IpcResult<Method>>;
};

/** Narrows an arbitrary wire string to a known method before it indexes the table. */
export function isIpcMethodName(name: string): name is IpcMethodName {
	return Object.hasOwn(IPC_METHODS, name);
}
