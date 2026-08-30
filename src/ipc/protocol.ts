/**
 * The daemon's wire protocol — the Zod schemas every IPC message is parsed with, in both
 * directions.
 *
 * Two processes, so every message is parsed and nothing is cast
 * (ai/CODING_STANDARDS.md "Zod is the source of truth", boundary #2).
 *
 * **The envelope is transport-agnostic on purpose** (D17). A client may be on another
 * machine, so no field here may be a filesystem path, a peer uid, a hostname or an
 * instant: the client shares no clock, no user and no filesystem with the host. The
 * envelope is `{ protocolVersion, id, method, params }` and nothing else, and
 * `tests/unit/ipc/protocol.test.ts` fails if that key set ever grows. Where a duration
 * is needed, send the duration (`uptimeMs`), never a timestamp the peer would have to
 * subtract from its own clock.
 */

import { z } from 'zod';

/**
 * Bumped only for an **incompatible** frame-shape change — an added optional field is
 * not one (Swarm's `TRANSPORT_PROTOCOL_VERSION` follows the same rule). A mismatch is
 * reported as its own error code rather than surfacing as a generic parse failure.
 */
export const PROTOCOL_VERSION = 1;

/** Exact-version check. Distinct from the envelope's loose `protocolVersion` — see below. */
export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);

/**
 * Correlates a response with its request. Opaque to the host: the client picks it and
 * the daemon only ever echoes it back, so it carries no meaning and must not be parsed.
 */
export const RequestIdSchema = z.string().min(1).max(128);
export type RequestId = z.infer<typeof RequestIdSchema>;

/**
 * Bounded for the same reason as {@link RequestIdSchema}: it is an opaque string a peer
 * chooses, and the server echoes it back in `No such method: '…'`. Unbounded, a method
 * name just under the frame cap would have the host allocate and encode a response of
 * roughly the same size — and JSON escaping can push that response past the cap, so one
 * request costs an outsized allocation on both ends. 128 characters is far above any
 * method this table will ever carry, and an over-long one is `malformed_frame` at the
 * envelope rather than something the host formats and writes back.
 */
export const MethodNameSchema = z.string().min(1).max(128);

/**
 * The error vocabulary. An agent has to be able to tell "you asked wrong" from "the host
 * broke" — those call for opposite responses — so the code is part of the contract
 * rather than something to recover from a message string.
 *
 * The first seven travel on the wire. `timeout` and `connection_closed` are raised by the
 * client against itself and are never sent by a server; they share the vocabulary so a
 * caller has one `code` to switch on however the request failed.
 */
export const IpcErrorCodeSchema = z.enum([
	/** A frame was not valid JSON, not a valid envelope, or exceeded the frame cap. */
	'malformed_frame',
	/** The peer speaks a protocol version this build cannot parse. */
	'unsupported_protocol_version',
	/** No such method in the method table. */
	'unknown_method',
	/** `params` did not parse against the method's params schema. */
	'invalid_params',
	/** A handler returned a value that did not parse against the method's result schema. */
	'invalid_result',
	/** A handler threw. The host broke; the request was not malformed. */
	'internal_error',
	/**
	 * The peer did not present a token this host accepts. Only the network transport ever
	 * sends it — the local socket is ungated — and it arrives before any request, as an
	 * `id: null` error that ends the connection. The message is fixed and identical for
	 * every pre-auth failure: it says nothing about why, and nothing about the host's
	 * inventory, because a refusal must not be an oracle (D20).
	 */
	'unauthenticated',
	/** Client-side: no response arrived within the request's timeout. */
	'timeout',
	/** Client-side: the connection ended with the request still in flight. */
	'connection_closed',
]);
export type IpcErrorCode = z.infer<typeof IpcErrorCodeSchema>;

export const IpcErrorSchema = z
	.object({
		code: IpcErrorCodeSchema,
		message: z.string().min(1),
	})
	.strict();
export type IpcError = z.infer<typeof IpcErrorSchema>;

/**
 * A request frame. Four fields, forever — see this module's header.
 *
 * `protocolVersion` is deliberately loose (any integer) so a version mismatch parses far
 * enough to be reported as `unsupported_protocol_version`; `ProtocolVersionSchema` above
 * does the exact check as a separate step. `params` is `unknown` here and parsed against
 * the method's own schema once the method is known.
 *
 * Unknown keys are **stripped** rather than rejected: a peer on a newer protocol should
 * be told its version is unsupported, not that its frame was malformed, and stripping
 * guarantees a smuggled `socketPath` or `uid` can never reach a handler regardless.
 */
export const RequestEnvelopeSchema = z.object({
	protocolVersion: z.number().int(),
	id: RequestIdSchema,
	method: MethodNameSchema,
	params: z.unknown(),
});
export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>;

export const ResultResponseSchema = z.object({
	type: z.literal('result'),
	protocolVersion: z.number().int(),
	id: RequestIdSchema,
	result: z.unknown(),
});
export type ResultResponse = z.infer<typeof ResultResponseSchema>;

/**
 * An error response. `id` is nullable **only here**: a frame too malformed to yield an id
 * still has to be answered, and the client treats an `id: null` error as "this connection
 * is no longer trustworthy" and fails everything in flight rather than hanging.
 */
export const ErrorResponseSchema = z.object({
	type: z.literal('error'),
	protocolVersion: z.number().int(),
	id: RequestIdSchema.nullable(),
	error: IpcErrorSchema,
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const ResponseSchema = z.discriminatedUnion('type', [
	ResultResponseSchema,
	ErrorResponseSchema,
]);
export type Response = z.infer<typeof ResponseSchema>;

/**
 * What a failed `request()` rejects with. Carries the {@link IpcErrorCode} so a caller can
 * branch on the kind of failure without matching on a message
 * (ai/CODING_STANDARDS.md "Error handling": throw, don't wrap in a `Result`).
 */
export class IpcRequestError extends Error {
	readonly code: IpcErrorCode;

	constructor(code: IpcErrorCode, message: string) {
		super(message);
		this.name = 'IpcRequestError';
		this.code = code;
	}
}

/**
 * Renders a Zod failure as one line for an error response. A caller on another machine
 * has no stack and no schema, so the *path* is the whole diagnosis: `serial: Required`
 * tells it what to fix, where a bare "invalid input" starts a support thread. The path is
 * rooted at the value being parsed — the server parses `params` against the method's own
 * schema — so it names the field, with no `params.` prefix in front of it.
 */
export function describeIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
		.join('; ');
}
