import { afterEach, describe, expect, it } from 'vitest';
// Side-effect import: exactly what `src/daemon/main.ts` now does. Without it the daemon this
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
 * Host-side verb execution (D19, R21) against a real device: a daemon on a socket, a lease
 * taken over it, and a verb dispatched by the process that owns the hardware.
 *
 * `tests/unit/daemon/verb-dispatch.test.ts` proves the dispatch over a fake backend, and
 * `tests/unit/no-backend-in-a-client.test.ts` proves a client cannot reach one. Neither
 * proves the join — that the socket, a real device re-verified through its backend, the
 * registry lookup and the answer coming back all hold against hardware in front of you. That
 * is all this suite is for, and it is why it is short.
 *
 * **This is the first suite in `tests/device/` that takes its lease from a running daemon**
 * (ai/TESTING.md, "The exemption"), which is the shape the others convert to.
 *
 * **What this deliberately does not cover, so silence is not read as "checked":**
 *
 * - **No real screen is read.** The backend honestly declares `canReadScreen: false` until
 *   `read_screen` lands (R13), so both waits and any target-by-text answer
 *   `missing-capability` — which is itself an assertion below, because a loud, structured
 *   refusal naming the real device and the real backend is exactly what D11 asks of a
 *   capability nothing backs. When that flag flips, this suite gains the assertions it cannot
 *   make today: a wait that resolves off a real read, a tap that lands on a named button, and
 *   a timeout naming what was on screen instead.
 * - **A point-addressed `tap` does run on the hardware**, and it is the one call here that
 *   reaches the device rather than being refused before it: the verb resolves the coordinate
 *   against the real screen size, converts it, and injects. What is *not* proved is what the
 *   tap did — nothing here can read the screen back — which is why the point below is one
 *   where a tap does nothing.
 * - **`long_press` and `scroll` are not exercised here at all.** Neither can be told from a
 *   plain tap without watching the device: the injection succeeds either way. Both were
 *   confirmed by hand against a real device, and the threshold a long press has to clear is
 *   recorded in PROJECT.md §6.
 * - What *is* proved against the hardware is everything either side of the screen read: the
 *   daemon lends this machine's own device over a socket, derives it from the lease id,
 *   re-verifies it through its backend on every call (D6), reaches the verb layer with a
 *   context built from it, and brings the answer back as data.
 *
 * It changes no setting and touches no radio, so `ROVER_TEST_DEVICE` rather than the local-only
 * gate — a device reached over a network transport is a perfectly good subject for a tap. Its
 * lease is released in `afterEach`.
 */

/** Text no screen carries, so both directions of the wait are deterministic. */
const ABSENT = { by: 'text', text: 'rover-r21-absent-text' } as const;

/**
 * A coordinate in the top-left corner of the panel, where a tap does nothing on any screen a
 * device happens to be showing.
 *
 * This suite runs against whatever is in front of it and has no verb to put the device back
 * (`press_key` is #12 phase 3), so the tap it injects has to be one that needs no putting
 * back. In dp, because that is the space `Point` is declared in — the conversion to the pixels
 * the device takes is the backend's, and asserting it is `tests/device/android/input.test.ts`'s
 * job rather than this suite's.
 */
const HARMLESS_POINT = { by: 'point', at: { x: 1, y: 1 } } as const;

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
 * The first free, ready device the **daemon** reports.
 *
 * Polled rather than read once: the inventory is a subscription, and the host's first frame
 * arrives a moment after it starts watching. A condition with a deadline, not a sleep.
 */
async function freeDevice(client: IpcClient): Promise<ListedDevice> {
	return waitForCondition<ListedDevice>({
		what: 'the host to report a free, ready device',
		timeoutMs: INVENTORY_TIMEOUT_MS,
		pollIntervalMs: INVENTORY_POLL_MS,
		probe: async (): Promise<Observation<ListedDevice>> => {
			const { devices, stale } = await client.request('list_devices', {});
			const free = devices.find((device) => device.state === 'ready' && device.heldBy === null);
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
		owner: 'issue-21',
		project: 'rover',
		testName: 'verb-dispatch',
	});
	if (outcome.outcome !== 'granted') {
		throw new Error(`The host refused a lease on '${serial}': ${outcome.message}`);
	}
	leases.push({ client, leaseId: outcome.lease.leaseId });
	return outcome.lease.leaseId;
}

afterEach(async () => {
	for (const { client, leaseId } of leases.splice(0)) {
		await client.request('release_device', { leaseId });
	}
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	if (temp) {
		await removeTempSocket(temp);
	}
});

describe.skipIf(!process.env.ROVER_TEST_DEVICE)('a daemon runs verbs on its own device', () => {
	it('dispatches a verb against the device its lease names, and answers as data', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const answer = await client.request('wait_until_gone', {
			leaseId,
			target: ABSENT,
			timeoutMs: 0,
		});

		// The whole path in one assertion: socket, dispatch, a real device re-verified through its
		// own backend, the registry lookup, the verb layer, and a structured answer back. It names
		// the serial the *lease* is on, which the client never sent (D20).
		expect(answer).toMatchObject({
			outcome: 'failed',
			failure: {
				kind: 'missing-capability',
				capability: 'canReadScreen',
				serial: device.serial,
				platform: device.platform,
			},
		});
		// A refusal an agent can act on, not an `internal_error`: `client.request` resolved.
		if (answer.outcome !== 'failed' || answer.failure.kind !== 'missing-capability') {
			throw new Error('the assertion above should have caught this');
		}
		expect(answer.failure.message).toContain(device.serial);
		expect(answer.failure.backendLabel.length).toBeGreaterThan(0);
	});

	it('answers the other wait the same way, off the same connection', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		// Same client, same connection, same envelope as the `acquire_device` above — verb calls
		// travel on the surface the lease operations already use (R6, D19).
		const answer = await client.request('wait_for', {
			leaseId,
			target: ABSENT,
			timeoutMs: 2_000,
			pollIntervalMs: 500,
		});

		expect(answer).toMatchObject({ outcome: 'failed', failure: { kind: 'missing-capability' } });
	});

	it('taps a coordinate on the device the lease names', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const answer = await client.request('tap', { leaseId, target: HARMLESS_POINT });

		// The whole path again, and this time with something reaching the hardware at the far
		// end of it: the verb range-checked the coordinate against the screen the device
		// reported, the backend converted it and injected, and the answer came back as data.
		expect(answer).toMatchObject({
			outcome: 'ok',
			result: {
				verb: 'tap',
				device: { serial: device.serial },
				// A coordinate is the documented fallback and the result says it was one (D12(a)).
				target: { source: 'caller-point', point: HARMLESS_POINT.at, element: null },
			},
		});
		// This device cannot read its screen yet, so the honest post-state is the capability that
		// would have answered — never an empty element list, which would read as a blank screen.
		expect(answer).toMatchObject({
			result: { after: { kind: 'unavailable', capability: 'canReadScreen' } },
		});
	});

	it('refuses a tap by text until the device can read its own screen', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const answer = await client.request('tap', { leaseId, target: ABSENT });

		// D11 working rather than a gap: the target has to come off a screen read, the backend
		// declares it cannot do one, and the refusal names the capability instead of guessing.
		expect(answer).toMatchObject({
			outcome: 'failed',
			failure: { kind: 'missing-capability', capability: 'canReadScreen', serial: device.serial },
		});
	});

	it('refuses a verb call once the lease is over', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);
		await client.request('release_device', { leaseId: leases.pop()?.leaseId ?? leaseId });

		const answer = await client.request('wait_until_gone', {
			leaseId,
			target: ABSENT,
			timeoutMs: 0,
		});

		expect(answer).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
	});
});
