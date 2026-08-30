/**
 * `list_devices` end to end: a registered backend, a real daemon on a temp socket, and a
 * client asking over the real framing.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never
 * `~/.rover/rover.sock`, and every daemon closed through its own handle in `afterEach`.
 *
 * The backend goes in through `registerDeviceBackend()` rather than being injected past
 * it, because the production lookup — the inventory iterating the registry — is half of
 * what is being asserted: `list_devices` has to reach a backend nobody named in
 * `src/daemon/`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { waitForCondition } from '@/core/wait.js';
import { LEASE_TTL_MS } from '@/daemon/leases.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import type { ListDevicesResult } from '@/ipc/methods.js';
import { IpcRequestError } from '@/ipc/protocol.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });
const elsewhere = createMockDevice({
	serial: parseDeviceSerial('elsewhere-1'),
	attachment: 'another-host',
});

/** Short enough that the expiry lands inside the test, long enough to survive the acquire. */
const SHORT_TTL_MS = 25;

/** How long a condition below may stay unmet before the test gives up on it. */
const CONDITION_TIMEOUT_MS = 5_000;
const CONDITION_POLL_MS = 5;

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];

/** Registers a backend that reports both devices, and hands back what the test asserts on. */
function registerFakeBackend(devices: Device[] = [attached, elsewhere]) {
	const stopWatch = vi.fn<DeviceWatch['stop']>(async () => {});
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices(devices);
		return { stop: stopWatch };
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
		// The factory's own `describeDevice` answers about one fixed serial whatever it is
		// asked, which would quietly make every grant below land on the same device.
		backend: createMockDeviceBackend({
			watchDevices,
			describeDevice: async (serial) => createMockDevice({ serial }),
		}),
	});
	return { stopWatch, watchDevices };
}

async function start(options: { leaseTtlMs?: number } = {}): Promise<RunningDaemon> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		...options,
	});
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

/** The listed device this suite asserts on, by the serial the fake backend reports. */
function listed(result: ListDevicesResult) {
	const device = result.devices.find((candidate) => candidate.serial === attached.serial);
	if (!device) {
		throw new Error(`'${attached.serial}' is missing from the list`);
	}
	return device;
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	if (temp) {
		await removeTempSocket(temp);
	}
});

describe('list_devices over the socket', () => {
	it('answers with the devices attached to this host and leaves out the one that is not', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await start();

		const client = await connectWithoutStarting(temp.socketPath);
		const result = await client?.request('list_devices', {});

		// `heldBy: null` is part of the reply's shape, not an extra a client may find missing —
		// so this stays one assertion over the whole thing, `stale` included.
		expect(result).toEqual({ devices: [{ ...attached, heldBy: null }], stale: false });
		await client?.close();
	});

	it('rejects an unexpected param key as invalid_params', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await start();

		const client = await connectWithoutStarting(temp.socketPath);
		// `.strict()` on the params schema is what makes a typo'd argument a refusal instead
		// of a silently ignored key.
		const rejection = client?.request('list_devices', { serial: 'attached-1' } as never);

		await expect(rejection).rejects.toBeInstanceOf(IpcRequestError);
		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
		await client?.close();
	});

	it('stops the backend watch when the daemon closes', async () => {
		const { stopWatch } = registerFakeBackend();
		temp = await createTempSocket();
		await start();
		expect(stopWatch).not.toHaveBeenCalled();

		await Promise.all(running.splice(0).map((daemon) => daemon.close()));

		// The acceptance criterion in its literal form: closing the daemon leaves no watch —
		// and so no child process — behind.
		expect(stopWatch).toHaveBeenCalledTimes(1);
	});

	it('starts exactly one inventory when two starts race for the bind', async () => {
		const { watchDevices } = registerFakeBackend();
		temp = await createTempSocket();

		const results = await Promise.all([
			startDaemon({
				socketPath: temp.socketPath,
				artifactsRoot: temp.artifactsRoot,
				projectsRoot: temp.projectsRoot,
			}),
			startDaemon({
				socketPath: temp.socketPath,
				artifactsRoot: temp.artifactsRoot,
				projectsRoot: temp.projectsRoot,
			}),
		]);
		for (const result of results) {
			if (result.started) running.push(result);
		}

		// The loser constructs an inventory and never starts it — construction subscribes to
		// nothing, so there is no watch, and no child process, left running with nobody
		// holding a handle on it.
		expect(results.filter((result) => result.started)).toHaveLength(1);
		expect(watchDevices).toHaveBeenCalledTimes(1);
	});

	it('answers an empty list when no backend is registered', async () => {
		temp = await createTempSocket();
		await start();

		const client = await connectWithoutStarting(temp.socketPath);

		// Empty and *not* stale — the one honest empty answer: the inventory is running and
		// there is no backend to have a view, so nothing has been interrupted and nothing is
		// still unheard. A host that has gone blind answers the same list with `stale: true`,
		// and the flag is the only thing that keeps the two apart.
		await expect(client?.request('list_devices', {})).resolves.toEqual({
			devices: [],
			stale: false,
		});
		await client?.close();
	});
});

describe('who holds what, in a list reply', () => {
	it('lists a device nobody holds as free', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await start();
		const client = await connect();

		// `null` rather than an absent key: `undefined` does not survive JSON, so a missing
		// `heldBy` would make "free" something every client has to special-case.
		expect(listed(await client.request('list_devices', {})).heldBy).toBeNull();
	});

	it('names the holder of a held device with the strings the caller supplied', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await start();
		const client = await connect();

		const granted = await client.request('acquire_device', {
			serial: attached.serial,
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
		});
		expect(granted.outcome).toBe('granted');

		const heldBy = listed(await client.request('list_devices', {})).heldBy;
		// Echoed verbatim: the host stores these and never reads them (D16, D22).
		expect(heldBy).toMatchObject({
			serial: attached.serial,
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
		});
		// A duration, not an instant — the caller may share no clock with the host (D17).
		expect(heldBy?.expiresInMs).toBeGreaterThan(0);
		expect(heldBy?.expiresInMs).toBeLessThanOrEqual(LEASE_TTL_MS);
	});

	it('never puts the lease id in a list reply', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await start();
		const client = await connect();

		const granted = await client.request('acquire_device', {
			serial: attached.serial,
			owner: 'issue-112',
			project: 'rover',
		});
		if (granted.outcome !== 'granted') throw new Error('expected a granted lease');

		// The whole reply, not one key: the lease id is what *ends* a lease (D20) and a list is
		// readable by anyone who can reach the host, so this has to catch an id smuggled in
		// through any field, including one added later.
		const result = await client.request('list_devices', {});
		expect(JSON.stringify(result).includes(granted.lease.leaseId)).toBe(false);
	});

	it('lists the device as free again once its lease is released', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await start();
		const client = await connect();

		const granted = await client.request('acquire_device', {
			serial: attached.serial,
			owner: 'issue-112',
			project: 'rover',
		});
		if (granted.outcome !== 'granted') throw new Error('expected a granted lease');
		await client.request('release_device', { leaseId: granted.lease.leaseId });

		expect(listed(await client.request('list_devices', {})).heldBy).toBeNull();
	});

	it('lists a device whose lease expired as free', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await start({ leaseTtlMs: SHORT_TTL_MS });
		const client = await connect();

		await client.request('acquire_device', {
			serial: attached.serial,
			owner: 'issue-112',
			project: 'rover',
		});

		// Polled on the condition, never slept on: the expiry is observed by the read itself —
		// every read of the store drops a record whose instant has passed — so this asks again
		// until the answer changes rather than assuming when it will.
		await waitForCondition({
			what: 'the expired lease to stop being listed as a holder',
			timeoutMs: CONDITION_TIMEOUT_MS,
			pollIntervalMs: CONDITION_POLL_MS,
			probe: async () => {
				const heldBy = listed(await client.request('list_devices', {})).heldBy;
				return heldBy === null
					? { met: true, value: undefined }
					: { met: false, found: 'still held' };
			},
		});
	});
});
