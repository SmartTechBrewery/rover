/**
 * R22's client half end to end: the real remote client against the real TLS listener, over a
 * real TCP socket with a real certificate.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md), and it applies harder
 * here than anywhere else: what this file asserts is a TLS handshake, a certificate that is
 * or is not trusted, a token that is or is not accepted, and a port with nothing on it. Not
 * one of those has a meaning against a mock. So the certificates are generated with
 * `openssl`, the listener binds `127.0.0.1:0`, and the client is the shipping
 * `connectToNetworkHost`.
 *
 * The through-line is that **a client never starts a host** (D5): every failure below is a
 * failure, named, rather than a spawn, a retry or an empty list. Every `spawn` in the process
 * is counted for the whole file, so that is asserted as a fact rather than as an intention.
 */

import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import {
	HOST_ADDRESS_ENV_VAR,
	type NetworkListenerConfig,
	type RemoteHostConfig,
} from '@/daemon/network-config.js';
import { connectToNetworkHost } from '@/daemon/network-connect.js';
import type { IpcClient } from '@/ipc/client.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';
import {
	createTestCertificate,
	removeTestCertificate,
	type TestCertificate,
} from '../../helpers/tls-fixtures.js';
import { createTestUserStore, type TestUserStore } from '../../helpers/user-store.js';

/**
 * Every child process this test process starts, counted.
 *
 * `vi.spyOn` cannot touch an ESM module namespace, so the interception has to be the mock
 * itself — and it **delegates to the real `spawn`** rather than replacing it, because
 * `tests/helpers/tls-fixtures.ts` genuinely runs `openssl` through this same module and a
 * stubbed-out child process would leave this suite with no certificate to connect with.
 *
 * It is the executable companion to `tests/unit/daemon/remote-never-spawns.test.ts`: that one
 * says the import is not there, and this one says nothing started a process anyway.
 */
const spawned = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: (...args: Parameters<typeof actual.spawn>) => {
			spawned(...args);
			return actual.spawn(...args);
		},
	};
});

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });
const second = createMockDevice({ serial: parseDeviceSerial('attached-2') });

/** Long enough to be accepted by the schema, and obviously not the host's. */
/** A well-formed token no `rover users add` on this host ever issued. */
const WRONG_TOKEN = 'the-wrong-token-but-long-enough-1234';

/**
 * Generated once for the file: a 2048-bit key costs a few hundred milliseconds and nothing
 * here mutates any of them. The second is the host nobody trusts — a certificate that is
 * perfectly valid and simply is not the one `ROVER_HOST_CA` names. The third is the opposite
 * failure: trusted, and issued for a name this client is not connecting to.
 */
let certificate: TestCertificate;
let stranger: TestCertificate;
let misnamed: TestCertificate;
let temp: TempSocket;
/** The host's user store and the one user in it, recreated per test beside the temp socket. */
let store: TestUserStore;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
const occupied: Server[] = [];
/** Sockets a silent listener is deliberately holding open — see {@link silentListenerOn}. */
const held: Socket[] = [];

beforeAll(async () => {
	[certificate, stranger, misnamed] = await Promise.all([
		createTestCertificate(),
		createTestCertificate(),
		// Trusted as its own CA below, and still wrong for `127.0.0.1`: the private-network
		// deployment this transport was built for, with a certificate issued for a hostname.
		createTestCertificate({
			commonName: 'rover-host.example',
			subjectAltName: 'DNS:rover-host.example',
		}),
	]);
});

afterAll(async () => {
	await Promise.all([certificate, stranger, misnamed].map(removeTestCertificate));
});

beforeEach(async () => {
	spawned.mockClear();
	temp = await createTempSocket();
	// The host authenticates against a real store (R28), so the token this client presents is
	// one the shipping `rover users add` minted, not a fixture constant.
	store = await createTestUserStore(temp.dir);
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	// Before the servers, never after: `server.close()` stops accepting and then waits for the
	// connections still open, and a socket held on purpose is one that will never close itself.
	for (const socket of held.splice(0)) {
		socket.destroy();
	}
	await Promise.all(
		occupied
			.splice(0)
			.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
	_resetDeviceBackendRegistryForTesting();
	vi.restoreAllMocks();
	if (temp) {
		await removeTempSocket(temp);
	}
});

function registerFakeBackend(devices: Device[] = [attached, second]): void {
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
		// Port 0 and never a fixed one: the kernel picks and `RunningDaemon.networkPort` says
		// which, so two suites running at once cannot collide.
		port: 0,
		certPath: certificate.certPath,
		keyPath: certificate.keyPath,
		usersPath: store.path,
		...overrides,
	};
}

/** A daemon on the temp socket with the TLS listener up beside it, and the port it bound. */
async function startHost(overrides: Partial<NetworkListenerConfig> = {}): Promise<number> {
	registerFakeBackend();
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		network: networkConfig(overrides),
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
	if (result.networkPort === null) {
		throw new Error('The daemon opened no network listener');
	}
	return result.networkPort;
}

function remoteConfig(port: number, overrides: Partial<RemoteHostConfig> = {}): RemoteHostConfig {
	return {
		address: '127.0.0.1',
		port,
		token: store.token,
		caPath: certificate.certPath,
		...overrides,
	};
}

/** The shipping client, tracked so nothing is left holding a socket after the test. */
async function overNetwork(
	port: number,
	overrides: Partial<RemoteHostConfig> = {},
): Promise<IpcClient> {
	const client = await connectToNetworkHost(remoteConfig(port, overrides));
	clients.push(client);
	return client;
}

/** The local client, for the same daemon, so the two transports can be compared. */
async function overSocket(): Promise<IpcClient> {
	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
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

/**
 * A TCP listener that accepts and immediately drops, for "something is on that port and it is
 * not a Rover host" — the peer that answers the ClientHello with a reset.
 *
 * Its silent counterpart is {@link silentListenerOn}, which is the harder half of the same
 * case and is covered by its own test below.
 */
async function plainListenerOn(port: number): Promise<void> {
	const server = createNetServer((socket) => {
		socket.on('error', () => {});
		socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
	occupied.push(server);
}

/**
 * A TCP listener that accepts and then says **nothing at all** — never answering the
 * ClientHello, never closing.
 *
 * This is the shape a dead `ssh -L` tunnel, an L4 balancer with no live backend and a
 * SIGSTOPped host all present. It raises no socket event of any kind, so only the client's own
 * deadline can end it, and the socket is retained rather than left to the garbage collector so
 * that nothing closes it early and turns this back into the easy case above.
 */
async function silentListenerOn(port: number): Promise<void> {
	const server = createNetServer((socket) => {
		socket.on('error', () => {});
		held.push(socket);
	});
	await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
	occupied.push(server);
}

describe('the same surface over the network client', () => {
	it('answers status, matching what the local client gets from the same daemon', async () => {
		const port = await startHost();

		const remote = await (await overNetwork(port)).request('status', {});
		const local = await (await overSocket()).request('status', {});

		// One daemon, so the pid and the protocol version are the same answer arriving over two
		// transports — which is the whole claim D17 makes and the whole reason there is no
		// second client implementation to compare against.
		expect(remote).toMatchObject({ pid: process.pid, protocolVersion: 1 });
		expect(remote.pid).toBe(local.pid);
		expect(remote.protocolVersion).toBe(local.protocolVersion);
	});

	it('lists the attached devices identically to the local client', async () => {
		const port = await startHost();

		const remote = await (await overNetwork(port)).request('list_devices', {});

		expect(remote).toEqual(await (await overSocket()).request('list_devices', {}));
		expect(remote.devices.map((device) => device.serial)).toEqual([attached.serial, second.serial]);
	});

	it('drives the whole method table over one connection', async () => {
		const port = await startHost();
		const client = await overNetwork(port);

		const acquired = await client.request('acquire_device', {
			serial: attached.serial,
			owner: 'issue-62',
			project: 'rover',
		});
		if (acquired.outcome !== 'granted') {
			throw new Error(`The device was refused: ${acquired.message}`);
		}
		// The two waits, over the same connection. The fake backend reads an empty screen, so
		// one answers `failed` and the other `ok`; what matters is that a verb call crosses the
		// network, the host runs it (D19) and the answer comes back as *data* rather than as a
		// broken host.
		const waited = await client.request('wait_for', {
			leaseId: acquired.lease.leaseId,
			target: { by: 'text', text: 'nothing on this screen' },
			timeoutMs: 0,
		});
		const gone = await client.request('wait_until_gone', {
			leaseId: acquired.lease.leaseId,
			target: { by: 'text', text: 'nothing on this screen' },
			timeoutMs: 0,
		});

		expect(waited).toMatchObject({ outcome: 'failed' });
		expect(gone).toMatchObject({ outcome: 'ok' });
		await expect(
			client.request('release_device', { leaseId: acquired.lease.leaseId }),
		).resolves.toEqual({ released: true });
	});

	it('carries the client’s own owner string onto the lease (D20)', async () => {
		const port = await startHost();
		const client = await overNetwork(port);

		const acquired = await client.request('acquire_device', {
			serial: attached.serial,
			owner: 'pr-127-review',
			project: 'rover',
		});
		if (acquired.outcome !== 'granted') {
			throw new Error(`The device was refused: ${acquired.message}`);
		}
		const listed = await client.request('list_devices', {});

		// The token authenticated; it attributed nothing. The owner is the string this client
		// sent and the one that comes back.
		expect(acquired.lease.owner).toBe('pr-127-review');
		expect(
			listed.devices.find((device) => device.serial === attached.serial)?.heldBy,
		).toMatchObject({ owner: 'pr-127-review' });
		// Deep-scanned rather than field-by-field, so a field added later cannot quietly start
		// carrying the token.
		for (const result of [acquired, listed]) {
			expect(JSON.stringify(result)).not.toContain(store.token);
		}
	});

	it('writes the token nowhere — not to a console, not to a stream', async () => {
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
		const port = await startHost();

		// A whole session's worth of chances to leak it: a connection that works, one that is
		// refused, and the shutdown.
		await (await overNetwork(port)).request('status', {});
		await expect(overNetwork(port, { token: WRONG_TOKEN })).rejects.toThrow();
		await Promise.all(running.splice(0).map((daemon) => daemon.close()));

		expect(written.join('\n')).not.toContain(store.token);
		expect(written.join('\n')).not.toContain(WRONG_TOKEN);
	});
});

describe('a client never starts a host (D5)', () => {
	it('reports a refused connection as one, naming the address, the port and ECONNREFUSED', async () => {
		const port = await freePort();

		const attempt = connectToNetworkHost(remoteConfig(port));

		await expect(attempt).rejects.toThrow(`127.0.0.1:${port}`);
		await expect(attempt).rejects.toThrow('ECONNREFUSED');
		// The sentence that makes this D5 rather than a generic network error: nothing here is
		// coming up on its own, so waiting for it would be waiting forever.
		await expect(attempt).rejects.toThrow(/never started from a client/);
		expect(spawned).not.toHaveBeenCalled();
		// And nothing was started on the local socket either — a client that "helpfully" fell
		// back to the local daemon would be answering a question nobody asked.
		expect(await connectWithoutStarting(temp.socketPath)).toBeNull();
	});

	it('never answers an unreachable host with an empty device list', async () => {
		const port = await freePort();

		// The failure mode this whole error path exists to prevent: `list_devices` returning
		// `{ devices: [] }` for a host that was never reached reads as "no devices attached".
		await expect(connectToNetworkHost(remoteConfig(port))).rejects.toThrow();
	});

	it('gives up on a peer that accepts and never answers, naming ETIMEDOUT', async () => {
		const port = await freePort();
		await silentListenerOn(port);

		// The deadline is passed in only so this test does not wait the production ten seconds;
		// nothing shipping supplies it. Without it there is no event on this socket at all, so
		// the promise would stay pending forever and the CLI would sit there with no output and
		// no exit code — the one failure a caller cannot tell apart from a slow host.
		const attempt = connectToNetworkHost(remoteConfig(port), { connectTimeoutMs: 250 });

		await expect(attempt).rejects.toThrow(`127.0.0.1:${port}`);
		await expect(attempt).rejects.toThrow('ETIMEDOUT');
		// Its own diagnosis, not ECONNREFUSED's: something *is* answering there, so the next
		// step is a firewall or a dead tunnel rather than a daemon that was never started.
		await expect(attempt).rejects.toThrow(/never completed the handshake/);
		expect(spawned).not.toHaveBeenCalled();
	});

	it('starts nothing for a host that is on the port and is not a Rover', async () => {
		const port = await freePort();
		await plainListenerOn(port);

		// Something answers TCP and speaks no TLS. It fails, it fails naming the address and
		// the port, and it fails without anything being started.
		await expect(connectToNetworkHost(remoteConfig(port))).rejects.toThrow(`127.0.0.1:${port}`);
		expect(spawned).not.toHaveBeenCalled();
	});
});

describe('a rejected token is reported as a rejected token', () => {
	it('names ROVER_HOST_TOKEN and never echoes the value', async () => {
		const port = await startHost();

		const attempt = connectToNetworkHost(remoteConfig(port, { token: WRONG_TOKEN }));

		await expect(attempt).rejects.toThrow('ROVER_HOST_TOKEN');
		// The D20 assertion, repeated on the client side: the message may say which variable
		// was wrong and must never say what was in it.
		await expect(attempt).rejects.toThrow(
			expect.objectContaining({ message: expect.not.stringContaining(WRONG_TOKEN) }),
		);
	});

	it('sends the operator to rover users, not to a secret the host no longer holds', async () => {
		// The message R28 makes wrong if it is left alone: there is no host-side value to copy
		// here any more. The actionable next step is a token that host's own `rover users add`
		// or `rover users rotate` printed.
		const port = await startHost();

		const rejected = await connectToNetworkHost(remoteConfig(port, { token: WRONG_TOKEN })).catch(
			(error: Error) => error.message,
		);

		expect(rejected).toContain('rover users');
		expect(rejected).not.toContain('same secret');
	});

	it('reads as a rejection rather than as an unreachable or a broken host', async () => {
		const port = await startHost();

		const rejected = await connectToNetworkHost(remoteConfig(port, { token: WRONG_TOKEN })).catch(
			(error: Error) => error.message,
		);

		// Three outcomes, three messages. A refused token that read `ECONNREFUSED` would send
		// an operator to check a firewall for a secret they mistyped.
		expect(rejected).toContain('rejected');
		expect(rejected).not.toContain('ECONNREFUSED');
		expect(rejected).not.toContain('Cannot reach');
	});

	it('leaves the device untouched — nothing ran behind the refusal', async () => {
		const port = await startHost();

		await expect(overNetwork(port, { token: WRONG_TOKEN })).rejects.toThrow();

		const listed = await (await overSocket()).request('list_devices', {});
		expect(listed.devices.find((device) => device.serial === attached.serial)?.heldBy).toBeNull();
	});
});

describe('the host’s certificate is verified, never waved through', () => {
	it('refuses a host whose certificate is not the one ROVER_HOST_CA names', async () => {
		const port = await startHost({
			certPath: stranger.certPath,
			keyPath: stranger.keyPath,
		});

		const attempt = connectToNetworkHost(remoteConfig(port));

		// At the TLS layer, before a greeting is written: the token is never presented to a
		// host this client could not identify.
		await expect(attempt).rejects.toThrow('SELF_SIGNED_CERT');
		await expect(attempt).rejects.toThrow('ROVER_HOST_CA');
	});

	it('refuses a host it has no certificate for at all, rather than trusting it', async () => {
		const port = await startHost();

		// `caPath` unset means the system trust store, and a throwaway self-signed certificate
		// is not in anybody's. The point is that this *fails* — there is no flag anywhere in
		// this client that would have let it through.
		await expect(connectToNetworkHost(remoteConfig(port, { caPath: undefined }))).rejects.toThrow(
			'SELF_SIGNED_CERT',
		);
	});

	it('sends a mismatched name to the address, not to ROVER_HOST_CA', async () => {
		const port = await startHost({ certPath: misnamed.certPath, keyPath: misnamed.keyPath });

		// Trusted as its own CA, so the chain verifies and only `checkServerIdentity` fails —
		// which is why `ROVER_HOST_CA` is the one thing that cannot fix this.
		const attempt = connectToNetworkHost(remoteConfig(port, { caPath: misnamed.certPath }));

		await expect(attempt).rejects.toThrow('ERR_TLS_CERT_ALTNAME_INVALID');
		await expect(attempt).rejects.toThrow(HOST_ADDRESS_ENV_VAR);
		await expect(attempt).rejects.toThrow('subjectAltName');
		// The trust sentence would send an operator to re-do the thing they already did right.
		await expect(attempt).rejects.toThrow(
			expect.objectContaining({
				message: expect.not.stringContaining('does not trust'),
			}),
		);
	});

	it('names the variable and the path when the certificate cannot be read', async () => {
		// No host at all: an unreadable certificate is a setup failure that has to be reported
		// before a connection is attempted, not as a TLS mystery once one is.
		const attempt = connectToNetworkHost(
			remoteConfig(await freePort(), { caPath: '/nonexistent/rover-ca.pem' }),
		);

		await expect(attempt).rejects.toThrow('ROVER_HOST_CA');
		await expect(attempt).rejects.toThrow('/nonexistent/rover-ca.pem');
	});
});
