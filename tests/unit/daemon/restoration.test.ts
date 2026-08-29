/**
 * Forced state restoration (D9) — the daemon puts the device back, on both paths.
 *
 * **The expiry suite is the row's headline criterion** (PROJECT.md §9.3, R9): a teardown that
 * only runs when a well-behaved client remembers to call `release_device` is the predecessor's
 * failure with a daemon around it. So that suite calls nothing that ends a lease on purpose —
 * it moves the clock and lets the sweep notice, which is exactly what happens when the agent
 * holding the device has died.
 *
 * The handlers are driven directly rather than over a socket: what is asserted here is the
 * order of the work and who waits for whom, and a real unix socket adds nothing to that
 * (`acquire-device.test.ts` is where the wire itself is exercised). The clock is the same
 * mutable closure `leases.test.ts` uses — nothing in this file waits on real time.
 *
 * The backend records into one shared array rather than answering with mocks, because every
 * assertion here is about **order**: which step ran before which, and whether a grant landed
 * before the restoration it was supposed to wait for.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Capabilities } from '@/core/capabilities.js';
import type { DeviceBackend } from '@/core/device.js';
import { type AppId, type LeaseId, parseAppId, parseDeviceSerial } from '@/core/ids.js';
import { createDeviceInventory } from '@/daemon/inventory.js';
import { createLeaseHandlers, type LeaseHandlers } from '@/daemon/lease-handlers.js';
import { createLeaseStore, type LeaseStore } from '@/daemon/leases.js';
import { createDeviceRestorer, type ProjectRestoration } from '@/daemon/restore.js';
import { createMockDevice } from '../../helpers/factories.js';

const SERIAL = parseDeviceSerial('attached-1');
const APP = parseAppId('com.example.rover');
const OTHER_APP = parseAppId('com.example.rover.helper');
const TTL_MS = 60_000;

/** What a fully restored device looks like, in the order PROJECT.md §6 says is correct. */
const FULL_RESTORATION = [
	`stopApp ${APP}`,
	`stopApp ${OTHER_APP}`,
	'setAirplaneMode false',
	'setWifiEnabled true',
	'teardown',
];

interface Harness {
	readonly handlers: LeaseHandlers;
	readonly leases: LeaseStore;
	/** Every step the device and the project hook performed, in the order they performed it. */
	readonly performed: string[];
	readonly warnings: string[];
	settle(): Promise<void>;
	at(instant: number): void;
	acquire(owner: string): Promise<LeaseId>;
}

interface HarnessOptions {
	readonly capabilities?: Partial<Capabilities>;
	readonly backend?: (performed: string[]) => Partial<DeviceBackend>;
	/** Defaults to two apps and a hook; `null` is the R17-shaped "nobody described it". */
	readonly project?: (performed: string[]) => ProjectRestoration | null;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const performed: string[] = [];
	const warnings: string[] = [];
	let nowMs = 1_000_000;

	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: {
				canReadScreen: true,
				canInput: true,
				canControlNetwork: true,
				...options.capabilities,
			},
		},
		backend: createRecordingBackend(performed, options.backend?.(performed) ?? {}),
	});

	const inventory = createDeviceInventory({ warn: (message) => warnings.push(message) });
	const restorer = createDeviceRestorer({
		inventory,
		resolveProject: () =>
			options.project
				? options.project(performed)
				: {
						apps: [APP, OTHER_APP],
						teardown: async () => {
							performed.push('teardown');
						},
					},
		warn: (message) => warnings.push(message),
	});
	const leases = createLeaseStore({
		ttlMs: TTL_MS,
		now: () => nowMs,
		onLeaseEnded: (lease, reason) => restorer.restore(lease, reason),
		warn: (message) => warnings.push(message),
	});

	return {
		handlers: createLeaseHandlers(inventory, leases, restorer),
		leases,
		performed,
		warnings,
		settle: () => restorer.settle(SERIAL),
		at: (instant: number) => {
			nowMs = instant;
		},
		async acquire(owner: string): Promise<LeaseId> {
			const result = await this.handlers.acquire_device({
				serial: SERIAL,
				owner,
				project: 'rover',
			});
			if (result.outcome !== 'granted') {
				throw new Error(`the acquire must be granted, got '${result.message}'`);
			}
			return result.lease.leaseId;
		},
	};
}

/**
 * A backend whose every relevant method appends what it did to `performed`. Plain functions
 * rather than `vi.fn()` — the assertions are about the order of the whole sequence, which one
 * shared array says far more directly than four separate call lists.
 */
function createRecordingBackend(
	performed: string[],
	overrides: Partial<DeviceBackend>,
): DeviceBackend {
	return {
		listDevices: async () => [createMockDevice({ serial: SERIAL })],
		watchDevices: () => ({ stop: async () => {} }),
		describeDevice: async (serial) => createMockDevice({ serial }),
		deviceInfo: async () => {
			throw new Error('deviceInfo is not part of a restoration');
		},
		installApp: async () => {},
		launchApp: async () => {},
		stopApp: async (_serial, appId: AppId) => {
			performed.push(`stopApp ${appId}`);
		},
		clearAppData: async () => {},
		screenshot: async () => new Uint8Array(),
		setAirplaneMode: async (_serial, enabled: boolean) => {
			performed.push(`setAirplaneMode ${enabled}`);
		},
		setWifiEnabled: async (_serial, enabled: boolean) => {
			performed.push(`setWifiEnabled ${enabled}`);
		},
		...overrides,
	};
}

/** A promise the test resolves by hand, so nothing here waits on a duration. */
function createGate(): { reached: Promise<void>; reach: () => void } {
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	return { reached, reach };
}

afterEach(() => {
	_resetDeviceBackendRegistryForTesting();
});

describe('the teardown runs when a lease expires', () => {
	it('restores the device with nobody having released it', async () => {
		const harness = createHarness();
		await harness.acquire('issue-112');

		// The whole point of the row: the agent that held this device is gone. It issues no
		// further calls, and there is nothing in this test that ends its lease — the instant
		// passes, and the daemon's own sweep is what notices.
		harness.at(1_000_000 + TTL_MS);
		harness.leases.sweep();
		await harness.settle();

		expect(harness.performed).toEqual(FULL_RESTORATION);
		expect(harness.warnings).toEqual([]);
	});

	it('restores when a competing acquire is what observes the expiry', async () => {
		const harness = createHarness();
		await harness.acquire('issue-112');

		harness.at(1_000_000 + TTL_MS);
		const leaseId = await harness.acquire('pr-127-review');

		// The new lessee's own grant observed the dead one and waited out its restoration, so
		// every step above is behind it rather than racing it.
		expect(harness.performed).toEqual(FULL_RESTORATION);
		expect(leaseId).toBeTruthy();
	});
});

describe('the teardown runs when a lease is released', () => {
	it('restores the device after release_device', async () => {
		const harness = createHarness();
		const leaseId = await harness.acquire('issue-112');

		expect(harness.handlers.release_device({ leaseId })).toEqual({ released: true });
		await harness.settle();

		expect(harness.performed).toEqual(FULL_RESTORATION);
	});

	it('answers the release without waiting for the device', async () => {
		const gate = createGate();
		const harness = createHarness({
			backend: (performed) => ({
				stopApp: async (_serial, appId) => {
					await gate.reached;
					performed.push(`stopApp ${appId}`);
				},
			}),
		});
		const leaseId = await harness.acquire('issue-112');

		// The answer is "the lease is over", and that is true the moment the record is gone —
		// the device is still mid-restoration here.
		expect(harness.handlers.release_device({ leaseId })).toEqual({ released: true });
		expect(harness.performed).toEqual([]);

		gate.reach();
		await harness.settle();
		expect(harness.performed).toEqual(FULL_RESTORATION);
	});

	it('restores exactly once per lease, however many times the end is looked for', async () => {
		const harness = createHarness();
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		harness.handlers.release_device({ leaseId });
		harness.at(1_000_000 + TTL_MS);
		harness.leases.sweep();
		harness.leases.sweep();
		await harness.settle();

		// `forget` fires the hook, and a record is only forgotten once. A second restoration
		// would be a device torn down under whoever acquired it in between.
		expect(harness.performed).toEqual(FULL_RESTORATION);
	});
});

describe('a step that fails does not take the rest with it', () => {
	it('runs every remaining step and says which one failed', async () => {
		const harness = createHarness({
			backend: () => ({
				setAirplaneMode: async () => {
					throw new Error('the device refused');
				},
			}),
		});
		const leaseId = await harness.acquire('issue-112');

		expect(harness.handlers.release_device({ leaseId })).toEqual({ released: true });
		await harness.settle();

		// A teardown that stops at the first error is "only runs on the happy path" in a new
		// costume: the app would be left running because a radio would not turn off.
		expect(harness.performed).toEqual([
			`stopApp ${APP}`,
			`stopApp ${OTHER_APP}`,
			'setWifiEnabled true',
			'teardown',
		]);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain('airplane mode');
		expect(harness.warnings[0]).toContain('the device refused');
	});

	it('frees the device for the next lessee even so', async () => {
		const harness = createHarness({
			project: (performed) => ({
				apps: [APP],
				teardown: async () => {
					performed.push('teardown');
					throw new Error('the project hook broke');
				},
			}),
		});
		const leaseId = await harness.acquire('issue-112');
		harness.handlers.release_device({ leaseId });

		await expect(harness.acquire('pr-127-review')).resolves.toBeTruthy();
	});
});

describe('a backend that cannot control the network', () => {
	it('skips those two steps with one warning and still runs the rest', async () => {
		const harness = createHarness({ capabilities: { canControlNetwork: false } });
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		await harness.settle();

		// An honest opt-out is not a failure (D11), and a teardown is not a verb an agent
		// called — there is nobody to hand a `MissingCapabilityError` to.
		expect(harness.performed).toEqual([`stopApp ${APP}`, `stopApp ${OTHER_APP}`, 'teardown']);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain('canControlNetwork');
		expect(harness.warnings[0]).toContain(SERIAL);
	});
});

describe('the project seam R17 fills', () => {
	it('does not reject a later grant when the resolver itself throws', async () => {
		const harness = createHarness({
			project: () => {
				throw new Error('the project file is unreadable');
			},
		});
		const leaseId = await harness.acquire('issue-112');
		harness.handlers.release_device({ leaseId });

		// `settle` is awaited inside `acquire_device`. A restoration that rejected would come
		// back to the next caller as `internal_error` about a device that is perfectly fine.
		await expect(harness.acquire('pr-127-review')).resolves.toBeTruthy();
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain('the project file is unreadable');
	});

	it('restores the radios and says nothing about a project nobody has described', async () => {
		const harness = createHarness({ project: () => null });
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		await harness.settle();

		// No configuration source exists yet, so the app and hook steps have nothing to do. A
		// hook that does not fire yet is not a hook that is broken.
		expect(harness.performed).toEqual(['setAirplaneMode false', 'setWifiEnabled true']);
		expect(harness.warnings).toEqual([]);
	});
});

describe('a device is never granted mid-restore', () => {
	it('makes the next acquire wait for the restoration in flight rather than race it', async () => {
		const teardownGate = createGate();
		const reachedWifi = createGate();
		const harness = createHarness({
			backend: (performed) => ({
				setWifiEnabled: async (_serial, enabled) => {
					performed.push(`setWifiEnabled ${enabled}`);
					reachedWifi.reach();
				},
			}),
			project: (performed) => ({
				apps: [APP],
				teardown: async () => {
					await teardownGate.reached;
					performed.push('teardown');
				},
			}),
		});
		const leaseId = await harness.acquire('issue-112');
		harness.handlers.release_device({ leaseId });

		const acquiring = harness.acquire('pr-127-review').then((granted) => {
			harness.performed.push('granted');
			return granted;
		});

		// Waited on the condition, not on a duration: the restoration is provably past its
		// third step and stuck in the project hook.
		await reachedWifi.reached;
		expect(harness.performed).not.toContain('granted');

		teardownGate.reach();
		await acquiring;

		expect(harness.performed).toEqual([
			`stopApp ${APP}`,
			'setAirplaneMode false',
			'setWifiEnabled true',
			'teardown',
			'granted',
		]);
	});
});
