/**
 * The server half of the IPC surface — dispatch, with no transport in it.
 *
 * `handleConnection(stream: Duplex)` is the **whole** binding surface (D17). Node's own
 * duplex stream is the contract rather than a bespoke `Transport` interface, because the
 * transports that matter are already duplex streams: the local socket phase 2 adds and the
 * TLS socket R22 adds are both `Duplex` subclasses, and this module cannot tell them
 * apart. That is what makes the network listener an added transport rather than a rewrite,
 * and the unit tests prove it by driving this over an in-memory stream pair — a transport
 * that is not a socket at all.
 *
 * **The server never throws out of a connection.** A daemon that dies on one malformed
 * byte from one client is a worse failure than one that answers "no": everything below
 * becomes an error *response*, and only a frame whose id could not be recovered closes
 * the connection.
 *
 * **No frame is dispatched after a refusal**, however the peer chunked its writes. `end()`
 * alone would close only the writable half, leaving the server reading — and dispatching —
 * frames from a peer it has already declared untrustworthy, with every reply dropped into a
 * stream that no longer accepts writes. Verbs with side effects (a lease granted, a device
 * tapped) would run for nobody. So a refusal writes its `id: null` error as the final frame,
 * abandons the frames already decoded from the chunk it landed in, ignores every later
 * chunk, and destroys the stream once that frame has flushed.
 */

import type { Duplex } from 'node:stream';
import { encodeFrame, FrameDecoder } from './framing.js';
import {
	IPC_METHODS,
	type IpcHandlers,
	type IpcMethodDefinition,
	type IpcMethodName,
	isIpcMethodName,
} from './methods.js';
import {
	describeIssues,
	type ErrorResponse,
	type IpcErrorCode,
	PROTOCOL_VERSION,
	RequestEnvelopeSchema,
	type RequestId,
	type Response,
	type ResultResponse,
} from './protocol.js';

export interface IpcServer {
	/**
	 * Serve one connection. Returns immediately; the connection is driven by the stream's
	 * own events and needs no polling.
	 */
	handleConnection(stream: Duplex): void;
}

export function createIpcServer(handlers: IpcHandlers): IpcServer {
	return {
		handleConnection(stream: Duplex): void {
			serveConnection(handlers, stream);
		},
	};
}

function serveConnection(handlers: IpcHandlers, stream: Duplex): void {
	const decoder = new FrameDecoder();
	let refused = false;

	const write = (response: Response): void => {
		// A dispatch already in flight when the refusal landed finds the stream gone. Its
		// reply is dropped on purpose: the connection is over, and there is nobody to tell.
		if (stream.writable) {
			stream.write(encodeFrame(response));
		}
	};

	const refuseConnection = (code: IpcErrorCode, message: string): void => {
		if (refused) {
			return;
		}
		refused = true;

		const frame = encodeFrame(errorResponse(null, code, message));
		if (stream.writable) {
			stream.end(frame, () => stream.destroy());
			return;
		}
		stream.destroy();
	};

	stream.on('data', (chunk: Buffer | string) => {
		if (refused) {
			return;
		}

		let frames: string[];
		try {
			frames = decoder.push(chunk);
		} catch (error) {
			refuseConnection('malformed_frame', messageOf(error));
			return;
		}

		for (const frame of frames) {
			// A refusal raised by an earlier frame has to stop this chunk too, not just the
			// next one: the peer picks the chunking, so it can always put the garbage and the
			// verb it wants executed in one write. `dispatchFrame` reaches `refuseConnection`
			// before its first await, so the flag is already set when the loop comes back here.
			if (refused) {
				break;
			}

			// Deliberately not awaited: a verb can take seconds (R21), and holding the next
			// frame behind it would make one slow call block every other request on the
			// connection. Ids correlate the replies, so out-of-order completion is expected.
			void dispatchFrame(handlers, frame, write, refuseConnection);
		}
	});

	// A stream error is the transport failing, not a protocol violation. There is nothing
	// to answer on a broken stream; swallowing it is what keeps it from reaching an
	// unhandled-error crash of the whole daemon.
	stream.on('error', () => {});
}

async function dispatchFrame(
	handlers: IpcHandlers,
	frame: string,
	write: (response: Response) => void,
	refuseConnection: (code: IpcErrorCode, message: string) => void,
): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(frame);
	} catch (error) {
		refuseConnection('malformed_frame', messageOf(error));
		return;
	}

	const envelope = RequestEnvelopeSchema.safeParse(parsed);
	if (!envelope.success) {
		// The id cannot be trusted from a frame that did not parse as an envelope, so this
		// is answered with `id: null` and the connection ends: the client fails everything
		// in flight rather than waiting on replies that will never be correlated.
		refuseConnection('malformed_frame', describeIssues(envelope.error));
		return;
	}

	const { id, method, params, protocolVersion } = envelope.data;
	if (protocolVersion !== PROTOCOL_VERSION) {
		write(
			errorResponse(
				id,
				'unsupported_protocol_version',
				`Host speaks protocol version ${PROTOCOL_VERSION}, client sent ${protocolVersion}`,
			),
		);
		return;
	}

	if (!isIpcMethodName(method)) {
		write(errorResponse(id, 'unknown_method', `No such method: '${method}'`));
		return;
	}

	write(await invokeMethod(handlers, id, method, params));
}

async function invokeMethod<Method extends IpcMethodName>(
	handlers: IpcHandlers,
	id: RequestId,
	method: Method,
	rawParams: unknown,
): Promise<Response> {
	const definition: IpcMethodDefinition = IPC_METHODS[method];

	const params = definition.params.safeParse(rawParams);
	if (!params.success) {
		return errorResponse(id, 'invalid_params', describeIssues(params.error));
	}

	let returned: unknown;
	try {
		returned = await handlers[method](params.data);
	} catch (error) {
		return errorResponse(id, 'internal_error', messageOf(error));
	}

	// The response path is parsed too, so "never cast" holds in both directions. A handler
	// returning the wrong shape is a daemon bug, and it is caught here — at the boundary —
	// instead of at the agent, which cannot tell a bad result from a bad device.
	const result = definition.result.safeParse(returned);
	if (!result.success) {
		return errorResponse(
			id,
			'invalid_result',
			`Handler for '${method}' returned an invalid result: ${describeIssues(result.error)}`,
		);
	}

	return resultResponse(id, result.data);
}

function resultResponse(id: RequestId, result: unknown): ResultResponse {
	return { type: 'result', protocolVersion: PROTOCOL_VERSION, id, result };
}

function errorResponse(id: RequestId | null, code: IpcErrorCode, message: string): ErrorResponse {
	return { type: 'error', protocolVersion: PROTOCOL_VERSION, id, error: { code, message } };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
