/**
 * Per-slot port allocation for helper services (R18) — the pool, and the pool over a grant.
 *
 * **The two suites answer two different questions.** The first is arithmetic and bookkeeping:
 * what a slot's ports are, that a released one comes back, and what happens when there are
 * none left. The second is the row's actual criterion, and it is about *when*: that two
 * concurrent grants cannot be handed one block, and that a slot orphaned by an agent that died
 * without releasing is reclaimed on the same lease-expiry path restoration runs on (D9) rather
 * than by a timer of its own.
 *
 * The concurrency test is R8's five-client test in a second costume, and it holds every caller
 * at a **barrier inside `describeDevice`** — the only `await` on the grant path — so all five
 * are provably past it before any reaches the store. Nothing here waits on a duration; the
 * clock is the same mutable closure `leases.test.ts` and `restoration.test.ts` use.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { DeviceBackend } from '@/core/device.js';
import { type DeviceSerial, type LeaseId, parseDeviceSerial } from '@/core/ids.js';
import { createDeviceInventory } from '@/daemon/inventory.js';
import { createLeaseHandlers, type LeaseHandlers } from '@/daemon/lease-handlers.js';
import { createLeaseStore, type LeaseStore } from '@/daemon/leases.js';
import type { DeviceRestorer } from '@/daemon/restore.js';
import { createDeviceRestorer } from '@/daemon/restore.js';
import {
	createSlotAllocator,
	PORTS_PER_SLOT,
	SLOT_COUNT,
	SLOT_PORT_BASE,
	type Slot,
	type SlotAllocator,
} from '@/daemon/slots.js';
import { createMockDevice, createNoProjectServices } from '../../helpers/factories.js';

const TTL_MS = 60_000;
const START_MS = 1_000_000;

describe('the slot pool on its own', () => {
	it('hands out distinct, non-overlapping blocks in index order', () => {
		const slots = createSlotAllocator();

		const first = slots.allocate();
		const second = slots.allocate();

		// The derivation is pinned against the exported constants rather than described: a hook
		// is told these numbers, and a change to the arithmetic has to be a deliberate one.
		expect(first).toEqual({ index: 0, portBase: SLOT_PORT_BASE, portCount: PORTS_PER_SLOT });
		expect(second).toEqual({
			index: 1,
			portBase: SLOT_PORT_BASE + PORTS_PER_SLOT,
			portCount: PORTS_PER_SLOT,
		});
		// The property a helper service actually depends on: the blocks do not overlap.
		expect(second?.portBase).toBeGreaterThanOrEqual(
			(first?.portBase ?? 0) + (first?.portCount ?? 0),
		);
		expect(slots.taken()).toBe(2);
		expect(slots.size).toBe(SLOT_COUNT);
	});

	it('reuses the lowest free index once one is given back', () => {
		const slots = createSlotAllocator();
		const first = slots.allocate();
		const second = slots.allocate();
		if (!first || !second) throw new Error('both allocations must succeed');

		slots.release(first);

		expect(slots.taken()).toBe(1);
		expect(slots.allocate()).toEqual(first);
	});

	it('answers null when every slot is taken, and says how many that was', () => {
		const slots = createSlotAllocator({ count: 3 });

		const taken = [slots.allocate(), slots.allocate(), slots.allocate()];

		expect(taken.every((slot) => slot !== null)).toBe(true);
		// Named rather than degraded: a lease granted with no ports would be the silent
		// half-success ai/RULES.md §2 forbids, and the caller is the one that turns this into a
		// refusal an agent can act on.
		expect(slots.allocate()).toBeNull();
		expect(slots.taken()).toBe(3);
		expect(slots.size).toBe(3);
	});

	it('treats releasing an already-free slot as nothing at all', () => {
		const slots = createSlotAllocator();
		const slot = slots.allocate();
		if (!slot) throw new Error('the allocation must succeed');

		slots.release(slot);
		slots.release(slot);

		// A double release must not make room that is not there, or `taken()` would drift below
		// what is actually out and the pool would hand one block to two live leases.
		expect(slots.taken()).toBe(0);
		expect(slots.allocate()).toEqual(slot);
		expect(slots.taken()).toBe(1);
	});

	it('keeps every port below the ephemeral range the OS hands out on its own', () => {
		const slots = createSlotAllocator();
		const last = lastSlotOf(slots);

		// 32768 is the lowest ephemeral base of the platforms this runs on (Linux's). A slot
		// inside that range could be handed to an unrelated process while a lease holds it, and
		// nothing here binds a port, so nothing here would notice.
		expect(SLOT_PORT_BASE).toBeGreaterThan(1023);
		expect(last.portBase + last.portCount).toBeLessThan(32_768);
	});
});

describe('a slot per lease, over the grant path', () => {
	afterEach(() => {
		_resetDeviceBackendRegistryForTesting();
	});

	it('gives five concurrent grants five distinct, disjoint blocks', async () => {
		const serials = ['device-a', 'device-b', 'device-c', 'device-d', 'device-e'].map(
			parseDeviceSerial,
		);
		const barrier = createBarrier(serials.length);
		const harness = createHarness({ beforeDescribe: () => barrier.arrive() });

		const grants = serials.map((serial) => harness.acquire(serial, 'issue-112'));
		// Every one of them is now past `describeDevice` — the only await on the grant path —
		// so the five reach the allocator and the store with nothing left to interleave on.
		await barrier.reached;
		barrier.release();
		await Promise.all(grants);

		const slots = serials.map((serial) => harness.leases.holderOf(serial)?.slot);
		expect(slots.every((slot) => slot !== undefined)).toBe(true);
		// The row's criterion: five leases, five different numbers. An allocator that read and
		// wrote across an await would hand at least two of these the same block.
		expect(new Set(slots.map((slot) => slot?.index)).size).toBe(serials.length);
		expect(new Set(slots.map((slot) => slot?.portBase)).size).toBe(serials.length);
		expect(harness.slots.taken()).toBe(serials.length);
		expect(overlapping(slots)).toEqual([]);
	});

	it('consumes no slot when the device is already held', async () => {
		const harness = createHarness();
		const serial = parseDeviceSerial('device-a');
		await harness.acquire(serial, 'issue-112');

		const refused = await harness.handlers.acquire_device({
			serial,
			owner: 'pr-127-review',
			project: 'rover',
		});

		expect(refused).toMatchObject({ outcome: 'refused', reason: 'held' });
		// The slot the refused grant took is handed straight back, still synchronously: one
		// leaked per contended acquire would exhaust this host without a lease being held.
		expect(harness.slots.taken()).toBe(1);
	});

	it('frees the slot when the lease is released — but not before the teardown ran', async () => {
		const takenDuringTeardown: number[] = [];
		const harness = createHarness({
			teardown: (slots) => {
				takenDuringTeardown.push(slots.taken());
			},
		});
		const serial = parseDeviceSerial('device-a');
		const leaseId = await harness.acquire(serial, 'issue-112');

		harness.handlers.release_device({ leaseId });
		await harness.restorer.settleAll();

		// The teardown is the thing that was told these ports, and the allocator hands out the
		// lowest free index — so freeing them at `onLeaseEnded` would give the very next grant
		// a block the previous lessee's `stop` is still on.
		expect(takenDuringTeardown).toEqual([1]);
		expect(harness.slots.taken()).toBe(0);
	});

	it('reclaims an orphaned slot on the expiry path, with nobody left to ask', async () => {
		const harness = createHarness();
		const serial = parseDeviceSerial('device-a');
		const orphaned = (await harness.holderSlotAfterAcquire(serial)).index;

		// The agent holding this device died: it issues no further call, nothing here releases
		// its lease, and the daemon's own sweep is what notices the instant has passed (D9).
		harness.at(START_MS + TTL_MS);
		harness.leases.sweep();
		await harness.restorer.settleAll();

		// The row's headline criterion, on the lease-expiry path and no other clock.
		expect(harness.slots.taken()).toBe(0);
		const reused = await harness.holderSlotAfterAcquire(parseDeviceSerial('device-b'));
		expect(reused.index).toBe(orphaned);
	});

	it('refuses by name when the pool is empty, and leaves the lease holding it alone', async () => {
		const harness = createHarness({ slots: createSlotAllocator({ count: 1 }) });
		const held = parseDeviceSerial('device-a');
		const leaseId = await harness.acquire(held, 'issue-112');

		const refused = await harness.handlers.acquire_device({
			serial: parseDeviceSerial('device-b'),
			owner: 'pr-127-review',
			project: 'rover',
		});

		// A refusal an agent can act on — release something and ask again — rather than a lease
		// with no ports or an `internal_error` claiming the host broke.
		expect(refused.outcome).toBe('refused');
		if (refused.outcome !== 'refused') throw new Error('the second grant must be refused');
		expect(refused.reason).toBe('no-slot');
		expect(refused.message).toContain('device-b');
		expect(refused.message).toContain('1');
		expect(refused.heldBy).toBeNull();
		// The first lease is untouched by somebody else's refusal, and still releasable.
		expect(harness.leases.holderOf(held)?.id).toBe(leaseId);
		expect(harness.handlers.release_device({ leaseId })).toEqual({ released: true });
	});
});

interface Harness {
	readonly handlers: LeaseHandlers;
	readonly leases: LeaseStore;
	readonly restorer: DeviceRestorer;
	readonly slots: SlotAllocator;
	at(instant: number): void;
	acquire(serial: DeviceSerial, owner: string): Promise<LeaseId>;
	/** Acquire and hand back the slot the store recorded for the new holder. */
	holderSlotAfterAcquire(serial: DeviceSerial): Promise<{ index: number; portBase: number }>;
}

interface HarnessOptions {
	/** Defaults to a full pool. A one-slot pool is what proves the exhaustion refusal. */
	readonly slots?: SlotAllocator;
	/** Awaited inside `describeDevice` — the one await on the grant path. */
	readonly beforeDescribe?: () => Promise<void>;
	/** Called from the project teardown, so a test can look at the pool while it runs. */
	readonly teardown?: (slots: SlotAllocator) => void;
}

/**
 * The daemon's grant and end paths, wired the way `listen.ts` wires them and no other way:
 * one allocator, taken in `createLeaseHandlers` and given back from the restorer's
 * `onRestored`. A harness that released the slot anywhere else would prove nothing about the
 * daemon.
 */
function createHarness(options: HarnessOptions = {}): Harness {
	let nowMs = START_MS;
	const slots = options.slots ?? createSlotAllocator();
	const warnings: string[] = [];

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
		backend: createBackend(options.beforeDescribe),
	});

	const inventory = createDeviceInventory({ warn: (message) => warnings.push(message) });
	const restorer = createDeviceRestorer({
		inventory,
		resolveProject: async () => ({
			apps: [],
			teardown: async () => options.teardown?.(slots),
		}),
		warn: (message) => warnings.push(message),
		onRestored: (lease) => slots.release(lease.slot),
	});
	const leases = createLeaseStore({
		ttlMs: TTL_MS,
		now: () => nowMs,
		onLeaseEnded: (lease, reason) => restorer.restore(lease, reason),
		warn: (message) => warnings.push(message),
	});
	const handlers = createLeaseHandlers(
		inventory,
		leases,
		restorer,
		createNoProjectServices(),
		slots,
	);

	return {
		handlers,
		leases,
		restorer,
		slots,
		at: (instant: number) => {
			nowMs = instant;
		},
		async acquire(serial: DeviceSerial, owner: string): Promise<LeaseId> {
			const result = await handlers.acquire_device({ serial, owner, project: 'rover' });
			if (result.outcome !== 'granted') {
				throw new Error(`the acquire must be granted, got '${result.message}'`);
			}
			return result.lease.leaseId;
		},
		async holderSlotAfterAcquire(serial: DeviceSerial) {
			await this.acquire(serial, 'issue-112');
			const slot = leases.holderOf(serial)?.slot;
			if (!slot) throw new Error('the new holder must carry a slot');
			return slot;
		},
	};
}

/** Enough of a backend for a grant and a restoration; nothing here is asserted about. */
function createBackend(beforeDescribe?: () => Promise<void>): DeviceBackend {
	return {
		listDevices: async () => [],
		watchDevices: () => ({ stop: async () => {} }),
		describeDevice: async (serial) => {
			// The barrier lives here because this is the grant path's only await: a test that
			// released it later would be asserting about work that had already serialised.
			await beforeDescribe?.();
			return createMockDevice({ serial });
		},
		deviceInfo: async () => {
			throw new Error('deviceInfo is not part of a grant');
		},
		installApp: async () => {},
		launchApp: async () => {},
		stopApp: async () => {},
		clearAppData: async () => {},
		screenshot: async () => new Uint8Array(),
		readLogs: async () => {
			throw new Error('readLogs is not part of a grant');
		},
		pushFile: async () => {
			throw new Error('pushFile is not part of a grant');
		},
		pullFile: async () => {
			throw new Error('pullFile is not part of a grant');
		},
		setAirplaneMode: async () => {},
		setWifiEnabled: async () => {},
	};
}

/**
 * A rendezvous for `count` callers, resolved by hand — never a delay (D12, and the no-sleep
 * gate). `reached` settles once all of them have arrived; `release` lets them all go on.
 */
function createBarrier(count: number): {
	reached: Promise<void>;
	arrive: () => Promise<void>;
	release: () => void;
} {
	let arrived = 0;
	let allArrived!: () => void;
	const reached = new Promise<void>((resolve) => {
		allArrived = resolve;
	});
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});

	return {
		reached,
		arrive: async () => {
			arrived += 1;
			if (arrived === count) {
				allArrived();
			}
			await released;
		},
		release: () => release(),
	};
}

/** The highest block a full pool hands out — drained and then given back. */
function lastSlotOf(slots: SlotAllocator): { portBase: number; portCount: number } {
	const drained: Slot[] = [];
	for (let taken = 0; taken < slots.size; taken += 1) {
		const slot = slots.allocate();
		if (!slot) throw new Error('a fresh pool must hand out every one of its slots');
		drained.push(slot);
	}
	for (const slot of drained) {
		slots.release(slot);
	}
	const last = drained.at(-1);
	if (!last) throw new Error('the pool must have at least one slot');
	return last;
}

/** Every pair of blocks that share a port — the thing that must always be empty. */
function overlapping(
	slots: ReadonlyArray<{ portBase: number; portCount: number } | undefined>,
): string[] {
	const owners = new Map<number, number>();
	const clashes: string[] = [];
	slots.forEach((slot, owner) => {
		if (!slot) return;
		for (let port = slot.portBase; port < slot.portBase + slot.portCount; port += 1) {
			const held = owners.get(port);
			if (held !== undefined) {
				clashes.push(`port ${port} was given to both lease ${held} and lease ${owner}`);
			}
			owners.set(port, owner);
		}
	});
	return clashes;
}
