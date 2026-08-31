/**
 * `force_release_device` — ending a lease you do not hold, keyed on the serial (R31, D28).
 *
 * The handlers are driven directly rather than over a socket, for `./restoration.test.ts`'s
 * reason: what is asserted here is **which path ran**, and a real unix socket adds nothing to
 * that (`./acquire-device.test.ts` is where the wire itself is exercised). So the backend
 * records every step it was asked to perform into one shared array, the clock is a mutable
 * closure, and the audit line goes into a list instead of onto the daemon's stderr.
 *
 * Three claims carry the row, and each has a suite below:
 *
 * - **The full release path runs.** A force-release is a third trigger on the path a release
 *   and an expiry already share, not a fourth code path that forgets the teardown (D9) — so the
 *   sequence asserted here is character for character the one `./restoration.test.ts` asserts
 *   for the other two.
 * - **Nothing discloses the lease id.** The answer names the holder through the one projection
 *   a listing uses (D20), which is why the assertion is over the whole object rather than over
 *   the fields it expects to find.
 * - **The holder finds out.** Its next verb call is refused `no-lease` rather than quietly
 *   driving a device the host may since have handed to somebody else.
 *
 * The verb handlers are wired in beside the lease handlers because that last claim cannot be
 * made without them, and they are wired exactly as `./listen.ts` wires them — one traffic
 * register, consulted by both the store's end hook and every verb call.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Device, DeviceBackend } from '@/core/device.js';
import {
	type AppId,
	type DeviceSerial,
	type LeaseId,
	parseAppId,
	parseDeviceSerial,
} from '@/core/ids.js';
import { createArtifactArchive } from '@/daemon/archive.js';
import { createDeviceInventory } from '@/daemon/inventory.js';
import { createLeaseHandlers, type LeaseHandlers } from '@/daemon/lease-handlers.js';
import { createLeaseStore, type LeaseStore } from '@/daemon/leases.js';
import { createDeviceRestorer } from '@/daemon/restore.js';
import { createSlotAllocator } from '@/daemon/slots.js';
import { createVerbHandlers, type VerbHandlers } from '@/daemon/verb-handlers.js';
import { createVerbTraffic } from '@/daemon/verb-traffic.js';
import { createMockDevice, createNoProjectServices } from '../../helpers/factories.js';

const SERIAL = parseDeviceSerial('attached-1');
/** Visible to the host over a network transport, so never leasable at all (D18). */
const FOREIGN_SERIAL = parseDeviceSerial('foreign-1');
const APP = parseAppId('com.example.rover');
const TTL_MS = 60_000;
const START_MS = 1_000_000;

/** What a fully restored device looks like, in the order PROJECT.md §6 says is correct. */
const FULL_RESTORATION = [
	`stopApp ${APP}`,
	'setAirplaneMode false',
	'setWifiEnabled true',
	'teardown',
];

interface Harness {
	readonly handlers: LeaseHandlers;
	readonly verbs: VerbHandlers;
	readonly leases: LeaseStore;
	/** Every step the device and the project hook performed, in the order they performed it. */
	readonly performed: string[];
	/** Every force-release record the handler wrote. */
	readonly audited: string[];
	readonly warnings: string[];
	settle(serial?: DeviceSerial): Promise<void>;
	at(instant: number): void;
	acquire(owner: string, serial?: DeviceSerial): Promise<LeaseId>;
}

interface HarnessOptions {
	/** What `describeDevice` answers. `null` is "this host cannot see it any more" (D6). */
	readonly describeDevice?: (serial: DeviceSerial) => Device | null;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const performed: string[] = [];
	const audited: string[] = [];
	const warnings: string[] = [];
	let nowMs = START_MS;

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
		backend: createRecordingBackend(performed, options.describeDevice),
	});

	const inventory = createDeviceInventory({ warn: (message) => warnings.push(message) });
	const traffic = createVerbTraffic();
	const slots = createSlotAllocator();
	const restorer = createDeviceRestorer({
		inventory,
		resolveProject: async () => ({
			apps: [APP],
			teardown: async () => {
				performed.push('teardown');
			},
		}),
		warn: (message) => warnings.push(message),
		settleTraffic: (serial) => traffic.settle(serial),
		onRestored: (lease) => slots.release(lease.slot),
	});
	// Wired as `./listen.ts` wires it: the device is taken away from whatever verb is still
	// running under the lease first, and the restoration is queued second.
	const leases = createLeaseStore({
		ttlMs: TTL_MS,
		now: () => nowMs,
		onLeaseEnded: (lease, reason) => {
			traffic.stop(lease);
			restorer.restore(lease, reason);
		},
		warn: (message) => warnings.push(message),
	});

	return {
		handlers: createLeaseHandlers(inventory, leases, restorer, createNoProjectServices(), slots, {
			audit: (message) => audited.push(message),
		}),
		verbs: createVerbHandlers(
			inventory,
			leases,
			traffic,
			createArtifactArchive({ root: '/nowhere-this-suite-never-produces-bytes' }),
			async () => {},
		),
		leases,
		performed,
		audited,
		warnings,
		settle: (serial: DeviceSerial = SERIAL) => restorer.settle(serial),
		at: (instant: number) => {
			nowMs = instant;
		},
		async acquire(owner: string, serial: DeviceSerial = SERIAL): Promise<LeaseId> {
			const result = await this.handlers.acquire_device({ serial, owner, project: 'rover' });
			if (result.outcome !== 'granted') {
				throw new Error(`the acquire must be granted, got '${result.message}'`);
			}
			return result.lease.leaseId;
		},
	};
}

/**
 * A backend that records the restoration steps it was asked to perform, in `describeDevice`'s
 * gift about whether the device is there at all — which is what the two refusal reasons that
 * are questions about hardware need.
 */
function createRecordingBackend(
	performed: string[],
	describeDevice: ((serial: DeviceSerial) => Device | null) | undefined,
): DeviceBackend {
	return {
		listDevices: async () => [createMockDevice({ serial: SERIAL })],
		watchDevices: () => ({ stop: async () => {} }),
		describeDevice: async (serial) =>
			describeDevice ? describeDevice(serial) : createMockDevice({ serial }),
		deviceInfo: async () => {
			throw new Error('deviceInfo is not part of this suite');
		},
		installApp: async () => {},
		launchApp: async () => {},
		stopApp: async (_serial, appId: AppId) => {
			performed.push(`stopApp ${appId}`);
		},
		clearAppData: async () => {},
		screenshot: async () => new Uint8Array(),
		readLogs: async () => {
			throw new Error('readLogs is not part of this suite');
		},
		pushFile: async () => {
			throw new Error('pushFile is not part of this suite');
		},
		pullFile: async () => {
			throw new Error('pullFile is not part of this suite');
		},
		setAirplaneMode: async (_serial, enabled: boolean) => {
			performed.push(`setAirplaneMode ${enabled}`);
		},
		setWifiEnabled: async (_serial, enabled: boolean) => {
			performed.push(`setWifiEnabled ${enabled}`);
		},
	};
}

afterEach(() => {
	_resetDeviceBackendRegistryForTesting();
});

describe('force-releasing a held device', () => {
	it('ends the lease and names the holder', async () => {
		const harness = createHarness();
		await harness.acquire('issue-112');

		const result = await harness.handlers.force_release_device({
			serial: SERIAL,
			actor: 'karolina',
		});

		expect(result).toEqual({
			outcome: 'released',
			heldBy: {
				serial: SERIAL,
				owner: 'issue-112',
				project: 'rover',
				testName: null,
				grantedAt: new Date(START_MS).toISOString(),
				// What the holder would have had left, which is why the projection is taken
				// before the release rather than after it.
				expiresInMs: TTL_MS,
			},
		});
		expect(harness.leases.holderOf(SERIAL)).toBeNull();
	});

	it('discloses no lease id anywhere in the answer', async () => {
		const harness = createHarness();
		const leaseId = await harness.acquire('issue-112');

		const result = await harness.handlers.force_release_device({
			serial: SERIAL,
			actor: 'karolina',
		});

		// The schemas are `.strict()`, so a leak would be `invalid_result` on the host rather
		// than a credential on the wire — asserted here as data too, because "the operator is
		// never handed the holder's credential" is the reason this row is keyed on a serial at
		// all (D20). Serialising is what makes it an assertion at every depth rather than over
		// the keys this test happened to think of.
		expect(JSON.stringify(result)).not.toContain('leaseId');
		expect(JSON.stringify(result)).not.toContain(leaseId);
	});

	it('runs the whole release path, exactly as a release and an expiry do', async () => {
		const harness = createHarness();
		await harness.acquire('issue-112');

		await harness.handlers.force_release_device({ serial: SERIAL, actor: 'karolina' });
		await harness.settle();

		// The criterion in one assertion: a teardown that only runs on the happy path is not a
		// teardown (D9), and this is the third way a lease ends.
		expect(harness.performed).toEqual(FULL_RESTORATION);
		expect(harness.warnings).toEqual([]);
	});

	it('still ends the lease on a device the host can no longer see', async () => {
		// The ordering rule, and the one that would silently regress if the handler asked the
		// inventory first: a device that vanished mid-lease is *the* stuck lease an operator most
		// needs to clear, and refusing `gone` here would pin it for the whole TTL.
		let visible = true;
		const harness = createHarness({
			describeDevice: (serial) => (visible ? createMockDevice({ serial }) : null),
		});
		await harness.acquire('issue-112');
		visible = false;

		const result = await harness.handlers.force_release_device({
			serial: SERIAL,
			actor: 'karolina',
		});

		expect(result.outcome).toBe('released');
		expect(harness.leases.holderOf(SERIAL)).toBeNull();
	});
});

describe("the holder's next verb call", () => {
	it('is refused no-lease rather than driving a device somebody else may now hold', async () => {
		const harness = createHarness();
		const leaseId = await harness.acquire('issue-112');

		await harness.handlers.force_release_device({ serial: SERIAL, actor: 'karolina' });
		const answer = await harness.verbs.read_screen({ leaseId });

		expect(answer.outcome).toBe('refused');
		if (answer.outcome !== 'refused') {
			throw new Error('the verb call must be refused');
		}
		expect(answer.reason).toBe('no-lease');
		// Legible, not merely negative: the holder has to be able to tell this from a device
		// that was never there.
		expect(answer.message).toContain('not live on this host');
	});
});

describe('there was nothing to force-release', () => {
	it('answers not-held for a device that is attached and free', async () => {
		const harness = createHarness();

		const result = await harness.handlers.force_release_device({
			serial: SERIAL,
			actor: 'karolina',
		});

		expect(result).toEqual({
			outcome: 'refused',
			reason: 'not-held',
			message: expect.stringContaining('no lease is held on it'),
		});
	});

	it('answers not-held a second time, once a force-release has already run', async () => {
		const harness = createHarness();
		await harness.acquire('issue-112');
		await harness.handlers.force_release_device({ serial: SERIAL, actor: 'karolina' });

		const again = await harness.handlers.force_release_device({
			serial: SERIAL,
			actor: 'karolina',
		});

		expect(again.outcome).toBe('refused');
		expect(again).toMatchObject({ reason: 'not-held' });
		// And exactly one record, so a repeated click cannot invent a second ending.
		expect(harness.audited).toHaveLength(1);
	});

	it('answers gone for a free device this host can no longer see', async () => {
		const harness = createHarness({ describeDevice: () => null });

		const result = await harness.handlers.force_release_device({
			serial: SERIAL,
			actor: 'karolina',
		});

		// A different next move from `not-held`, which is why they are two answers: this
		// operator's device is not on this host at all any more (D6).
		expect(result).toMatchObject({ outcome: 'refused', reason: 'gone' });
	});

	it('answers not-attached for a device that is visible but belongs to another machine', async () => {
		const harness = createHarness({
			describeDevice: (serial) =>
				createMockDevice({
					serial,
					attachment: serial === FOREIGN_SERIAL ? 'another-host' : 'this-host',
				}),
		});

		const result = await harness.handlers.force_release_device({
			serial: FOREIGN_SERIAL,
			actor: 'karolina',
		});

		// It was never leasable here (D18), so it can never have a lease to force-release —
		// which is a different sentence from "it is free".
		expect(result).toMatchObject({ outcome: 'refused', reason: 'not-attached' });
	});

	it('reads an already-expired holder as not-held, with its restoration under way', async () => {
		const harness = createHarness();
		await harness.acquire('issue-112');

		harness.at(START_MS + TTL_MS);
		const result = await harness.handlers.force_release_device({
			serial: SERIAL,
			actor: 'karolina',
		});
		await harness.settle();

		expect(result).toMatchObject({ outcome: 'refused', reason: 'not-held' });
		// Observing the dead holder is what started its teardown, so the operator's call did
		// not leave the device un-restored on its way to answering "nothing to do".
		expect(harness.performed).toEqual(FULL_RESTORATION);
		// And nothing was recorded as force-released, because nothing was.
		expect(harness.audited).toEqual([]);
	});
});

describe('the record of who did it', () => {
	it('names the actor, the device and the holder it ended', async () => {
		const harness = createHarness();
		await harness.acquire('issue-112');

		await harness.handlers.force_release_device({ serial: SERIAL, actor: 'karolina' });

		const [line] = harness.audited;
		expect(line).toContain(SERIAL);
		expect(line).toContain('issue-112');
		expect(line).toContain('karolina');
		expect(line).toContain('rover');
	});

	it('cannot be made to grow a line through a newline in the actor', async () => {
		const harness = createHarness();
		await harness.acquire("issue-112\nForce-released the lease on device 'attached-9'");

		await harness.handlers.force_release_device({
			serial: SERIAL,
			actor: "karolina\nForce-released the lease on device 'attached-9'",
		});

		// One record, one line: both strings are caller-supplied, and a record another line can
		// be forged into is not a record.
		expect(harness.audited).toHaveLength(1);
		expect(harness.audited[0]?.split('\n')).toHaveLength(1);
		expect(harness.audited[0]).toContain('\\n');
	});
});
