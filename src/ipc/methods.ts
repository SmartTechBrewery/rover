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
	LongPressParamsSchema,
	PressKeyParamsSchema,
	ReadLogsCallResultSchema,
	ReadLogsParamsSchema,
	ReadScreenParamsSchema,
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
	type DeviceInfoParams,
	DeviceInfoParamsSchema,
	type EnvironmentVerbParams,
	EnvironmentVerbParamsSchema,
	type LongPressParams,
	LongPressParamsSchema,
	MAX_LOG_ENTRIES,
	MAX_VERB_TIMEOUT_MS,
	type PressKeyParams,
	PressKeyParamsSchema,
	type ReadLogsCallResult,
	ReadLogsCallResultSchema,
	type ReadLogsParams,
	ReadLogsParamsSchema,
	type ReadScreenParams,
	ReadScreenParamsSchema,
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
 * What a caller who is *not* the holder is told about a lease — deliberately
 * {@link GrantedLeaseSchema} minus `leaseId`. It is what a refusal names and what a listed
 * device names, because both are readable by anyone who can reach the host.
 *
 * Anyone may ask for a busy device, so anything in this shape is public to strangers. The
 * lease id ends the lease, so including it would let whoever was refused release the holder
 * and take the device. The owner, project and test name are here because "held by
 * `pr-127-review` for another eleven minutes" is what makes a refusal actionable.
 */
export const LeaseHolderSchema = z
	.object({
		serial: DeviceSerialSchema,
		owner: z.string(),
		project: z.string(),
		testName: z.string().nullable(),
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
 * (D22) — share one schema because the host treats them identically: it stores them, echoes
 * them back, and never reads their content. No `.trim()` (that would modify a caller's
 * string), no default synthesized from a branch, a pull request or a process, and nothing
 * anywhere branches on what they say.
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
 * `status` and `list_devices` exist in the *protocol* rather than in the MCP layer because
 * D16 requires daemon state to be answerable to something that is not an agent: whatever
 * Swarm asks, it asks here, the same way a local caller does. Nothing device-shaped may
 * exist only in a local path.
 *
 * The names follow the verb table in PROJECT.md §4 (`list_devices`), not a camelCase
 * variant of it.
 *
 * The verb rows are the two waits, the six input verbs, the three read verbs, the three
 * app-lifecycle verbs, the log read, the screen recording, and the two environment verbs;
 * each further verb family is one more row beside them and one more entry in
 * `src/daemon/verb-handlers.ts`. All but one answer with `VerbCallResultSchema`, because
 * "what happened on the device" is one shape whatever was asked of it. `read_screen` and
 * `device_info` answer with the state every other verb already reports, while `screenshot`
 * and `record_video` carry their bytes on `ActionResult.artifact`. The verbs that address no
 * element — those two reads, `type_text`, `press_key`, and both environment rows because a
 * radio is not something on the screen — answer with a null `target`. The three app rows
 * share one params schema, and the two environment rows share a lease id and boolean schema.
 *
 * `read_logs` is the exception that proves the rule: its answer is that same shape with the
 * log entries added, built by the same factory in `./verb-methods.ts`, so its refusals are
 * word for word every other verb's.
 */
export const IPC_METHODS = {
	status: { params: StatusParamsSchema, result: StatusResultSchema },
	list_devices: { params: ListDevicesParamsSchema, result: ListDevicesResultSchema },
	acquire_device: { params: AcquireDeviceParamsSchema, result: AcquireDeviceResultSchema },
	release_device: { params: ReleaseDeviceParamsSchema, result: ReleaseDeviceResultSchema },
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
	record_video: { params: RecordVideoParamsSchema, result: VerbCallResultSchema },
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
