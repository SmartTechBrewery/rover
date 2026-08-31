/**
 * Binding the transport-agnostic IPC surface to an HTTP listener a browser can reach, behind a
 * per-request token gate.
 *
 * **This is a third transport, not a third implementation** (D17, D29). It consumes the very
 * `IpcServer` the unix socket and `./network-listen.ts` are already serving and hands it one
 * framed envelope over an in-memory duplex; every method, every schema and every framing rule is
 * therefore shared by construction rather than by three files agreeing. `src/ipc/` never learns
 * that a request arrived over HTTP — `tests/unit/ipc/transport-independence.test.ts` is what
 * keeps that true, and it now forbids `node:http` and `node:https` there too.
 *
 * **One route, and the envelope names the method.** `POST /rpc`, whose request body is the
 * existing request envelope and whose response body is the existing response envelope. Not a
 * route per method: a REST-ish surface would be a second place a method name exists, to be kept
 * in step with `IPC_METHODS` by hand, which is the second implementation the whole design
 * forbids. With one route and one envelope, a method reachable over HTTP that is not on the one
 * table is structurally impossible.
 *
 * **The token is a request header, never a URL.** `Authorization: Bearer <token>` (D20). The
 * query string is not read by anything in this module — there is no token-in-a-URL path to
 * support by accident — and nothing here logs: not an attempt, not a refusal, not a path. A URL
 * reaches a browser's history, a proxy's access log and a referrer header, which is three places
 * a credential must never be.
 *
 * **The gate has no secret of its own; it asks the user store (D25).** The presented token is
 * hashed and looked up in `~/.rover/users.json` — whatever `ROVER_USERS_PATH` resolves to — so
 * the panel's login *is* an `rover users` credential and there is deliberately no second one,
 * no `ROVER_HOST_TOKEN` revival and no fallback. That settles what `docs/WEB_PANEL.md` left open.
 *
 * **The store is re-read on every request, and never cached** (D6, D25). HTTP has no connection
 * to authenticate — a keep-alive connection carries many requests, and a browser opens and drops
 * them as it pleases — so the gate is per *request* by nature rather than by choice, and that is
 * the stronger property anyway: `rover users revoke` bites on the very next request, on a
 * connection the revoked user is already holding. The cost is one `scrypt` per stored record per
 * request, which is `network-listen.ts`'s trade made once more for the same reason.
 *
 * **Authentication happens before routing, before the body is read, and before anything is
 * dispatched.** An unauthenticated stranger therefore cannot learn which paths exist, cannot make
 * this host buffer a byte on their behalf, and cannot reach a handler.
 *
 * **Every pre-auth failure gets one byte-identical refusal**: no credential, a malformed one, a
 * scheme that is not `Bearer`, a token no user holds, a token a revoked user still holds, a user
 * store this host cannot read, a path that does not exist, a method the route does not take. All
 * of them are `401` with {@link REFUSAL_BODY} — the same bytes `network-listen.ts` writes as its
 * refusal frame, minus the newline, because both come from `UNAUTHENTICATED_REFUSAL`. A `403`
 * beside a `401`, or a stack trace, or a `404` for a path that does not exist, would each be an
 * oracle, and it would undo the property for *both* transports rather than only for this one.
 * Two shapes get no answer at all, matching the TLS gate's "a peer that never completes the
 * handshake gets no frame": a malformed HTTP request and a peer that never finishes sending
 * headers, both of which Node would otherwise answer with a `400` or a `408` that varies with the
 * reason.
 *
 * **So there are exactly two statuses**, and neither carries information the envelope does not:
 * `401`, the uniform refusal, and `200`, meaning the surface answered — *read the envelope*.
 * Dispatch outcomes are never mapped onto status codes, because `IpcErrorCodeSchema` is already
 * the complete error vocabulary and a second one in the status line is two sources of truth that
 * can disagree.
 *
 * **Only the panel's methods are reachable here** — {@link PANEL_METHODS}, an allowlist and never
 * a second table. Every method still runs on the host either way (D19), so what this protects is
 * D27: the panel carries authority over the device pool and deliberately does not acquire
 * devices, and without the allowlist an authenticated user could `acquire_device` from a browser
 * tab and then drive the phone with the lease id it was handed. A method not on the list is
 * refused **before** dispatch, so nothing runs.
 *
 * **Request/response only: the panel polls, this surface does not push.** `list_devices` answers
 * with `expiresInMs`, a duration (D17), so the countdown on the screen ticks in the browser from
 * a value the server sent and re-syncs on the next poll — which is also how a lease renewed by
 * its holder's activity (D8) makes that number go back up. So there is no SSE stream, no
 * WebSocket and no long poll, and therefore no second connection style to build, authenticate or
 * shut down. Polling cannot keep a stuck lease alive either: `list_devices` reads the store and
 * never renews (`./leases.ts` — `use()` is the one call that does).
 *
 * **No CORS header is emitted anywhere**, deliberately. The panel will be served by this same
 * listener (R33), so it is same-origin and needs none; emitting one would make this surface
 * readable from any page a browser happens to have open. A preflight arrives without the
 * `Authorization` header and so gets the same uniform refusal, which is the correct answer to it.
 * Authentication is header-only and no cookie is read, so there is no CSRF surface here for a
 * session to have to defend — that question arrives with the session itself (R34).
 *
 * **The token authenticates; it attributes nothing** (D20). Which user a request turned out to be
 * is deliberately not carried past this gate: a lease's `owner` stays an explicit,
 * caller-supplied string.
 */

import { readFile } from 'node:fs/promises';
import {
	createServer as createHttpServer,
	type Server as HttpServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { Duplex, PassThrough } from 'node:stream';
import { encodeFrame } from '../ipc/framing.js';
import { type IpcMethodName, isIpcMethodName } from '../ipc/methods.js';
import {
	type ErrorResponse,
	type IpcErrorCode,
	PROTOCOL_VERSION,
	RequestEnvelopeSchema,
	type RequestId,
	UNAUTHENTICATED_REFUSAL,
} from '../ipc/protocol.js';
import type { IpcServer } from '../ipc/server.js';
import { type HttpListenerConfig, TLS_CERT_ENV_VAR, TLS_KEY_ENV_VAR } from './network-config.js';
import { findUserByToken } from './user-store.js';

/**
 * The methods this transport serves — **a subset of the one table, never an addition to it**.
 *
 * Typed against `IpcMethodName`, so renaming a method is a compile error here rather than a
 * surface that silently stops answering. `force_release_device` is on the table already (R31,
 * #109) and joins this list in the change that builds the screen calling it (R35); nothing else
 * is expected to.
 */
const PANEL_METHODS: readonly IpcMethodName[] = ['list_devices'];

/**
 * How long a peer gets to finish sending its request headers — and therefore its credential,
 * since the credential *is* a header. The pre-auth deadline, in the sense
 * `network-listen.ts`'s greeting deadline is one: a peer that has not authenticated has no
 * claim on a socket, and every one of them holds a socket the host cannot reclaim.
 *
 * Five seconds, matching the TLS gate's budget, and enforced by Node rather than by a timer of
 * this module's own — see {@link connectionsCheckingIntervalFor} for the part of that which is
 * not obvious.
 */
const AUTH_TIMEOUT_MS = 5_000;

/**
 * The bound on a whole request, headers and body together, so a body that never finishes cannot
 * park a connection the way a headers-less peer cannot. Node requires it to be **at least**
 * `headersTimeout`, and only checks that when both are passed to `createServer()` — assigning
 * them as properties afterwards is not validated at all (§6).
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Cap on a request body. Deliberately **not** `MAX_FRAME_BYTES`: that 8 MiB is sized for a
 * screenshot travelling the other way, on an authenticated connection, and no method this
 * transport serves takes more than a few hundred bytes in. A body over this is answered — the
 * peer is authenticated by the time it is read — but the rest of it is never buffered.
 */
const MAX_PANEL_REQUEST_BYTES = 64 * 1024;

/** The one route. Everything else is the uniform refusal, because routing happens after the gate. */
const RPC_PATH = '/rpc';

/**
 * The one refusal, as a body rather than as a frame.
 *
 * The value comes from `src/ipc/protocol.ts`, which is what makes it the identical bytes
 * `network-listen.ts` writes without its trailing newline — by construction rather than by two
 * files agreeing (D20).
 */
const REFUSAL_BODY = JSON.stringify(UNAUTHENTICATED_REFUSAL);

export interface HttpListener {
	/** The port actually bound — a configured port of 0 resolves to a real one here. */
	readonly port: number;
	/** Whether the listener terminates TLS itself, so a caller can print the right scheme. */
	readonly secure: boolean;
	/** Stops accepting and drops live connections. Safe to call twice. */
	close(): Promise<void>;
}

export interface HttpListenerOptions {
	/**
	 * Defaults to {@link AUTH_TIMEOUT_MS}. A test seam in the spirit of
	 * `NetworkListenerOptions.authTimeoutMs`, not a configuration surface: there is nothing here
	 * for an operator to tune, and it exists so a suite can prove that a peer which sends no
	 * headers is dropped rather than answered.
	 */
	readonly authTimeoutMs?: number;
}

/**
 * Read the TLS material if any was configured, bind `address:port`, and serve every
 * authenticated request through `ipcServer`.
 *
 * Rejects rather than degrading, exactly as `startNetworkListener` does: unreadable certificate
 * material and a refused bind are both misconfigurations the operator has to see, and a host
 * that quietly served nothing to the browser its operator had pointed at it is the silent
 * degradation this project forbids everywhere else.
 */
export async function startHttpListener(
	config: HttpListenerConfig,
	ipcServer: IpcServer,
	options: HttpListenerOptions = {},
): Promise<HttpListener> {
	const authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
	const { certPath, keyPath } = config;
	// Both or neither — `resolveHttpListener` has already refused every other combination, and
	// refused plain HTTP anywhere a stranger could reach. Read before the bind, so a missing file
	// is reported as a missing file rather than as a TLS mystery on the first request.
	const material =
		certPath !== undefined && keyPath !== undefined
			? {
					cert: await readPem(certPath, TLS_CERT_ENV_VAR),
					key: await readPem(keyPath, TLS_KEY_ENV_VAR),
				}
			: undefined;
	const secure = material !== undefined;

	const serverOptions = {
		// The pre-auth deadline. See {@link AUTH_TIMEOUT_MS}.
		headersTimeout: authTimeoutMs,
		requestTimeout: Math.max(REQUEST_TIMEOUT_MS, authTimeoutMs),
		connectionsCheckingInterval: connectionsCheckingIntervalFor(authTimeoutMs),
	};
	const server: HttpServer | HttpsServer =
		material === undefined
			? createHttpServer(serverOptions)
			: createHttpsServer({ ...serverOptions, ...material });

	server.on('request', (request: IncomingMessage, response: ServerResponse) => {
		// First, before anything can fail: an `'error'` with no listener on either half is a
		// crashed daemon, and a browser that navigates away mid-response produces one routinely.
		request.on('error', () => {});
		response.on('error', () => {});
		// The `.catch` is a backstop, not a path: everything below answers rather than throwing.
		// Anything left is a bug, and a bug here must drop the connection rather than become an
		// unhandled rejection that takes the whole daemon down.
		void handleRequest(request, response, config, ipcServer).catch(() => {
			response.destroy();
		});
	});
	// Node's default answers a malformed request line with `400 Bad Request` and a headers
	// timeout with `408 Request Timeout`. Both are pre-auth answers that vary with the reason,
	// which is exactly the oracle the uniform refusal exists to deny, so neither is written: the
	// socket is destroyed, matching the TLS gate's "a peer that never completes the handshake
	// gets no frame at all".
	server.on('clientError', (_error: Error, socket: Duplex) => {
		socket.destroy();
	});

	await bind(server, config);

	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : config.port;

	let closed: Promise<void> | undefined;
	return {
		port,
		secure,
		close(): Promise<void> {
			closed ??= new Promise<void>((resolve) => {
				server.close(() => resolve());
				// `close()` only stops accepting; a browser holding an idle keep-alive connection
				// would keep it pending forever, and a daemon asked to shut down has to actually go
				// away. This is the discipline `network-listen.ts` hand-rolls over two socket sets,
				// which `http.Server` happens to provide outright.
				server.closeAllConnections();
			});
			return closed;
		},
	};
}

/**
 * How often Node sweeps its connection list looking for one that has blown a deadline.
 *
 * **Without this, neither timeout above is worth anything.** `headersTimeout` is not checked
 * when it elapses; it is checked on this interval, which defaults to 30 seconds — so a
 * five-second pre-auth deadline would in practice drop a silent peer somewhere in the next half
 * minute, and a test seam of 250ms would not land inside a test at all (§6). A fifth of the
 * deadline keeps the enforcement close to what the deadline says, and at operator scale the
 * sweep costs nothing.
 */
function connectionsCheckingIntervalFor(authTimeoutMs: number): number {
	return Math.max(50, Math.floor(authTimeoutMs / 5));
}

/** One bind attempt, resolving on `'listening'` and rejecting on the pre-bind `'error'`. */
function bind(server: HttpServer | HttpsServer, config: HttpListenerConfig): Promise<void> {
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
 * One request, in the order the module header promises: authenticate, then route, then read,
 * then dispatch.
 *
 * Nothing above a step has been examined by the time that step runs — in particular the body is
 * not touched until the peer is known, and the URL is not looked at until then either.
 */
async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	config: HttpListenerConfig,
	ipcServer: IpcServer,
): Promise<void> {
	if (!(await authenticates(config.usersPath, request.headers.authorization))) {
		refuse(response);
		return;
	}

	// Only the path, never the query: a credential must never be readable out of a URL, so there
	// is deliberately no code here that could read one out of a URL (D20).
	if (request.method !== 'POST' || pathOf(request.url) !== RPC_PATH) {
		// Refused with the same bytes as an unauthenticated caller gets, on purpose: routing
		// happens after the gate, so a stranger cannot use a `404` to learn which paths exist,
		// and an authenticated caller learns nothing it did not already know from this file.
		refuse(response);
		return;
	}

	const body = await readBody(request, MAX_PANEL_REQUEST_BYTES);
	if (body === undefined) {
		answer(
			response,
			errorEnvelope(
				null,
				'malformed_frame',
				`A request body may not exceed ${MAX_PANEL_REQUEST_BYTES} bytes`,
			),
			{ close: true },
		);
		return;
	}

	const refusal = disallowedMethodIn(body);
	if (refusal !== undefined) {
		answer(response, refusal);
		return;
	}

	answer(response, await dispatch(ipcServer, body));
}

/**
 * The `unknown_method` answer for a request naming a method this transport does not serve, or
 * `undefined` when there is nothing to refuse here.
 *
 * A body that does not parse is deliberately **not** refused here: `IpcServer` is the single
 * source of the `malformed_frame` message, and duplicating its diagnosis would be a second
 * implementation of the smallest possible thing.
 *
 * `unknown_method` is the closest code in the closed `IpcErrorCodeSchema` vocabulary; adding one
 * would change the wire for every client of every transport, to say something only this one has
 * to say. The message is what distinguishes the two cases for a human reading it.
 */
function disallowedMethodIn(body: string): ErrorResponse | undefined {
	const envelope = RequestEnvelopeSchema.safeParse(parseJson(body));
	if (!envelope.success) {
		return undefined;
	}
	const { id, method } = envelope.data;
	if (PANEL_METHODS.some((allowed) => allowed === method)) {
		return undefined;
	}
	return errorEnvelope(
		id,
		'unknown_method',
		isIpcMethodName(method)
			? `'${method}' is not served over this host's HTTP surface`
			: `No such method: '${method}'`,
	);
}

/**
 * Hand one framed envelope to the IPC server and read the one it writes back.
 *
 * A body that parsed as JSON is **re-encoded** rather than passed through, which is what makes
 * it exactly one frame: `JSON.stringify` escapes a newline inside a string, so an encoded frame
 * can never contain a raw one, while a pretty-printed body would otherwise be split across
 * several frames by the very framing that makes NDJSON work. A body that did not parse is passed
 * through untouched, so the `malformed_frame` the peer reads is the server's own.
 */
async function dispatch(ipcServer: IpcServer, body: string): Promise<ErrorResponse | string> {
	const parsed = parseJson(body);
	if (parsed === undefined && body.trim().length === 0) {
		// The one case the server has no message for: a blank frame carries no message and the
		// decoder skips it, so handing this on would mean waiting for an answer that never comes.
		return errorEnvelope(null, 'malformed_frame', 'A request body is required');
	}
	const frame = parsed === undefined ? `${body}\n` : encodeFrame(parsed);
	try {
		return await callOnce(ipcServer, frame);
	} catch (error) {
		// The server writes a frame on every path it has, refusals included, so reaching this is
		// a bug in the handover rather than a request the peer can provoke. It is answered rather
		// than thrown for the reason every other failure is: a host that broke says so.
		return errorEnvelope(null, 'internal_error', messageOf(error));
	}
}

/**
 * One request, one response, over the one binding surface `IpcServer` exposes.
 *
 * The pair of `PassThrough`s is the same "transport that is not a socket" `tests/unit/ipc/`
 * already drives the surface over, and that is the point: this module adds no dispatch of its
 * own, so there is nothing for a second implementation to drift from. Exactly one frame goes in
 * and the server writes exactly one frame back — a refusal included, which it writes before
 * destroying the stream, and after which it dispatches nothing further from the same chunk — so
 * the first frame out is the answer and both streams are torn down once it has arrived.
 *
 * **The rejected alternative**, recorded because it will be proposed again: a
 * `handleFrame(frame): Promise<Response>` on `IpcServer`, called directly. It is cheaper per
 * request and it would be defensible — but it widens the interface whose narrowness is the
 * stated reason a new transport is not a rewrite, and it would refactor the dispatcher both
 * existing transports depend on for a saving no caller here can measure (the methods this
 * surface serves take and return kilobytes). If per-request framing ever costs something real,
 * that is the escape hatch.
 */
function callOnce(ipcServer: IpcServer, frame: string): Promise<string> {
	const toServer = new PassThrough();
	const fromServer = new PassThrough();
	const serverSide = Duplex.from({ writable: fromServer, readable: toServer });
	// Tearing these down mid-flight is an ordinary outcome — a peer hangs up, the answer has
	// arrived — and a stream error with no listener would take the daemon down.
	serverSide.on('error', () => {});
	toServer.on('error', () => {});
	fromServer.on('error', () => {});

	const answered = firstFrame(fromServer);
	ipcServer.handleConnection(serverSide);
	toServer.end(frame);

	return answered.finally(() => {
		serverSide.destroy();
		toServer.destroy();
		fromServer.destroy();
	});
}

/** The first whole frame written to `stream`, or a rejection if it ends without one. */
function firstFrame(stream: PassThrough): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let buffered = '';
		stream.setEncoding('utf8');
		stream.on('data', (chunk: string) => {
			buffered += chunk;
			const newline = buffered.indexOf('\n');
			if (newline !== -1) {
				resolve(buffered.slice(0, newline));
			}
		});
		stream.on('end', () => reject(new Error('The IPC server answered nothing')));
		stream.on('close', () => reject(new Error('The IPC server answered nothing')));
	});
}

/**
 * The request body as text, or `undefined` when the peer sent more than `cap` bytes.
 *
 * Over the cap the body is **abandoned rather than drained**: reading stops, and what has
 * already arrived is dropped. A peer that keeps writing past the answer is not one this host
 * keeps buffering for.
 */
function readBody(request: IncomingMessage, cap: number): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let received = 0;

		const onData = (chunk: Buffer): void => {
			received += chunk.length;
			if (received > cap) {
				request.removeListener('data', onData);
				request.pause();
				resolve(undefined);
				return;
			}
			chunks.push(chunk);
		};

		request.on('data', onData);
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}

/** Whether the `Authorization` header carries a token some user in the store holds. */
async function authenticates(usersPath: string, header: string | undefined): Promise<boolean> {
	const token = bearerTokenIn(header);
	if (token === undefined) {
		return false;
	}
	try {
		return (await findUserByToken(usersPath, token)) !== undefined;
	} catch {
		// A store this host cannot read authenticates nobody — and says so with the same bytes as
		// every other refusal. Whether the operator's own file is missing, unreadable or malformed
		// is not something the wire may reveal; `rover users list` is where that is diagnosed, by
		// someone with a shell on this machine.
		return false;
	}
}

/**
 * The token in an `Authorization` header, or `undefined` for anything this host will not accept.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is case-insensitive and a
 * client library will pick its own casing. Deliberately no diagnosis of what was wrong: that is
 * exactly the detail a refusal must not become an oracle for.
 */
function bearerTokenIn(header: string | undefined): string | undefined {
	if (header === undefined) {
		return undefined;
	}
	const separator = header.indexOf(' ');
	if (separator === -1 || header.slice(0, separator).toLowerCase() !== 'bearer') {
		return undefined;
	}
	const token = header.slice(separator + 1).trim();
	return token.length === 0 ? undefined : token;
}

/** The path of a request target, with any query string discarded unread. */
function pathOf(url: string | undefined): string {
	if (url === undefined) {
		return '';
	}
	const query = url.indexOf('?');
	return query === -1 ? url : url.slice(0, query);
}

/** The uniform pre-auth refusal — the same bytes, the same headers, whatever it is refusing. */
function refuse(response: ServerResponse): void {
	write(response, 401, REFUSAL_BODY, true);
}

/**
 * The surface answered: `200`, and the envelope is what says how.
 *
 * Dispatch outcomes are never mapped onto status codes. `IpcErrorCodeSchema` is already the
 * complete error vocabulary every other transport reads, and a second one in the status line is
 * two sources of truth that can disagree — the panel would then have to decide which to believe.
 */
function answer(
	response: ServerResponse,
	body: ErrorResponse | string,
	options: { readonly close?: boolean } = {},
): void {
	write(response, 200, typeof body === 'string' ? body : JSON.stringify(body), options.close);
}

function write(
	response: ServerResponse,
	status: number,
	body: string,
	close: boolean | undefined,
): void {
	if (!response.writable) {
		return;
	}
	response.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(body, 'utf8'),
		...(close === true ? { connection: 'close' } : {}),
	});
	response.end(body);
}

function errorEnvelope(id: RequestId | null, code: IpcErrorCode, message: string): ErrorResponse {
	return { type: 'error', protocolVersion: PROTOCOL_VERSION, id, error: { code, message } };
}

/** `JSON.parse`, with a failure as `undefined` rather than as a throw. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The TLS material, read with the error wording `network-listen.ts` uses.
 *
 * Duplicated rather than shared, and deliberately: the alternative is a module whose whole
 * content is this function, or one transport importing the other, and both cost more than five
 * lines. If a third caller ever appears, that is the moment to lift it.
 */
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
