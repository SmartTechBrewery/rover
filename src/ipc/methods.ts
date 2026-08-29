/**
 * The method table — one place mapping a method name to the schema its params are parsed
 * with and the schema its result is parsed with.
 *
 * Both directions go through this table, which is what makes "every message is parsed,
 * never cast" true on the response path too: the server parses `params` before calling a
 * handler and parses the handler's return value before writing it.
 *
 * The surface carries **verb calls**, not just lease operations (PROJECT.md R6). Adding
 * `acquire_device`, `tap` or `read_screen` later is a row here plus its handler — the
 * envelope, the framing, the server and the client do not change. {@link IpcHandlers} is a
 * complete mapped type over this table's keys, so adding a row without a handler is a
 * compile error rather than an `unknown_method` an agent discovers at runtime.
 */

import { z } from 'zod';
import { DeviceSchema } from '../core/device.js';
import { ProtocolVersionSchema } from './protocol.js';

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
 * `DeviceSchema` is imported rather than restated, so the shape a backend produces and the
 * shape a client reads are one schema parsed twice — once on the way out of the handler,
 * once on the way into the client — instead of two that drift.
 *
 * `stale` earns its place next to the list: a view of the devices presented as current
 * when the source of it went away is exactly the stale-state failure D6 is about, and no
 * client can infer it from the list itself — a host that has gone blind and a host with
 * nothing attached both answer with an empty array.
 */
export const ListDevicesResultSchema = z
	.object({
		devices: z.array(DeviceSchema),
		/** The host's view of its devices was interrupted and has not been re-established. */
		stale: z.boolean(),
	})
	.strict();
export type ListDevicesResult = z.infer<typeof ListDevicesResultSchema>;

/**
 * `status` and `list_devices` exist in the *protocol* rather than in the MCP layer because
 * D16 requires daemon state to be answerable to something that is not an agent: whatever
 * Swarm asks, it asks here, the same way a local caller does. Nothing device-shaped may
 * exist only in a local path.
 *
 * The names follow the verb table in PROJECT.md §4 (`list_devices`), not a camelCase
 * variant of it.
 */
export const IPC_METHODS = {
	status: { params: StatusParamsSchema, result: StatusResultSchema },
	list_devices: { params: ListDevicesParamsSchema, result: ListDevicesResultSchema },
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
