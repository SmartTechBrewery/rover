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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
			capabilities: {
				canReadScreen: true,
				canInput: false,
				canControlNetwork: true,
				canRecordVideo: true,
			},
		},
		backend: createMockDeviceBackend({ watchDevices, describeDevice }),
	});
}

async function start(): Promise<RunningDaemon> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
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

/** The common case: one backend reporting one ready device, and a daemon serving it. */
async function serveReadyDevice(describeDevice?: DeviceBackend['describeDevice']): Promise<void> {
	registerFakeBackend(describeDevice);
	temp = await createTempSocket();
	await start();
}

function acquire(
	client: IpcClient,
	owner: string,
	extra: {
		serial?: DeviceSerial;
		project?: string;
		testName?: string;
		testDescription?: string;
		groupId?: string;
	} = {},
): Promise<AcquireDeviceResult> {
	return client.request('acquire_device', {
		serial: extra.serial ?? SERIAL,
		owner,
		project: extra.project ?? 'rover',
		testName: extra.testName ?? 'home screen',
		// Left off entirely when the test names none, which is what absent means on this wire.
		...(extra.testDescription === undefined ? {} : { testDescription: extra.testDescription }),
		...(extra.groupId === undefined ? {} : { groupId: extra.groupId }),
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
			canRecordVideo: true,
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

	it('carries no slot and no port, because those are host state (R18)', async () => {
		await serveReadyDevice();
		const client = await connect();

		const result = await acquire(client, 'issue-112');

		if (result.outcome !== 'granted') throw new Error('expected a granted lease');
		// `GrantedLeaseSchema` is `.strict()`, so this is belt and braces — and it is the
		// assertion that says out loud that a lease's ports are the host's, told to the hooks
		// the host runs and to nobody on the wire.
		expect(Object.keys(result.lease).sort()).toEqual([
			'expiresInMs',
			'leaseId',
			'owner',
			'project',
			'serial',
			'testName',
		]);
	});

	it("echoes the caller's test name back verbatim, unparsed", async () => {
		await serveReadyDevice();
		const client = await connect();

		const result = await acquire(client, 'issue-112', { testName: 'home screen' });

		if (result.outcome !== 'granted') throw new Error('expected a granted lease');
		expect(result.lease.testName).toBe('home screen');
	});

	/*
	 * The optional fourth string (D22, as amended #148), echoed back verbatim on the grant — and
	 * **absent as an absent key** for a caller who supplied none, which is the assertion the key
	 * set above is worth making: there is no empty string and no invented placeholder.
	 */
	it("echoes the caller's description back, and answers no key without one", async () => {
		await serveReadyDevice();
		const client = await connect();
		const testDescription = 'Checks the home screen keeps its top space after the theme change.';

		const described = await acquire(client, 'issue-112', { testDescription });
		const plain = await acquire(client, 'pr-127-review', {
			serial: parseDeviceSerial('attached-2'),
		});

		if (described.outcome !== 'granted' || plain.outcome !== 'granted') {
			throw new Error('expected two granted leases');
		}
		expect(described.lease.testDescription).toBe(testDescription);
		expect('testDescription' in plain.lease).toBe(false);
	});

	/*
	 * The fifth string (D22, as amended #150), echoed back on the grant — and echoed back for a
	 * reason beyond symmetry: it is the string the caller passes to the *next* acquire in the
	 * comparison, so a grant that swallowed it would leave an agent guessing at what it just sent.
	 * Absent is an absent key, exactly as the description above.
	 */
	it("echoes the caller's group back, and answers no key without one", async () => {
		await serveReadyDevice();
		const client = await connect();

		const grouped = await acquire(client, 'issue-150', { groupId: 'app-bar-top-space' });
		const plain = await acquire(client, 'pr-127-review', {
			serial: parseDeviceSerial('attached-2'),
		});

		if (grouped.outcome !== 'granted' || plain.outcome !== 'granted') {
			throw new Error('expected two granted leases');
		}
		expect(grouped.lease.groupId).toBe('app-bar-top-space');
		expect('groupId' in plain.lease).toBe(false);
	});

	/*
	 * The holder a stranger is shown carries it too, so a refusal and a listing cannot disagree
	 * (`src/daemon/lease-holder.ts`). Read off the **refusal**, which is the half a second agent
	 * actually meets.
	 */
	it('names the holder’s group in the refusal a second caller gets', async () => {
		await serveReadyDevice();
		const client = await connect();
		await acquire(client, 'issue-150', { groupId: 'app-bar-top-space' });

		const refused = await acquire(client, 'someone-else');

		if (refused.outcome !== 'refused' || refused.heldBy === null) {
			throw new Error('expected a refusal naming the holder');
		}
		expect(refused.heldBy.groupId).toBe('app-bar-top-space');
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

/**
 * A project's **helper services** over the real socket (D13, R17 phase 4): a real hook file, a
 * real child process per service, and the refusal a start that fails becomes.
 *
 * `restoration.test.ts` pins the order the stops run in; what this suite adds is the wire — that
 * the refusal is **data** carrying the service's name rather than an `internal_error`, and that a
 * device refused this way is left free for whoever asks next.
 */
describe('a project that declares helper services', () => {
	const PROJECT = 'checkout-web';

	/** Every line the hooks appended, in the order they appended it. */
	async function hooksThatRan(): Promise<string[]> {
		const contents = await readFile(join(temp.dir, 'hooks.log'), 'utf8').catch(() => '');
		return contents.split('\n').filter((line) => line !== '');
	}

	/** A hook that appends `what` to the log and exits 0. */
	function appendHook(what: string): { command: string; args: string[] } {
		return {
			command: process.execPath,
			args: [
				'-e',
				"require('node:fs').appendFileSync(process.argv[1], process.argv[2] + '\\n')",
				join(temp.dir, 'hooks.log'),
				what,
			],
		};
	}

	/** Written before the daemon starts, into the temp projects root nothing pre-creates. */
	async function writeHookFile(services: unknown): Promise<void> {
		await mkdir(temp.projectsRoot, { recursive: true });
		await writeFile(
			join(temp.projectsRoot, `${PROJECT}.json`),
			JSON.stringify({ project: PROJECT, services }),
			'utf8',
		);
	}

	it('starts them before the grant is answered', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await writeHookFile([
			{ name: 'db', start: appendHook('start db'), stop: appendHook('stop db') },
			{ name: 'api', start: appendHook('start api') },
		]);
		await start();
		const client = await connect();

		const result = await acquire(client, 'issue-112', { project: PROJECT });

		expect(result.outcome).toBe('granted');
		// Answered *after* they were started, in declaration order: a caller holding a lease has
		// the services that lease implies, not services that are still coming up.
		expect(await hooksThatRan()).toEqual(['start db', 'start api']);
	});

	it('refuses by name when one will not start, as data rather than an error', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await writeHookFile([
			{ name: 'db', start: appendHook('start db'), stop: appendHook('stop db') },
			{
				name: 'api',
				start: {
					command: process.execPath,
					args: ['-e', "process.stderr.write('the api would not bind'); process.exit(3)"],
				},
			},
		]);
		await start();
		const client = await connect();

		const result = await acquire(client, 'issue-112', { project: PROJECT });

		// Granting a device whose helper services are down is a false yes (ai/RULES.md §2). It is
		// a refusal and never an IPC error: `internal_error` means the host broke, and an agent
		// told that learns nothing it can act on.
		if (result.outcome !== 'refused') throw new Error('the acquire must be refused');
		expect(result.reason).toBe('service-failed');
		expect(result.message).toContain("'api'");
		expect(result.message).toContain('the api would not bind');
		expect(result.heldBy).toBeNull();
		// What the grant had already started is down again, before the answer travelled.
		expect(await hooksThatRan()).toContain('stop db');
	});

	it('leaves the device free for the next caller after refusing one', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await writeHookFile([
			{ name: 'api', start: { command: process.execPath, args: ['-e', 'process.exit(3)'] } },
		]);
		await start();
		const client = await connect();
		await acquire(client, 'issue-112', { project: PROJECT });

		// The lease the refused grant took was handed straight back, so a caller on a project
		// with no such services is not queueing behind a twenty-minute TTL nobody is using.
		const other = await acquire(client, 'pr-127-review', { project: 'rover' });

		expect(other.outcome).toBe('granted');
	});

	it('grants exactly as it does today when the project has no hook file', async () => {
		await serveReadyDevice();
		const client = await connect();

		// A project nobody has described is the ordinary state of a host: nothing is started,
		// nothing is refused, and no directory is created for one either.
		await expect(acquire(client, 'issue-112', { project: 'unregistered' })).resolves.toMatchObject({
			outcome: 'granted',
		});
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

	it('rejects a missing test name — it is refused, never defaulted (D22, as amended #129)', async () => {
		await serveReadyDevice();
		const client = await connect();

		const rejection = client.request('acquire_device', {
			serial: SERIAL,
			owner: 'issue-112',
			project: 'rover',
		} as never);

		// A refusal naming the field rather than a lease filed under a directory the code
		// invented for a caller who named nothing.
		await expect(rejection).rejects.toBeInstanceOf(IpcRequestError);
		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
	});

	/*
	 * `.strict()` still covers the optional key: a typo'd `testDescriptoin` is `invalid_params`
	 * rather than a lease quietly granted with the description dropped, which is exactly the
	 * failure an *optional* field would otherwise make silent (D22, as amended #148).
	 */
	it('rejects a typo’d description key rather than dropping it', async () => {
		await serveReadyDevice();
		const client = await connect();

		const rejection = client.request('acquire_device', {
			serial: SERIAL,
			owner: 'issue-112',
			project: 'rover',
			testName: 'home screen',
			testDescriptoin: 'Checks the home screen.',
		} as never);

		await expect(rejection).rejects.toBeInstanceOf(IpcRequestError);
		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
	});

	/*
	 * The same for the group (D22, as amended #150), and it is worth its own case rather than
	 * being assumed from the one above: an optional key silently lost is a comparison that can
	 * never be recovered, and the second lease would look fine.
	 */
	it('rejects a typo’d group key rather than dropping it', async () => {
		await serveReadyDevice();
		const client = await connect();

		const rejection = client.request('acquire_device', {
			serial: SERIAL,
			owner: 'issue-150',
			project: 'rover',
			testName: 'home screen',
			groupID: 'app-bar-top-space',
		} as never);

		await expect(rejection).rejects.toBeInstanceOf(IpcRequestError);
		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
	});

	it('rejects an empty group id — absent is the only way to say nothing', async () => {
		await serveReadyDevice();
		const client = await connect();

		const rejection = client.request('acquire_device', {
			serial: SERIAL,
			owner: 'issue-150',
			project: 'rover',
			testName: 'home screen',
			groupId: '',
		});

		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
	});

	// An empty one is not a description, so it is refused rather than stored and rendered blank.
	it('rejects an empty description — absent is the only way to say nothing', async () => {
		await serveReadyDevice();
		const client = await connect();

		const rejection = client.request('acquire_device', {
			serial: SERIAL,
			owner: 'issue-112',
			project: 'rover',
			testName: 'home screen',
			testDescription: '',
		});

		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
	});

	/**
	 * A whitespace-only id is the gap `.min(1)` does not close, and the branded-id parsers
	 * *throw* on one. Zod lets an exception raised inside a `.transform()` escape
	 * `safeParse`, so before `DeviceSerialSchema`/`LeaseIdSchema` refined ahead of the
	 * transform, one such frame from any client rejected an unawaited `dispatchFrame` and
	 * took the whole daemon down with it — every other client's leases included.
	 *
	 * So each case asserts two things: the frame is refused as `invalid_params`, and the
	 * daemon is still there afterwards to refuse the next one.
	 */
	it.each([
		['acquire_device', { serial: ' ', owner: 'issue-112', project: 'rover' }],
		['acquire_device', { serial: '\t', owner: 'issue-112', project: 'rover' }],
		['release_device', { leaseId: ' ' }],
	])('refuses %s with a whitespace-only id and stays alive', async (method, params) => {
		await serveReadyDevice();
		const client = await connect();

		const rejection = client.request(method as never, params as never);

		await expect(rejection).rejects.toBeInstanceOf(IpcRequestError);
		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });

		// A fresh connection, because a dead daemon would also have dropped the first one.
		const survivor = await connect();
		await expect(survivor.request('status', {})).resolves.toMatchObject({ pid: process.pid });
	});
});
