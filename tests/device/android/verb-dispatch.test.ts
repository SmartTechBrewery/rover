import { afterEach, describe, expect, it } from 'vitest';
// Side-effect import: exactly what `src/daemon/main.ts` now does. Without it the daemon this
// suite starts would have an empty registry and lend nothing.
import '@/backends/index.js';
import { runAdbOnDevice } from '@/backends/android/adb.js';
import type { LogEntry } from '@/core/device.js';
import { type DeviceSerial, type LeaseId, parseAppId, unwrap } from '@/core/ids.js';
import { type Observation, waitForCondition } from '@/core/wait.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import type { ListedDevice, ReadLogsCallResult } from '@/ipc/methods.js';
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
 * **The screen read is real since #13**, and that is what the assertions below are built
 * on: a wait that resolves off a read of the device in front of you, a wait that times out
 * naming what was on screen instead, and a wait that resolves an element id taken off one
 * read against the fresh read it takes itself. Where this suite used to assert
 * `missing-capability`, it now asserts the thing the capability was standing in for.
 *
 * **Only one point on the device is ever touched**, and it is {@link HARMLESS_POINT}. That
 * is the rule the whole suite is bounded by, and it is why every target below is either
 * absent from the screen, resolved by a verb that touches nothing, or that one coordinate.
 *
 * **What this deliberately does not cover, so silence is not read as "checked":**
 *
 * - **No control is tapped by name, and no tap is addressed by an element id.** An element
 *   target resolves to `centreOf(element)` rather than to the point the element was found
 *   under, and on an arbitrary screen the elements covering the harmless corner are
 *   full-screen containers whose centre is the middle of the panel — so a tap addressed that
 *   way would activate whatever the device happens to be showing, on a suite that has no
 *   verb to put it back afterwards (`press_key` has no IPC row yet). That dispatch is
 *   covered over a stub in `tests/unit/verbs/input.test.ts` instead; what is proved here is
 *   the half a device is needed for — that an id off a real read resolves against a real
 *   read. Text matching is proved the same way, by waits that resolve a string taken off the
 *   device's own screen without touching it.
 * - **What a tap did is still not asserted.** The after-state now says what the screen looks
 *   like, but the point tapped is chosen so that nothing changes, so the read is evidence
 *   that the read works rather than evidence about the tap.
 * - **`clear_app_data` has no success case here**, for the reason
 *   `tests/device/android/app-control.test.ts` already records: a successful clear destroys an
 *   application's data, and there is no package on an arbitrary device whose data is safe for
 *   a test suite to destroy. Its dispatch is covered over a stub backend in
 *   `tests/unit/daemon/verb-dispatch.test.ts` instead.
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

/**
 * How long to wait for a crash to reach the device's log, and how much of the log to read
 * while waiting.
 *
 * A crash landed a fraction of a second after `am crash` returned on the capture device, so
 * the timeout is slack rather than an expectation. The bound is large because a device that
 * has just launched an app writes hundreds of entries a second (PROJECT.md §6) — with the
 * default two hundred, a crash can scroll off the end of the read before the next poll.
 */
const CRASH_TIMEOUT_MS = 30_000;
const CRASH_POLL_MS = 500;
const CRASH_LOG_ENTRIES = 2_000;

/**
 * What the device says a shell-induced crash was. Asserted **in the log and against the
 * screen**: the log carries it, and no screen ever will — a crash dialog says an app stopped,
 * never which exception ended it.
 */
const CRASH_EXCEPTION = 'CrashedByAdbException';

/**
 * The entry that says the app died. Matched on the **package** rather than on a wording,
 * because the package is what the caller asked about; the level is asserted separately, so a
 * platform that changes its phrasing fails loudly here rather than silently matching nothing.
 */
function namesTheCrash(entry: LogEntry): boolean {
	return entry.level === 'error' && entry.message.includes(unwrap(SETTINGS));
}

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
	 * A target addressed by an **element id** taken off a real read, rather than by a
	 * coordinate: an id one read of the device produced resolves against the *fresh* read the
	 * verb takes inside itself, and the result names the element it resolved to.
	 *
	 * **`wait_for` and not `tap`, because an element target is not a point target.**
	 * `resolveOnScreen` answers an element id with `centreOf(element)` — never the point the
	 * element was found under — so tapping "the element under {@link HARMLESS_POINT}" injects
	 * at that element's midpoint. On both the committed API 37 hierarchy and a live emulator,
	 * every element covering the top-left corner is a full-screen container whose centre is
	 * the middle of the panel, so such a tap lands on whatever control the device happens to
	 * be showing there and this suite has no verb to put it back. A wait resolves the id
	 * through exactly the same `resolveOnScreen` and touches nothing, which is what makes it
	 * the verb that can prove this against a device someone else is looking at.
	 *
	 * The element is the root of the read: its id is the one that survives the screen moving
	 * between the two reads, and identity is what is under test here rather than which node.
	 */
	it('resolves an element id it took off a read of the device', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const seen = await client.request('wait_until_gone', { leaseId, target: ABSENT, timeoutMs: 0 });
		if (seen.outcome !== 'ok' || seen.result.after.kind !== 'screen') {
			throw new Error(`the device could not report its screen: ${JSON.stringify(seen)}`);
		}
		// Addressable, which is what a wait waits for: a rectangle with an interior, so it has a
		// midpoint the verb layer will accept.
		const addressable = seen.result.after.elements.find(
			({ bounds }) => bounds.width > 0 && bounds.height > 0,
		);
		if (!addressable) throw new Error('no element on this screen has an interior');

		const answer = await client.request('wait_for', {
			leaseId,
			target: { by: 'element', id: addressable.id },
			timeoutMs: 2_000,
			pollIntervalMs: 500,
		});

		expect(answer).toMatchObject({
			outcome: 'ok',
			// `screen`, not `caller-point`: the point was computed from an element the verb
			// resolved on a screen it read itself (D12(a)).
			result: {
				verb: 'wait_for',
				target: { source: 'screen', element: { id: addressable.id } },
			},
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
				// Since #13 the post-state is the device's real screen rather than the capability
				// that would have answered — the read is what will eventually settle what a launch
				// or a stop actually did.
				after: { kind: 'screen' },
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
	 * device said, not a claim that anything was stopped. The after-state is a real screen since
	 * #13, but reading a *difference* out of it is the `read_screen` verb's job rather than this
	 * suite's, so nothing here asserts on it.
	 */
	it('cannot tell a stopped app from a package that was never there', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const answer = await client.request('stop_app', { leaseId, appId: ABSENT_PACKAGE });

		expect(answer).toMatchObject({ outcome: 'ok', result: { verb: 'stop_app' } });
	});

	/**
	 * **The acceptance criterion of #69, against real hardware: `read_logs` shows a crash the
	 * screen cannot.**
	 *
	 * An app is launched over a lease, crashed, and two questions are asked of the *same*
	 * answer — what the device logged, and what was on its screen. The log names the process
	 * that died, the level it died at, when, and with which exception. The screen names none of
	 * that, and the assertion below is exactly that gap.
	 *
	 * **What was on the screen, measured rather than assumed, because it is not one thing.**
	 * Both of these were seen on the capture device (API 37) minutes apart:
	 *
	 * - the **launcher**, with nothing on it about the crash at all — indistinguishable from
	 *   someone having pressed home;
	 * - a transient system dialog reading `Settings keeps stopping` / `App info` /
	 *   `Close app`, which appears after repeated crashes of the same package and clears
	 *   itself again.
	 *
	 * So the test does **not** assert that the screen is silent — that would be flaky *and*
	 * false in the second case. It asserts the thing that holds in both: the screen never names
	 * the package, the exception or the process, so a screenshot cannot say *what* died or
	 * *why*, while the log answers all three. That is the difference this verb exists for.
	 *
	 * **The crash is induced with `adb` rather than with a verb**, and that is deliberate:
	 * crashing an app is a fault to be injected, not something Rover lends devices out to do,
	 * so there is no verb for it and there should not be one. The call is pinned to the serial
	 * the **lease** names and made while this test holds that lease, which is what keeps it
	 * from being the outside-the-lease adb ai/TESTING.md warns about.
	 *
	 * `am crash <package>` was verified on this device and recorded in PROJECT.md §6, with the
	 * two properties that shape this test: it is **asynchronous** — the command exits 0 before
	 * the log line exists, so the read has to be a condition with a deadline rather than one
	 * read — and the crash lands as an **error-level** entry rather than a fatal-level one, so
	 * a test waiting for `fatal` would wait forever on a device that had already crashed.
	 *
	 * The read asks for a large bound because a device that has just launched an app writes
	 * hundreds of entries a second (PROJECT.md §6): with the default two hundred, the crash can
	 * be off the end of the read before the next poll.
	 */
	it('shows a crash in the log that the screen it answers with does not show', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const launched = await client.request('launch_app', { leaseId, appId: SETTINGS });
		expect(launched).toMatchObject({ outcome: 'ok' });

		await runAdbOnDevice(device.serial, ['shell', 'am', 'crash', unwrap(SETTINGS)]);

		const crashed = await waitForCondition<ReadLogsCallResult>({
			what: `the device to report '${SETTINGS}' crashing in its log`,
			timeoutMs: CRASH_TIMEOUT_MS,
			pollIntervalMs: CRASH_POLL_MS,
			probe: async (): Promise<Observation<ReadLogsCallResult>> => {
				const answer = await client.request('read_logs', {
					leaseId,
					maxEntries: CRASH_LOG_ENTRIES,
				});
				if (answer.outcome !== 'ok') {
					return { met: false, found: `the host answered '${answer.outcome}'` };
				}
				const named = answer.result.logs.entries.some(namesTheCrash);
				return named
					? { met: true, value: answer }
					: { met: false, found: `${answer.result.logs.entries.length} entries, none naming it` };
			},
		});
		if (crashed.outcome !== 'ok') throw new Error('the wait should have caught this');

		// What the log says: which process died, at what level, when, and with what.
		const entry = crashed.result.logs.entries.find(namesTheCrash);
		expect(entry).toMatchObject({ level: 'error' });
		expect(entry?.timestamp.length).toBeGreaterThan(0);
		expect(entry?.pid).not.toBeNull();
		expect(crashed.result.logs.entries.map((logged) => logged.message)).toContainEqual(
			expect.stringContaining(CRASH_EXCEPTION),
		);

		// And what the screen says: not that. Whether the device fell back to the launcher or
		// raised its transient dialog, no element on it names the package, the exception or the
		// process — so a screenshot of this moment says at most that *an* app stopped, and the
		// log is the only thing that says which one and why.
		expect(crashed.result.after.kind).toBe('screen');
		if (crashed.result.after.kind !== 'screen') throw new Error('unreachable');
		const onScreen = crashed.result.after.elements.flatMap((element) =>
			[element.text, element.label].filter((text): text is string => text !== null),
		);
		expect(onScreen.length).toBeGreaterThan(0);
		expect(onScreen.filter((text) => text.includes(unwrap(SETTINGS)))).toEqual([]);
		expect(onScreen.filter((text) => text.includes(CRASH_EXCEPTION))).toEqual([]);
		expect(onScreen.filter((text) => text.includes(String(entry?.pid)))).toEqual([]);

		// Leave the device as this test found it. A crash can raise a dialog that outlives the
		// suite by a good few seconds, and the next thing to read this screen would take it for
		// the app under test — `tests/device/android/backend.test.ts` measuring the root
		// element against `wm size` is exactly what that breaks. Back dismisses it; on a screen
		// with no dialog it does nothing, which is why it is unconditional. Best effort, and
		// nothing above depends on it.
		await runAdbOnDevice(device.serial, ['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
	});

	/**
	 * The bound is the caller's, and a short read has to be distinguishable from a quiet
	 * device — which is what `truncated` is for. A device that has been running long enough to
	 * be worth reading has more than two entries in its log, so this asks for two and expects
	 * to be told there were more.
	 */
	it('bounds the read to what was asked for, and says when there was more', async () => {
		const client = await startHost();
		const device = await freeDevice(client);
		const leaseId = await lease(client, device.serial);

		const answer = await client.request('read_logs', { leaseId, maxEntries: 2 });

		expect(answer).toMatchObject({
			outcome: 'ok',
			result: {
				verb: 'read_logs',
				device: { serial: device.serial },
				// A log read addresses no element, so nothing on the screen was resolved (D12(a)).
				target: null,
				logs: { truncated: true },
			},
		});
		if (answer.outcome !== 'ok') throw new Error('the assertion above should have caught this');
		expect(answer.result.logs.entries).toHaveLength(2);
		// Real lines off the device, not empty shapes: each carries the device's own timestamp
		// string (D17 — the host shares no clock with it) and the level it was written at.
		for (const logged of answer.result.logs.entries) {
			expect(logged.timestamp).toMatch(/\d/);
			expect(logged.level.length).toBeGreaterThan(0);
		}
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
