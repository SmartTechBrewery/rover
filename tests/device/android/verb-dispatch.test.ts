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
 * **The screen read is real since #13**, and that is what the assertions below are built
 * on: a wait that resolves off a read of the device in front of you, a wait that times out
 * naming what was on screen instead, and a tap that resolves an element id off one read and
 * lands on it in the next. Where this suite used to assert `missing-capability`, it now
 * asserts the thing the capability was standing in for.
 *
 * **What this deliberately does not cover, so silence is not read as "checked":**
 *
 * - **No control is tapped by name.** Every target here is either absent from the screen or
 *   the element under the same harmless corner point the suite already taps, because this
 *   suite runs against whatever screen is in front of it and has no verb to put the device
 *   back (`launch_app` and `press_key` have no IPC row yet). Text matching against a real
 *   read is proved by the waits instead, which resolve a string taken off the device's own
 *   screen without touching it.
 * - **What a tap did is still not asserted.** The after-state now says what the screen looks
 *   like, but the point tapped is chosen so that nothing changes, so the read is evidence
 *   that the read works rather than evidence about the tap.
 * - **`long_press` and `scroll` are not exercised here at all.** Neither can be told from a
 *   plain tap without watching the device: the injection succeeds either way. Both were
 *   confirmed by hand against a real device, and the threshold a long press has to clear is
 *   recorded in PROJECT.md §6.
 * - What *is* proved against the hardware is the whole path: the daemon lends this machine's
 *   own device over a socket, derives it from the lease id, re-verifies it through its
 *   backend on every call (D6), reaches the verb layer with a context built from it, reads
 *   the real screen inside the verb, and brings the answer back as data.
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
		// own backend, the registry lookup, the verb layer, a screen read off the hardware, and a
		// structured answer back. It names the serial the *lease* is on, which the client never
		// sent (D20).
		expect(answer).toMatchObject({
			outcome: 'ok',
			result: { verb: 'wait_until_gone', device: { serial: device.serial } },
		});
		if (answer.outcome !== 'ok') throw new Error('the assertion above should have caught this');
		// The condition was decided against a screen that was actually read — an `unavailable`
		// after-state here would mean the wait had resolved off nothing.
		expect(answer.result.after.kind).toBe('screen');
	});

	/**
	 * The second half of the read: a wait that cannot be met has to say **what was on screen
	 * instead**, because the agent's next move depends on the difference between "not there
	 * yet" and "on a screen you did not expect".
	 *
	 * Same client, same connection, same envelope as the `acquire_device` above — verb calls
	 * travel on the surface the lease operations already use (R6, D19).
	 */
	it('times out naming what was on the screen instead of what it waited for', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const answer = await client.request('wait_for', {
			leaseId,
			target: ABSENT,
			timeoutMs: 2_000,
			pollIntervalMs: 500,
		});

		expect(answer).toMatchObject({ outcome: 'failed', failure: { kind: 'wait-timeout' } });
		if (answer.outcome !== 'failed' || answer.failure.kind !== 'wait-timeout') {
			throw new Error('the assertion above should have caught this');
		}
		expect(answer.failure.waitedFor).toContain(ABSENT.text);
		// Not "nothing": the read happened, and the message describes the screen it happened on.
		expect(answer.failure.found.length).toBeGreaterThan(0);
		expect(answer.failure.polls).toBeGreaterThan(0);
	});

	/**
	 * The other direction of a real read: a target the device *does* carry resolves.
	 *
	 * The string is taken off the screen this device is showing rather than hardcoded — the
	 * machine running this has a different device on a different screen from the machine that
	 * wrote it — and `wait_until_gone` is the verb that asks for it, because it answers
	 * without touching anything.
	 */
	it('resolves a target by text against the screen the device is really showing', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const seen = await client.request('wait_until_gone', { leaseId, target: ABSENT, timeoutMs: 0 });
		if (seen.outcome !== 'ok' || seen.result.after.kind !== 'screen') {
			throw new Error(`the device could not report its screen: ${JSON.stringify(seen)}`);
		}
		const onScreen = seen.result.after.elements.find(
			(element) => element.text !== null && element.text.trim().length > 0,
		);
		if (!onScreen?.text) throw new Error('no element on this screen carries any text');

		const answer = await client.request('wait_until_gone', {
			leaseId,
			target: { by: 'text', text: onScreen.text },
			timeoutMs: 0,
		});

		// It is still there, so waiting for it to go away times out — which is the assertion
		// that the text matched something real rather than nothing.
		expect(answer).toMatchObject({ outcome: 'failed', failure: { kind: 'wait-timeout' } });
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
		// D12(c): every action reports the state after itself, and since #13 that state is the
		// device's real screen rather than the capability that would have answered.
		if (answer.outcome !== 'ok') throw new Error('the assertion above should have caught this');
		expect(answer.result.after.kind).toBe('screen');
		if (answer.result.after.kind !== 'screen') throw new Error('unreachable');
		expect(answer.result.after.elements.length).toBeGreaterThan(0);
	});

	/**
	 * A tap addressed by an **element id** taken off a real read, rather than by a coordinate.
	 *
	 * The element chosen is the one under {@link HARMLESS_POINT}, so this lands on exactly the
	 * pixel the coordinate tap above already lands on and is no less safe — what it adds is
	 * the round trip that a coordinate tap skips entirely: an id produced by one read of the
	 * device resolves against the *fresh* read the verb takes inside itself, and the result
	 * names the element it hit.
	 */
	it('taps an element it resolved off a read of the device', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const seen = await client.request('tap', { leaseId, target: HARMLESS_POINT });
		if (seen.outcome !== 'ok' || seen.result.after.kind !== 'screen') {
			throw new Error(`the device could not report its screen: ${JSON.stringify(seen)}`);
		}
		const { at } = HARMLESS_POINT;
		// The **last** in pre-order, which is the innermost node covering the point: an ancestor
		// covering it too is a rectangle whose centre is somewhere else entirely.
		const covering = seen.result.after.elements.filter(
			({ bounds }) =>
				bounds.width > 0 &&
				bounds.height > 0 &&
				at.x >= bounds.x &&
				at.y >= bounds.y &&
				at.x < bounds.x + bounds.width &&
				at.y < bounds.y + bounds.height,
		);
		const under = covering[covering.length - 1];
		if (!under) throw new Error(`nothing on this screen covers (${at.x}, ${at.y}) dp`);

		const answer = await client.request('tap', {
			leaseId,
			target: { by: 'element', id: under.id },
		});

		expect(answer).toMatchObject({
			outcome: 'ok',
			// `screen`, not `caller-point`: the point was computed from an element the verb
			// resolved on a screen it read itself (D12(a)).
			result: { verb: 'tap', target: { source: 'screen', element: { id: under.id } } },
		});
	});

	// The refusal is still the right answer for a target no screen carries — and now it is a
	// miss rather than a missing capability, which is the difference this change makes.
	it('reports a target no screen carries as not found, naming what was there instead', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const answer = await client.request('tap', { leaseId, target: ABSENT });

		expect(answer).toMatchObject({
			outcome: 'failed',
			failure: { kind: 'target-not-found', serial: device.serial },
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
