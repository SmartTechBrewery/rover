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
import { DeviceSerialSchema, LeaseIdSchema } from '../core/ids.js';
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
 * The grant instant is here and *not* on `GrantedLeaseSchema` for the opposite reason: the
 * winner of an acquire already knows when it was granted, because it asked. A stranger
 * reading a list has no other way to find out.
 */
export const LeaseHolderSchema = z
	.object({
		serial: DeviceSerialSchema,
		owner: z.string(),
		project: z.string(),
		testName: z.string().nullable(),
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
 * `.strict()` so a typo'd key is `invalid_params` rather than a lease granted with an
 * attribution string silently missing — which the archive would only discover later, with
 * the device already handed out.
 *
 * `testName` is optional and deliberately **not unique** (D22): the same named check run
 * before and after a change is two leases carrying one name, which is the expected shape.
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
		testName: AttributionStringSchema.optional(),
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
 */
export const GrantedLeaseSchema = z
	.object({
		leaseId: LeaseIdSchema,
		serial: DeviceSerialSchema,
		owner: z.string(),
		project: z.string(),
		testName: z.string().nullable(),
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
