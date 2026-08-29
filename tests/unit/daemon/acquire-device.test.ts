/**
 * `acquire_device` and `release_device` end to end: a registered backend, a real daemon on a
 * temp socket, and clients asking over the real framing.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never
 * `~/.rover/rover.sock`, and every daemon closed through its own handle in `afterEach`.
 *
 * **The five-client suite below is the reason backlog row R8 exists**, and a barrier is what
 * makes it prove anything. Five requests issued together would very likely be scheduled one
 * after another anyway, so the test would pass on a store that was thoroughly unsafe. The
 * fake backend instead holds every `describeDevice` call until all five have arrived, which
 * puts all five handlers provably past their one and only `await` before any of them reaches
 * the store.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { type DeviceSerial, parseDeviceSerial, parseLeaseId } from '@/core/ids.js';
import { LEASE_TTL_MS } from '@/daemon/leases.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import type { AcquireDeviceResult } from '@/ipc/methods.js';
import { IpcRequestError } from '@/ipc/protocol.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';

const SERIAL = parseDeviceSerial('attached-1');
const attached = createMockDevice({ serial: SERIAL });

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];

/**
 * A gate that opens once `count` callers have reached it, so every one of them is provably
 * suspended at the same point before any is allowed on. Not a sleep: it resolves on the
 * condition (ai/RULES.md §2).
 */
function createBarrier(count: number) {
	let arrived = 0;
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return async (): Promise<void> => {
		arrived += 1;
		if (arrived >= count) {
			open();
		}
		await opened;
	};
}

/**
 * Registers a backend that answers `describeDevice` however the test asks it to, defaulting
 * to "yes, that device is here and ready" — the factory's own default ignores the serial it
 * was asked about, which would quietly make every grant land on one device.
 */
function registerFakeBackend(
	describeDevice: DeviceBackend['describeDevice'] = async (serial) => createMockDevice({ serial }),
) {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([attached]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: { canReadScreen: true, canInput: false, canControlNetwork: true },
		},
		backend: createMockDeviceBackend({ watchDevices, describeDevice }),
	});
}

async function start(): Promise<RunningDaemon> {
	const result = await startDaemon({ socketPath: temp.socketPath });
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
	return result;
}

async function connect(): Promise<IpcClient> {
	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
}

/** The common case: one backend reporting one ready device, and a daemon serving it. */
async function serveReadyDevice(describeDevice?: DeviceBackend['describeDevice']): Promise<void> {
	registerFakeBackend(describeDevice);
	temp = await createTempSocket();
	await start();
}

function acquire(
	client: IpcClient,
	owner: string,
	extra: { serial?: DeviceSerial; project?: string; testName?: string } = {},
): Promise<AcquireDeviceResult> {
	return client.request('acquire_device', {
		serial: extra.serial ?? SERIAL,
		owner,
		project: extra.project ?? 'rover',
		...(extra.testName === undefined ? {} : { testName: extra.testName }),
	});
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	if (temp) {
		await removeTempSocket(temp);
	}
});

describe('five concurrent clients asking for one device', () => {
	it('yields exactly one winner, and tells the other four who holds it', async () => {
		const barrier = createBarrier(5);
		await serveReadyDevice(async (serial): Promise<Device | null> => {
			// Every handler is suspended here until all five have arrived, so the interleaving
			// this row is about is forced rather than hoped for.
			await barrier();
			return createMockDevice({ serial });
		});

		const connections = await Promise.all([1, 2, 3, 4, 5].map(() => connect()));
		const results = await Promise.all(
			connections.map((client, index) => acquire(client, `owner-${index}`)),
		);

		const granted = results.filter((result) => result.outcome === 'granted');
		const refused = results.filter((result) => result.outcome === 'refused');
		// The predecessor let four through. This is the assertion the row exists for.
		expect(granted).toHaveLength(1);
		expect(refused).toHaveLength(4);

		const winner = granted[0];
		if (winner?.outcome !== 'granted') throw new Error('expected exactly one granted result');
		for (const result of refused) {
			if (result.outcome !== 'refused') throw new Error('unreachable');
			expect(result.reason).toBe('held');
			expect(result.heldBy?.owner).toBe(winner.lease.owner);
		}
	});

	it('never tells a refused caller the holder’s lease id', async () => {
		await serveReadyDevice();
		const holder = await connect();
		const stranger = await connect();
		await acquire(holder, 'issue-112');

		const refusal = await acquire(stranger, 'pr-127-review');

		if (refusal.outcome !== 'refused') throw new Error('the second acquire must be refused');
		// The lease id is the credential — the owner string attributes and authorizes nothing
		// (D20). Handing it to whoever was refused would let them release the holder and take
		// the device.
		expect(refusal.heldBy).not.toHaveProperty('leaseId');
		expect(refusal.heldBy).toMatchObject({ owner: 'issue-112', project: 'rover' });
	});
});

describe('what a granted lease carries', () => {
	it('echoes the attribution back and names the device and its capabilities', async () => {
		await serveReadyDevice();
		const client = await connect();

		const result = await acquire(client, 'issue-112', {
			project: 'rover',
			testName: 'home screen before changes',
		});

		if (result.outcome !== 'granted') throw new Error('expected a granted lease');
		expect(result.lease).toMatchObject({
			serial: SERIAL,
			owner: 'issue-112',
			project: 'rover',
			testName: 'home screen before changes',
		});
		expect(result.lease.leaseId.length).toBeGreaterThan(0);
		expect(result.device).toEqual(attached);
		// The registered manifest's own capabilities, not a default — PROJECT.md §4 has
		// `acquire_device` return the capability list alongside the handle.
		expect(result.capabilities).toEqual({
			canReadScreen: true,
			canInput: false,
			canControlNetwork: true,
		});
	});

	it('reports the time left as a duration, inside the twenty-minute TTL', async () => {
		await serveReadyDevice();
		const client = await connect();

		const result = await acquire(client, 'issue-112');

		if (result.outcome !== 'granted') throw new Error('expected a granted lease');
		// A duration, never an instant: the caller may be on another machine and shares no
		// clock with the host (D17).
		expect(result.lease.expiresInMs).toBeGreaterThan(0);
		expect(result.lease.expiresInMs).toBeLessThanOrEqual(LEASE_TTL_MS);
	});

	it('reports an omitted test name as null rather than leaving the key out', async () => {
		await serveReadyDevice();
		const client = await connect();

		const result = await acquire(client, 'issue-112');

		if (result.outcome !== 'granted') throw new Error('expected a granted lease');
		expect(result.lease.testName).toBeNull();
	});

	it('grants two devices at once — a lease is per device, not per host (D7)', async () => {
		await serveReadyDevice();
		const client = await connect();

		const first = await acquire(client, 'issue-112');
		const second = await acquire(client, 'pr-127-review', {
			serial: parseDeviceSerial('attached-2'),
		});

		expect(first.outcome).toBe('granted');
		expect(second.outcome).toBe('granted');
	});
});

describe('a device that cannot be granted', () => {
	it('refuses a device the host can no longer find, as data rather than an error', async () => {
		await serveReadyDevice(async () => null);
		const client = await connect();

		const result = await acquire(client, 'issue-112');

		// D6: the inventory is a cache and the platform is the truth, so the grant re-verifies.
		// A vanished device is an ordinary answer, not `internal_error` — "the host broke" and
		// "your device is gone" call for opposite responses from an agent.
		expect(result).toMatchObject({ outcome: 'refused', reason: 'gone', heldBy: null });
	});

	it('refuses a device that is only reachable over a network transport (D18)', async () => {
		await serveReadyDevice(async (serial) =>
			createMockDevice({ serial, attachment: 'another-host' }),
		);
		const client = await connect();

		const result = await acquire(client, 'issue-112');

		expect(result).toMatchObject({ outcome: 'refused', reason: 'not-attached', heldBy: null });
	});

	it('refuses a device in a state no verb could run on', async () => {
		await serveReadyDevice(async (serial) => createMockDevice({ serial, state: 'offline' }));
		const client = await connect();

		const result = await acquire(client, 'issue-112');

		// Granting here would hand back a handle that looks like a success and fails at the
		// first call — the plausible-looking answer ai/RULES.md §2 forbids.
		expect(result).toMatchObject({ outcome: 'refused', reason: 'not-ready', heldBy: null });
	});
});

describe('release_device', () => {
	it('frees the device for a different owner', async () => {
		await serveReadyDevice();
		const client = await connect();
		const granted = await acquire(client, 'issue-112');
		if (granted.outcome !== 'granted') throw new Error('expected a granted lease');

		await expect(
			client.request('release_device', { leaseId: granted.lease.leaseId }),
		).resolves.toEqual({ released: true });

		await expect(acquire(client, 'pr-127-review')).resolves.toMatchObject({
			outcome: 'granted',
		});
	});

	it('answers released: false the second time and for an id nobody was ever given', async () => {
		await serveReadyDevice();
		const client = await connect();
		const granted = await acquire(client, 'issue-112');
		if (granted.outcome !== 'granted') throw new Error('expected a granted lease');
		await client.request('release_device', { leaseId: granted.lease.leaseId });

		// Never an error: an id that never existed and one whose lease already ended are
		// indistinguishable to the store, and a distinction it cannot make is not modelled.
		await expect(
			client.request('release_device', { leaseId: granted.lease.leaseId }),
		).resolves.toEqual({ released: false });
		await expect(
			client.request('release_device', { leaseId: parseLeaseId('never-issued') }),
		).resolves.toEqual({ released: false });
	});
});

describe('the params gate', () => {
	it('rejects a typo’d key as invalid_params', async () => {
		await serveReadyDevice();
		const client = await connect();

		const rejection = client.request('acquire_device', {
			serial: SERIAL,
			owner: 'issue-112',
			project: 'rover',
			test_name: 'home screen',
		} as never);

		// `.strict()` is what keeps a mistyped attribution key from becoming a lease filed
		// under nothing (D22): the wire is camelCase, the prose in PROJECT.md is not.
		await expect(rejection).rejects.toBeInstanceOf(IpcRequestError);
		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
	});

	it('rejects a missing project — nothing here is defaulted for the caller', async () => {
		await serveReadyDevice();
		const client = await connect();

		const rejection = client.request('acquire_device', {
			serial: SERIAL,
			owner: 'issue-112',
		} as never);

		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
	});
});
