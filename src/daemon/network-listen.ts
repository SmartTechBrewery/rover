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
 * **The gate has no secret of its own; it asks the user store (D25).** The presented token is
 * hashed and looked up in `~/.rover/users.json` — whatever `ROVER_USERS_PATH` resolves to —
 * so every credential that opens this port is one `rover users add` issued to a named user.
 * There is no `ROVER_HOST_TOKEN` on this side and deliberately no fallback to one: a second
 * way in that no `rover users` command could take away is exactly what the store retires.
 *
 * **The store is re-read at every connection attempt, and never cached** (D6, D25 — the daemon
 * is a cache and holds nothing it cannot re-derive, the same rule the device inventory lives
 * under). So `rover users revoke` bites on that user's *very next* attempt, with this daemon
 * still running and no restart, and `rover users add` lets a new user in just as immediately.
 * The cost is one `scrypt` per stored record per attempt, inside the pre-auth deadline below;
 * that is the price of a stored credential that survives the file leaking, and caching the
 * store to avoid it would trade away the only property this gate is here for.
 *
 * **Every pre-auth failure gets one byte-identical refusal.** A token no user holds, a token a
 * revoked user still holds, no greeting, a greeting that is not JSON, an unknown key, an
 * oversize line, a greeting that never arrives in time, a user store this host cannot read —
 * all of them get {@link REFUSAL_FRAME} and a destroyed connection. Anything that varied with
 * the reason would be an oracle, and a refusal names no device, no count, no serial, no user
 * and no pid: a stranger learns only that there is a Rover here that wants a token (D20).
 * Nothing about an attempt is logged either, because the only interesting thing to log about
 * one is the token that was tried. A peer that never completes the TLS handshake is the one
 * case with no frame at all — there is no session to write one into — and it is simply
 * dropped.
 *
 * **The token authenticates; it attributes nothing** (D20). Which user a connection turned out
 * to be is deliberately not carried past this gate: a lease's `owner` stays an explicit,
 * caller-supplied string.
 */

import { readFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { createServer, type TLSSocket } from 'node:tls';
import { z } from 'zod';
import { encodeFrame } from '../ipc/framing.js';
import { UNAUTHENTICATED_REFUSAL } from '../ipc/protocol.js';
import type { IpcServer } from '../ipc/server.js';
import { type NetworkListenerConfig, TLS_CERT_ENV_VAR, TLS_KEY_ENV_VAR } from './network-config.js';
import { findUserByToken } from './user-store.js';

/**
 * How long each half of authenticating gets: the TLS handshake, from the moment the TCP
 * connection is accepted, and then the greeting, from the moment that handshake completes.
 *
 * A connection that says nothing has to be refused rather than parked: every one of them holds
 * a socket the host cannot reclaim, and a peer that has not authenticated has no claim on one.
 * Both deadlines are therefore **absolute** — armed once, never rearmed by arriving bytes — so
 * the total time an unauthenticated peer can hold a socket is bounded at twice this whatever it
 * sends and however it chunks it. Deadlines on a peer, not sleeps (ai/RULES.md §2).
 *
 * The greeting half of that budget covers the **store lookup** too, not merely the bytes: the
 * deadline stays armed across one `scrypt` per stored user, which is what keeps "a peer that
 * has not authenticated has no claim on a socket" literally true rather than true-until-the-
 * verification-starts. Five seconds is comfortable at operator scale.
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
 *
 * The value comes from `src/ipc/protocol.ts` rather than being spelled out here, because
 * `./http-listen.ts` refuses with the same bytes and the two must be identical by construction
 * rather than by two files agreeing (D20).
 */
const REFUSAL_FRAME = encodeFrame(UNAUTHENTICATED_REFUSAL);

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
			gateConnection(socket, config.usersPath, ipcServer, authTimeoutMs);
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
 * Read the greeting, look the token up in the user store, then either refuse or hand the
 * stream to the IPC server.
 *
 * The handover order below is the whole correctness of this module. A peer is free to put the
 * greeting and its first request in one TCP write, so the bytes after the newline are already
 * in this handler's chunk; dropping them there is a hang that only ever shows up under a real
 * client. `pause()` / `unshift()` / `resume()` is what replays them into the IPC server.
 *
 * The store lookup makes the check **asynchronous**, which adds one state the byte-only
 * version did not have: the greeting is complete but not yet judged. Hence a three-state
 * `phase` rather than a boolean, and the strict ordering in `onGreeting` — pause the socket
 * and drop the `'data'` listener *before* the first `await`, so no byte arriving during the
 * verification is delivered to a handler that is no longer there and silently lost.
 */
function gateConnection(
	socket: TLSSocket,
	usersPath: string,
	ipcServer: IpcServer,
	authTimeoutMs: number,
): void {
	// First, before anything can fail: an `'error'` with no listener is a crashed daemon.
	socket.on('error', () => {});

	// `checking` is the window the `await` opens: the greeting has been read and the socket
	// paused, but nothing has been decided. Both of the other two are terminal for this gate.
	let phase: 'reading' | 'checking' | 'settled' = 'reading';
	// Explicitly typed: a chunk off a socket is `Buffer<ArrayBufferLike>`, which the narrower
	// type `Buffer.alloc` infers will not accept.
	let buffered: Buffer = Buffer.alloc(0);
	// Assigned below, once `refuse` exists to be its expiry.
	let deadline: NodeJS.Timeout | undefined;

	const refuse = (): void => {
		if (phase === 'settled') {
			return;
		}
		phase = 'settled';
		clearTimeout(deadline);
		socket.removeListener('data', onGreeting);
		if (socket.writable) {
			socket.end(REFUSAL_FRAME, () => socket.destroy());
			return;
		}
		socket.destroy();
	};

	/** The second half of the greeting, after the store has answered. */
	async function check(line: string, remainder: Buffer): Promise<void> {
		const authenticated = await authenticates(usersPath, line);
		// The deadline may have fired, or the peer hung up, while `scrypt` ran. Either way this
		// socket is spoken for and must not be handed to the IPC server or written to again.
		if (phase === 'settled') {
			return;
		}
		if (!authenticated) {
			refuse();
			return;
		}

		phase = 'settled';
		// An authenticated connection has no deadline — a client may hold one open between verbs
		// for as long as it likes.
		clearTimeout(deadline);
		if (remainder.length > 0) {
			socket.unshift(remainder);
		}
		ipcServer.handleConnection(socket);
		socket.resume();
	}

	function onGreeting(chunk: Buffer): void {
		if (phase !== 'reading') {
			return;
		}
		buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

		const greeting = splitGreeting(buffered);
		if (greeting.state === 'incomplete') {
			return;
		}
		if (greeting.state === 'refused') {
			refuse();
			return;
		}

		// This ordering is load-bearing, and all of it happens before the first `await`: the
		// socket stops flowing and this handler stops listening while the store is consulted,
		// so whatever the peer writes next stays in the stream for `handleConnection` — or goes
		// away with the socket on a refusal — rather than being read and dropped.
		phase = 'checking';
		socket.pause();
		socket.removeListener('data', onGreeting);
		// The `.catch` is a backstop, not a path: `authenticates` swallows everything the store
		// can throw. Anything left is a bug in the handover, and a bug there must drop the
		// connection rather than become an unhandled rejection that takes the daemon down. Once
		// the stream has been handed over the phase is already settled, so `refuse` is a no-op
		// and an authenticated peer cannot be dropped by this.
		void check(greeting.line, greeting.remainder).catch(() => refuse());
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
	// A peer that hangs up mid-verification settles the gate itself, so the `await` above can
	// never come back and attach the IPC server to a socket that is already gone.
	socket.on('close', () => {
		phase = 'settled';
		clearTimeout(deadline);
	});
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

/** Whether `line` is a greeting carrying a token some user in the store holds. */
async function authenticates(usersPath: string, line: string): Promise<boolean> {
	const token = tokenIn(line);
	if (token === undefined) {
		return false;
	}
	try {
		return (await findUserByToken(usersPath, token)) !== undefined;
	} catch {
		// A store this host cannot read authenticates nobody — and says so with the same bytes
		// as every other refusal. Whether the operator's own file is missing, unreadable or
		// malformed is not something the wire may reveal; `rover users list` is where that is
		// diagnosed, by someone with a shell on this machine.
		return false;
	}
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
