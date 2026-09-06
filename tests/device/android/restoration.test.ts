import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { createSlotAllocator } from '@/daemon/slots.js';
import { createNoProjectServices } from '../../helpers/factories.js';

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
 * rather than a backend class, so it takes a lease — just not from a daemon on a socket
 * (ai/TESTING.md, "The exemption"). That is now a choice rather than a gap: `src/daemon/main.ts`
 * imports the barrel and `./verb-dispatch.test.ts` does go over a socket, but what this suite
 * asserts is the store's end hook firing on both paths, which is a layer below the protocol and
 * would only be obscured by putting one in front of it.
 *
 * **The recorder cases are the exception to that shortness** (#191). "No recorder outlives its
 * lease" is a claim about the device, and the unit suite asserts it over a mock that cannot say
 * whether the device let go — so those two cases start a real `screenrecord`, end the lease
 * without stopping it, and then ask `adb` itself whether the process is gone and the file is
 * removed.
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

const execFileAsync = promisify(execFile);
const ADB_TIMEOUT_MS = 10_000;

/**
 * The device-side scratch path the backend owns, named here rather than imported so the
 * assertion is over the path a person would look at with `adb` — the recording suite names it
 * the same way and for the same reason.
 */
const RECORDING_PATH = '/sdcard/rover-recording.mp4';

/** The recorder's own kill switch, long enough that nothing but the teardown ends it. */
const MAX_RECORDING_MS = 15_000;

/** Only for arranging and cleaning up — never for the restoration this suite is about. */
const backend = new AndroidDeviceBackend();

/** The daemon's own objects, wired exactly as `startDaemon` wires them. */
function createHost() {
	const warnings: string[] = [];
	let nowMs = 1_000_000;
	let hookRan = false;

	const inventory = createDeviceInventory({ warn: (message) => warnings.push(message) });
	// A real pool, wired the way `listen.ts` wires one: nothing here asserts about slots, but a
	// grant needs one and a lease that ended must give it back (R18).
	const slots = createSlotAllocator();
	const restorer = createDeviceRestorer({
		inventory,
		// Standing in for `project-resolver.ts`, which supplies this from a project hook file —
		// this suite is about what reaches the device, not about where the hooks came from.
		resolveProject: async () => ({
			apps: [SETTINGS],
			teardown: async () => {
				hookRan = true;
			},
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

	return {
		leases,
		restorer,
		warnings,
		// The stand-in for a host where no project declares helper services: this suite is about
		// what a restoration puts back on the device, and a grant that started nothing is the
		// honest arrangement for that.
		handlers: createLeaseHandlers(inventory, leases, restorer, createNoProjectServices(), slots),
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
	// Whatever a recording case left behind, gone — including on the path where the assertion
	// that follows it failed. This is the backend's own teardown, which is what the suite is
	// about, so it is deliberately the *only* cleanup here that could hide what it asserts;
	// every assertion below is made before this runs.
	await backend.discardRecording(device.serial);
}

/**
 * The device's own answer about whether a recorder is running — asked with `adb` directly rather
 * than through the backend, because the backend is what is under test.
 *
 * `|| true` for the reason the backend's own probe carries it: `pidof` exits 1 when nothing
 * matches, and "no such process" is the answer this is looking for.
 */
async function recorderPidsOnDevice(serial: string): Promise<string> {
	const { stdout } = await execFileAsync(
		'adb',
		['-s', serial, 'shell', 'pidof screenrecord || true'],
		{ timeout: ADB_TIMEOUT_MS },
	);
	return stdout.trim();
}

/** What `ls` says about the scratch path — the device's own words, whichever stream. */
async function listScratchFile(serial: string): Promise<string> {
	const { stdout, stderr } = await execFileAsync(
		'adb',
		['-s', serial, 'shell', 'ls', RECORDING_PATH],
		{ timeout: ADB_TIMEOUT_MS },
	).catch((error: { stdout?: string; stderr?: string }) => ({
		stdout: error.stdout ?? '',
		stderr: error.stderr ?? '',
	}));
	return `${stdout}${stderr}`;
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
			testName: 'checkout flow',
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
			testName: 'checkout flow',
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

	/**
	 * The claim #191 turns on, and the only place it can be made: a recorder the lease left
	 * running is really gone and its file is really removed.
	 *
	 * Everything the unit suite asserts about this is asserted over a mock, which cannot say
	 * whether the device let go — and `--time-limit`, which is all that bounded a stray recorder
	 * before, would keep this one running for the whole fifteen seconds and leave its file
	 * behind afterwards. So both assertions are the device's own words, read with `adb` rather
	 * than through the backend that is under test, and they are made *before* `afterEach` gets
	 * to tidy anything.
	 *
	 * The recording is started through the backend class rather than through a verb: what is
	 * under test is the teardown, and arranging for it must not go through the thing being torn
	 * down.
	 */
	it('stops a recording the lease left running, and removes its file', async () => {
		const host = createHost();
		const device = await firstLocalDevice();
		const granted = await host.handlers.acquire_device({
			serial: device.serial,
			owner: 'device-suite',
			project: 'rover',
			testName: 'checkout flow',
		});
		if (granted.outcome !== 'granted') {
			throw new Error(`the acquire must be granted, got '${granted.message}'`);
		}
		await backend.startRecording(device.serial, { maxDurationMs: MAX_RECORDING_MS });
		// The premise, asserted rather than assumed: there is really a recorder to outlive the
		// lease, so a teardown that did nothing at all could not pass this test.
		expect(await recorderPidsOnDevice(device.serial)).not.toBe('');

		// Nobody stops it. The lease simply ends — and the holder never asked for the bytes.
		expect(host.handlers.release_device({ leaseId: granted.lease.leaseId })).toEqual({
			released: true,
		});
		await host.restorer.settle(device.serial);

		expect(await recorderPidsOnDevice(device.serial)).toBe('');
		expect(await listScratchFile(device.serial)).toMatch(/No such file or directory/);
		expect(host.warnings).toEqual([]);
	}, 60_000);

	// And on the path with no caller left to ask, which is the half of D9 a teardown is most
	// likely to be missing: nothing here releases anything.
	it('stops one left running when the lease simply expires', async () => {
		const host = createHost();
		const device = await firstLocalDevice();
		const granted = await host.handlers.acquire_device({
			serial: device.serial,
			owner: 'device-suite',
			project: 'rover',
			testName: 'checkout flow',
		});
		if (granted.outcome !== 'granted') {
			throw new Error(`the acquire must be granted, got '${granted.message}'`);
		}
		await backend.startRecording(device.serial, { maxDurationMs: MAX_RECORDING_MS });
		expect(await recorderPidsOnDevice(device.serial)).not.toBe('');

		host.at(1_000_000 + TTL_MS);
		host.leases.sweep();
		await host.restorer.settle(device.serial);

		expect(await recorderPidsOnDevice(device.serial)).toBe('');
		expect(await listScratchFile(device.serial)).toMatch(/No such file or directory/);
		expect(host.warnings).toEqual([]);
	}, 60_000);
});
