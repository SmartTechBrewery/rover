import { afterEach, describe, expect, it } from 'vitest';
// Side-effect import: this is what puts a backend in the registry, which is where the
// restorer under test resolves the device's platform to something it can drive.
import '@/backends/index.js';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import type { Device } from '@/core/device.js';
import { parseAppId } from '@/core/ids.js';
import { createDeviceInventory } from '@/daemon/inventory.js';
import { createLeaseHandlers } from '@/daemon/lease-handlers.js';
import { createLeaseStore } from '@/daemon/leases.js';
import { createDeviceRestorer } from '@/daemon/restore.js';

/**
 * Forced state restoration (D9) driven by the **daemon layer** against a real device.
 *
 * `./network.test.ts` proves the two primitives move a real radio, and the unit suite
 * (`tests/unit/daemon/restoration.test.ts`) proves the daemon fires them on both paths over a
 * fake backend. Neither one proves the join: that the store's end hook, the restorer and the
 * registry resolve to the device in front of you and drive it without a step failing. That is
 * all this suite is for, and it is why it is short.
 *
 * Unlike its siblings this one imports the backend barrel and builds the daemon's own objects
 * rather than a backend class, so it is closer to the exemption's end than the rest of
 * `tests/device/` (ai/TESTING.md, "The exemption"): what is still missing is a *running*
 * daemon on a socket — `src/daemon/main.ts` does not import the barrel — not a lease.
 *
 * **What this deliberately does not cover, so silence is not read as "checked":**
 *
 * - **No assertion reads a radio back**, for the reason `./network.test.ts` records at
 *   length: `DeviceBackend` has no network getter. What is asserted is that the daemon ran
 *   every step against the device and none of them reported a failure — an empty warning log
 *   is the restorer's own statement that nothing was skipped or swallowed.
 * - **Nothing here asserts an interval fired.** The sweep is called by hand, so this suite
 *   says nothing about `LEASE_SWEEP_INTERVAL_MS` beyond it being what `listen.ts` passes.
 *
 * It changes something an operator would notice, so the same two rules as `./network.test.ts`
 * bind: `ROVER_TEST_LOCAL_DEVICE` only (a device reached over a network transport would have
 * its own transport cut), and the resting state is restored in `afterEach` unconditionally.
 */

/** Present on every Android build, and safe to open and close under someone else's eyes. */
const SETTINGS = parseAppId('com.android.settings');
const TTL_MS = 60_000;

/** Only for arranging and cleaning up — never for the restoration this suite is about. */
const backend = new AndroidDeviceBackend();

/** The daemon's own objects, wired exactly as `startDaemon` wires them. */
function createHost() {
	const warnings: string[] = [];
	let nowMs = 1_000_000;
	let hookRan = false;

	const inventory = createDeviceInventory({ warn: (message) => warnings.push(message) });
	const restorer = createDeviceRestorer({
		inventory,
		// Standing in for R17, which is what will supply this from a project file.
		resolveProject: () => ({
			apps: [SETTINGS],
			teardown: async () => {
				hookRan = true;
			},
		}),
		warn: (message) => warnings.push(message),
	});
	const leases = createLeaseStore({
		ttlMs: TTL_MS,
		now: () => nowMs,
		onLeaseEnded: (lease, reason) => restorer.restore(lease, reason),
		warn: (message) => warnings.push(message),
	});

	return {
		leases,
		restorer,
		warnings,
		handlers: createLeaseHandlers(inventory, leases, restorer),
		hookRan: () => hookRan,
		at: (instant: number) => {
			nowMs = instant;
		},
	};
}

/**
 * Ready **and physically attached** — stricter than the sibling suites' filter for the same
 * reason `./network.test.ts` is: this suite can take a device off the network it is reached
 * over.
 */
async function firstLocalDevice(): Promise<Device> {
	const usable = (await backend.listDevices()).filter(
		(device) => device.state === 'ready' && device.attachment === 'this-host',
	);
	expect(
		usable.length,
		"no device is both state 'ready' and attachment 'this-host' — this suite may only " +
			'touch a device physically attached to this host (D18), and the gate found one when ' +
			'the run started',
	).toBeGreaterThan(0);
	return usable[0] as Device;
}

/**
 * Leave the device the way a lease could have left it: airplane mode on, wifi off, the app
 * open. Driven through the backend class like every sibling suite — the daemon path is what
 * is under test, so setting up for it must not go through the daemon.
 */
async function dirty(device: Device): Promise<void> {
	await backend.launchApp(device.serial, SETTINGS);
	await backend.setAirplaneMode(device.serial, true);
	await backend.setWifiEnabled(device.serial, false);
}

/** The state an operator expects to find the device in, whatever a test did to it. */
async function reset(device: Device): Promise<void> {
	// Airplane mode first and wifi last, for the reason PROJECT.md §6 gives.
	await backend.setAirplaneMode(device.serial, false);
	await backend.setWifiEnabled(device.serial, true);
	await backend.stopApp(device.serial, SETTINGS);
}

describe.skipIf(!process.env.ROVER_TEST_LOCAL_DEVICE)('the daemon restores a real device', () => {
	afterEach(async () => {
		await reset(await firstLocalDevice());
	});

	it('runs every step after release_device, without the caller asking', async () => {
		const host = createHost();
		const device = await firstLocalDevice();
		const granted = await host.handlers.acquire_device({
			serial: device.serial,
			owner: 'device-suite',
			project: 'rover',
		});
		if (granted.outcome !== 'granted') {
			throw new Error(`the acquire must be granted, got '${granted.message}'`);
		}
		await dirty(device);

		expect(host.handlers.release_device({ leaseId: granted.lease.leaseId })).toEqual({
			released: true,
		});
		await host.restorer.settle(device.serial);

		// Nothing warned: every step reached the device and the device accepted it.
		expect(host.warnings).toEqual([]);
		expect(host.hookRan()).toBe(true);
	});

	it('runs every step when the lease simply expires', async () => {
		const host = createHost();
		const device = await firstLocalDevice();
		const granted = await host.handlers.acquire_device({
			serial: device.serial,
			owner: 'device-suite',
			project: 'rover',
		});
		if (granted.outcome !== 'granted') {
			throw new Error(`the acquire must be granted, got '${granted.message}'`);
		}
		await dirty(device);

		// The agent that held this device is gone: it hands nothing back, and the sweep is
		// what notices. There is no release in this test.
		host.at(1_000_000 + TTL_MS);
		host.leases.sweep();
		await host.restorer.settle(device.serial);

		expect(host.warnings).toEqual([]);
		expect(host.hookRan()).toBe(true);
	});
});
