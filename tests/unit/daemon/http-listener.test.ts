/**
 * R32's host half end to end: a real HTTP listener beside the real unix socket, serving the
 * **same** `IpcServer`, with a token gate in front of it that resolves every presented token
 * against a real `users.json` on **every request**.
 *
 * The daemon suite's real-socket exception applies and extends once more (ai/TESTING.md). A gate
 * that authenticates per request cannot be asserted against a mock any more than a gate that
 * authenticates per connection can: the criterion is that `rover users revoke` bites on the very
 * next request over a connection the revoked user is *already holding*, and only a real
 * keep-alive connection can be held. So the store is a real file in a per-test `mkdtemp`
 * directory — never `~/.rover/users.json` — the listener binds `127.0.0.1:0`, the certificate for
 * the TLS case is real, and the client is `node:http`'s own `request` rather than a Rover client,
 * because a browser is not a Rover client and there is nothing here for one to prove.
 *
 * Nothing here ever binds a fixed public address, and every daemon is closed through its own
 * handle in `afterEach`.
 */

import { rm, writeFile } from 'node:fs/promises';
import {
	Agent,
	request as httpRequest,
	type IncomingHttpHeaders,
	type IncomingMessage,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
	createServer as createNetServer,
	connect as netConnect,
	type Server,
	type Socket,
} from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import type { ArchiveFileReader } from '@/daemon/archive-file.js';
import { connectToLocalDaemon } from '@/daemon/connect.js';
import { KEEP_ALIVE_TIMEOUT_MS, startHttpListener } from '@/daemon/http-listen.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import {
	HTTP_ADDRESS_ENV_VAR,
	HTTP_PORT_ENV_VAR,
	type HttpListenerConfig,
	TLS_CERT_ENV_VAR,
	TLS_KEY_ENV_VAR,
} from '@/daemon/network-config.js';
import { revokeUser, rotateUserToken } from '@/daemon/user-store.js';
import type { IpcClient } from '@/ipc/client.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	stopDaemonAt,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';
import {
	createTestCertificate,
	removeTestCertificate,
	type TestCertificate,
	UNISSUED_TOKEN,
} from '../../helpers/tls-fixtures.js';
import { createTestUserStore, type TestUserStore } from '../../helpers/user-store.js';

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });
const second = createMockDevice({ serial: parseDeviceSerial('attached-2') });

/**
 * The one refusal body, spelled out here rather than imported: a copy is what makes it a
 * contract. It is the TCP gate's `REFUSAL` frame (`network-listener.test.ts`) **without the
 * trailing newline**, which is the cross-transport identity this suite exists to pin.
 */
const REFUSAL_BODY = JSON.stringify({
	type: 'error',
	protocolVersion: 1,
	id: null,
	error: { code: 'unauthenticated', message: 'Authentication failed.' },
});

/**
 * `POLL_MS` from `panel/src/devices/device-list-provider.tsx`, restated rather than imported: the
 * panel is a separate tree and `@panel` must never mean two of them (`vitest.config.ts`). What
 * keeps the two copies honest is `tests/unit/panel/poll-outlives-keep-alive.test.ts`, which reads
 * the panel's own source.
 */
const PANEL_POLL_MS = 5_000;

/** Short enough that the pre-auth deadline lands inside a test, long enough not to race it. */
const SHORT_AUTH_TIMEOUT_MS = 250;

/** The cap `http-listen.ts` puts on a request body, restated so the assertion can exceed it. */
const MAX_PANEL_REQUEST_BYTES = 64 * 1024;

/**
 * Generated once for the file rather than per test: a 2048-bit key costs a few hundred
 * milliseconds, nothing here mutates it, and it is removed in `afterAll` either way.
 */
let certificate: TestCertificate;
let temp: TempSocket;
/** The store the gate authenticates against, created per test so a revoke cannot reach another. */
let store: TestUserStore;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
const agents: Agent[] = [];
const occupied: Server[] = [];

beforeAll(async () => {
	certificate = await createTestCertificate();
});

afterAll(async () => {
	await removeTestCertificate(certificate);
});

function registerFakeBackend(devices: Device[] = [attached, second]) {
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

/**
 * The same fake backend, with its watcher kept so a test can deliver a **second** device set — an
 * attach or a detach after the daemon is already up, which is what #125 is about.
 */
function registerWatchedBackend(devices: Device[] = [attached, second]): {
	deliver: (next: Device[]) => void;
} {
	let watching: DeviceWatcher | undefined;
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watching = watcher;
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
	return {
		deliver: (next: Device[]) => {
			if (watching === undefined) {
				throw new Error('Nothing is watching this backend yet');
			}
			watching.onDevices(next);
		},
	};
}

function httpConfig(overrides: Partial<HttpListenerConfig> = {}): HttpListenerConfig {
	return {
		address: '127.0.0.1',
		// Port 0 and never a fixed one: the kernel picks, `RunningDaemon.httpPort` says which,
		// and two suites running at once cannot collide.
		port: 0,
		usersPath: store.path,
		...overrides,
	};
}

/** A temp socket **and** a one-user store beside it, which every test here needs. */
async function withStore(): Promise<void> {
	temp = await createTempSocket();
	store = await createTestUserStore(temp.dir);
}

/** A daemon on the temp socket, with the HTTP listener up beside it. */
async function startWithHttp(overrides: Partial<HttpListenerConfig> = {}): Promise<RunningDaemon> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		http: httpConfig(overrides),
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

async function overSocket(): Promise<IpcClient> {
	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
}

interface Answer {
	readonly status: number;
	readonly headers: IncomingHttpHeaders;
	readonly body: string;
	/**
	 * The connection the request was sent on, captured at `'socket'` rather than off the
	 * response: Node detaches `response.socket` before `'end'` fires, so reading it there is
	 * `null` and an identity assertion built on it proves nothing.
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
	/** The fixture certificate to trust, which also selects the HTTPS client. */
	readonly ca?: string;
}

/**
 * One HTTP request, over Node's own client rather than over `fetch`.
 *
 * Deliberately the low-level one: this suite has to see the exact status, the exact headers and
 * the exact connection a response came back on, and it has to be able to send a request with no
 * `Authorization` header, an oversize body and a request line `fetch` would refuse to construct.
 */
function send(options: Call): Promise<Answer> {
	return new Promise<Answer>((resolve, reject) => {
		const requestOptions = {
			host: '127.0.0.1',
			port: options.port,
			path: options.path ?? '/rpc',
			method: options.method ?? 'POST',
			headers: options.authorization === undefined ? {} : { authorization: options.authorization },
			...(options.agent === undefined ? {} : { agent: options.agent }),
			...(options.ca === undefined ? {} : { ca: options.ca }),
		};
		let assigned: Socket | undefined;
		const request = (options.ca === undefined ? httpRequest : httpsRequest)(
			requestOptions,
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

/** The panel's own call: a request envelope on `POST /rpc`, with a bearer token. */
function call(
	daemon: RunningDaemon,
	method: string,
	params: unknown = {},
	options: Partial<Call> & { readonly id?: string } = {},
): Promise<Answer> {
	const { id = 'req-1', ...rest } = options;
	return send({
		port: portOf(daemon),
		authorization: `Bearer ${store.token}`,
		body: JSON.stringify({ protocolVersion: 1, id, method, params }),
		...rest,
	});
}

/** The parsed envelope of an answer, which is where every outcome on this surface lives. */
function envelopeOf(answer: Answer): Record<string, unknown> {
	return JSON.parse(answer.body) as Record<string, unknown>;
}

/**
 * An archive reader for the two standalone listeners below, neither of which reaches the byte
 * route: one asserts the pre-auth deadline and the other counts frames on `/rpc`. It answers
 * `missing` so that a request which somehow did reach it would fail loudly as a `404` rather than
 * as a thrown `undefined`.
 */
function noArchiveFiles(): ArchiveFileReader {
	return { open: async () => ({ outcome: 'missing' }) };
}

/** A keep-alive agent pinned to one connection, released in `afterEach`. */
function keepAlive(): Agent {
	const agent = new Agent({ keepAlive: true, maxSockets: 1 });
	agents.push(agent);
	return agent;
}

/** A port nothing is on, by binding one and letting it go again. */
async function freePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** Hold a port so a bind against it fails, released in `afterEach`. */
async function occupy(port: number): Promise<void> {
	const server = createNetServer();
	await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
	occupied.push(server);
}

/** Whether a plain TCP connection to `port` is refused — i.e. nothing is listening there. */
function nothingListensOn(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = netConnect({ port, host: '127.0.0.1' });
		socket.once('connect', () => {
			socket.destroy();
			resolve(false);
		});
		socket.once('error', () => {
			socket.destroy();
			resolve(true);
		});
	});
}

/** Every byte a raw peer received before the host closed on it. */
function rawExchange(port: number, write: string): Promise<string> {
	return new Promise((resolve) => {
		const socket = netConnect({ port, host: '127.0.0.1' }, () => {
			if (write.length > 0) {
				socket.write(write);
			}
		});
		let received = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			received += chunk;
		});
		// Swallowed, not rejected: the host drops these peers, so an `ECONNRESET` here is the
		// deadline working rather than the test failing. `'close'` follows either way.
		socket.on('error', () => {});
		socket.on('close', () => resolve(received));
	});
}

/** `work`, or a rejection naming `what` once `limitMs` has passed. */
async function withinDeadline<T>(work: Promise<T>, limitMs: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} after ${limitMs}ms`)), limitMs);
	});
	try {
		return await Promise.race([work, expiry]);
	} finally {
		clearTimeout(timer);
	}
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	for (const agent of agents.splice(0)) {
		agent.destroy();
	}
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	await Promise.all(
		occupied
			.splice(0)
			.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
	_resetDeviceBackendRegistryForTesting();
	if (temp) {
		await removeTempSocket(temp);
	}
});

describe('one surface, a third transport', () => {
	it('answers list_devices with the very bytes the unix socket answers', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const overHttp = envelopeOf(await call(daemon, 'list_devices'));
		const overUnix = await (await overSocket()).request('list_devices', {});

		// One `IpcServer`, one method table, one set of schemas. A second implementation would
		// have to agree with this by hand; there is nothing here to agree with.
		expect(overHttp).toEqual({ type: 'result', protocolVersion: 1, id: 'req-1', result: overUnix });
		expect(overUnix).toEqual({
			devices: [
				{ ...attached, heldBy: null },
				{ ...second, heldBy: null },
			],
			stale: false,
		});
	});

	it('dispatches force_release_device, and answers the very bytes the unix socket answers', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();
		const socket = await overSocket();

		// A lease taken the way a real one is taken — by a client that is not a browser — because
		// the point of this method on this transport is ending somebody else's (D28).
		await expect(
			socket.request('acquire_device', {
				serial: attached.serial,
				owner: 'issue-113',
				project: 'rover',
				testName: 'checkout flow',
			}),
		).resolves.toMatchObject({ outcome: 'granted' });

		const released = envelopeOf(
			await call(daemon, 'force_release_device', {
				serial: attached.serial,
				actor: 'karolina',
			}),
		);

		expect(released).toMatchObject({
			type: 'result',
			protocolVersion: 1,
			id: 'req-1',
			result: { outcome: 'released', heldBy: { owner: 'issue-113', project: 'rover' } },
		});
		// The lease really ended, and the transport it ended over left no trace on the answer any
		// other client reads.
		const listed = await socket.request('list_devices', {});
		expect(listed.devices.map((device) => device.heldBy)).toEqual([null, null]);
		// Never the holder's credential, whatever the transport (D20) — the browser is the one
		// caller that could put it straight into a page.
		expect(released.result).not.toHaveProperty('lease');
		expect(JSON.stringify(released)).not.toContain('leaseId');

		// And the refusal for a device nobody holds is the same answer on both transports, field
		// for field: one `IpcServer`, one set of schemas, asked twice.
		const refusedOverHttp = envelopeOf(
			await call(daemon, 'force_release_device', {
				serial: attached.serial,
				actor: 'karolina',
			}),
		);
		const refusedOverUnix = await socket.request('force_release_device', {
			serial: attached.serial,
			actor: 'karolina',
		});

		expect(refusedOverHttp).toEqual({
			type: 'result',
			protocolVersion: 1,
			id: 'req-1',
			result: refusedOverUnix,
		});
		expect(refusedOverUnix).toMatchObject({ outcome: 'refused', reason: 'not-held' });
	});

	it('answers with the existing error vocabulary rather than with a status code', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answer = await call(daemon, 'list_devices', { unknown: true });

		// `200`, and the envelope says how it went — the panel reads the vocabulary it already
		// has instead of a second one in the status line.
		expect(answer.status).toBe(200);
		expect(envelopeOf(answer)).toMatchObject({
			type: 'error',
			id: 'req-1',
			error: { code: 'invalid_params' },
		});
	});

	it('reports an unsupported protocol version as itself', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answer = await send({
			port: portOf(daemon),
			authorization: `Bearer ${store.token}`,
			body: JSON.stringify({ protocolVersion: 99, id: 'req-1', method: 'list_devices' }),
		});

		expect(envelopeOf(answer)).toMatchObject({
			error: { code: 'unsupported_protocol_version' },
		});
	});
});

describe('only the panel’s methods are reachable, and no table gained a row', () => {
	it.each([
		['acquire_device'],
		['tap'],
		['release_device'],
		['status'],
	])('refuses %s before dispatch, with the closed vocabulary', async (method) => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answer = await call(daemon, method, {
			serial: attached.serial,
			owner: 'a-browser-tab',
		});

		expect(answer.status).toBe(200);
		expect(envelopeOf(answer)).toMatchObject({
			type: 'error',
			id: 'req-1',
			error: { code: 'unknown_method' },
		});
	});

	it('reaches list_archive, the archive\u2019s own read side', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answer = await call(daemon, 'list_archive', { path: [] });

		// On the allowlist since #130, so a browser can walk the archive one level at a time
		// (D24). Nothing archived on this host yet, which is `missing` and not a refusal.
		expect(envelopeOf(answer)).toMatchObject({
			type: 'result',
			id: 'req-1',
			result: { outcome: 'missing' },
		});
	});

	it('reaches search_archive, the archive\u2019s search', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answer = await call(daemon, 'search_archive', { text: 'checkout' });

		// On the allowlist since #144, because the operator's browser is the surface a search of
		// the archive is *for* (R38, D27) — and the one place it is safe, an agent's copy of it
		// being every other agent's run names in one call. Nothing archived on this host yet,
		// which is `missing` and not a refusal.
		expect(envelopeOf(answer)).toMatchObject({
			type: 'result',
			id: 'req-1',
			result: { outcome: 'missing' },
		});
	});

	it('reaches list_projects, what this host has registered', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answer = await call(daemon, 'list_projects', {});

		// On the allowlist since #152, because the panel's *Projects* screen is the surface D31's
		// read side is *for* — and it is a read alone: nothing on this transport writes a hook
		// file. Nothing pre-creates `temp.projectsRoot`, so `missing` and not a refusal is what
		// proves it reached the handler.
		expect(envelopeOf(answer)).toMatchObject({
			type: 'result',
			id: 'req-1',
			result: { outcome: 'missing' },
		});
	});

	it('runs nothing it refused — the device is still free over the socket', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		await call(daemon, 'acquire_device', {
			serial: attached.serial,
			owner: 'a-browser-tab',
			project: 'panel',
			testName: 'checkout flow',
		});

		// The allowlist is transport policy, not table surgery: nothing ran here, and the same
		// call over the unix socket still works exactly as it did.
		const listed = await (await overSocket()).request('list_devices', {});
		expect(listed.devices.map((device) => device.heldBy)).toEqual([null, null]);
		await expect(
			(await overSocket()).request('acquire_device', {
				serial: attached.serial,
				owner: 'a-real-client',
				project: 'panel',
				testName: 'checkout flow',
			}),
		).resolves.toMatchObject({ outcome: 'granted' });
	});

	it('cannot be smuggled past with a second envelope on a second line', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		// The allowlist's other half: the whole body is not valid JSON, so nothing may hand it to
		// a decoder that would split it on the newline and dispatch **both** envelopes — the
		// allowed one and, behind it, the one that takes the phone.
		const answer = await send({
			port: portOf(daemon),
			authorization: `Bearer ${store.token}`,
			body: `${JSON.stringify({
				protocolVersion: 1,
				id: 'req-1',
				method: 'list_devices',
				params: {},
			})}\n${JSON.stringify({
				protocolVersion: 1,
				id: 'req-2',
				method: 'acquire_device',
				params: { serial: attached.serial, owner: 'a-browser-tab', project: 'panel' },
			})}`,
		});

		expect(answer.status).toBe(200);
		expect(envelopeOf(answer)).toMatchObject({
			type: 'error',
			id: null,
			error: { code: 'malformed_frame' },
		});
		const listed = await (await overSocket()).request('list_devices', {});
		expect(listed.devices.map((device) => device.heldBy)).toEqual([null, null]);
	});

	it('runs nothing for an envelope with a garbage line after it, refusal or not', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		// The same hole in its cheapest form: one trailing junk line is enough to make the body
		// unparseable, and the answer a peer reads then says `malformed_frame` — so an acquire
		// that ran anyway would have run *invisibly*.
		const answer = await send({
			port: portOf(daemon),
			authorization: `Bearer ${store.token}`,
			body: `${JSON.stringify({
				protocolVersion: 1,
				id: 'req-1',
				method: 'acquire_device',
				params: { serial: attached.serial, owner: 'a-browser-tab', project: 'panel' },
			})}\nx`,
		});

		expect(envelopeOf(answer)).toMatchObject({ error: { code: 'malformed_frame' } });
		expect(answer.body).not.toContain('leaseId');
		const listed = await (await overSocket()).request('list_devices', {});
		expect(listed.devices.map((device) => device.heldBy)).toEqual([null, null]);
	});

	it('answers a name that is on no table with the same shape', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const unknown = envelopeOf(await call(daemon, 'not_a_method_at_all'));
		const disallowed = envelopeOf(await call(daemon, 'tap'));

		expect(unknown).toMatchObject({ error: { code: 'unknown_method' } });
		expect(disallowed).toMatchObject({ error: { code: 'unknown_method' } });
	});
});

describe('the panel’s poll gets a live answer, on a connection it is already holding', () => {
	/*
	 * #125's host half. The panel polls `list_devices` every `POLL_MS` = 5 000 ms over one
	 * keep-alive connection, and Node's **default** `server.keepAliveTimeout` is 5 000 ms — the
	 * same number — so every poll went out on a socket this listener was within its own response
	 * time of closing. The loser of that race is an answer the panel never receives, and an answer
	 * the panel never receives used to freeze the grid for the life of the tab.
	 *
	 * The advertised window is the assertion because it is what a client actually reads: Node puts
	 * `keepAliveTimeout` on the wire as `Keep-Alive: timeout=<seconds>`, so this pins the number the
	 * browser and the dev proxy are told, not merely the property that was set.
	 */
	it('advertises an idle window far longer than the panel’s poll interval', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answered = await call(daemon, 'list_devices');

		expect(answered.headers.connection).toBe('keep-alive');
		expect(answered.headers['keep-alive']).toBe(`timeout=${KEEP_ALIVE_TIMEOUT_MS / 1_000}`);
		expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(PANEL_POLL_MS * 2);
	});

	/*
	 * And the answer itself follows the host, over the very connection the browser is already
	 * holding — a detach delivered between two polls is gone from the second one. The unix socket
	 * is asked at the same moment because two transports may never disagree about one device
	 * (#123): they read one `DeviceInventory` through one `IpcServer`, and this is what keeps that
	 * structural rather than assumed.
	 */
	it('answers the current inventory on the next poll, and the socket agrees', async () => {
		const watched = registerWatchedBackend();
		await withStore();
		const daemon = await startWithHttp();
		const agent = keepAlive();

		const before = envelopeOf(await call(daemon, 'list_devices', {}, { agent }));
		watched.deliver([attached]);
		const after = await call(daemon, 'list_devices', {}, { agent });
		const overUnix = await (await overSocket()).request('list_devices', {});

		expect(JSON.stringify(before.result)).toContain('attached-2');
		expect(after.body).not.toContain('attached-2');
		expect(envelopeOf(after).result).toEqual({
			devices: [{ ...attached, heldBy: null }],
			stale: false,
		});
		// One connection, two polls, the second current — the browser never reconnected to get it.
		expect(after.socket).toBe((await call(daemon, 'list_devices', {}, { agent })).socket);
		expect(envelopeOf(after).result).toEqual(overUnix);
	});
});

describe('the store is read per request, never per connection', () => {
	it('lets a revoke bite on the very next request over a connection already open', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();
		const agent = keepAlive();

		const first = await call(daemon, 'list_devices', {}, { agent });
		await revokeUser(store.path, store.identifier);
		const second = await call(daemon, 'list_devices', {}, { agent });

		expect(first.status).toBe(200);
		expect(second.status).toBe(401);
		expect(second.body).toBe(REFUSAL_BODY);
		// The whole criterion: one connection, two requests, the second refused. A gate that
		// authenticated the connection would have let this through.
		expect(second.socket).toBe(first.socket);
	});

	it('invalidates the old token on a rotate and admits the new one immediately', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();
		const stale = store.token;

		const issued = await rotateUserToken(store.path, store.identifier);

		expect(
			(await call(daemon, 'list_devices', {}, { authorization: `Bearer ${stale}` })).status,
		).toBe(401);
		expect(
			(await call(daemon, 'list_devices', {}, { authorization: `Bearer ${issued.token}` })).status,
		).toBe(200);
	});
});

/**
 * The byte route's gate, pinned where the gate is pinned rather than in
 * `artifact-route.test.ts`: the criterion is that `/artifact/…` is authenticated *exactly as the
 * rest of the surface is*, and that is a property of this suite's subject. What the route answers
 * once a caller is through it belongs in the other file.
 */
describe('the byte route is behind the same gate as everything else (R37)', () => {
	/** A path whose components are shaped like a listing's, pointing at nothing. */
	const ARTIFACT_PATH = '/artifact/rover/home-screen/nothing.png';

	it('refuses a request with no credential, and one with a token nobody holds', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const anonymous = await send({ port: portOf(daemon), path: ARTIFACT_PATH, method: 'GET' });
		const stranger = await send({
			port: portOf(daemon),
			path: ARTIFACT_PATH,
			method: 'GET',
			authorization: `Bearer ${UNISSUED_TOKEN}`,
		});

		for (const refused of [anonymous, stranger]) {
			expect(refused.status).toBe(401);
			// Byte-identical to every other refusal: a `404` here would tell a stranger the route
			// exists, and a different body would tell them why they were refused.
			expect(refused.body).toBe(REFUSAL_BODY);
		}
	});

	it('lets a revoke bite on the very next request over a connection already open', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();
		const agent = keepAlive();
		const get = () =>
			send({
				port: portOf(daemon),
				path: ARTIFACT_PATH,
				method: 'GET',
				authorization: `Bearer ${store.token}`,
				agent,
			});

		// Through the gate: nothing is filed at that path, which is the route's own `404` and not
		// the gate's refusal. That distinction is the whole point of the assertion below it.
		const first = await get();
		await revokeUser(store.path, store.identifier);
		const second = await get();

		expect(first.status).toBe(404);
		expect(second.status).toBe(401);
		expect(second.body).toBe(REFUSAL_BODY);
		expect(second.socket).toBe(first.socket);
	});

	it('takes a session id exactly as it takes a raw token (D30)', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const signedIn = await send({
			port: portOf(daemon),
			path: '/session',
			method: 'POST',
			body: JSON.stringify({ token: store.token }),
		});
		const session = (JSON.parse(signedIn.body) as { session: string }).session;

		expect(
			(
				await send({
					port: portOf(daemon),
					path: ARTIFACT_PATH,
					method: 'GET',
					authorization: `Bearer ${session}`,
				})
			).status,
		).toBe(404);
	});

	it('refuses every method the route does not take, as an unrouted request', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		for (const method of ['POST', 'DELETE', 'PUT']) {
			const answer = await send({
				port: portOf(daemon),
				path: ARTIFACT_PATH,
				method,
				authorization: `Bearer ${store.token}`,
			});
			expect(answer.status).toBe(401);
			expect(answer.body).toBe(REFUSAL_BODY);
		}
	});
});

describe('every pre-auth failure gets one byte-identical refusal', () => {
	it('refuses all of them with the identical status, headers and body', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();
		const port = portOf(daemon);
		const envelope = JSON.stringify({
			protocolVersion: 1,
			id: 'req-1',
			method: 'list_devices',
			params: {},
		});

		const refusals: Answer[] = [];
		// No credential at all.
		refusals.push(await send({ port, body: envelope }));
		// A `Bearer` with nothing after it, and one with only whitespace.
		refusals.push(await send({ port, authorization: 'Bearer', body: envelope }));
		refusals.push(await send({ port, authorization: 'Bearer   ', body: envelope }));
		// A scheme this host does not speak.
		refusals.push(await send({ port, authorization: 'Basic YWxpY2U6cw==', body: envelope }));
		// A well-formed token no store ever issued.
		refusals.push(await send({ port, authorization: `Bearer ${UNISSUED_TOKEN}`, body: envelope }));
		// A path that does not exist, and the right path with the wrong method — both refused
		// before routing, so a stranger cannot learn which paths exist.
		refusals.push(await send({ port, path: '/', body: envelope }));
		refusals.push(await send({ port, path: '/panel/index.html', body: envelope }));
		refusals.push(await send({ port, method: 'GET' }));
		// A token in the query string, with no header: there is no credential path through a URL.
		refusals.push(await send({ port, path: `/rpc?token=${store.token}`, body: envelope }));

		// A revoked user, then a store this host cannot read, then one that is not JSON. Ordered
		// last because each destroys the arrangement the next needs.
		await revokeUser(store.path, store.identifier);
		refusals.push(await call(daemon, 'list_devices'));
		await rm(store.path, { force: true });
		refusals.push(await call(daemon, 'list_devices'));
		await writeFile(store.path, 'not json at all', 'utf8');
		refusals.push(await call(daemon, 'list_devices'));

		// Asserted as one set rather than as a dozen literals: what matters is that no two of
		// them differ, because any difference at all is an oracle (D20).
		expect(new Set(refusals.map((answer) => answer.status))).toEqual(new Set([401]));
		expect(new Set(refusals.map((answer) => answer.body))).toEqual(new Set([REFUSAL_BODY]));
		expect(new Set(refusals.map((answer) => answer.headers['content-type']))).toEqual(
			new Set(['application/json']),
		);
		expect(new Set(refusals.map((answer) => answer.headers.connection))).toEqual(
			new Set(['close']),
		);
	});

	it('refuses with the bytes the TLS gate writes, minus its newline', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const refusal = await send({ port: portOf(daemon), authorization: 'Bearer nope' });

		// One policy, two transports: `UNAUTHENTICATED_REFUSAL` is the single source of both, so
		// this cannot drift without the network listener drifting with it.
		expect(refusal.body).toBe(REFUSAL_BODY);
		expect(`${refusal.body}\n`).toBe(`${REFUSAL_BODY}\n`);
	});

	it('answers a malformed HTTP request with nothing at all', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		// Node's own default here is `400 Bad Request`, which would be a pre-auth answer that
		// varies with the reason — an oracle, and one nothing in this suite could have caught
		// except by asking for it.
		expect(await rawExchange(portOf(daemon), 'not an http request at all\r\n\r\n')).toBe('');
	});

	it.each([
		['an Expect header it does not understand', 'Expect: foo'],
		['an Expect: 100-continue it will not negotiate', 'Expect: 100-continue'],
	])('answers %s with nothing at all', async (_what, header) => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		// Node answers an `Expect:` itself when nothing listens for it — `417 Expectation Failed`
		// for an unknown one, a bare `100 Continue` for this one — both before the gate and both
		// varying with what was sent, which is two more statuses than this surface has.
		expect(
			await rawExchange(
				portOf(daemon),
				`POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\n${header}\r\nContent-Length: 0\r\n\r\n`,
			),
		).toBe('');
	});

	it('drops a peer that opens a connection and sends no headers, with no 408', async () => {
		await withStore();
		// A standalone listener so the deadline is a quarter of a second rather than the five the
		// daemon runs with. Nothing behind the gate is ever reached, which is the point.
		const listener = await startHttpListener(
			httpConfig(),
			{ handleConnection: () => {} },
			noArchiveFiles(),
			{ authTimeoutMs: SHORT_AUTH_TIMEOUT_MS },
		);

		try {
			expect(
				await withinDeadline(
					rawExchange(listener.port, ''),
					5_000,
					'The silent peer was still connected',
				),
			).toBe('');
		} finally {
			await listener.close();
		}
	});
});

describe('the token never reaches a body, a header or a log (D20)', () => {
	it('writes nothing to the console for an answer or for a refusal', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			await call(daemon, 'list_devices');
			await send({ port: portOf(daemon), authorization: `Bearer ${UNISSUED_TOKEN}` });

			// The only interesting thing to log about an attempt is the token that was tried,
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

	it('echoes no token back, on the answer or on the refusal', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answered = await call(daemon, 'list_devices');
		const refused = await send({
			port: portOf(daemon),
			authorization: `Bearer ${UNISSUED_TOKEN}`,
			body: JSON.stringify({ protocolVersion: 1, id: 'req-1', method: 'list_devices' }),
		});

		for (const answer of [answered, refused]) {
			const rendered = `${answer.body}${JSON.stringify(answer.headers)}`;
			expect(rendered).not.toContain(store.token);
			expect(rendered).not.toContain(UNISSUED_TOKEN);
		}
	});
});

describe('the body is bounded, and the server owns its own diagnosis', () => {
	it('refuses an oversize body naming the limit, without buffering the rest', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answer = await call(daemon, 'list_devices', {
			padding: 'x'.repeat(MAX_PANEL_REQUEST_BYTES + 1),
		});

		expect(answer.status).toBe(200);
		expect(envelopeOf(answer)).toMatchObject({
			type: 'error',
			id: null,
			error: { code: 'malformed_frame', message: expect.stringContaining('65536') },
		});
	});

	it('lets the IPC server answer a body that is not JSON', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answer = await send({
			port: portOf(daemon),
			authorization: `Bearer ${store.token}`,
			body: '{ this is not json',
		});

		// `id: null`, and the message is the server's own — this transport does not duplicate a
		// diagnosis that already has exactly one source.
		expect(envelopeOf(answer)).toMatchObject({ type: 'error', id: null });
		expect(envelopeOf(answer).error).toMatchObject({ code: 'malformed_frame' });
	});

	it('answers an empty body rather than waiting for a frame that will never come', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answer = await withinDeadline(
			send({ port: portOf(daemon), authorization: `Bearer ${store.token}` }),
			5_000,
			'The empty body was still unanswered',
		);

		expect(envelopeOf(answer)).toMatchObject({ error: { code: 'malformed_frame' } });
	});

	it('hands the server at most one frame, whatever the body is', async () => {
		await withStore();
		const envelope = (id: string, method: string) =>
			JSON.stringify({ protocolVersion: 1, id, method, params: {} });
		const frames: string[] = [];
		// A counting `IpcServer` rather than the real one: the property is about how many messages
		// one HTTP request can become, which is invisible from the outside when the extra ones are
		// answered on the same connection.
		const listener = await startHttpListener(
			httpConfig(),
			{
				handleConnection: (stream) => {
					stream.on('data', (chunk: Buffer | string) => {
						for (const frame of String(chunk).split('\n')) {
							if (frame.trim().length > 0) {
								frames.push(frame);
							}
						}
						stream.write(`${JSON.stringify({ type: 'result', protocolVersion: 1, id: null })}\n`);
					});
				},
			},
			noArchiveFiles(),
		);

		try {
			const bodies = [
				envelope('req-1', 'list_devices'),
				`${envelope('req-1', 'list_devices')}\n${envelope('req-2', 'list_devices')}`,
				`${envelope('req-1', 'list_devices')}\nx`,
				'{ not json\nnot json either',
				'\n\n',
			];
			for (const body of bodies) {
				frames.length = 0;
				await withinDeadline(
					send({
						port: listener.port,
						authorization: `Bearer ${store.token}`,
						body,
					}),
					5_000,
					'One request was never answered',
				);
				expect(frames.length).toBeLessThanOrEqual(1);
			}
		} finally {
			await listener.close();
		}
	});

	it('carries a pretty-printed body through as one frame', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();

		const answer = await send({
			port: portOf(daemon),
			authorization: `Bearer ${store.token}`,
			// The newlines matter: NDJSON framing would split this into four frames, three of
			// them malformed, if the body were passed through untouched.
			body: JSON.stringify(
				{ protocolVersion: 1, id: 'req-1', method: 'list_devices', params: {} },
				null,
				2,
			),
		});

		expect(envelopeOf(answer)).toMatchObject({ type: 'result', id: 'req-1' });
	});
});

describe('the listener is opt-in and dies with the daemon', () => {
	it('binds nothing when no HTTP configuration was passed, whatever the environment says', async () => {
		registerFakeBackend();
		await withStore();
		const port = await freePort();
		vi.stubEnv(HTTP_PORT_ENV_VAR, String(port));
		vi.stubEnv(HTTP_ADDRESS_ENV_VAR, '127.0.0.1');

		const daemon = await startDaemon({
			socketPath: temp.socketPath,
			artifactsRoot: temp.artifactsRoot,
			projectsRoot: temp.projectsRoot,
		});
		if (!daemon.started) {
			throw new Error('Another daemon holds the temp socket — the test cannot proceed');
		}
		running.push(daemon);

		// `startDaemon` never reads the environment: a unit test must not open a port because
		// the developer happened to export `ROVER_HTTP_PORT` in that shell.
		expect(daemon.httpPort).toBeNull();
		expect(await nothingListensOn(port)).toBe(true);
	});

	it('stops answering once the daemon is closed, and closes twice safely', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp();
		const port = portOf(daemon);
		const agent = keepAlive();

		// A live keep-alive connection held open at `close()` time: untracked, it would keep the
		// server's connection count above zero and `close()` would never resolve.
		expect((await call(daemon, 'list_devices', {}, { agent })).status).toBe(200);

		await withinDeadline(
			Promise.all(running.splice(0).map((instance) => instance.close())),
			10_000,
			'The daemon was still closing',
		);
		await withinDeadline(daemon.close(), 10_000, 'The second close was still pending');

		expect(await nothingListensOn(port)).toBe(true);
	});

	it('fails the whole start when the HTTP bind fails, leaving the socket unserved', async () => {
		registerFakeBackend();
		await withStore();
		const port = await freePort();
		await occupy(port);

		// Silent degradation is the failure this forbids, one transport along: a host serving
		// Rover clients while the browser its operator pointed at it gets nothing.
		await expect(startWithHttp({ port })).rejects.toMatchObject({ code: 'EADDRINUSE' });

		expect(await connectWithoutStarting(temp.socketPath)).toBeNull();
	});

	it('fails the start when the certificate cannot be read, naming the variable', async () => {
		registerFakeBackend();
		await withStore();

		await expect(
			startWithHttp({ certPath: '/nonexistent/cert.pem', keyPath: certificate.keyPath }),
		).rejects.toThrow(TLS_CERT_ENV_VAR);
	});
});

describe('HTTPS when the TLS material is configured', () => {
	it('serves the same surface over TLS, and refuses a plain request on that port', async () => {
		registerFakeBackend();
		await withStore();
		const daemon = await startWithHttp({
			certPath: certificate.certPath,
			keyPath: certificate.keyPath,
		});

		const answer = await call(daemon, 'list_devices', {}, { ca: certificate.certPem });
		expect(envelopeOf(answer)).toMatchObject({ type: 'result', id: 'req-1' });

		// Plain HTTP to an HTTPS port is not an answer, and it is certainly not one that varies.
		await expect(call(daemon, 'list_devices')).rejects.toBeDefined();
	});

	it('names the key variable when only the key is unreadable', async () => {
		registerFakeBackend();
		await withStore();

		await expect(
			startWithHttp({ certPath: certificate.certPath, keyPath: '/nonexistent/key.pem' }),
		).rejects.toThrow(TLS_KEY_ENV_VAR);
	});
});

describe('an autostarted daemon is never a panel host', () => {
	it('brings up a child that answers locally and listens on no HTTP port', {
		timeout: 30_000,
	}, async () => {
		await withStore();
		const port = await freePort();
		vi.stubEnv(HTTP_PORT_ENV_VAR, String(port));
		vi.stubEnv(HTTP_ADDRESS_ENV_VAR, '127.0.0.1');

		const client = await connectToLocalDaemon({ socketPath: temp.socketPath });
		try {
			await expect(client.request('status', {})).resolves.toMatchObject({
				protocolVersion: 1,
			});
			// A plain `rover list` must never turn a laptop into a panel host, however its
			// shell is configured: `spawnDaemon` clears this switch in the child too.
			expect(await nothingListensOn(port)).toBe(true);
		} finally {
			await client.close();
			await stopDaemonAt(temp.socketPath);
		}
	});
});
