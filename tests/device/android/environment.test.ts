import { afterEach, describe, expect, it } from 'vitest';
// Side-effect import: exactly what `src/daemon/main.ts` does. Without it the daemon this
// suite starts would have an empty registry and lend nothing.
import '@/backends/index.js';
import type { DeviceSerial, LeaseId } from '@/core/ids.js';
import { type Observation, waitForCondition } from '@/core/wait.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import type { ListedDevice } from '@/ipc/methods.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

/**
 * The two environment verbs against a real device, over a lease, from the process that owns
 * the hardware (D19, R21).
 *
 * `tests/device/android/network.test.ts` proves the **recipes** one layer down, driving the
 * backend class directly, and `tests/unit/daemon/verb-dispatch.test.ts` proves the dispatch
 * over a fake backend. Neither proves the join: that a client asking `set_airplane_mode` over
 * a socket reaches a real radio on a device the host derived from a lease id, with no root
 * anywhere in the path. That is all this suite is for, and it is why it is short.
 *
 * **The release in `afterEach` is the no-drift check made real.** R9's restoration
 * (`src/daemon/restore.ts`) drives the same two backend methods these verbs do, in the same
 * order, on the release path and the expiry path alike — so a suite that toggles both radios
 * through the verbs and then releases both puts the device back and demonstrates that the two
 * callers agree about the recipe. There is one recipe per toggle, in one backend; nothing
 * here can drift from the restoration without the restoration breaking too.
 *
 * **What this deliberately does not cover, so silence is not read as "checked":**
 *
 * - **No assertion reads a radio back.** `DeviceBackend` has no network getter (PROJECT.md §6
 *   records the two reads that would say, and why they were noted rather than used), so what
 *   is proved is that the device accepted the command and answered — not that the radio
 *   moved. The `after` state on each answer is the screen, which is evidence the device was
 *   still there, and never a reading of the radio.
 * - **Which way airplane mode drags wifi is not asserted either.** It moves it as a side
 *   effect whose direction depends on state the device remembers, observed both ways on one
 *   emulator (PROJECT.md §6). A test asserting either direction would be red on half the
 *   devices it ran on.
 *
 * It changes something an operator would notice, so the same two rules as
 * `./network.test.ts` bind. `ROVER_TEST_LOCAL_DEVICE` rather than `ROVER_TEST_DEVICE`: a
 * device reached over a network transport would have its own transport cut by
 * `set_wifi { enabled: false }`, and D18 says such a device is never leased anyway. And the
 * lease is released in `afterEach` **unconditionally**, including after a failed assertion,
 * which is what puts the device back.
 */

/** How long to wait for the host's first view of its devices — a subscription, not a verb. */
const INVENTORY_TIMEOUT_MS = 20_000;
const INVENTORY_POLL_MS = 100;

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
const leases: Array<{ client: IpcClient; leaseId: LeaseId }> = [];

/** A daemon of this repository's own making, on a socket nobody else uses. */
async function startHost(): Promise<IpcClient> {
	temp = await createTempSocket();
	const daemon = await startDaemon({ socketPath: temp.socketPath });
	if (!daemon.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(daemon);

	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
}

/**
 * The first free, ready, **physically attached** device the daemon reports.
 *
 * The attachment filter is stricter than the sibling verb suite's and has to be, for the
 * reason the header gives: this one can take a device off the network it is reached over.
 * Polled rather than read once — the inventory is a subscription, and the host's first frame
 * arrives a moment after it starts watching. A condition with a deadline, not a sleep.
 */
async function freeLocalDevice(client: IpcClient): Promise<ListedDevice> {
	return waitForCondition<ListedDevice>({
		what: 'the host to report a free, ready, physically attached device',
		timeoutMs: INVENTORY_TIMEOUT_MS,
		pollIntervalMs: INVENTORY_POLL_MS,
		probe: async (): Promise<Observation<ListedDevice>> => {
			const { devices, stale } = await client.request('list_devices', {});
			const free = devices.find(
				(device) =>
					device.state === 'ready' && device.attachment === 'this-host' && device.heldBy === null,
			);
			return free
				? { met: true, value: free }
				: { met: false, found: `${devices.length} devices${stale ? ' (a stale view)' : ''}` };
		},
	});
}

/** A lease on that device, taken over the same connection the verbs then use. */
async function lease(client: IpcClient, serial: DeviceSerial): Promise<LeaseId> {
	const outcome = await client.request('acquire_device', {
		serial,
		owner: 'issue-16',
		project: 'rover',
		testName: 'environment',
	});
	if (outcome.outcome !== 'granted') {
		throw new Error(`The host refused a lease on '${serial}': ${outcome.message}`);
	}
	leases.push({ client, leaseId: outcome.lease.leaseId });
	return outcome.lease.leaseId;
}

afterEach(async () => {
	// Unconditional, and first: releasing is what fires the restoration that puts the radios
	// back, whatever the assertions above did or failed to do.
	for (const { client, leaseId } of leases.splice(0)) {
		await client.request('release_device', { leaseId });
	}
	await Promise.all(clients.splice(0).map((client) => client.close()));
	// `close()` waits for the restorations in flight, so the device is settled before the next
	// test's daemon starts watching it.
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	if (temp) {
		await removeTempSocket(temp);
	}
});

describe.skipIf(!process.env.ROVER_TEST_LOCAL_DEVICE)(
	'a daemon runs the environment verbs on its own device',
	() => {
		it('turns airplane mode on and off again over a lease', async () => {
			const client = await startHost();
			const device = await freeLocalDevice(client);
			const leaseId = await lease(client, device.serial);

			for (const enabled of [true, false]) {
				const answer = await client.request('set_airplane_mode', { leaseId, enabled });

				// The whole path in one assertion: socket, dispatch, a real device re-verified
				// through its own backend, the registry lookup, the verb layer, a real radio, and a
				// structured answer back naming the serial the *lease* is on (D20).
				expect(answer).toMatchObject({
					outcome: 'ok',
					// No target: a radio is not something on the screen.
					result: { verb: 'set_airplane_mode', target: null, device: { serial: device.serial } },
				});
			}
		});

		it('turns wifi off and on again over a lease', async () => {
			const client = await startHost();
			const device = await freeLocalDevice(client);
			const leaseId = await lease(client, device.serial);

			for (const enabled of [false, true]) {
				const answer = await client.request('set_wifi', { leaseId, enabled });

				expect(answer).toMatchObject({
					outcome: 'ok',
					result: { verb: 'set_wifi', target: null, device: { serial: device.serial } },
				});
			}
		});

		/**
		 * Every verb returns the state after itself (D12(c)), and on a device that can read its
		 * screen that state is the screen — read *after* the toggle, inside the verb. It is
		 * evidence the device was still there and answering; it is not, and must not be read as,
		 * a reading of the radio.
		 */
		it('answers with the state after the toggle, read off the device', async () => {
			const client = await startHost();
			const device = await freeLocalDevice(client);
			const leaseId = await lease(client, device.serial);

			const answer = await client.request('set_wifi', { leaseId, enabled: false });

			expect(answer.outcome).toBe('ok');
			if (answer.outcome !== 'ok') throw new Error('the assertion above should have caught this');
			expect(answer.result.after.kind).toBe('screen');
			// And the device it names is described from the hardware, density and all (D14).
			expect(answer.result.device.screen.density).toBeGreaterThan(0);
		});

		/**
		 * Asking for the state the device is already in. The restoration sets a resting state
		 * without reading it first — there is nothing to read it with — so every call it makes is
		 * potentially this one, and a verb that refused a no-op would fail every release of a
		 * device nobody had touched.
		 */
		it('accepts being asked for a state the device is already in', async () => {
			const client = await startHost();
			const device = await freeLocalDevice(client);
			const leaseId = await lease(client, device.serial);

			await client.request('set_airplane_mode', { leaseId, enabled: false });
			await expect(
				client.request('set_airplane_mode', { leaseId, enabled: false }),
			).resolves.toMatchObject({ outcome: 'ok' });
			await client.request('set_wifi', { leaseId, enabled: true });
			await expect(client.request('set_wifi', { leaseId, enabled: true })).resolves.toMatchObject({
				outcome: 'ok',
			});
		});
	},
);
