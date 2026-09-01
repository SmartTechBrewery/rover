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
 * forbids. With one route and one envelope, there is nowhere here a method name could live that
 * `IPC_METHODS` does not already hold — and **one request is one frame**, which is what makes
 * the allowlist below see every method a request can run; see {@link frameFor}.
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
 * this host buffer a byte on their behalf, and cannot reach a handler. **`POST /session` is the
 * one exception, and it is the exception by necessity**: a sign-in carries its credential in the
 * body, so that body is read before the peer is known. It is bounded three ways — the
 * `headersTimeout`/`requestTimeout` above, a tight {@link MAX_SIGN_IN_BYTES}, and the uniform
 * refusal for *every* failure, so no diagnosis of a body a stranger sent ever leaves this host.
 * `/rpc`'s `malformed_frame` wording must never be reused there: the peer is pre-auth, and every
 * diagnosis handed to a pre-auth peer is an oracle.
 *
 * **A browser holds a session, not the token** (D30, R34). `POST /session` takes `{"token": …}`,
 * verifies it against the very same store the gate does, and answers `{session, identifier,
 * displayName}` with `cache-control: no-store`; the page then presents that session id where a
 * token goes today. `GET /session` is the boot probe — is this still good — and `DELETE /session`
 * ends it server-side, which is what makes signing out real rather than a `localStorage`
 * deletion. `src/daemon/panel-session.ts` holds them, keyed by the SHA-256 of the id and bound to
 * the user's `identifier` and `tokenHash`, so resolving one re-reads the user store and a revoke
 * or a rotate ends the session on its very next request exactly as it ends a token's. A raw token
 * keeps working everywhere it worked before, unchanged.
 *
 * **`/session` is a route, not an IPC method**, and that is a decision rather than an oversight:
 * it is this transport's own credential exchange, the analogue of the greeting frame
 * `./network-listen.ts` consumes before attaching the IPC server — which is likewise not on
 * `IPC_METHODS`. A `create_panel_session` method on the one table would put a raw credential into
 * an envelope layer that has never carried one, and would exist on the unix socket, where a
 * browser cannot reach and a session means nothing.
 *
 * **Every pre-auth failure gets one byte-identical refusal**: no credential, a malformed one, a
 * scheme that is not `Bearer`, a token no user holds, a token a revoked user still holds, a user
 * store this host cannot read, a path that does not exist, a method the route does not take. All
 * of them are `401` with {@link REFUSAL_BODY} — the same bytes `network-listen.ts` writes as its
 * refusal frame, minus the newline, because both come from `UNAUTHENTICATED_REFUSAL`. A `403`
 * beside a `401`, or a stack trace, or a `404` for a path that does not exist, would each be an
 * oracle, and it would undo the property for *both* transports rather than only for this one.
 * Three shapes get no answer at all, matching the TLS gate's "a peer that never completes the
 * handshake gets no frame": a malformed HTTP request, a peer that never finishes sending headers,
 * and a peer that wants Node to negotiate an `Expect:` before it has presented a credential.
 * Node would otherwise answer those with a `400`, a `408`, a `417` or a bare `100 Continue`,
 * every one of them a pre-auth answer that varies with the reason.
 *
 * **So there are exactly two statuses**, and neither carries information the envelope does not:
 * `401`, the uniform refusal, and `200`, meaning the surface answered — *read the envelope*.
 * Dispatch outcomes are never mapped onto status codes, because `IpcErrorCodeSchema` is already
 * the complete error vocabulary and a second one in the status line is two sources of truth that
 * can disagree. The `/session` verbs answer within that same pair: a `200` and a small object, or
 * the one refusal.
 *
 * **Only the panel's methods are reachable here** — {@link PANEL_METHODS}, an allowlist and never
 * a second table. Every method still runs on the host either way (D19), so what this protects is
 * D27: the panel carries authority over the device pool and deliberately does not acquire
 * devices, and without the allowlist an authenticated user could `acquire_device` from a browser
 * tab and then drive the phone with the lease id it was handed. A method not on the list is
 * refused **before** dispatch, so nothing runs — and because {@link frameFor} hands the server
 * at most one frame per request, there is no second envelope for a refused method to ride in on.
 *
 * **Request/response only: the panel polls, this surface does not push.** `list_devices` answers
 * with `expiresInMs`, a duration (D17), so the countdown on the screen ticks in the browser from
 * a value the server sent and re-syncs on the next poll — which is also how a lease renewed by
 * its holder's activity (D8) makes that number go back up. So there is no SSE stream, no
 * WebSocket and no long poll, and therefore no second connection style to build, authenticate or
 * shut down. Polling cannot keep a stuck lease alive either: `list_devices` reads the store and
 * never renews (`./leases.ts` — `use()` is the one call that does).
 *
 * **No CORS header is emitted anywhere**, deliberately. The panel is meant to be served by this
 * same listener, so it will be same-origin and needs none — no roadmap row owns serving its assets
 * yet (R33 built the panel, R32 built this route). Emitting one would make this surface readable
 * from any page a browser happens to have open. A preflight arrives without the
 * `Authorization` header and so gets the same uniform refusal, which is the correct answer to it.
 * Authentication is header-only and no cookie is read, so there is no CSRF surface here for a
 * session to have to defend — and **the session did not bring one either** (D30): this module
 * emits no `Set-Cookie` and reads no cookie, so the session id is a header the page attaches
 * itself. A cookie is attached by the browser to a cross-site request whether the page meant it
 * or not, which is the CSRF surface; a credential a script has to fetch and set cannot be
 * attached by a page that is not this origin, and no CORS header is emitted for one to try. The
 * cost is stated rather than hidden: whatever the panel stores the id in is readable by script,
 * so an XSS in the panel reads it — but it reads a credential that expires, that `DELETE
 * /session` ends, and that is not the token `rover users` issued.
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
import { z } from 'zod';
import { encodeFrame } from '../ipc/framing.js';
import { type IpcMethodName, isIpcMethodName } from '../ipc/methods.js';
import {
	type ErrorResponse,
	type IpcErrorCode,
	PROTOCOL_VERSION,
	type RequestEnvelope,
	RequestEnvelopeSchema,
	type RequestId,
	UNAUTHENTICATED_REFUSAL,
} from '../ipc/protocol.js';
import type { IpcServer } from '../ipc/server.js';
import { type HttpListenerConfig, TLS_CERT_ENV_VAR, TLS_KEY_ENV_VAR } from './network-config.js';
import {
	createPanelSessionStore,
	type PanelSessionIdentity,
	type PanelSessionStore,
} from './panel-session.js';
import { findUserByToken, type UserRecord } from './user-store.js';

/**
 * The methods this transport serves — **a subset of the one table, never an addition to it**.
 *
 * Typed against `IpcMethodName`, so renaming a method is a compile error here rather than a
 * surface that silently stops answering. `force_release_device` joined it with the screen that
 * calls it (R35, #122) and `list_archive` with the archive's own read side (R36, #130) — both
 * were on the table already, so what changed here is one transport's reach and not the surface.
 * That is the whole list: the panel reads the pool, ends a stuck lease in it, and reads the
 * artifact archive one directory level at a time, and D27 still keeps every acquire and every
 * verb off a browser.
 */
const PANEL_METHODS: readonly IpcMethodName[] = [
	'list_devices',
	'force_release_device',
	'list_archive',
];

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
 * How long an idle keep-alive connection is kept before this listener closes it.
 *
 * **Not Node's default, and that is the point.** Node's is 5 000 ms — the same number the panel
 * polls on (`panel/src/devices/device-list-provider.tsx`, `POLL_MS`), so the browser's next request
 * went out on a socket this listener was within its response time of closing, every single poll,
 * with the dev proxy's own reused sockets carrying a second copy of the race
 * (`panel/vite.config.ts`). The loser of that race is a request the panel never gets an answer to,
 * and #125 is what one of those used to cost: the poll's in-flight guard was unbounded, so one lost
 * answer froze the grid for the life of the tab. Both halves are fixed; this is the one that stops
 * manufacturing the lost answer.
 *
 * A number well clear of the poll rather than a tuning knob — there is nothing here for an operator
 * to set, exactly as with the three deadlines around it. Holding an idle socket longer costs the
 * daemon nothing on shutdown, because `close()` below calls `closeAllConnections()`: a host asked
 * to go away still goes away at once, whatever this says.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * Cap on a request body. Deliberately **not** `MAX_FRAME_BYTES`: that 8 MiB is sized for a
 * screenshot travelling the other way, on an authenticated connection, and no method this
 * transport serves takes more than a few hundred bytes in. A body over this is answered — the
 * peer is authenticated by the time it is read — but the rest of it is never buffered.
 */
const MAX_PANEL_REQUEST_BYTES = 64 * 1024;

/**
 * Cap on a sign-in body — the one body read before the peer is known, so its bound is far tighter
 * than {@link MAX_PANEL_REQUEST_BYTES} and is not the same number by accident. A token is 43
 * characters; 4 KiB is room for a JSON object around one and nothing a stranger could park here.
 * Over the cap the body is abandoned rather than drained, and the answer is the uniform refusal.
 */
const MAX_SIGN_IN_BYTES = 4 * 1024;

/** The RPC route. Everything unmatched is the uniform refusal, because routing follows the gate. */
const RPC_PATH = '/rpc';

/** The credential-exchange route: `POST` mints a session, `GET` probes one, `DELETE` ends it. */
const SESSION_PATH = '/session';

/**
 * The sign-in body, and the only thing this surface will read from a peer it has not
 * authenticated. `.strict()` so an unexpected key is a refusal rather than something ignored —
 * there is nothing else a browser has to send, and a body carrying more is not one this host
 * wrote the panel for.
 */
const SignInRequestSchema = z.object({ token: z.string().min(1) }).strict();

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

	const serverOptions = {
		// The pre-auth deadline. See {@link AUTH_TIMEOUT_MS}.
		headersTimeout: authTimeoutMs,
		requestTimeout: Math.max(REQUEST_TIMEOUT_MS, authTimeoutMs),
		connectionsCheckingInterval: connectionsCheckingIntervalFor(authTimeoutMs),
		// The idle window between two requests on one connection. See {@link KEEP_ALIVE_TIMEOUT_MS}
		// — this is the one number here that was left at a Node default, and the default collided
		// with the panel's poll interval exactly (#125).
		keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
	};
	const server: HttpServer | HttpsServer =
		material === undefined
			? createHttpServer(serverOptions)
			: createHttpsServer({ ...serverOptions, ...material });

	// Per listener, in memory, and gone when this daemon is: a restart signs every browser out,
	// which needs no file and cannot go stale against the user store (D30).
	const sessions = createPanelSessionStore();

	server.on('request', (request: IncomingMessage, response: ServerResponse) => {
		// First, before anything can fail: an `'error'` with no listener on either half is a
		// crashed daemon, and a browser that navigates away mid-response produces one routinely.
		request.on('error', () => {});
		response.on('error', () => {});
		// The `.catch` is a backstop, not a path: everything below answers rather than throwing.
		// Anything left is a bug, and a bug here must drop the connection rather than become an
		// unhandled rejection that takes the whole daemon down.
		void handleRequest(request, response, config, ipcServer, sessions).catch(() => {
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
	// The same class of Node default, one layer up and easy to miss (§6): with no listener for
	// these two events Node answers an `Expect:` header *itself* — `417 Expectation Failed` for
	// one it does not understand, a bare `100 Continue` for `100-continue` — before this module
	// sees the request at all, which is two more pre-auth statuses that vary with what was sent.
	// A peer asking the host to negotiate before it has presented a credential is a peer with no
	// claim on the socket, so it is dropped exactly as a malformed request line is. Nothing
	// legitimate is lost: a body here is capped at {@link MAX_PANEL_REQUEST_BYTES}, far below the
	// size at which any client volunteers an `Expect`.
	const dropExpectant = (request: IncomingMessage, response: ServerResponse) => {
		// For the `'request'` handler's reason: an `'error'` with no listener on either half is a
		// crashed daemon, and these two halves never reach that handler.
		request.on('error', () => {});
		response.on('error', () => {});
		response.socket?.destroy();
	};
	server.on('checkExpectation', dropExpectant);
	server.on('checkContinue', dropExpectant);

	await bind(server, config);

	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : config.port;

	let closed: Promise<void> | undefined;
	return {
		port,
		close(): Promise<void> {
			closed ??= new Promise<void>((resolve) => {
				// Nothing is going to present one of these again, and a closed listener has no
				// business still holding a live credential in memory.
				sessions.clear();
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
 * One request: sign in, or else authenticate, then route, then read, then dispatch.
 *
 * Nothing above a step has been examined by the time that step runs — in particular a body is not
 * touched until the peer is known, with the single exception the header names: `POST /session`,
 * whose body *is* the credential. Matching that one route is the only thing the URL is read for
 * before the gate, and everything it does not match falls through to the gate unchanged, so a
 * stranger still learns nothing about which paths exist.
 */
async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	config: HttpListenerConfig,
	ipcServer: IpcServer,
	sessions: PanelSessionStore,
): Promise<void> {
	// Only the path, never the query: a credential must never be readable out of a URL, so there
	// is deliberately no code here that could read one out of a URL (D20).
	const path = pathOf(request.url);

	if (request.method === 'POST' && path === SESSION_PATH) {
		await signIn(request, response, config.usersPath, sessions);
		return;
	}

	const authenticated = await authenticate(
		config.usersPath,
		sessions,
		request.headers.authorization,
	);
	if (authenticated === undefined) {
		refuse(response);
		return;
	}

	if (path === SESSION_PATH) {
		describeOrEndSession(request, response, sessions, authenticated);
		return;
	}

	if (request.method !== 'POST' || path !== RPC_PATH) {
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

	// One decision about the whole body, taken in one place: either the answer this module owes
	// the peer, or the single frame the server is allowed to see. Nothing reaches `IpcServer`
	// that this step has not classified.
	const framed = frameFor(body);
	if (typeof framed !== 'string') {
		answer(response, framed);
		return;
	}

	answer(response, await dispatch(ipcServer, framed));
}

/**
 * The one frame this request may become, or the answer this module owes instead of one.
 *
 * **One request is one frame, and this is where that is true.** `IpcServer.handleConnection`
 * consumes NDJSON, so a body carrying a raw newline decodes into *several* frames and the server
 * dispatches every one of them (`src/ipc/framing.ts`) — which would let a body of two envelopes
 * put a method the allowlist never saw on the wire behind one that it did, allowlist and all.
 * So a `string` returned here is a frame that cannot decode into more than one message, and
 * every path that cannot promise that answers rather than hands anything on.
 *
 * A body that parsed as JSON is **re-encoded** rather than passed through, which is what makes it
 * exactly one frame: `JSON.stringify` escapes a newline inside a string, so an encoded frame can
 * never contain a raw one, while a pretty-printed body would otherwise be split by the very
 * framing that makes NDJSON work.
 *
 * A body that did not parse still gets `IpcServer`'s own `malformed_frame` rather than a second
 * copy of that diagnosis — but only when it holds no raw newline, which is the one property that
 * would make it more than one frame. One that holds one is diagnosed here, because there is
 * nothing to hand on that would still be the peer's own bytes.
 *
 * A body that parsed as JSON but not as an envelope needs no allowlist decision: the server
 * validates against this very same `RequestEnvelopeSchema` and refuses it before a method name is
 * read at all, so no method can run that {@link disallowedMethodIn} did not pass.
 */
function frameFor(body: string): ErrorResponse | string {
	if (body.trim().length === 0) {
		// The one case the server has no message for: a blank frame carries no message and the
		// decoder skips it, so handing this on would mean waiting for an answer that never comes.
		return errorEnvelope(null, 'malformed_frame', 'A request body is required');
	}

	const parsed = parseJson(body);
	if (parsed === undefined) {
		return /[\n\r]/.test(body)
			? errorEnvelope(
					null,
					'malformed_frame',
					'A request body must be a single JSON value: one request, one envelope',
				)
			: `${body}\n`;
	}

	const envelope = RequestEnvelopeSchema.safeParse(parsed);
	if (envelope.success) {
		const refusal = disallowedMethodIn(envelope.data);
		if (refusal !== undefined) {
			return refusal;
		}
	}
	return encodeFrame(parsed);
}

/**
 * The `unknown_method` answer for a request naming a method this transport does not serve, or
 * `undefined` when the method is on {@link PANEL_METHODS} and may run.
 *
 * `unknown_method` is the closest code in the closed `IpcErrorCodeSchema` vocabulary; adding one
 * would change the wire for every client of every transport, to say something only this one has
 * to say. The message is what distinguishes the two cases for a human reading it.
 */
function disallowedMethodIn({ id, method }: RequestEnvelope): ErrorResponse | undefined {
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

/** Hand the one frame to the IPC server and read the one it writes back. */
async function dispatch(ipcServer: IpcServer, frame: string): Promise<ErrorResponse | string> {
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

/**
 * `POST /session`: the credential exchange, and the one route reached before the gate.
 *
 * **Every failure is the one refusal, with no diagnosis whatsoever** — no body, a body over the
 * cap, a body that is not JSON, a body that is not `{token: string}`, a token nobody holds, a
 * token a revoked user still holds, a store this host cannot read. The peer is pre-auth, so any
 * two of those answering differently is an oracle, and `/rpc`'s `malformed_frame` wording is
 * deliberately not reused here for exactly that reason.
 *
 * The token is read out of the body, handed to `findUserByToken`, and reaches nothing else: not
 * the answer, not a header, not a log, not the session entry that outlives the request.
 */
async function signIn(
	request: IncomingMessage,
	response: ServerResponse,
	usersPath: string,
	sessions: PanelSessionStore,
): Promise<void> {
	const body = await readBody(request, MAX_SIGN_IN_BYTES);
	if (body === undefined) {
		refuse(response);
		return;
	}

	const parsed = SignInRequestSchema.safeParse(parseJson(body));
	if (!parsed.success) {
		refuse(response);
		return;
	}

	let user: UserRecord | undefined;
	try {
		user = await findUserByToken(usersPath, parsed.data.token);
	} catch {
		refuse(response);
		return;
	}
	if (user === undefined) {
		refuse(response);
		return;
	}

	// The one place a raw session id exists outside the browser that is about to hold it.
	answerJson(response, {
		session: sessions.open(user),
		identifier: user.identifier,
		displayName: user.displayName,
	});
}

/**
 * `GET /session` — the panel's boot probe, answering with who this credential is, which is also
 * what renews a session's idle window — and `DELETE /session`, which ends it server-side.
 *
 * `DELETE` answers `200 {}` whether or not the credential it was given had a session behind it —
 * a raw token has none — because an answer that varied would say whether an id was live. It is
 * behind the gate like everything but the sign-in, so *repeating* a `DELETE` with an id that the
 * first one killed is the uniform refusal rather than a second `200`: a dead session id is not a
 * credential any more, and it is refused exactly as an id nobody was ever issued is. Any other
 * method on this path is that same refusal, as every unrouted request is.
 */
function describeOrEndSession(
	request: IncomingMessage,
	response: ServerResponse,
	sessions: PanelSessionStore,
	authenticated: Authenticated,
): void {
	if (request.method === 'GET') {
		answerJson(response, authenticated.identity);
		return;
	}
	if (request.method === 'DELETE') {
		if (authenticated.kind === 'session') {
			sessions.end(authenticated.id);
		}
		answerJson(response, {});
		return;
	}
	refuse(response);
}

/** Which credential a request presented, once it has turned out to be a real one. */
type Authenticated =
	| { readonly kind: 'session'; readonly id: string; readonly identity: PanelSessionIdentity }
	| { readonly kind: 'user'; readonly identity: PanelSessionIdentity };

/**
 * The gate: the identity behind an `Authorization: Bearer` credential, or `undefined`.
 *
 * **Two kinds, one header, one refusal.** A session id is tried first because it is a `Map` hit
 * against a hash, where a token costs one `scrypt` per stored record; a raw token then keeps
 * working exactly as it did before this route existed, which is R32's documented `curl` recipe
 * and not something a browser's convenience may cost the operator. Both kinds are resolved
 * against the user store on **this** request, so a revoke bites either one on its next.
 */
async function authenticate(
	usersPath: string,
	sessions: PanelSessionStore,
	header: string | undefined,
): Promise<Authenticated | undefined> {
	const credential = bearerTokenIn(header);
	if (credential === undefined) {
		return undefined;
	}
	try {
		const session = await sessions.resolve(usersPath, credential);
		if (session !== undefined) {
			return { kind: 'session', id: credential, identity: session };
		}
		const user = await findUserByToken(usersPath, credential);
		return user === undefined
			? undefined
			: { kind: 'user', identity: { identifier: user.identifier, displayName: user.displayName } };
	} catch {
		// A store this host cannot read authenticates nobody — and says so with the same bytes as
		// every other refusal. Whether the operator's own file is missing, unreadable or malformed
		// is not something the wire may reveal; `rover users list` is where that is diagnosed, by
		// someone with a shell on this machine.
		return undefined;
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
	write(response, 401, REFUSAL_BODY, { close: true });
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
	write(response, 200, typeof body === 'string' ? body : JSON.stringify(body), {
		close: options.close,
	});
}

/**
 * The `/session` verbs' answer: `200`, a small JSON object, and `cache-control: no-store`.
 *
 * `no-store` on all three, not only on the one that mints an id: a probe's answer names the
 * signed-in user, and neither a credential nor an identity is something a browser, a proxy or a
 * back button may keep a copy of. Nothing here ever writes a `Set-Cookie` — see the module
 * header's CSRF paragraph for why that omission is the design and not an oversight.
 */
function answerJson(response: ServerResponse, value: unknown): void {
	write(response, 200, JSON.stringify(value), { noStore: true });
}

interface WriteOptions {
	readonly close?: boolean;
	readonly noStore?: boolean;
}

function write(
	response: ServerResponse,
	status: number,
	body: string,
	options: WriteOptions,
): void {
	if (!response.writable) {
		return;
	}
	response.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(body, 'utf8'),
		...(options.close === true ? { connection: 'close' } : {}),
		...(options.noStore === true ? { 'cache-control': 'no-store' } : {}),
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
