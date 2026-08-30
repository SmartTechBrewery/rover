import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { parseDeviceSerial, parseLeaseId } from '@/core/ids.js';
import { createIpcClient } from '@/ipc/client.js';
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from '@/ipc/framing.js';
import { IPC_METHODS, type IpcHandlers, type StatusResult } from '@/ipc/methods.js';
import { IpcRequestError, PROTOCOL_VERSION, ResponseSchema } from '@/ipc/protocol.js';
import { createIpcServer } from '@/ipc/server.js';
import { createDuplexPair } from '../../helpers/duplex-pair.js';
import { createMockDeviceInfo, createMockScreenElement } from '../../helpers/factories.js';

/** One element, so a verb result carried over the wire has something real in it. */
const save = createMockScreenElement({ id: 'save', text: 'Save' });

/**
 * A complete handler table — complete because {@link IpcHandlers} is a complete mapped
 * type over `IPC_METHODS`, so a row added without a handler is a compile error here too.
 * These suites drive the message surface rather than any one method; the bodies are the
 * least interesting thing in the file.
 */
function statusHandlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
	return {
		status: () => ({ protocolVersion: PROTOCOL_VERSION, pid: 4242, uptimeMs: 7 }),
		list_devices: () => ({ devices: [], stale: false }),
		// The lease rows exist so this table stays complete; the refusal is the cheapest
		// answer that is still a real one, and one suite below sends it over the wire.
		acquire_device: () => ({
			outcome: 'refused',
			reason: 'gone',
			message: 'no device host in these tests',
			heldBy: null,
		}),
		release_device: () => ({ released: false }),
		// The verb rows, for the same reason and with the same cheapest real answer: these
		// suites are about the surface, and a refusal is what a host with no device says.
		wait_for: () => refusedWithoutAHost(),
		wait_until_gone: () => refusedWithoutAHost(),
		tap: () => refusedWithoutAHost(),
		long_press: () => refusedWithoutAHost(),
		swipe: () => refusedWithoutAHost(),
		scroll: () => refusedWithoutAHost(),
		read_screen: () => refusedWithoutAHost(),
		device_info: () => refusedWithoutAHost(),
		launch_app: () => refusedWithoutAHost(),
		stop_app: () => refusedWithoutAHost(),
		clear_app_data: () => refusedWithoutAHost(),
		...overrides,
	};
}

/** The answer every verb row above gives, since none of these suites has a device. */
function refusedWithoutAHost() {
	return {
		outcome: 'refused',
		reason: 'no-lease',
		message: 'no lease store in these tests',
	} as const;
}

/** Server on one end of an in-memory pair, typed client on the other. No socket anywhere. */
function connect(handlers: IpcHandlers = statusHandlers()) {
	const [clientSide, serverSide] = createDuplexPair();
	createIpcServer(handlers).handleConnection(serverSide);
	return { client: createIpcClient(clientSide), clientSide, serverSide };
}

/** Reads raw response frames off a stream, for the cases a typed client cannot produce. */
function collectResponses(stream: Duplex) {
	const decoder = new FrameDecoder();
	const frames: unknown[] = [];

	stream.on('data', (chunk: Buffer) => {
		for (const frame of decoder.push(chunk)) {
			frames.push(ResponseSchema.parse(JSON.parse(frame)));
		}
	});
	// A peer that destroys its side surfaces on this one as an error — `ECONNRESET` on a
	// socket, `ABORT_ERR` on the in-memory pair. There is nothing a reader can do about it,
	// and `createIpcClient` swallows it the same way; without this it is an unhandled 'error'.
	stream.on('error', () => {});

	return {
		frames,
		async next(index: number): Promise<unknown> {
			await vi.waitFor(() => expect(frames.length).toBeGreaterThan(index));
			return frames[index];
		},
	};
}

describe('request/response over a duplex pair', () => {
	it('resolves a status call with the handler’s value', async () => {
		const { client } = connect();

		await expect(client.request('status', {})).resolves.toEqual({
			protocolVersion: PROTOCOL_VERSION,
			pid: 4242,
			uptimeMs: 7,
		});
	});

	it('carries an acquire_device refusal, discriminant and all, over the wire', async () => {
		const { client } = connect(
			statusHandlers({
				acquire_device: () => ({
					outcome: 'refused',
					reason: 'held',
					message: "Device 'attached-1' is held by 'issue-112'",
					heldBy: {
						serial: parseDeviceSerial('attached-1'),
						owner: 'issue-112',
						project: 'rover',
						testName: null,
						expiresInMs: 60_000,
					},
				}),
			}),
		);

		// A refusal is data, not an IPC error, so it has to survive both parses — the server's
		// on the way out and the client's on the way in — as a result rather than a rejection.
		await expect(
			client.request('acquire_device', {
				serial: parseDeviceSerial('attached-1'),
				owner: 'pr-127-review',
				project: 'rover',
			}),
		).resolves.toMatchObject({
			outcome: 'refused',
			reason: 'held',
			heldBy: { owner: 'issue-112', expiresInMs: 60_000 },
		});
	});

	it('carries a verb result over the same surface as a lease call', async () => {
		const { client } = connect(
			statusHandlers({
				wait_for: () => ({
					outcome: 'ok',
					result: {
						verb: 'wait_for',
						device: createMockDeviceInfo(),
						target: { source: 'screen', point: { x: 60, y: 40 }, element: save },
						after: { kind: 'screen', elements: [save] },
					},
				}),
			}),
		);

		// The same client, the same framing and the same envelope that carried the lease call
		// above — which is the criterion this row is about, not the contents of the answer.
		await expect(
			client.request('wait_for', {
				leaseId: parseLeaseId('lease-1'),
				target: { by: 'text', text: 'Save' },
			}),
		).resolves.toMatchObject({
			outcome: 'ok',
			result: { verb: 'wait_for', after: { kind: 'screen' } },
		});
	});

	it('carries a verb failure, discriminant and all, as a result rather than an error', async () => {
		const { client } = connect(
			statusHandlers({
				wait_until_gone: () => ({
					outcome: 'failed',
					failure: {
						kind: 'wait-timeout',
						waitedFor: "text containing 'Saving…' to go away",
						found: "1 element: 'Saving…' [spinner] at 0,0 10×10 still on a screen of 3",
						timeoutMs: 5_000,
						polls: 21,
						message: 'Timed out after 5000ms',
					},
				}),
			}),
		);

		// A verb that answered "no" is data. It has to survive both parses — the server's on
		// the way out and the client's on the way in — as a result, not as a rejection.
		await expect(
			client.request('wait_until_gone', {
				leaseId: parseLeaseId('lease-1'),
				target: { by: 'text', text: 'Saving…' },
			}),
		).resolves.toMatchObject({
			outcome: 'failed',
			failure: { kind: 'wait-timeout', polls: 21 },
		});
	});

	it('correlates two concurrent requests when the replies come back out of order', async () => {
		const releases: Array<() => void> = [];
		let started = 0;
		const { client } = connect(
			statusHandlers({
				status: async (): Promise<StatusResult> => {
					const index = started++;
					await new Promise<void>((resolve) => {
						releases[index] = resolve;
					});
					return { protocolVersion: PROTOCOL_VERSION, pid: 1000 + index, uptimeMs: index };
				},
			}),
		);

		const first = client.request('status', {});
		const second = client.request('status', {});
		await vi.waitFor(() => expect(releases).toHaveLength(2));

		// Second in, first out — the ids are the only thing that can match a reply to a caller.
		releases[1]?.();
		releases[0]?.();

		expect((await first).pid).toBe(1000);
		expect((await second).pid).toBe(1001);
	});

	it('rejects with invalid_params and leaves the connection usable', async () => {
		const { client } = connect();

		// TypeScript cannot catch this one: `status` takes an empty object, and every object
		// is assignable to that. The strict params schema is the only thing standing between a
		// typo'd argument and a silently ignored one — which is the point of parsing at the
		// boundary rather than trusting the caller's types.
		await expect(client.request('status', { unexpected: 1 })).rejects.toMatchObject({
			code: 'invalid_params',
		});

		await expect(client.request('status', {})).resolves.toMatchObject({ pid: 4242 });
	});

	it('reports a throwing handler as internal_error without dropping the connection', async () => {
		const { client } = connect(
			statusHandlers({
				status: () => {
					throw new Error('the device host fell over');
				},
			}),
		);

		await expect(client.request('status', {})).rejects.toMatchObject({
			code: 'internal_error',
			message: 'the device host fell over',
		});
	});

	it('catches a handler returning the wrong shape at the boundary', async () => {
		// The one cast in these tests, and it exists to prove the boundary catches one: the
		// handler type makes this impossible in real code (ai/CODING_STANDARDS.md).
		const broken = { status: () => ({ pid: -1 }) } as unknown as IpcHandlers;
		const { client } = connect(broken);

		await expect(client.request('status', {})).rejects.toMatchObject({ code: 'invalid_result' });
	});

	it('times out a request the host never answers', async () => {
		const { client } = connect(
			statusHandlers({ status: () => new Promise<StatusResult>(() => {}) }),
		);

		const error = await client.request('status', {}, { timeoutMs: 20 }).catch((cause) => cause);

		expect(error).toBeInstanceOf(IpcRequestError);
		expect((error as IpcRequestError).code).toBe('timeout');
	});

	it('fails an in-flight request when the connection ends', async () => {
		let reached = false;
		const { client, serverSide } = connect(
			statusHandlers({
				status: () =>
					new Promise<StatusResult>(() => {
						reached = true;
					}),
			}),
		);

		const pending = client.request('status', {});
		await vi.waitFor(() => expect(reached).toBe(true));
		serverSide.end();

		await expect(pending).rejects.toMatchObject({ code: 'connection_closed' });
	});

	it('refuses a request once the client is closed', async () => {
		const { client } = connect();
		await client.close();

		await expect(client.request('status', {})).rejects.toMatchObject({
			code: 'connection_closed',
		});
	});
});

describe('a client that is not this one', () => {
	it('gets unknown_method, and the connection stays up', async () => {
		const [clientSide, serverSide] = createDuplexPair();
		createIpcServer(statusHandlers()).handleConnection(serverSide);
		const responses = collectResponses(clientSide);

		clientSide.write(
			encodeFrame({ protocolVersion: PROTOCOL_VERSION, id: 'a', method: 'no_such', params: {} }),
		);
		expect(await responses.next(0)).toMatchObject({
			type: 'error',
			id: 'a',
			error: { code: 'unknown_method' },
		});

		clientSide.write(
			encodeFrame({ protocolVersion: PROTOCOL_VERSION, id: 'b', method: 'status', params: {} }),
		);
		expect(await responses.next(1)).toMatchObject({ type: 'result', id: 'b' });
	});

	it('gets unsupported_protocol_version, reported against its own request id', async () => {
		const [clientSide, serverSide] = createDuplexPair();
		createIpcServer(statusHandlers()).handleConnection(serverSide);
		const responses = collectResponses(clientSide);

		clientSide.write(encodeFrame({ protocolVersion: 99, id: 'c', method: 'status', params: {} }));

		expect(await responses.next(0)).toMatchObject({
			type: 'error',
			id: 'c',
			error: { code: 'unsupported_protocol_version' },
		});
	});

	it('gets a null-id malformed_frame for garbage, and the connection closes', async () => {
		const [clientSide, serverSide] = createDuplexPair();
		createIpcServer(statusHandlers()).handleConnection(serverSide);
		const responses = collectResponses(clientSide);
		const ended = new Promise<void>((resolve) => clientSide.on('end', () => resolve()));

		clientSide.write('this is not json\n');

		expect(await responses.next(0)).toMatchObject({
			type: 'error',
			id: null,
			error: { code: 'malformed_frame' },
		});
		await expect(ended).resolves.toBeUndefined();
	});

	/**
	 * `end()` on its own closes only the writable half, which would leave the server reading
	 * — and running handlers — for a peer it has already refused. Once the method table
	 * carries `acquire_device` and `tap`, that is a lease granted to nobody and a real device
	 * moved for a client the host has given up on, with every reply written into a stream
	 * that drops it.
	 */
	it('stops reading after a refusal, so no later frame reaches a handler', async () => {
		const [clientSide, serverSide] = createDuplexPair();
		const status = vi.fn(
			(): StatusResult => ({ protocolVersion: PROTOCOL_VERSION, pid: 1, uptimeMs: 0 }),
		);
		createIpcServer(statusHandlers({ status })).handleConnection(serverSide);
		const responses = collectResponses(clientSide);

		clientSide.write('this is not json\n');
		expect(await responses.next(0)).toMatchObject({ id: null, error: { code: 'malformed_frame' } });

		clientSide.write(
			encodeFrame({ protocolVersion: PROTOCOL_VERSION, id: 'after', method: 'status', params: {} }),
		);
		await vi.waitFor(() => expect(serverSide.destroyed).toBe(true));

		expect(status).not.toHaveBeenCalled();
		expect(responses.frames).toHaveLength(1);
	});

	/**
	 * The peer chooses the chunking, so it can always put the garbage and the verb it wants
	 * executed in one write. If the refusal only stopped the *next* chunk, batching
	 * `garbage\n` ahead of `acquire_device` would be enough to get it run on a connection the
	 * host has already given up on, with the reply discarded.
	 */
	it('refuses without dispatching the frames batched behind the garbage in one write', async () => {
		const [clientSide, serverSide] = createDuplexPair();
		const status = vi.fn(
			(): StatusResult => ({ protocolVersion: PROTOCOL_VERSION, pid: 1, uptimeMs: 0 }),
		);
		createIpcServer(statusHandlers({ status })).handleConnection(serverSide);
		const responses = collectResponses(clientSide);

		clientSide.write(
			`this is not json\n${encodeFrame({
				protocolVersion: PROTOCOL_VERSION,
				id: 'behind',
				method: 'status',
				params: {},
			})}`,
		);

		expect(await responses.next(0)).toMatchObject({ id: null, error: { code: 'malformed_frame' } });
		await vi.waitFor(() => expect(serverSide.destroyed).toBe(true));

		expect(status).not.toHaveBeenCalled();
		expect(responses.frames).toHaveLength(1);
	});

	/**
	 * The frame cap is the surface's only denial-of-service guard, and it has to hold at the
	 * connection, not just inside the decoder: a peer that opens a frame and never closes it
	 * must be cut off rather than answered and left reading.
	 */
	it('refuses and destroys a connection that opens a frame past the cap', async () => {
		const [clientSide, serverSide] = createDuplexPair();
		createIpcServer(statusHandlers()).handleConnection(serverSide);
		const responses = collectResponses(clientSide);

		clientSide.write('x'.repeat(MAX_FRAME_BYTES + 1));

		expect(await responses.next(0)).toMatchObject({
			type: 'error',
			id: null,
			error: { code: 'malformed_frame' },
		});
		await vi.waitFor(() => expect(serverSide.destroyed).toBe(true));
	});

	it('gets a null-id malformed_frame for a method name past the envelope cap', async () => {
		const [clientSide, serverSide] = createDuplexPair();
		createIpcServer(statusHandlers()).handleConnection(serverSide);
		const responses = collectResponses(clientSide);

		// Bounded at the envelope rather than echoed back: an unbounded name is a response the
		// host allocates, encodes and writes on the peer's behalf.
		clientSide.write(
			encodeFrame({
				protocolVersion: PROTOCOL_VERSION,
				id: 'e',
				method: 'z'.repeat(129),
				params: {},
			}),
		);

		expect(await responses.next(0)).toMatchObject({
			type: 'error',
			id: null,
			error: { code: 'malformed_frame' },
		});
	});

	it('cannot smuggle an extra envelope field past the parser', async () => {
		const [clientSide, serverSide] = createDuplexPair();
		const seen: unknown[] = [];
		createIpcServer(
			statusHandlers({
				status: (params) => {
					seen.push(params);
					return { protocolVersion: PROTOCOL_VERSION, pid: 1, uptimeMs: 0 };
				},
			}),
		).handleConnection(serverSide);
		const responses = collectResponses(clientSide);

		clientSide.write(
			`${JSON.stringify({
				protocolVersion: PROTOCOL_VERSION,
				id: 'd',
				method: 'status',
				params: {},
				socketPath: '/tmp/rover.sock',
				uid: 501,
			})}\n`,
		);

		expect(await responses.next(0)).toMatchObject({ type: 'result', id: 'd' });
		expect(seen).toEqual([{}]);
	});
});

describe('a host that is not this one', () => {
	it('fails every in-flight request when it sends an unreadable frame', async () => {
		const [clientSide, serverSide] = createDuplexPair();
		const client = createIpcClient(clientSide);

		const pending = client.request('status', {});
		serverSide.write('}}}not a response\n');

		await expect(pending).rejects.toMatchObject({ code: 'malformed_frame' });
	});

	it('fails a request whose result does not match the method schema', async () => {
		const [clientSide, serverSide] = createDuplexPair();
		const client = createIpcClient(clientSide);
		const requests = new FrameDecoder();
		serverSide.on('data', (chunk: Buffer) => {
			for (const frame of requests.push(chunk)) {
				const { id } = JSON.parse(frame) as { id: string };
				serverSide.write(
					encodeFrame({
						type: 'result',
						protocolVersion: PROTOCOL_VERSION,
						id,
						result: { protocolVersion: PROTOCOL_VERSION, pid: 1 },
					}),
				);
			}
		});

		await expect(client.request('status', {})).rejects.toMatchObject({ code: 'invalid_result' });
	});
});

/**
 * The server's own promise is that it never throws out of a connection, and `safeParse` is
 * only as safe as the schema behind it: Zod lets an exception raised inside a `.transform()`
 * propagate straight out, past a caller that has every reason to expect a returned failure.
 * An unawaited `dispatchFrame` rejecting that way is process death, not a bad response.
 *
 * These stub the schema rather than send a bad id on purpose — the guard has to hold for any
 * schema anyone adds later, not just for the two branded-id fields that first exposed it.
 */
describe('a schema that throws instead of returning an issue', () => {
	it('answers invalid_params rather than rejecting the dispatch', async () => {
		vi.spyOn(IPC_METHODS.status.params, 'safeParse').mockImplementation(() => {
			throw new Error('schema exploded');
		});
		const { client } = connect();

		await expect(client.request('status', {})).rejects.toMatchObject({
			code: 'invalid_params',
			message: 'schema exploded',
		});
		expect(IPC_METHODS.status.params.safeParse).toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it('fails the client’s request rather than throwing inside its data listener', async () => {
		// The mirror image of the server case: the client parses results in the stream's
		// `data` handler, where a throw is an uncaught exception in the CLI or MCP process.
		vi.spyOn(IPC_METHODS.status.result, 'safeParse').mockImplementation(() => {
			throw new Error('client-side schema exploded');
		});
		const [clientSide, serverSide] = createDuplexPair();
		const requests = new FrameDecoder();
		serverSide.on('data', (chunk: Buffer) => {
			for (const frame of requests.push(chunk)) {
				const { id } = JSON.parse(frame) as { id: string };
				serverSide.write(
					encodeFrame({
						type: 'result',
						protocolVersion: PROTOCOL_VERSION,
						id,
						result: { protocolVersion: PROTOCOL_VERSION, pid: 1, uptimeMs: 0 },
					}),
				);
			}
		});

		await expect(createIpcClient(clientSide).request('status', {})).rejects.toMatchObject({
			code: 'invalid_result',
		});
		vi.restoreAllMocks();
	});

	it('answers invalid_result when it is the result schema that throws', async () => {
		vi.spyOn(IPC_METHODS.status.result, 'safeParse').mockImplementation(() => {
			throw new Error('result schema exploded');
		});
		const { client } = connect();

		await expect(client.request('status', {})).rejects.toMatchObject({
			code: 'invalid_result',
		});
		vi.restoreAllMocks();
	});
});
