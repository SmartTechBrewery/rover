import { afterEach, describe, expect, it } from 'vitest';
// Side-effect import: exactly what `src/daemon/main.ts` now does. Without it the daemon this
// suite starts would have an empty registry and lend nothing.
import '@/backends/index.js';
import { type DeviceSerial, type LeaseId, parseAppId } from '@/core/ids.js';
import { type Observation, waitForCondition } from '@/core/wait.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import type { ListedDevice } from '@/ipc/methods.js';
import { IpcRequestError } from '@/ipc/protocol.js';
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
 * - **`clear_app_data` has no success case here**, for the reason
 *   `tests/device/android/app-control.test.ts` already records: a successful clear destroys an
 *   application's data, and there is no package on an arbitrary device whose data is safe for
 *   a test suite to destroy. Its dispatch is covered over a stub backend in
 *   `tests/unit/daemon/verb-dispatch.test.ts` instead.
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

/**
 * Present on every Android build, and safe to open and close under someone else's eyes —
 * the same package `tests/device/android/app-control.test.ts` drives, for the same reason.
 */
const SETTINGS = parseAppId('com.android.settings');

/** A package no device has. Both halves matter: it is not installed, and it never will be. */
const ABSENT_PACKAGE = parseAppId('com.rover.no.such.package');

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

	/**
	 * The app rows against real hardware: a package really launched and really stopped, over a
	 * lease, by the process that owns the device. Both halves run in one test so the suite
	 * leaves the device as it found it.
	 */
	it('launches and stops a real app on the device the lease names', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const launched = await client.request('launch_app', { leaseId, appId: SETTINGS });

		expect(launched).toMatchObject({
			outcome: 'ok',
			result: {
				verb: 'launch_app',
				device: { serial: device.serial },
				// An app id addresses a package, so no screen was read to resolve anything and there
				// is nothing on it to report — `null` is a fact about the verb (D12(a)).
				target: null,
				// This device cannot read its screen yet, so the honest post-state is the capability
				// that would have answered — never an empty element list.
				after: { kind: 'unavailable', capability: 'canReadScreen' },
			},
		});

		const stopped = await client.request('stop_app', { leaseId, appId: SETTINGS });

		expect(stopped).toMatchObject({
			outcome: 'ok',
			result: { verb: 'stop_app', device: { serial: device.serial }, target: null },
		});
	});

	/**
	 * Pins what the code **actually answers** today rather than what it should. The backend
	 * rejects for a package the device does not have, nothing converts that into a
	 * `VerbFailure`, and so an agent reads `internal_error` — "the host broke" — for an
	 * ordinary answer about a device. That is a pre-existing, repo-wide gap every verb family
	 * shares, and it is filed as its own issue rather than widened into this change.
	 */
	it('reports a package the device does not have as internal_error, for now', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const thrown = await client
			.request('launch_app', { leaseId, appId: ABSENT_PACKAGE })
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(IpcRequestError);
		expect((thrown as IpcRequestError).code).toBe('internal_error');
	});

	/**
	 * `am force-stop` prints nothing and exits 0 whether it stopped something or the package was
	 * never there (PROJECT.md §6), so this answers `ok` — which is the honest report of what the
	 * device said, not a claim that anything was stopped. What settles it is the after-state,
	 * once `read_screen` (#13) lands.
	 */
	it('cannot tell a stopped app from a package that was never there', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const answer = await client.request('stop_app', { leaseId, appId: ABSENT_PACKAGE });

		expect(answer).toMatchObject({ outcome: 'ok', result: { verb: 'stop_app' } });
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
