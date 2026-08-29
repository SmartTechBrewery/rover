/**
 * The two halves of restoration (D9) that live in `startDaemon` rather than in the restorer:
 * the sweep interval that observes a dead holder when nobody is asking, and `close()` waiting
 * for what that observation started.
 *
 * **Both need a real daemon.** `restoration.test.ts` drives the handlers directly and calls
 * `sweep()` by hand, which proves the restoration and nothing about the wiring that fires it —
 * deleting the interval outright would leave that suite green. The daemon suite's real-socket
 * exception applies (ai/TESTING.md): a temp socket, never `~/.rover/rover.sock`, and every
 * daemon closed through its own handle.
 *
 * `sweepIntervalMs` and `leaseTtlMs` are what make the first test possible at all — the real
 * thirty seconds and twenty minutes cannot both be in a unit test. Nothing here waits on a
 * duration: every step is awaited on the condition it is about.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { DeviceBackend } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { type Observation, pause, waitForCondition } from '@/core/wait.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';

const SERIAL = parseDeviceSerial('attached-1');
const attached = createMockDevice({ serial: SERIAL });

/** Short enough that the expiry lands inside the test, long enough to survive the acquire. */
const SHORT_TTL_MS = 25;
const SHORT_SWEEP_MS = 5;

/** How long a condition below may stay unmet before the test gives up on it. */
const CONDITION_TIMEOUT_MS = 5_000;
const CONDITION_POLL_MS = 5;

/**
 * How many event-loop turns {@link drainEventLoop} gives the shutdown before concluding that
 * what is left is genuinely blocked. `close()`'s remaining work is a handful of filesystem
 * calls; this is an order of magnitude more turns than that needs.
 */
const LOOP_DRAIN_TURNS = 50;

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];

/** A promise the test resolves by hand, so nothing here waits on a duration. */
function createGate(): { reached: Promise<void>; reach: () => void } {
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	return { reached, reach };
}

interface Recorded {
	/** Every restoration step the backend performed, in order. */
	readonly performed: string[];
	/** Resolves when the airplane-mode step is entered, before `holdAirplaneMode` is awaited. */
	readonly started: Promise<void>;
	/** Resolves the first time the wifi step — the last one — runs. */
	readonly restored: Promise<void>;
}

/**
 * A backend reporting one ready device and recording the restoration steps. `holdAirplaneMode`
 * suspends the restoration provably mid-flight, which is what the shutdown test needs.
 */
function registerRecordingBackend(holdAirplaneMode?: Promise<void>): Recorded {
	const performed: string[] = [];
	const airplane = createGate();
	const wifi = createGate();

	const overrides: Partial<DeviceBackend> = {
		watchDevices: (watcher) => {
			watcher.onDevices([attached]);
			return { stop: async () => {} };
		},
		describeDevice: async (serial) => createMockDevice({ serial }),
		setAirplaneMode: async (_serial, enabled) => {
			airplane.reach();
			await holdAirplaneMode;
			performed.push(`setAirplaneMode ${enabled}`);
		},
		setWifiEnabled: async (_serial, enabled) => {
			performed.push(`setWifiEnabled ${enabled}`);
			wifi.reach();
		},
	};

	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: { canReadScreen: true, canInput: false, canControlNetwork: true },
		},
		backend: createMockDeviceBackend(overrides),
	});

	return { performed, started: airplane.reached, restored: wifi.reached };
}

async function start(options: { sweepIntervalMs?: number; leaseTtlMs?: number } = {}) {
	temp = await createTempSocket();
	const result = await startDaemon({ socketPath: temp.socketPath, ...options });
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

/** Polls on the condition with a deadline, never a wait instead of a check (ai/RULES.md §2). */
async function until(what: string, met: () => Promise<boolean> | boolean): Promise<void> {
	await waitForCondition({
		what,
		timeoutMs: CONDITION_TIMEOUT_MS,
		pollIntervalMs: CONDITION_POLL_MS,
		probe: async (): Promise<Observation<void>> =>
			(await met()) ? { met: true, value: undefined } : { met: false, found: 'it still unmet' },
	});
}

/**
 * Yield until everything already scheduled has run — timers, I/O callbacks and the microtasks
 * they queue, repeatedly, because each turn can schedule the next. Not a wait on a duration:
 * it is over when the loop has nothing of its own left to do, and what is still pending after
 * it is pending on something this test is holding.
 */
async function drainEventLoop(): Promise<void> {
	for (let turn = 0; turn < LOOP_DRAIN_TURNS; turn += 1) {
		await new Promise((resolve) => setImmediate(resolve));
		await pause(0);
	}
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	if (temp) {
		await removeTempSocket(temp);
	}
});

describe('the sweep the daemon runs on its own', () => {
	it('restores a device whose holder died, with nobody having asked', async () => {
		const recorded = registerRecordingBackend();
		await start({ sweepIntervalMs: SHORT_SWEEP_MS, leaseTtlMs: SHORT_TTL_MS });
		const client = await connect();

		await client.request('acquire_device', {
			serial: SERIAL,
			owner: 'issue-112',
			project: 'rover',
		});

		// The row's headline criterion: the agent holding this device is gone. Nothing releases
		// the lease and nothing asks another question about the device — the daemon's own
		// interval is the only thing that can notice.
		await recorded.restored;
		expect(recorded.performed).toEqual(['setAirplaneMode false', 'setWifiEnabled true']);
	});
});

describe('shutting the daemon down mid-restoration', () => {
	it('does not resolve close() until the restoration it owes has finished', async () => {
		const held = createGate();
		const recorded = registerRecordingBackend(held.reached);
		const daemon = await start();
		const client = await connect();

		const granted = await client.request('acquire_device', {
			serial: SERIAL,
			owner: 'issue-112',
			project: 'rover',
		});
		if (granted.outcome !== 'granted') throw new Error('expected a granted lease');
		// Answers the moment the record is gone, deliberately — the restoration it started is
		// still ahead of us.
		await client.request('release_device', { leaseId: granted.lease.leaseId });
		// Waited on the condition, not on a duration: the restoration is provably in flight and
		// suspended in its first device step.
		await recorded.started;

		let closed = false;
		const closing = daemon.close().then(() => {
			closed = true;
		});

		// Every other thing `close()` does is already finished — the path is unserved (the server
		// is closed before its first await), this backend's watch stops at once, and the socket
		// bookkeeping is a couple of filesystem calls. Draining the loop is what makes that
		// "already finished" rather than "probably by now": nothing but the held restoration is
		// left to run, so a `close()` that was not waiting for it would have resolved.
		await until('the daemon to stop answering', async () => {
			const probe = await connectWithoutStarting(temp.socketPath);
			await probe?.close();
			return probe === null;
		});
		await drainEventLoop();
		// A restoration has no second chance: leases die with the host (D6), so a successor
		// daemon sees no expired holder and nothing ever re-fires this teardown.
		expect(closed).toBe(false);
		expect(recorded.performed).toEqual([]);

		held.reach();
		await closing;

		// `close()` resolving is a statement that what the daemon owed the device was done, not
		// merely that it was started.
		expect(recorded.performed).toEqual(['setAirplaneMode false', 'setWifiEnabled true']);
	});
});
