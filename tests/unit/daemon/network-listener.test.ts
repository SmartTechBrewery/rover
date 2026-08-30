/**
 * R22's host half end to end: a real TLS listener beside the real unix socket, serving the
 * **same** `IpcServer`, with a token gate in front of it.
 *
 * The daemon suite's real-socket exception applies and extends (ai/TESTING.md): a token gate
 * on a real TLS socket cannot be asserted against a mock any more than the bind race can. So
 * the certificate is real, the listener binds `127.0.0.1:0`, and the client is `tls.connect`
 * rather than a Rover client — phase 2 owns `connectToNetworkHost`, and driving the host with
 * a raw socket is what proves the second transport serves the same surface *without* a second
 * client implementation existing to prove it with.
 *
 * Nothing here ever binds a fixed public address, and every daemon is closed through its own
 * handle in `afterEach`.
 */

import {
	createServer as createNetServer,
	connect as netConnect,
	type Server,
	type Socket,
} from 'node:net';
import type { TLSSocket } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { connectToLocalDaemon } from '@/daemon/connect.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import {
	HOST_TOKEN_ENV_VAR,
	LISTEN_ADDRESS_ENV_VAR,
	LISTEN_PORT_ENV_VAR,
	type NetworkListenerConfig,
	TLS_CERT_ENV_VAR,
	TLS_KEY_ENV_VAR,
} from '@/daemon/network-config.js';
import { startNetworkListener } from '@/daemon/network-listen.js';
import type { IpcClient } from '@/ipc/client.js';
import { encodeFrame } from '@/ipc/framing.js';
import { ErrorResponseSchema } from '@/ipc/protocol.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	stopDaemonAt,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';
import {
	connectWithToken,
	createTestCertificate,
	greetingFor,
	rawTlsConnect,
	readUntilClosed,
	removeTestCertificate,
	TEST_HOST_TOKEN,
	type TestCertificate,
} from '../../helpers/tls-fixtures.js';

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });
const second = createMockDevice({ serial: parseDeviceSerial('attached-2') });

/** The one refusal, spelled out here rather than imported: a copy is what makes it a contract. */
const REFUSAL = `${JSON.stringify({
	type: 'error',
	protocolVersion: 1,
	id: null,
	error: { code: 'unauthenticated', message: 'Authentication failed.' },
})}\n`;

/** Short enough that the handshake deadline lands inside a test, long enough not to race it. */
const SHORT_AUTH_TIMEOUT_MS = 250;

/**
 * Generated once for the file rather than per test: a 2048-bit key costs a few hundred
 * milliseconds, nothing here mutates it, and it is removed in `afterAll` either way.
 */
let certificate: TestCertificate;
let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
const sockets: TLSSocket[] = [];
const plainSockets: Socket[] = [];
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

function networkConfig(overrides: Partial<NetworkListenerConfig> = {}): NetworkListenerConfig {
	return {
		address: '127.0.0.1',
		// Port 0 and never a fixed one: the kernel picks, and `RunningDaemon.networkPort` says
		// which, so two suites running at once cannot collide.
		port: 0,
		token: TEST_HOST_TOKEN,
		certPath: certificate.certPath,
		keyPath: certificate.keyPath,
		...overrides,
	};
}

/** A daemon on the temp socket, with the TLS listener up beside it. */
async function startWithNetwork(
	overrides: Partial<NetworkListenerConfig> = {},
): Promise<RunningDaemon> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		network: networkConfig(overrides),
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
	return result;
}

function portOf(daemon: RunningDaemon): number {
	if (daemon.networkPort === null) {
		throw new Error('The daemon opened no network listener');
	}
	return daemon.networkPort;
}

async function overTls(daemon: RunningDaemon, token = TEST_HOST_TOKEN): Promise<IpcClient> {
	const client = await connectWithToken(portOf(daemon), token, certificate.certPem);
	clients.push(client);
	return client;
}

async function overSocket(): Promise<IpcClient> {
	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
}

async function raw(daemon: RunningDaemon): Promise<TLSSocket> {
	const socket = await rawTlsConnect(portOf(daemon), certificate.certPem);
	sockets.push(socket);
	return socket;
}

function requestFrame(method: string, params: unknown, id = 'req-1'): string {
	return encodeFrame({ protocolVersion: 1, id, method, params });
}

/** The first whole frame the host writes, for a peer that is not a full IPC client. */
function readFirstFrame(socket: TLSSocket): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffered = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			buffered += chunk;
			const newline = buffered.indexOf('\n');
			if (newline !== -1) {
				resolve(buffered.slice(0, newline));
			}
		});
		socket.on('close', () =>
			reject(new Error(`The host closed without a whole frame: ${buffered}`)),
		);
	});
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

/**
 * A plain TCP connection that never speaks TLS — a port scanner, a load balancer's health
 * check, an `nc` left open. Tracked so a test that means to leave one open still cannot leak it.
 */
function plainConnect(port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ port, host: '127.0.0.1' });
		plainSockets.push(socket);
		socket.on('error', () => {});
		socket.once('connect', () => resolve(socket));
		socket.once('close', () => reject(new Error('The connection closed before it was made')));
	});
}

/** Resolves when `socket` is closed, or rejects once `limitMs` has passed without that. */
function closesWithin(socket: Socket, limitMs: number): Promise<void> {
	return withinDeadline(
		new Promise<void>((resolve) => socket.once('close', () => resolve())),
		limitMs,
		'The socket was still open',
	);
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
	for (const socket of sockets.splice(0)) {
		socket.destroy();
	}
	for (const socket of plainSockets.splice(0)) {
		socket.destroy();
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

describe('one surface, two transports', () => {
	const TRANSPORTS = [
		['the local unix socket', async (_daemon: RunningDaemon) => overSocket()],
		['the TLS listener', async (daemon: RunningDaemon) => overTls(daemon)],
	] as const;

	// The assertion body is written once and run over both transports on purpose: a message
	// valid on one has to be valid on the other, because there is one `IpcServer` behind both
	// (D17). A second copy of these assertions would be the thing this test exists to forbid.
	it.each(TRANSPORTS)('answers status over %s', async (_name, connect) => {
		registerFakeBackend();
		temp = await createTempSocket();
		const daemon = await startWithNetwork();

		const status = await (await connect(daemon)).request('status', {});

		expect(status).toMatchObject({ protocolVersion: 1, pid: process.pid });
	});

	it.each(TRANSPORTS)('lists the attached devices over %s', async (_name, connect) => {
		registerFakeBackend();
		temp = await createTempSocket();
		const daemon = await startWithNetwork();

		const listed = await (await connect(daemon)).request('list_devices', {});

		expect(listed).toEqual({
			devices: [
				{ ...attached, heldBy: null },
				{ ...second, heldBy: null },
			],
			stale: false,
		});
	});

	it.each(TRANSPORTS)('grants and releases a lease over %s', async (_name, connect) => {
		registerFakeBackend();
		temp = await createTempSocket();
		const daemon = await startWithNetwork();
		const client = await connect(daemon);

		const acquired = await client.request('acquire_device', {
			serial: attached.serial,
			owner: 'issue-112',
			project: 'rover',
		});
		if (acquired.outcome !== 'granted') {
			throw new Error(`The device was refused: ${acquired.message}`);
		}

		await expect(
			client.request('release_device', { leaseId: acquired.lease.leaseId }),
		).resolves.toEqual({ released: true });
	});

	it.each(
		TRANSPORTS,
	)('refuses an unknown param key the same way over %s', async (_name, connect) => {
		registerFakeBackend();
		temp = await createTempSocket();
		const daemon = await startWithNetwork();

		const rejection = (await connect(daemon)).request('list_devices', { serial: 'x' } as never);

		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
	});

	it('leaves the local socket ungated while the listener is up', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await startWithNetwork();

		// The acceptance criterion in its literal form: a local client sends no greeting, has
		// no token and needs no configuration, because the gate lives in the other transport.
		await expect((await overSocket()).request('status', {})).resolves.toMatchObject({
			pid: process.pid,
		});
	});
});

describe('the token authenticates, the owner string attributes (D20)', () => {
	it('never lets the token become the owner, and never echoes it back', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		const daemon = await startWithNetwork();
		const client = await overTls(daemon);

		const acquired = await client.request('acquire_device', {
			serial: attached.serial,
			owner: 'pr-127-review',
			project: 'rover',
		});
		if (acquired.outcome !== 'granted') {
			throw new Error(`The device was refused: ${acquired.message}`);
		}
		const listed = await client.request('list_devices', {});
		const refused = await (await overTls(daemon)).request('acquire_device', {
			serial: attached.serial,
			owner: 'someone-else',
			project: 'rover',
		});

		expect(acquired.lease.owner).toBe('pr-127-review');
		expect(
			listed.devices.find((device) => device.serial === attached.serial)?.heldBy,
		).toMatchObject({ owner: 'pr-127-review' });
		// Deep-scanned rather than field-by-field, so a field added later cannot quietly start
		// carrying the token.
		for (const result of [acquired, listed, refused]) {
			expect(JSON.stringify(result)).not.toContain(TEST_HOST_TOKEN);
		}
	});

	it('writes the token nowhere — not to a log, not to a refused socket', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		const written: string[] = [];
		for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				written.push(args.map(String).join(' '));
			});
		}
		for (const stream of [process.stdout, process.stderr] as const) {
			vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
				written.push(String(chunk));
				return true;
			});
		}

		const daemon = await startWithNetwork();
		// A whole session's worth of chances to leak it: a successful connection, a refused
		// one, and the shutdown.
		await (await overTls(daemon)).request('status', {});
		const refusedSocket = await rawTlsConnect(portOf(daemon), certificate.certPem);
		refusedSocket.write(greetingFor('the-wrong-token-but-long-enough-1234'));
		const refusal = await readUntilClosed(refusedSocket);
		await Promise.all(running.splice(0).map((instance) => instance.close()));

		expect(written.join('\n')).not.toContain(TEST_HOST_TOKEN);
		expect(written.join('\n')).not.toContain('the-wrong-token-but-long-enough-1234');
		// The refusal is a fixed string; it cannot contain a token, and this is what keeps that
		// true if anyone ever makes it "more helpful".
		expect(refusal).toBe(REFUSAL);
	});
});

describe('a refusal is not an oracle', () => {
	it.each([
		['a wrong token', greetingFor('the-wrong-token-but-long-enough-1234')],
		['a greeting that is not JSON', 'hello there\n'],
		[
			'a greeting with an extra key',
			`${JSON.stringify({ token: TEST_HOST_TOKEN, admin: true })}\n`,
		],
		['a greeting with no token at all', `${JSON.stringify({})}\n`],
		['an oversize greeting', `${'x'.repeat(9000)}\n`],
	])('answers %s with the one refusal frame and closes', async (_what, greeting) => {
		registerFakeBackend();
		temp = await createTempSocket();
		const daemon = await startWithNetwork();

		const socket = await rawTlsConnect(portOf(daemon), certificate.certPem);
		socket.write(greeting);
		const received = await readUntilClosed(socket);

		expect(received).toBe(REFUSAL);
		// Byte-identity is the headline, but spelling out what must not be in there is what
		// makes a future "just add the reason" change fail loudly.
		expect(received).not.toContain(attached.serial);
		expect(received).not.toContain(second.serial);
		expect(received).not.toContain(String(process.pid));
	});

	it('parses as an ErrorResponse a client already knows how to fail on', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		const daemon = await startWithNetwork();

		const socket = await rawTlsConnect(portOf(daemon), certificate.certPem);
		socket.write(greetingFor('the-wrong-token-but-long-enough-1234'));
		const parsed = ErrorResponseSchema.parse(JSON.parse(await readUntilClosed(socket)));

		// `id: null` is what makes `createIpcClient` treat the connection as untrustworthy and
		// fail everything in flight — so phase 2's client needs no new frame handling.
		expect(parsed).toEqual({
			type: 'error',
			protocolVersion: 1,
			id: null,
			error: { code: 'unauthenticated', message: 'Authentication failed.' },
		});
	});

	it('refuses a peer that connects and says nothing, identically', async () => {
		// The handshake deadline, against a standalone listener so the wait is a quarter of a
		// second rather than the five the daemon runs with. The IPC server behind it is never
		// reached — nothing here ever authenticates — which is the point: the refusal has to be
		// the same bytes whatever is behind the gate.
		const listener = await startNetworkListener(
			networkConfig(),
			{ handleConnection: () => {} },
			{ authTimeoutMs: SHORT_AUTH_TIMEOUT_MS },
		);

		try {
			const socket = await rawTlsConnect(listener.port, certificate.certPem);
			expect(await readUntilClosed(socket)).toBe(REFUSAL);
		} finally {
			await listener.close();
		}
	});

	it('refuses a peer that dribbles its greeting, on a deadline it cannot rearm', async () => {
		const listener = await startNetworkListener(
			networkConfig(),
			{ handleConnection: () => {} },
			{ authTimeoutMs: SHORT_AUTH_TIMEOUT_MS },
		);

		try {
			const socket = await rawTlsConnect(listener.port, certificate.certPem);
			const refusal = readUntilClosed(socket);
			// One byte at a time, faster than the deadline and never a newline. An *idle* deadline is
			// rearmed by every arriving byte, so this peer would stay unauthenticated for as long
			// as it cared to keep typing — the 4 KiB cap bounds the bytes, not the time. The
			// interval is this peer's typing speed, not a wait on the host (ai/RULES.md §2).
			const dribble = setInterval(() => socket.write('x'), SHORT_AUTH_TIMEOUT_MS / 2);
			socket.once('close', () => clearInterval(dribble));

			expect(
				await withinDeadline(refusal, 5_000, 'The dribbling peer was still unauthenticated'),
			).toBe(REFUSAL);
		} finally {
			await listener.close();
		}
	});

	it('drops a peer that opens a socket and never starts the handshake', async () => {
		const listener = await startNetworkListener(
			networkConfig(),
			{ handleConnection: () => {} },
			{ authTimeoutMs: SHORT_AUTH_TIMEOUT_MS },
		);

		try {
			const socket = await plainConnect(listener.port);
			// No frame for this one, and deliberately so: there is no TLS session to write one
			// into. What the deadline has to guarantee is that the socket goes away — and that it
			// starts at accept, because `secureConnection` never fires for a peer like this.
			await closesWithin(socket, 5_000);
			expect(socket.bytesRead).toBe(0);
		} finally {
			await listener.close();
		}
	});
});

describe('nothing is dispatched before the greeting is accepted', () => {
	it('runs no verb from a request batched behind a bad token', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		const daemon = await startWithNetwork();

		const socket = await rawTlsConnect(portOf(daemon), certificate.certPem);
		// One write, on purpose: the peer picks the chunking, so it can always put the garbage
		// and the side effect it wants in the same TCP segment.
		socket.write(
			greetingFor('the-wrong-token-but-long-enough-1234') +
				requestFrame('acquire_device', {
					serial: attached.serial,
					owner: 'attacker',
					project: 'rover',
				}),
		);
		const received = await readUntilClosed(socket);

		expect(received).toBe(REFUSAL);
		// The device is still free, so the acquire never ran — the surface was never attached
		// to that stream at all.
		const listed = await (await overSocket()).request('list_devices', {});
		expect(listed.devices.find((device) => device.serial === attached.serial)?.heldBy).toBeNull();
	});

	it('answers a request written in the same chunk as a good greeting', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		const daemon = await startWithNetwork();

		const socket = await raw(daemon);
		socket.write(greetingFor(TEST_HOST_TOKEN) + requestFrame('status', {}));
		const frame = JSON.parse(await readFirstFrame(socket));

		// This is the test that goes red if the pause/unshift/resume handover is wrong: the
		// bytes after the greeting's newline were already read off the socket by the gate, and
		// dropping them is a hang no unit test without a real client would ever see.
		expect(frame).toMatchObject({ type: 'result', id: 'req-1' });
	});
});

describe('the listener is opt-in and dies with the daemon', () => {
	it('binds nothing when no network configuration was passed, whatever the environment says', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		const port = await freePort();
		vi.stubEnv(LISTEN_PORT_ENV_VAR, String(port));
		vi.stubEnv(LISTEN_ADDRESS_ENV_VAR, '127.0.0.1');
		vi.stubEnv(HOST_TOKEN_ENV_VAR, TEST_HOST_TOKEN);
		vi.stubEnv(TLS_CERT_ENV_VAR, certificate.certPath);
		vi.stubEnv(TLS_KEY_ENV_VAR, certificate.keyPath);

		const daemon = await startDaemon({ socketPath: temp.socketPath });
		if (!daemon.started) {
			throw new Error('Another daemon holds the temp socket — the test cannot proceed');
		}
		running.push(daemon);

		// `startDaemon` never reads the environment: a unit test must not open a port because
		// the developer happened to export `ROVER_LISTEN_PORT` in that shell.
		expect(daemon.networkPort).toBeNull();
		expect(await nothingListensOn(port)).toBe(true);
	});

	it('stops answering on the port once the daemon is closed, and closes twice safely', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		const daemon = await startWithNetwork();
		const port = portOf(daemon);

		// Both tracking paths held open at `close()` time: an authenticated TLS connection, which
		// the listener sees through `secureConnection`, and a peer that never spoke TLS at all,
		// which it only ever sees as a raw accepted socket. Untracked, the second one counts
		// against `net.Server`'s connection count forever and `close()` never resolves.
		const client = await overTls(daemon);
		expect((await client.request('status', {})).protocolVersion).toBe(1);
		await plainConnect(port);

		await withinDeadline(
			Promise.all(running.splice(0).map((instance) => instance.close())),
			10_000,
			'The daemon was still closing',
		);
		await withinDeadline(daemon.close(), 10_000, 'The second close was still pending');

		expect(await nothingListensOn(port)).toBe(true);
	});

	it('fails the whole start when the network bind fails, leaving the socket unserved', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		const port = await freePort();
		await occupy(port);

		// Silent degradation is the failure this forbids: a host serving only locally while its
		// operator believes it is reachable is worse than one that refused to start.
		await expect(startWithNetwork({ port })).rejects.toMatchObject({ code: 'EADDRINUSE' });

		expect(await connectWithoutStarting(temp.socketPath)).toBeNull();
	});

	it('fails the start when the certificate cannot be read, naming the variable', async () => {
		registerFakeBackend();
		temp = await createTempSocket();

		await expect(startWithNetwork({ certPath: '/nonexistent/cert.pem' })).rejects.toThrow(
			TLS_CERT_ENV_VAR,
		);
	});
});

describe('an autostarted daemon is never a network host', () => {
	it('brings up a child that answers locally and listens on no port', {
		timeout: 30_000,
	}, async () => {
		temp = await createTempSocket();
		const port = await freePort();
		vi.stubEnv(LISTEN_PORT_ENV_VAR, String(port));
		vi.stubEnv(LISTEN_ADDRESS_ENV_VAR, '127.0.0.1');
		vi.stubEnv(HOST_TOKEN_ENV_VAR, TEST_HOST_TOKEN);
		vi.stubEnv(TLS_CERT_ENV_VAR, certificate.certPath);
		vi.stubEnv(TLS_KEY_ENV_VAR, certificate.keyPath);

		const client = await connectToLocalDaemon({ socketPath: temp.socketPath });
		try {
			await expect(client.request('status', {})).resolves.toMatchObject({ protocolVersion: 1 });
			// A plain `rover list` must never turn a laptop into a network host, however its
			// shell is configured: `spawnDaemon` clears the switch in the child.
			expect(await nothingListensOn(port)).toBe(true);
		} finally {
			await client.close();
			await stopDaemonAt(temp.socketPath);
		}
	});
});
