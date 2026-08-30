/**
 * Binding the transport-agnostic IPC surface to a TCP+TLS socket, behind a token gate.
 *
 * **This is a second transport, not a second implementation** (D17). It consumes the very
 * `IpcServer` the unix socket is already serving and hands it an already-connected stream;
 * every method, every schema and every framing rule is therefore shared by construction
 * rather than by two files agreeing. `src/ipc/` never learns that a connection came from the
 * network — `tests/unit/ipc/transport-independence.test.ts` is what keeps that true.
 *
 * **The token never enters the envelope.** A request frame is `{ protocolVersion, id, method,
 * params }` and nothing else (`src/ipc/protocol.ts`), so authentication is a one-line NDJSON
 * *greeting* this module reads and consumes before `handleConnection` sees the stream:
 *
 * ```json
 * {"token":"…"}
 * ```
 *
 * No method can be dispatched before authentication, by construction rather than by a flag —
 * the IPC server is not attached to the socket until the greeting has been accepted. And
 * because the gate lives in this module, the local unix socket needs no token and no
 * configuration at all.
 *
 * **Every pre-auth failure gets one byte-identical refusal.** Wrong token, no greeting, a
 * greeting that is not JSON, an unknown key, an oversize line, a greeting that never arrives in
 * time — all of them get {@link REFUSAL_FRAME} and a destroyed connection. Anything that varied
 * with the reason would be an oracle, and a refusal names no device, no count, no serial and no
 * pid: a stranger learns only that there is a Rover here that wants a token (D20). Nothing
 * about an attempt is logged either, because the only interesting thing to log about one is
 * the token that was tried. A peer that never completes the TLS handshake is the one case with
 * no frame at all — there is no session to write one into — and it is simply dropped.
 */

import { readFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { createServer, type TLSSocket } from 'node:tls';
import { z } from 'zod';
import { encodeFrame } from '../ipc/framing.js';
import { type ErrorResponse, PROTOCOL_VERSION } from '../ipc/protocol.js';
import type { IpcServer } from '../ipc/server.js';
import { createTokenGate, type TokenGate } from './host-token.js';
import { type NetworkListenerConfig, TLS_CERT_ENV_VAR, TLS_KEY_ENV_VAR } from './network-config.js';

/**
 * How long each half of authenticating gets: the TLS handshake, from the moment the TCP
 * connection is accepted, and then the greeting, from the moment that handshake completes.
 *
 * A connection that says nothing has to be refused rather than parked: every one of them holds
 * a socket the host cannot reclaim, and a peer that has not authenticated has no claim on one.
 * Both deadlines are therefore **absolute** — armed once, never rearmed by arriving bytes — so
 * the total time an unauthenticated peer can hold a socket is bounded at twice this whatever it
 * sends and however it chunks it. Deadlines on a peer, not sleeps (ai/RULES.md §2).
 */
const AUTH_TIMEOUT_MS = 5_000;

/**
 * Cap on the greeting line. Deliberately **not** `MAX_FRAME_BYTES`: that 8 MiB is sized for a
 * screenshot travelling on an authenticated connection, and letting an unauthenticated peer
 * buffer 8 MiB of anything is the exact denial a cap exists to bound. A greeting is one JSON
 * object with one string in it.
 */
const MAX_GREETING_BYTES = 4096;

const NEWLINE = 0x0a;

/**
 * `.strict()`, so a greeting carrying anything besides the token is refused rather than
 * silently accepted with an extra key nobody reads.
 */
const HostGreetingSchema = z.object({ token: z.string().min(1) }).strict();

/**
 * The one refusal, encoded once so every path writes the identical bytes.
 *
 * A valid `ErrorResponse` with `id: null`, which is the shape `createIpcClient` already treats
 * as "this connection is not trustworthy" — so a client needs no separate handling for it and
 * fails everything in flight with `unauthenticated`.
 */
const REFUSAL_FRAME = encodeFrame({
	type: 'error',
	protocolVersion: PROTOCOL_VERSION,
	id: null,
	error: { code: 'unauthenticated', message: 'Authentication failed.' },
} satisfies ErrorResponse);

export interface NetworkListener {
	/** The port actually bound — a configured port of 0 resolves to a real one here. */
	readonly port: number;
	/** Stops accepting and drops live connections. Safe to call twice. */
	close(): Promise<void>;
}

export interface NetworkListenerOptions {
	/**
	 * Defaults to {@link AUTH_TIMEOUT_MS}. A test seam in the spirit of
	 * `StartDaemonOptions.sweepIntervalMs`, not a configuration surface: there is nothing here
	 * for an operator to tune, and it exists so a suite can prove that a peer which says
	 * nothing gets the same refusal as one that says the wrong thing.
	 */
	readonly authTimeoutMs?: number;
}

/**
 * Read the TLS material, bind `address:port`, and serve every authenticated connection
 * through `ipcServer`.
 *
 * Rejects rather than degrading: unreadable certificate material and a refused bind are both
 * misconfigurations the operator has to see. A host that quietly served only the local socket
 * while its operator believed it was reachable is the silent degradation this project forbids
 * everywhere else.
 */
export async function startNetworkListener(
	config: NetworkListenerConfig,
	ipcServer: IpcServer,
	options: NetworkListenerOptions = {},
): Promise<NetworkListener> {
	const authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
	// Before the bind, so a missing file is reported as a missing file rather than as a TLS
	// mystery on the first connection.
	const cert = await readPem(config.certPath, TLS_CERT_ENV_VAR);
	const key = await readPem(config.keyPath, TLS_KEY_ENV_VAR);
	const gate = createTokenGate(config.token);

	// Tracked by hand for the same reason `listenOnce` tracks its own: `tls.Server` has no
	// `closeAllConnections()` either, so `close()` would wait forever on an idle peer.
	//
	// Tracked at the **TCP** layer and not only at the TLS one, because `secureConnection` fires
	// only after a handshake: a peer that opens a socket and never sends a ClientHello would be in
	// no set here while still counting against `net.Server`'s own connection count — and
	// `server.close()`'s callback fires only when that count reaches zero. Tracking the raw socket
	// is what makes this listener's shutdown discipline actually equivalent to the unix path's,
	// rather than equivalent only for peers polite enough to speak TLS.
	const accepted = new Set<Socket>();
	const connections = new Set<TLSSocket>();
	let closing = false;

	const server = createServer(
		{
			cert,
			key,
			// The handshake half of the deadline, armed by Node at accept. Node's default is 120s,
			// which is a long time to hold a socket open for a peer that has not said a word. A
			// pre-handshake peer gets no refusal frame — there is no TLS session to write one into,
			// and plaintext on a TLS port is not an answer — only a destroyed socket.
			handshakeTimeout: authTimeoutMs,
		},
		(socket: TLSSocket) => {
			if (closing) {
				socket.destroy();
				return;
			}
			connections.add(socket);
			socket.on('close', () => connections.delete(socket));
			gateConnection(socket, gate, ipcServer, authTimeoutMs);
		},
	);
	server.on('connection', (socket: Socket) => {
		if (closing) {
			socket.destroy();
			return;
		}
		accepted.add(socket);
		socket.on('close', () => accepted.delete(socket));
	});
	// A peer that fails the TLS handshake — an unsupported cipher, a probe from a port scanner,
	// or one that let `handshakeTimeout` above expire without ever sending a ClientHello — is one
	// client's transport failing. Unlistened, it reaches the server's `'error'` handling, so it is
	// caught here and reported nowhere: it is a non-event, which is what it is.
	//
	// Destroyed rather than merely swallowed, because Node does not do it for us: a handshake
	// timeout emits this event and then leaves the socket exactly where it was, which would make
	// the deadline a log line rather than a deadline. Destroying the `TLSSocket` takes the raw
	// socket with it. No frame is written — there is no TLS session to write one into.
	server.on('tlsClientError', (_error: Error, socket: TLSSocket) => {
		socket.destroy();
	});

	await bind(server, config);

	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : config.port;

	let closed: Promise<void> | undefined;
	return {
		port,
		close(): Promise<void> {
			closed ??= new Promise<void>((resolve) => {
				closing = true;
				server.close(() => resolve());
				// `close()` only stops accepting; a client holding an idle connection would keep it
				// pending forever. A host asked to shut down has to actually go away.
				for (const connection of connections) {
					connection.destroy();
				}
				// And the raw sockets beside them — including any that never became a `TLSSocket`
				// at all, which are precisely the ones `server.close()` would otherwise wait on
				// forever.
				for (const socket of accepted) {
					socket.destroy();
				}
			});
			return closed;
		},
	};
}

/** One bind attempt, resolving on `'listening'` and rejecting on the pre-bind `'error'`. */
function bind(
	server: ReturnType<typeof createServer>,
	config: NetworkListenerConfig,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.removeListener('listening', onListening);
			reject(error);
		};
		const onListening = () => {
			server.removeListener('error', onError);
			// Past the bind, a server error is one client's transport failing. Swallowing it is
			// what keeps a single broken connection from taking the whole daemon down.
			server.on('error', () => {});
			resolve();
		};

		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(config.port, config.address);
	});
}

/**
 * Read the greeting, then either refuse or hand the stream to the IPC server.
 *
 * The handover order below is the whole correctness of this module. A peer is free to put the
 * greeting and its first request in one TCP write, so the bytes after the newline are already
 * in this handler's chunk; dropping them there is a hang that only ever shows up under a real
 * client. `pause()` / `unshift()` / `resume()` is what replays them into the IPC server.
 */
function gateConnection(
	socket: TLSSocket,
	gate: TokenGate,
	ipcServer: IpcServer,
	authTimeoutMs: number,
): void {
	// First, before anything can fail: an `'error'` with no listener is a crashed daemon.
	socket.on('error', () => {});

	let settled = false;
	// Explicitly typed: a chunk off a socket is `Buffer<ArrayBufferLike>`, which the narrower
	// type `Buffer.alloc` infers will not accept.
	let buffered: Buffer = Buffer.alloc(0);
	// Assigned below, once `refuse` exists to be its expiry.
	let deadline: NodeJS.Timeout | undefined;

	const refuse = (): void => {
		if (settled) {
			return;
		}
		settled = true;
		clearTimeout(deadline);
		socket.removeListener('data', onGreeting);
		if (socket.writable) {
			socket.end(REFUSAL_FRAME, () => socket.destroy());
			return;
		}
		socket.destroy();
	};

	function onGreeting(chunk: Buffer): void {
		if (settled) {
			return;
		}
		buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

		const greeting = splitGreeting(buffered);
		if (greeting.state === 'incomplete') {
			return;
		}
		if (greeting.state === 'refused' || !accepts(gate, greeting.line)) {
			refuse();
			return;
		}

		settled = true;
		// An authenticated connection has no deadline — a client may hold one open between verbs
		// for as long as it likes.
		clearTimeout(deadline);
		socket.pause();
		socket.removeListener('data', onGreeting);
		if (greeting.remainder.length > 0) {
			socket.unshift(greeting.remainder);
		}
		ipcServer.handleConnection(socket);
		socket.resume();
	}

	// One absolute window, and deliberately **not** `socket.setTimeout`: that is an *idle*
	// deadline which every arriving byte rearms, so a peer writing one byte at a time would stay
	// unauthenticated for `authTimeoutMs` per chunk — hours, at the greeting cap and the
	// production five seconds. The invariant this module claims is that a peer which has not
	// authenticated has no claim on a socket, and only an absolute window makes that true.
	deadline = setTimeout(refuse, authTimeoutMs);
	// Unreferenced: this timer exists to drop a socket, never to keep a process alive that is
	// otherwise finished.
	deadline.unref();
	socket.on('data', onGreeting);
}

/**
 * Where the greeting line ends, and what follows it.
 *
 * `refused` covers a line longer than the cap in either shape — one that has already run past
 * it with no newline in sight, and one that closed past it — because a peer that has not
 * authenticated may not make this host hold an arbitrary buffer on its behalf.
 */
type Greeting =
	| { readonly state: 'incomplete' }
	| { readonly state: 'refused' }
	| { readonly state: 'complete'; readonly line: string; readonly remainder: Buffer };

function splitGreeting(buffered: Buffer): Greeting {
	const newline = buffered.indexOf(NEWLINE);
	if (newline === -1) {
		return buffered.length > MAX_GREETING_BYTES ? { state: 'refused' } : { state: 'incomplete' };
	}
	if (newline > MAX_GREETING_BYTES) {
		return { state: 'refused' };
	}
	return {
		state: 'complete',
		line: buffered.subarray(0, newline).toString('utf8'),
		remainder: buffered.subarray(newline + 1),
	};
}

/** Whether `line` is a greeting carrying the token this gate holds. */
function accepts(gate: TokenGate, line: string): boolean {
	const token = tokenIn(line);
	return token !== undefined && gate.accepts(token);
}

/** The token in a greeting line, or `undefined` for anything this host will not accept. */
function tokenIn(line: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const greeting = HostGreetingSchema.safeParse(parsed);
	// Deliberately no diagnosis: what was wrong with the greeting is exactly the detail a
	// refusal must not become an oracle for.
	return greeting.success ? greeting.data.token : undefined;
}

async function readPem(path: string, envVar: string): Promise<Buffer> {
	try {
		return await readFile(path);
	} catch (error) {
		throw new Error(
			`Cannot read the TLS material at '${path}' named by ${envVar}: ` +
				(error instanceof Error ? error.message : String(error)),
		);
	}
}
