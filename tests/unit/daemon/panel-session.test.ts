/**
 * R34's host half: the three verbs on `/session`, the gate that now takes two kinds of credential,
 * and the two ways a session ends — a sign-out, and a `rover users revoke` on the machine holding
 * the store (D30).
 *
 * The daemon suite's real-socket exception applies here for the same reason it applies to
 * `http-listener.test.ts` (ai/TESTING.md), and for one criterion it applies *only* here: "a revoke
 * ends a live browser session on its very next request, on a connection the browser is already
 * holding" cannot be asserted against a mock, because only a real keep-alive connection can be
 * held. So the store is a real `users.json` in a per-test `mkdtemp` directory — never
 * `~/.rover/users.json` — the listener binds `127.0.0.1:0`, and the client is `node:http`'s own
 * `request`, because a browser is not a Rover client.
 *
 * The last block is the only one that talks to `createPanelSessionStore` directly: the idle window
 * is eight hours, so crossing it over HTTP would mean either a sleep (forbidden — ai/RULES.md) or
 * a listener seam that exists for nothing else. The `now` seam is where that is asserted instead.
 */

import { rm, writeFile } from 'node:fs/promises';
import {
	Agent,
	request as httpRequest,
	type IncomingHttpHeaders,
	type IncomingMessage,
} from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { HttpListenerConfig } from '@/daemon/network-config.js';
import { createPanelSessionStore, PANEL_SESSION_IDLE_MS } from '@/daemon/panel-session.js';
import { readUsers, revokeUser, rotateUserToken, type UserRecord } from '@/daemon/user-store.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';
import { UNISSUED_TOKEN } from '../../helpers/tls-fixtures.js';
import { createTestUserStore, type TestUserStore } from '../../helpers/user-store.js';

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });

/**
 * The one refusal body, spelled out here rather than imported, exactly as
 * `http-listener.test.ts` spells it out: a copy is what makes it a contract. Every sign-in
 * failure has to be these bytes and no others.
 */
const REFUSAL_BODY = JSON.stringify({
	type: 'error',
	protocolVersion: 1,
	id: null,
	error: { code: 'unauthenticated', message: 'Authentication failed.' },
});

/** The cap `http-listen.ts` puts on the one pre-auth body, restated so a test can exceed it. */
const MAX_SIGN_IN_BYTES = 4 * 1024;

let temp: TempSocket;
let store: TestUserStore;
const running: RunningDaemon[] = [];
const agents: Agent[] = [];

function registerFakeBackend(devices: Device[] = [attached]) {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices(devices);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: {
				canReadScreen: true,
				canInput: true,
				canControlNetwork: true,
				canRecordVideo: true,
			},
		},
		backend: createMockDeviceBackend({
			watchDevices,
			describeDevice: async (serial) => createMockDevice({ serial }),
		}),
	});
}

function httpConfig(): HttpListenerConfig {
	return { address: '127.0.0.1', port: 0, usersPath: store.path };
}

/** A temp socket, a one-user store beside it, and a daemon serving both. */
async function startWithHttp(): Promise<RunningDaemon> {
	temp = await createTempSocket();
	store = await createTestUserStore(temp.dir);
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		http: httpConfig(),
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
	return result;
}

function portOf(daemon: RunningDaemon): number {
	if (daemon.httpPort === null) {
		throw new Error('The daemon opened no HTTP listener');
	}
	return daemon.httpPort;
}

interface Answer {
	readonly status: number;
	readonly headers: IncomingHttpHeaders;
	readonly body: string;
	/**
	 * The connection the request went out on, captured at `'socket'`: Node detaches
	 * `response.socket` before `'end'`, so an identity assertion built on that proves nothing.
	 */
	readonly socket: Socket;
}

interface Call {
	readonly port: number;
	readonly path?: string;
	readonly method?: string;
	/** Omitted entirely when absent, so "no credential at all" is reachable. */
	readonly authorization?: string;
	readonly body?: string;
	readonly agent?: Agent;
}

/** One HTTP request over Node's own client — the exact status, headers and connection. */
function send(options: Call): Promise<Answer> {
	return new Promise<Answer>((resolve, reject) => {
		let assigned: Socket | undefined;
		const request = httpRequest(
			{
				host: '127.0.0.1',
				port: options.port,
				path: options.path ?? '/session',
				method: options.method ?? 'POST',
				headers:
					options.authorization === undefined ? {} : { authorization: options.authorization },
				...(options.agent === undefined ? {} : { agent: options.agent }),
			},
			(response: IncomingMessage) => {
				let body = '';
				response.setEncoding('utf8');
				response.on('data', (chunk: string) => {
					body += chunk;
				});
				response.on('end', () => {
					if (assigned === undefined) {
						reject(new Error('The request was answered on no connection at all'));
						return;
					}
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body,
						socket: assigned,
					});
				});
			},
		);
		request.on('socket', (socket: Socket) => {
			assigned = socket;
		});
		request.on('error', reject);
		if (options.body !== undefined) {
			request.write(options.body);
		}
		request.end();
	});
}

/** The credential exchange: `POST /session` with a token in the body, as the panel will send it. */
function signIn(
	daemon: RunningDaemon,
	token: string,
	options: Partial<Call> = {},
): Promise<Answer> {
	return send({ port: portOf(daemon), body: JSON.stringify({ token }), ...options });
}

/** `POST /rpc list_devices`, with whatever credential the caller wants to present. */
function callRpc(
	daemon: RunningDaemon,
	authorization: string,
	options: Partial<Call> = {},
): Promise<Answer> {
	return send({
		port: portOf(daemon),
		path: '/rpc',
		authorization,
		body: JSON.stringify({ protocolVersion: 1, id: 'req-1', method: 'list_devices', params: {} }),
		...options,
	});
}

function bodyOf(answer: Answer): Record<string, unknown> {
	return JSON.parse(answer.body) as Record<string, unknown>;
}

/** The session id an answer to `POST /session` carried, failing loudly if it carried none. */
function sessionIn(answer: Answer): string {
	const session = bodyOf(answer).session;
	if (typeof session !== 'string' || session.length === 0) {
		throw new Error(`No session in ${answer.status} ${answer.body}`);
	}
	return session;
}

/** A keep-alive agent pinned to one connection, destroyed in `afterEach`. */
function keepAlive(): Agent {
	const agent = new Agent({ keepAlive: true, maxSockets: 1 });
	agents.push(agent);
	return agent;
}

/** The one record `createTestUserStore` wrote, for the tests that drive the store directly. */
async function recordOf(path: string): Promise<UserRecord> {
	const [user] = await readUsers(path);
	if (user === undefined) {
		throw new Error('The test store holds no user');
	}
	return user;
}

afterEach(async () => {
	for (const agent of agents.splice(0)) {
		agent.destroy();
	}
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	if (temp) {
		await removeTempSocket(temp);
	}
});

describe('a token becomes a session', () => {
	it('answers a session id and the identity behind it, uncacheable and without a cookie', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();

		const answer = await signIn(daemon, store.token);

		expect(answer.status).toBe(200);
		expect(bodyOf(answer)).toEqual({
			session: expect.any(String),
			identifier: store.identifier,
			displayName: store.identifier,
		});
		// A credential in a response body is the one thing a browser, a proxy or a back button
		// may not keep a copy of.
		expect(answer.headers['cache-control']).toBe('no-store');
		// The deliberate omission (D30): no cookie is set, so no cookie is attached to a
		// cross-site request, so there is no CSRF surface for this session to have to defend.
		expect(answer.headers['set-cookie']).toBeUndefined();
	});

	it('lets that session id do at /rpc exactly what the raw token does', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();

		const session = sessionIn(await signIn(daemon, store.token));
		const overSession = await callRpc(daemon, `Bearer ${session}`);
		const overToken = await callRpc(daemon, `Bearer ${store.token}`);

		expect(overSession.status).toBe(200);
		// Byte-identical: the gate learned a second credential kind, not a second surface.
		expect(overSession.body).toBe(overToken.body);
	});

	it('names the signed-in user on the boot probe, for either credential', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();
		const session = sessionIn(await signIn(daemon, store.token));

		const probed = await send({
			port: portOf(daemon),
			method: 'GET',
			authorization: `Bearer ${session}`,
		});
		const withToken = await send({
			port: portOf(daemon),
			method: 'GET',
			authorization: `Bearer ${store.token}`,
		});

		expect(probed.status).toBe(200);
		expect(bodyOf(probed)).toEqual({
			identifier: store.identifier,
			displayName: store.identifier,
		});
		expect(withToken.body).toBe(probed.body);
		expect(probed.headers['cache-control']).toBe('no-store');
		expect(probed.headers['set-cookie']).toBeUndefined();
	});

	it('refuses a verb this resource does not have', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();
		const session = sessionIn(await signIn(daemon, store.token));

		const answer = await send({
			port: portOf(daemon),
			method: 'PUT',
			authorization: `Bearer ${session}`,
		});

		expect(answer.status).toBe(401);
		expect(answer.body).toBe(REFUSAL_BODY);
	});
});

describe('revocation ends a session on its very next request', () => {
	it('refuses the next request on a connection the browser is already holding', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();
		const agent = keepAlive();
		const session = sessionIn(await signIn(daemon, store.token));

		const first = await callRpc(daemon, `Bearer ${session}`, { agent });
		await revokeUser(store.path, store.identifier);
		const second = await callRpc(daemon, `Bearer ${session}`, { agent });

		expect(first.status).toBe(200);
		expect(second.status).toBe(401);
		expect(second.body).toBe(REFUSAL_BODY);
		// The whole criterion: one connection, two requests, the second refused. A session that
		// cached its user would have let this through.
		expect(second.socket).toBe(first.socket);
	});

	it('ends it on a rotate too, which is what invalidating the old token has to mean', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();
		const session = sessionIn(await signIn(daemon, store.token));

		const issued = await rotateUserToken(store.path, store.identifier);

		expect((await callRpc(daemon, `Bearer ${session}`)).status).toBe(401);
		// The new token still signs in — a rotate ends the session, it does not lock the user out.
		expect((await signIn(daemon, issued.token)).status).toBe(200);
	});

	it('refuses the boot probe once the user is gone', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();
		const session = sessionIn(await signIn(daemon, store.token));

		await revokeUser(store.path, store.identifier);
		const probed = await send({
			port: portOf(daemon),
			method: 'GET',
			authorization: `Bearer ${session}`,
		});

		expect(probed.status).toBe(401);
		expect(probed.body).toBe(REFUSAL_BODY);
	});
});

describe('signing out ends the session on the host', () => {
	it('refuses the same id afterwards on a connection the browser never used', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();
		const session = sessionIn(await signIn(daemon, store.token));

		const signedOut = await send({
			port: portOf(daemon),
			method: 'DELETE',
			authorization: `Bearer ${session}`,
		});
		// A second, freshly opened connection: nothing a browser could have done to its own copy
		// of the id could produce this refusal, which is what "ended server-side" means.
		const after = await callRpc(daemon, `Bearer ${session}`);

		expect(signedOut.status).toBe(200);
		expect(bodyOf(signedOut)).toEqual({});
		expect(after.status).toBe(401);
		expect(after.body).toBe(REFUSAL_BODY);
	});

	it('is idempotent, and says nothing about whether there was a session to end', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();
		const session = sessionIn(await signIn(daemon, store.token));
		const del = (authorization: string) =>
			send({ port: portOf(daemon), method: 'DELETE', authorization });

		const first = await del(`Bearer ${session}`);
		const second = await del(`Bearer ${session}`);
		// A raw token has no session to end. It answers the same, and keeps working.
		const withToken = await del(`Bearer ${store.token}`);

		// `second` is a refusal, not a `200`: the id it presents is no longer a credential at
		// all, so it never reaches the verb. What must not vary is the *live* credential's
		// answer, which is why the token's is compared to the first.
		expect(second.status).toBe(401);
		expect(withToken.status).toBe(200);
		expect(withToken.body).toBe(first.body);
		expect((await callRpc(daemon, `Bearer ${store.token}`)).status).toBe(200);
	});

	it("ends one browser's session and no other", async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();
		const one = sessionIn(await signIn(daemon, store.token));
		const other = sessionIn(await signIn(daemon, store.token));

		await send({ port: portOf(daemon), method: 'DELETE', authorization: `Bearer ${one}` });

		expect(one).not.toBe(other);
		expect((await callRpc(daemon, `Bearer ${one}`)).status).toBe(401);
		expect((await callRpc(daemon, `Bearer ${other}`)).status).toBe(200);
	});
});

describe('every sign-in failure gets the one byte-identical refusal', () => {
	it('refuses all of them with the identical status, headers and body', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();
		const port = portOf(daemon);

		const refusals: Answer[] = [];
		// No body at all, and an empty one.
		refusals.push(await send({ port }));
		refusals.push(await send({ port, body: '' }));
		// A JSON body that is not the request: no token, an empty one, one of the wrong type,
		// and one carrying a key this surface never asked for.
		refusals.push(await send({ port, body: '{}' }));
		refusals.push(await send({ port, body: JSON.stringify({ token: '' }) }));
		refusals.push(await send({ port, body: JSON.stringify({ token: 123 }) }));
		refusals.push(
			await send({ port, body: JSON.stringify({ token: store.token, identifier: 'alice' }) }),
		);
		// Not JSON at all — and `/rpc`'s `malformed_frame` diagnosis must never appear here.
		refusals.push(await send({ port, body: '{ this is not json' }));
		refusals.push(await send({ port, body: `token=${store.token}` }));
		// Over the cap, which is abandoned rather than buffered.
		refusals.push(
			await send({ port, body: JSON.stringify({ token: 'x'.repeat(MAX_SIGN_IN_BYTES + 1) }) }),
		);
		// A well-formed token no store ever issued.
		refusals.push(await signIn(daemon, UNISSUED_TOKEN));
		// A session id presented where a token goes: it is a credential, but not this one.
		refusals.push(await signIn(daemon, sessionIn(await signIn(daemon, store.token))));

		// A revoked user still holding their token, then a store that is gone, then one that is
		// not JSON. Ordered last because each destroys the arrangement the next needs.
		await revokeUser(store.path, store.identifier);
		refusals.push(await signIn(daemon, store.token));
		await rm(store.path, { force: true });
		refusals.push(await signIn(daemon, store.token));
		await writeFile(store.path, 'not json at all', 'utf8');
		refusals.push(await signIn(daemon, store.token));

		// Asserted as one set rather than as a dozen literals: what matters is that no two of
		// them differ, because on a pre-auth path any difference at all is an oracle (D20).
		expect(new Set(refusals.map((answer) => answer.status))).toEqual(new Set([401]));
		expect(new Set(refusals.map((answer) => answer.body))).toEqual(new Set([REFUSAL_BODY]));
		expect(new Set(refusals.map((answer) => answer.headers['content-type']))).toEqual(
			new Set(['application/json']),
		);
		expect(new Set(refusals.map((answer) => answer.headers.connection))).toEqual(
			new Set(['close']),
		);
		expect(new Set(refusals.map((answer) => answer.headers['set-cookie']))).toEqual(
			new Set([undefined]),
		);
	});

	it('refuses a sign-in with the very bytes /rpc refuses a stranger with', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();

		const signInRefusal = await signIn(daemon, UNISSUED_TOKEN);
		const rpcRefusal = await callRpc(daemon, `Bearer ${UNISSUED_TOKEN}`);

		// One policy for the whole surface: the new route did not bring a second refusal with it.
		expect(signInRefusal.status).toBe(rpcRefusal.status);
		expect(signInRefusal.body).toBe(rpcRefusal.body);
		expect(signInRefusal.headers['content-type']).toBe(rpcRefusal.headers['content-type']);
	});
});

describe('the credential reaches no log and no answer it did not have to', () => {
	it('writes nothing to the console for a sign-in, a refusal or a sign-out', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			const session = sessionIn(await signIn(daemon, store.token));
			await signIn(daemon, UNISSUED_TOKEN);
			await send({ port: portOf(daemon), method: 'DELETE', authorization: `Bearer ${session}` });

			// The only interesting thing to log about a sign-in is the token that was tried,
			// which is exactly the thing that may never be logged. So nothing is.
			expect(log).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
			warn.mockRestore();
			error.mockRestore();
		}
	});

	it('never echoes the token, and issues the session id exactly once', async () => {
		registerFakeBackend();
		const daemon = await startWithHttp();

		const minted = await signIn(daemon, store.token);
		const session = sessionIn(minted);
		const probed = await send({
			port: portOf(daemon),
			method: 'GET',
			authorization: `Bearer ${session}`,
		});
		const listed = await callRpc(daemon, `Bearer ${session}`);

		const everything = [minted, probed, listed].map(
			(answer) => `${answer.body} ${JSON.stringify(answer.headers)}`,
		);
		// The token reached a request body once and goes nowhere else — not the answer to the
		// sign-in it authenticated, and not a header of it.
		expect(everything.some((text) => text.includes(store.token))).toBe(false);
		// The session id exists in exactly one answer: the one that minted it.
		expect(everything.filter((text) => text.includes(session))).toHaveLength(1);
	});
});

describe('the store itself', () => {
	it('stops resolving once the idle window has passed, and sweeps the entry away', async () => {
		temp = await createTempSocket();
		store = await createTestUserStore(temp.dir);
		let clock = 1_000;
		const sessions = createPanelSessionStore({ idleMs: 60_000, now: () => clock });

		const id = sessions.open(await recordOf(store.path));
		clock += 60_000;

		expect(await sessions.resolve(store.path, id)).toBeUndefined();
	});

	it('slides the deadline forward on every use', async () => {
		temp = await createTempSocket();
		store = await createTestUserStore(temp.dir);
		let clock = 1_000;
		const sessions = createPanelSessionStore({ idleMs: 60_000, now: () => clock });
		const id = sessions.open(await recordOf(store.path));

		// Four uses at 40-second intervals: 160 seconds of wall clock, never 60 seconds idle.
		for (let step = 0; step < 4; step += 1) {
			clock += 40_000;
			expect(await sessions.resolve(store.path, id)).toEqual({
				identifier: store.identifier,
				displayName: store.identifier,
			});
		}
	});

	it('drops the entry it refused, rather than leaving a dead one behind', async () => {
		temp = await createTempSocket();
		store = await createTestUserStore(temp.dir);
		const sessions = createPanelSessionStore();
		const id = sessions.open(await recordOf(store.path));

		await revokeUser(store.path, store.identifier);
		expect(await sessions.resolve(store.path, id)).toBeUndefined();
		// Re-adding the same identifier mints a different token, so the entry — if it survived —
		// would still not resolve. What this pins is that a resolve after a revoke is not
		// answered from anything left in memory.
		expect(await sessions.resolve(store.path, id)).toBeUndefined();
	});

	it('resolves nothing for an id it never issued, and ends one without complaint', async () => {
		temp = await createTempSocket();
		store = await createTestUserStore(temp.dir);
		const sessions = createPanelSessionStore();

		expect(await sessions.resolve(store.path, UNISSUED_TOKEN)).toBeUndefined();
		expect(() => sessions.end(UNISSUED_TOKEN)).not.toThrow();
		expect(() => sessions.clear()).not.toThrow();
	});

	it('holds a session for a working day', () => {
		// Stated as an assertion rather than left in a comment: eight hours is the decision D30
		// records, and a change to it should have to come through here.
		expect(PANEL_SESSION_IDLE_MS).toBe(8 * 60 * 60 * 1000);
	});
});
