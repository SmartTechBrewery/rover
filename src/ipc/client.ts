/**
 * The client half of the IPC surface — id correlation and per-request timeouts, with no
 * transport in it.
 *
 * Like the server, it binds to a `Duplex` and nothing else (D17), so the same client
 * speaks to a local socket, a TLS socket or an in-memory pair without knowing which.
 *
 * A result is parsed against the method's own result schema **before** it is handed back,
 * so a caller never holds a value that was merely asserted to have the right shape: a
 * daemon on a different build answering a shape this one does not understand fails as
 * `invalid_result` here rather than as a confusing error deep in a caller.
 */

import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { encodeFrame, FrameDecoder } from './framing.js';
import {
	IPC_METHODS,
	type IpcMethodDefinition,
	type IpcMethodName,
	type IpcParams,
	type IpcResult,
} from './methods.js';
import {
	describeIssues,
	type IpcErrorCode,
	IpcRequestError,
	PROTOCOL_VERSION,
	type RequestId,
	ResponseSchema,
} from './protocol.js';

/**
 * A ceiling, not a policy: every request gets one so a client can never wait forever on a
 * host that stopped answering. Callers with a genuinely slow verb pass their own
 * (ai/RULES.md §2 — waiting is on a condition, with a timeout; this is not a sleep).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface IpcRequestOptions {
	timeoutMs?: number;
}

export interface IpcClient {
	request<Method extends IpcMethodName>(
		method: Method,
		params: IpcParams<Method>,
		options?: IpcRequestOptions,
	): Promise<IpcResult<Method>>;
	/** Ends the stream and fails everything still in flight. Safe to call twice. */
	close(): Promise<void>;
}

/**
 * One in-flight request. `deliver` is a closure over the *typed* resolver and over the
 * method's result schema — the map is heterogeneous, and closing over both is what lets a
 * result be parsed and handed back without a cast anywhere in this file.
 */
interface Pending {
	readonly deliver: (raw: unknown) => void;
	readonly fail: (error: IpcRequestError) => void;
	readonly timer: NodeJS.Timeout;
}

export function createIpcClient(stream: Duplex): IpcClient {
	const pending = new Map<RequestId, Pending>();
	const decoder = new FrameDecoder();

	const settle = (id: RequestId): Pending | undefined => {
		const entry = pending.get(id);
		if (entry) {
			clearTimeout(entry.timer);
			pending.delete(id);
		}
		return entry;
	};

	const failAll = (code: IpcErrorCode, message: string): void => {
		for (const id of [...pending.keys()]) {
			settle(id)?.fail(new IpcRequestError(code, message));
		}
	};

	const handleFrame = (frame: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(frame);
		} catch {
			// The host is emitting frames this client cannot read, so no reply that may still
			// arrive can be trusted to be correlated — fail everything rather than hang.
			failAll('malformed_frame', 'Host sent a frame that is not valid JSON');
			return;
		}

		const response = ResponseSchema.safeParse(parsed);
		if (!response.success) {
			failAll('malformed_frame', 'Host sent a frame that is not a valid IPC response');
			return;
		}

		if (response.data.type === 'error') {
			const { id, error } = response.data;
			if (id === null) {
				failAll(error.code, error.message);
				return;
			}
			settle(id)?.fail(new IpcRequestError(error.code, error.message));
			return;
		}

		const entry = settle(response.data.id);
		if (!entry) {
			// A reply to a request that already timed out or was failed by a close. Dropping it
			// is correct: the caller has been told, and there is nobody left to resolve.
			return;
		}
		entry.deliver(response.data.result);
	};

	stream.on('data', (chunk: Buffer | string) => {
		let frames: string[];
		try {
			frames = decoder.push(chunk);
		} catch (error) {
			failAll('malformed_frame', error instanceof Error ? error.message : String(error));
			// A decoder that has failed cannot resynchronise, so continuing to read would only
			// let the host keep feeding bytes nothing will ever decode. Destroying stops the
			// flow at the transport, not just the decode attempt.
			stream.destroy();
			return;
		}
		for (const frame of frames) {
			handleFrame(frame);
		}
	});

	// 'end' as well as 'close': a peer that stops sending has already made every in-flight
	// request unanswerable, and some duplex transports never emit 'close' for a half-open
	// stream. Either way nothing is left waiting on a reply that cannot come.
	stream.on('end', () => failAll('connection_closed', 'IPC connection ended'));
	stream.on('close', () => failAll('connection_closed', 'IPC connection closed'));
	stream.on('error', (error: Error) => failAll('connection_closed', error.message));

	return {
		request<Method extends IpcMethodName>(
			method: Method,
			params: IpcParams<Method>,
			options: IpcRequestOptions = {},
		): Promise<IpcResult<Method>> {
			const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
			const id = randomUUID();

			return new Promise<IpcResult<Method>>((resolve, reject) => {
				if (!stream.writable) {
					reject(new IpcRequestError('connection_closed', 'IPC connection is not writable'));
					return;
				}

				const timer = setTimeout(() => {
					pending.delete(id);
					reject(
						new IpcRequestError('timeout', `'${method}' did not answer within ${timeoutMs}ms`),
					);
				}, timeoutMs);
				// A pending request must not be what keeps a short-lived client process alive.
				timer.unref?.();

				const definition: IpcMethodDefinition = IPC_METHODS[method];
				pending.set(id, {
					deliver: (raw) => {
						// `deliver` runs inside the stream's `data` listener, where a throw is an
						// uncaught exception in the client process rather than a failed request. Zod
						// lets an exception raised inside a `.transform()` escape `safeParse`, so this
						// try is what keeps a host answering with a bad id from killing the CLI or the
						// MCP server instead of failing the one call.
						let result: ReturnType<typeof definition.result.safeParse>;
						try {
							result = definition.result.safeParse(raw);
						} catch (error) {
							reject(
								new IpcRequestError(
									'invalid_result',
									`Host returned an invalid result for '${method}': ${
										error instanceof Error ? error.message : String(error)
									}`,
								),
							);
							return;
						}
						if (result.success) {
							resolve(result.data);
							return;
						}
						reject(
							new IpcRequestError(
								'invalid_result',
								`Host returned an invalid result for '${method}': ${describeIssues(result.error)}`,
							),
						);
					},
					fail: reject,
					timer,
				});

				stream.write(encodeFrame({ protocolVersion: PROTOCOL_VERSION, id, method, params }));
			});
		},

		async close(): Promise<void> {
			failAll('connection_closed', 'IPC client closed');
			if (!stream.writable) {
				return;
			}
			await new Promise<void>((resolve) => stream.end(resolve));
		},
	};
}
