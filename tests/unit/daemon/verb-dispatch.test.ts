/**
 * Verb calls end to end: a registered backend, a real daemon on a temp socket, and one
 * client asking over the real framing — the shape R21 is about.
 *
 * **Every call in this file goes over the same `IpcClient` that took the lease**, on the
 * same connection and the same envelope. That is the criterion, not an incidental
 * convenience: verb calls travel on the surface the lease operations already use (R6, D19),
 * so there is deliberately no second client, no second protocol and no second socket
 * anywhere below.
 *
 * The client never touches a device. Every assertion about what happened to the hardware is
 * an assertion about a mock the **daemon** in this process called, which is the other half
 * of the same claim; `tests/unit/no-backend-in-a-client.test.ts` holds the static half.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never
 * `~/.rover/rover.sock`, and every daemon closed through its own handle in `afterEach`.
 *
 * Nothing here sleeps. Where a test needs a wait to have actually taken time it asks a verb
 * to poll to its own deadline, which is the wait vocabulary doing what it is for; everywhere
 * else `timeoutMs: 0` makes a wait exactly one screen read (`src/core/wait.ts`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Capabilities } from '@/core/capabilities.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher, Point } from '@/core/device.js';
import {
	type AppId,
	type DeviceSerial,
	type LeaseId,
	parseAppId,
	parseDeviceSerial,
	parseLeaseId,
} from '@/core/ids.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import { IpcRequestError } from '@/ipc/protocol.js';
import { LONG_PRESS_DURATION_MS } from '@/verbs/input.js';
import { DEFAULT_MAX_LOG_ENTRIES } from '@/verbs/logs.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import {
	createMockCapabilities,
	createMockDevice,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockLogEntry,
	createMockLogRead,
	createMockScreenElement,
} from '../../helpers/factories.js';
import { createGate, drainEventLoop } from '../../helpers/timing.js';

const SERIAL = parseDeviceSerial('attached-1');
const attached = createMockDevice({ serial: SERIAL });
const save = createMockScreenElement({ id: 'save', text: 'Save' });

/** What the device said about an app that is no longer on the screen to be seen. */
const crashed = createMockLogEntry({
	level: 'error',
	tag: 'CrashReporter',
	message: 'FATAL: com.example.app died',
});

/** Waiting on a target nothing on these screens matches. */
const ABSENT = { by: 'text', text: 'Nothing here' } as const;

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];

interface HostOptions {
	readonly describeDevice?: DeviceBackend['describeDevice'];
	readonly launchApp?: DeviceBackend['launchApp'];
	readonly readLogs?: DeviceBackend['readLogs'];
	readonly readScreen?: DeviceBackend['readScreen'];
	readonly deviceInfo?: DeviceBackend['deviceInfo'];
	readonly capabilities?: Partial<Capabilities>;
	readonly leaseTtlMs?: number;
}

/** The screen reads the daemon performed, so a test can prove the host did the work. */
let reads: number;

/**
 * What the daemon's backend was asked to do to the hardware, in order.
 *
 * The client sends a target and gets an answer; these are the only evidence that the host in
 * between turned one into the other — and, for a long press, that it reached the device as a
 * drag between two equal points rather than as anything else.
 */
let taps: Point[];
let drags: Array<{ from: Point; to: Point; durationMs: number }>;

/**
 * The app-lifecycle calls the daemon's backend received, in order and with the serial each
 * one named — the serial the *lease* carries, which the client never sent (D20).
 */
let appCalls: Array<{ method: string; serial: string; appId: string }>;

/**
 * The log reads the daemon's backend received — the serial off the lease, and the bound the
 * verb decided on, which is the one number a client can leave entirely unsaid.
 */
let logReads: Array<{ serial: string; maxEntries: number }>;

/**
 * A daemon on a temp socket with one ready device behind one registered backend.
 *
 * `describeDevice` defaults to answering about whatever serial it was asked, because the
 * factory's own default ignores it — which would quietly make every call land on one device.
 */
async function serve(options: HostOptions = {}): Promise<void> {
	reads = 0;
	taps = [];
	drags = [];
	appCalls = [];
	logReads = [];
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([attached]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});

	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: createMockCapabilities(options.capabilities ?? {}),
		},
		backend: createMockDeviceBackend({
			watchDevices,
			describeDevice:
				options.describeDevice ??
				(async (serial): Promise<Device | null> => createMockDevice({ serial })),
			readScreen:
				options.readScreen ??
				(async () => {
					reads += 1;
					return [save];
				}),
			deviceInfo: options.deviceInfo ?? (async (serial) => createMockDeviceInfo({ serial })),
			tap: async (_serial, at) => {
				taps.push(at);
			},
			swipe: async (_serial, from, to, durationMs) => {
				drags.push({ from, to, durationMs });
			},
			launchApp: options.launchApp ?? recordApp('launchApp'),
			stopApp: recordApp('stopApp'),
			clearAppData: recordApp('clearAppData'),
			readLogs:
				options.readLogs ??
				(async (serial, { maxEntries }) => {
					logReads.push({ serial, maxEntries });
					return createMockLogRead({ entries: [crashed] });
				}),
		}),
	});

	temp = await createTempSocket();
	const result = await startDaemon({
		socketPath: temp.socketPath,
		...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

/** One backend app method that records the call the daemon made rather than doing anything. */
function recordApp(method: string) {
	return async (serial: DeviceSerial, appId: AppId): Promise<void> => {
		appCalls.push({ method, serial, appId });
	};
}

async function connect(): Promise<IpcClient> {
	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
}

/** A held lease on the one device, taken over the same client the verbs then use. */
async function acquire(client: IpcClient): Promise<LeaseId> {
	const outcome = await client.request('acquire_device', {
		serial: SERIAL,
		owner: 'issue-21',
		project: 'rover',
	});
	if (outcome.outcome !== 'granted') {
		throw new Error(`The test needs a lease and was refused: ${outcome.message}`);
	}
	return outcome.lease.leaseId;
}

/** The one device's holder as `list_devices` reports it, or a failed test. */
async function holderOn(client: IpcClient) {
	const { devices } = await client.request('list_devices', {});
	const holder = devices.find((device) => device.serial === SERIAL)?.heldBy;
	if (!holder) {
		throw new Error('The device is not listed as held');
	}
	return holder;
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	if (temp) {
		await removeTempSocket(temp);
	}
});

describe('the daemon runs the verb against its own device', () => {
	it('answers a verb call on the same connection that took the lease', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request('wait_for', {
			leaseId,
			target: { by: 'text', text: 'Save' },
			timeoutMs: 0,
		});

		expect(answer).toMatchObject({
			outcome: 'ok',
			result: { verb: 'wait_for', target: { source: 'screen', element: { id: 'save' } } },
		});
		// The screen was read in *this* process, by the daemon — the client asked and nothing
		// else. That is the execution model this row exists to establish (D19).
		expect(reads).toBeGreaterThan(0);
	});

	it('names the device the lease is on, without the caller sending a serial', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request('wait_until_gone', {
			leaseId,
			target: ABSENT,
			timeoutMs: 0,
		});

		// The serial is derived from the lease on the host: the credential is the only handle a
		// verb call carries (D20), so a holder of one device cannot address another.
		expect(answer).toMatchObject({ outcome: 'ok', result: { device: { serial: SERIAL } } });
	});

	it('renews the lease when the call arrives (D8)', async () => {
		const ttlMs = 5_000;
		await serve({ leaseTtlMs: ttlMs, readScreen: async () => [] });
		const client = await connect();
		const startedAtMs = Date.now();
		const leaseId = await acquire(client);

		// A verb that polls to its own deadline, so real time passes without anything sleeping:
		// what ends this call is the timeout it was given, and the timeout is the point.
		await client.request('wait_for', {
			leaseId,
			target: ABSENT,
			timeoutMs: 300,
			pollIntervalMs: 25,
		});
		// The second call is the renewal being observed. It arrives well after the acquire, so a
		// store that only set the expiry once would show the elapsed time gone from the lease.
		await client.request('wait_until_gone', { leaseId, target: ABSENT, timeoutMs: 0 });

		const elapsedMs = Date.now() - startedAtMs;
		const { expiresInMs } = await holderOn(client);
		expect(elapsedMs).toBeGreaterThanOrEqual(300);
		expect(expiresInMs).toBeGreaterThan(ttlMs - 200);
	});
});

/**
 * The four gesture rows over the same surface, which is the claim: a verb family is a row and
 * a handler, and nothing about the envelope, the framing or the connection changed to carry
 * these (R6, D19).
 */
describe('the gesture rows dispatch like the waits', () => {
	it('taps a coordinate the client sent, and says it was one', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request('tap', {
			leaseId,
			target: { by: 'point', at: { x: 10, y: 20 } },
		});

		expect(answer).toMatchObject({
			outcome: 'ok',
			result: { verb: 'tap', target: { source: 'caller-point' } },
		});
		expect(taps).toEqual([{ x: 10, y: 20 }]);
	});

	it('resolves a text target on the host, from a screen the client never saw', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request('tap', { leaseId, target: { by: 'text', text: 'Save' } });

		expect(answer).toMatchObject({ outcome: 'ok', result: { target: { source: 'screen' } } });
		// The centre of `save`'s bounds. The client sent a word and the host sent a coordinate.
		expect(taps).toEqual([{ x: 60, y: 40 }]);
		expect(reads).toBeGreaterThan(0);
	});

	it('carries a long press to the device as a drag in place', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request('long_press', {
			leaseId,
			target: { by: 'text', text: 'Save' },
		});

		expect(answer).toMatchObject({ outcome: 'ok', result: { verb: 'long_press' } });
		expect(drags).toEqual([
			{ from: { x: 60, y: 40 }, to: { x: 60, y: 40 }, durationMs: LONG_PRESS_DURATION_MS },
		]);
		expect(taps).toEqual([]);
	});

	it('takes both ends of a swipe, and a caller-supplied duration', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request('swipe', {
			leaseId,
			from: { by: 'text', text: 'Save' },
			to: { by: 'point', at: { x: 300, y: 700 } },
			durationMs: 120,
		});

		// The result names the end the gesture started from, which is the target the caller aimed
		// at rather than the one it aimed for.
		expect(answer).toMatchObject({
			outcome: 'ok',
			result: { verb: 'swipe', target: { element: { id: 'save' } } },
		});
		expect(drags).toEqual([{ from: { x: 60, y: 40 }, to: { x: 300, y: 700 }, durationMs: 120 }]);
	});

	it('scrolls the screen when no region is named, in the direction the content moves', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request('scroll', { leaseId, direction: 'down' });

		expect(answer).toMatchObject({ outcome: 'ok', result: { verb: 'scroll', target: null } });
		const [drag] = drags;
		expect((drag?.from.y ?? 0) - (drag?.to.y ?? 0)).toBeGreaterThan(0);
	});

	it('refuses a gesture on a lease that was released, without touching the device', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);
		await client.request('release_device', { leaseId });

		const answer = await client.request('scroll', { leaseId, direction: 'up' });

		expect(answer).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
		expect(drags).toEqual([]);
	});

	it('answers a device that cannot take input with a failure naming the capability', async () => {
		await serve({ capabilities: { canInput: false } });
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request('tap', {
			leaseId,
			target: { by: 'point', at: { x: 1, y: 2 } },
		});

		expect(answer).toMatchObject({
			outcome: 'failed',
			failure: { kind: 'missing-capability', capability: 'canInput', serial: SERIAL },
		});
		// The manifest is consulted before anything is dispatched: no screen was read to reach
		// an answer that never depended on one.
		expect(reads).toBe(0);
	});

	it('stops a gesture whose lease ended part-way, before it reaches the hardware', async () => {
		const read = createGate();
		const held = createGate();
		await serve({
			readScreen: async () => {
				reads += 1;
				read.reach();
				// Suspended inside the resolution, which is before the tap: the lease ends here.
				await held.reached;
				return [save];
			},
		});
		const client = await connect();
		const leaseId = await acquire(client);

		const verb = client.request('tap', { leaseId, target: { by: 'text', text: 'Save' } });
		await read.reached;
		await client.request('release_device', { leaseId });
		held.reach();

		expect(await verb).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
		// The point of the guard: the gesture never reached the device the host had handed on.
		expect(taps).toEqual([]);
	});
});

/**
 * The three app rows, which is the same claim the gestures make one more time: a verb family
 * is a row and a handler, and nothing about the envelope, the framing or the connection
 * changed to carry these (R6, D19). What is new is that they address a **package** rather
 * than something on the screen — so no screen is read to reach the device, and the result's
 * target is `null`.
 */
describe('the app rows dispatch like the gestures', () => {
	const SETTINGS = parseAppId('com.android.settings');

	it.each([
		['launch_app', 'launchApp'],
		['stop_app', 'stopApp'],
		['clear_app_data', 'clearAppData'],
	] as const)('%s reaches %s on the device the lease names', async (method, backendMethod) => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request(method, { leaseId, appId: SETTINGS });

		expect(answer).toMatchObject({
			outcome: 'ok',
			// No target, because an app id addresses a package: nothing on the screen was resolved.
			result: { verb: method, target: null, device: { serial: SERIAL } },
		});
		// The serial came off the lease on the host. The client sent an app id and a lease id.
		expect(appCalls).toEqual([{ method: backendMethod, serial: SERIAL, appId: SETTINGS }]);
		// And no screen was read to get there — the read in the result is the after-state.
		expect(reads).toBe(1);
	});

	it('refuses an app verb on a lease id the store does not know, without touching the device', async () => {
		await serve();
		const client = await connect();

		const answer = await client.request('launch_app', {
			leaseId: parseLeaseId('never-granted'),
			appId: SETTINGS,
		});

		// Proof these go through `runVerb` rather than around it.
		expect(answer).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
		expect(appCalls).toEqual([]);
	});

	it('refuses an app verb whose lease ended part-way, before it reaches the hardware', async () => {
		const started = createGate();
		const held = createGate();
		await serve({
			launchApp: async () => {
				started.reach();
				await held.reached;
			},
		});
		const client = await connect();
		const leaseId = await acquire(client);

		const verb = client.request('launch_app', { leaseId, appId: SETTINGS });
		await started.reached;
		await client.request('release_device', { leaseId });
		held.reach();

		// The launch itself already ran; what the guard stops is everything after it, so the
		// answer is the ex-holder's refusal rather than a result about a device it no longer has.
		expect(await verb).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
	});

	it('refuses an app id that is not a reverse-DNS name, at the boundary', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const thrown = await client
			.request('stop_app', {
				leaseId,
				// @ts-expect-error — the point of the test is what a client that ignored the type gets.
				appId: 'notreversedns',
			})
			.catch((error: unknown) => error);

		// `invalid_params` a caller can read, rather than an `InvalidIdError` thrown deep inside
		// a backend building a device-side command line out of it.
		expect(thrown).toBeInstanceOf(IpcRequestError);
		expect((thrown as IpcRequestError).code).toBe('invalid_params');
		expect(appCalls).toEqual([]);
	});

	it('refuses a serial sent beside the lease id (D20)', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const thrown = await client
			.request('launch_app', {
				leaseId,
				appId: SETTINGS,
				// The lease id is the credential and the host derives the device from it. A serial
				// accepted here would let the holder of one lease drive another device.
				// @ts-expect-error — the point of the test is what a client that ignored the type gets.
				serial: 'another-device',
			})
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(IpcRequestError);
		expect((thrown as IpcRequestError).code).toBe('invalid_params');
	});

	/**
	 * Pins today's behaviour rather than blessing it: a backend that refuses — a package the
	 * device does not have — rejects, and the daemon has no `VerbFailure` branch for it, so it
	 * arrives as `internal_error` ("the host broke"). That is a pre-existing, repo-wide gap
	 * shared by every verb family, filed separately rather than widened into this change.
	 */
	it('leaves a device-level refusal as internal_error, for now', async () => {
		await serve({
			launchApp: async () => {
				throw new Error("Device has no package 'com.rover.no.such.package'");
			},
		});
		const client = await connect();
		const leaseId = await acquire(client);

		const thrown = await client
			.request('launch_app', { leaseId, appId: parseAppId('com.rover.no.such.package') })
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(IpcRequestError);
		expect((thrown as IpcRequestError).code).toBe('internal_error');
	});
});

/**
 * The log row, which is every claim the app rows make plus one more: **the answer carries a
 * payload**. The daemon parses each handler's return value against that row's own schema
 * before it writes it (`src/ipc/methods.ts`), so a `logs` field lost anywhere between the
 * verb and the wire is `invalid_result` on the host rather than a client reading a result
 * that looks fine and says nothing.
 */
describe('the log row carries a payload back over the same surface', () => {
	it('read_logs reaches the backend for the serial the lease names, and answers with entries', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request('read_logs', { leaseId });

		expect(answer).toMatchObject({
			outcome: 'ok',
			result: {
				verb: 'read_logs',
				// No target: a log read addresses no element (D12(a)).
				target: null,
				device: { serial: SERIAL },
				logs: { entries: [crashed], truncated: false },
			},
		});
		// The serial came off the lease on the host; the client sent a lease id and nothing else.
		expect(logReads).toEqual([{ serial: SERIAL, maxEntries: DEFAULT_MAX_LOG_ENTRIES }]);
		// And the screen read in the result is the after-state, not a read on the way in.
		expect(reads).toBe(1);
	});

	it('passes a bound the caller did send, and never a default of its own', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		await client.request('read_logs', { leaseId, maxEntries: 5 });

		expect(logReads).toEqual([{ serial: SERIAL, maxEntries: 5 }]);
	});

	it('says so when the device had more than the bound', async () => {
		await serve({
			readLogs: async () => createMockLogRead({ entries: [crashed], truncated: true }),
		});
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request('read_logs', { leaseId });

		expect(answer).toMatchObject({ outcome: 'ok', result: { logs: { truncated: true } } });
	});

	// Proof this row goes through `runVerb` rather than around it: the same refusal, in the
	// same words, as every other verb — which is the whole point of the generic spine.
	it('refuses a lease id the store does not know, without touching the device', async () => {
		await serve();
		const client = await connect();

		const answer = await client.request('read_logs', { leaseId: parseLeaseId('never-granted') });

		expect(answer).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
		expect(logReads).toEqual([]);
	});

	it('refuses a serial sent beside the lease id (D20)', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const thrown = await client
			.request('read_logs', {
				leaseId,
				// @ts-expect-error — the point of the test is what a client that ignored the type gets.
				serial: 'another-device',
			})
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(IpcRequestError);
		expect((thrown as IpcRequestError).code).toBe('invalid_params');
		expect(logReads).toEqual([]);
	});
});

describe('a call that cannot reach a verb is refused, as data', () => {
	it('refuses a lease id the store does not know, and resolves rather than rejecting', async () => {
		await serve();
		const client = await connect();

		const answer = await client.request('wait_for', {
			leaseId: parseLeaseId('never-granted'),
			target: { by: 'text', text: 'Save' },
			timeoutMs: 0,
		});

		expect(answer).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
		// One reason with no sub-reasons, so the message has to carry all three possibilities
		// and the way out of them.
		expect(answer).toMatchObject({ message: expect.stringContaining('Acquire the device again') });
		expect(reads).toBe(0);
	});

	it('refuses a lease that was released, without touching the device', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);
		await client.request('release_device', { leaseId });

		const answer = await client.request('wait_for', {
			leaseId,
			target: { by: 'text', text: 'Save' },
			timeoutMs: 0,
		});

		expect(answer).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
		expect(reads).toBe(0);
	});

	it('refuses when the device vanished mid-lease (D6)', async () => {
		let attachedNow = true;
		await serve({
			describeDevice: async (serial): Promise<Device | null> =>
				attachedNow ? createMockDevice({ serial }) : null,
		});
		const client = await connect();
		const leaseId = await acquire(client);
		attachedNow = false;

		const answer = await client.request('wait_for', {
			leaseId,
			target: { by: 'text', text: 'Save' },
			timeoutMs: 0,
		});

		expect(answer).toMatchObject({ outcome: 'refused', reason: 'gone' });
	});

	it('refuses a device that is only reachable over a network transport (D18)', async () => {
		let local = true;
		await serve({
			describeDevice: async (serial): Promise<Device> =>
				createMockDevice({ serial, attachment: local ? 'this-host' : 'another-host' }),
		});
		const client = await connect();
		const leaseId = await acquire(client);
		local = false;

		const answer = await client.request('wait_for', {
			leaseId,
			target: { by: 'text', text: 'Save' },
			timeoutMs: 0,
		});

		expect(answer).toMatchObject({ outcome: 'refused', reason: 'not-attached' });
	});

	it('refuses a device that is no longer in a state a verb could run against', async () => {
		let ready = true;
		await serve({
			describeDevice: async (serial): Promise<Device> =>
				createMockDevice({ serial, state: ready ? 'ready' : 'offline' }),
		});
		const client = await connect();
		const leaseId = await acquire(client);
		ready = false;

		const answer = await client.request('wait_for', {
			leaseId,
			target: { by: 'text', text: 'Save' },
			timeoutMs: 0,
		});

		expect(answer).toMatchObject({ outcome: 'refused', reason: 'not-ready' });
	});
});

describe('a verb that ran and answered no is a failure, not a broken host', () => {
	it('names the capability, the device and the backend when the device cannot answer (D11)', async () => {
		await serve({ capabilities: { canReadScreen: false } });
		const client = await connect();
		const leaseId = await acquire(client);

		const answer = await client.request('wait_for', {
			leaseId,
			target: { by: 'text', text: 'Save' },
			timeoutMs: 0,
		});

		expect(answer).toMatchObject({
			outcome: 'failed',
			failure: {
				kind: 'missing-capability',
				capability: 'canReadScreen',
				serial: SERIAL,
				platform: 'test-platform',
				backendLabel: 'Test',
			},
		});
	});

	it('carries a wait that timed out back as data, with what was on screen instead', async () => {
		await serve({ readScreen: async () => [save] });
		const client = await connect();
		const leaseId = await acquire(client);

		// `timeoutMs: 0` is exactly one screen read: the wait vocabulary probes before any
		// delay, so this proves a timeout without a test waiting on a duration.
		const answer = await client.request('wait_until_gone', {
			leaseId,
			target: { by: 'text', text: 'Save' },
			timeoutMs: 0,
		});

		expect(answer).toMatchObject({
			outcome: 'failed',
			failure: { kind: 'wait-timeout', polls: 1, timeoutMs: 0 },
		});
		if (answer.outcome !== 'failed' || answer.failure.kind !== 'wait-timeout') {
			throw new Error('the assertion above should have caught this');
		}
		expect(answer.failure.waitedFor).toContain('Save');
		expect(answer.failure.found).toContain('Save');
	});

	it('leaves a genuine host failure as internal_error', async () => {
		await serve({
			deviceInfo: async () => {
				throw new Error('the host broke');
			},
		});
		const client = await connect();
		const leaseId = await acquire(client);

		// Not a verb answering "no" — nothing about the device explains it, so dressing it up as
		// one would send the agent looking in the wrong place.
		const thrown = await client
			.request('wait_for', { leaseId, target: { by: 'text', text: 'Save' }, timeoutMs: 0 })
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(IpcRequestError);
		expect((thrown as IpcRequestError).code).toBe('internal_error');
	});
});

describe('the boundary parses what the type already forbids', () => {
	it('refuses an index on wait_until_gone rather than dropping it', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const thrown = await client
			.request('wait_until_gone', {
				// The type says no and so does the schema: an index is a slot in the match list, so
				// "index 2 is gone" would be reported for a row still plainly on the screen.
				// @ts-expect-error — the point of the test is what a client that ignored the type gets.
				target: { by: 'text', text: 'Save', index: 0 },
				leaseId,
			})
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(IpcRequestError);
		expect((thrown as IpcRequestError).code).toBe('invalid_params');
	});

	it('refuses a wait knob on a verb that does not wait', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const thrown = await client
			.request('tap', {
				leaseId,
				target: { by: 'text', text: 'Save' },
				// A gesture returns when the device is done with it. Accepting a timeout would
				// advertise a wait this verb does not perform.
				// @ts-expect-error — the point of the test is what a client that ignored the type gets.
				timeoutMs: 1_000,
			})
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(IpcRequestError);
		expect((thrown as IpcRequestError).code).toBe('invalid_params');
	});

	it('refuses a coordinate as the region a scroll happens in', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const thrown = await client
			.request('scroll', {
				leaseId,
				direction: 'down',
				// A point has no extent, so it cannot say how far a scroll may travel.
				// @ts-expect-error — the point of the test is what a client that ignored the type gets.
				target: { by: 'point', at: { x: 1, y: 2 } },
			})
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(IpcRequestError);
		expect((thrown as IpcRequestError).code).toBe('invalid_params');
	});

	it('refuses a wait longer than a lease could outlive', async () => {
		await serve();
		const client = await connect();
		const leaseId = await acquire(client);

		const thrown = await client
			.request('wait_for', {
				leaseId,
				target: { by: 'text', text: 'Save' },
				timeoutMs: 60 * 60_000,
			})
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(IpcRequestError);
		expect((thrown as IpcRequestError).code).toBe('invalid_params');
	});
});

describe('a verb never outlives the lease that authorised it', () => {
	it('stops one whose lease was released, and answers the ex-holder rather than the device', async () => {
		const read = createGate();
		await serve({
			readScreen: async () => {
				reads += 1;
				read.reach();
				return [save];
			},
		});
		const client = await connect();
		const leaseId = await acquire(client);

		// Not awaited, and that is the scenario: the server dispatches a frame without waiting
		// for the verb, so the release below is answered while this is still polling.
		const verb = client.request('wait_for', { leaseId, target: ABSENT, timeoutMs: 5_000 });
		// Waited on the condition rather than on a duration: the verb is provably driving.
		await read.reached;

		await client.request('release_device', { leaseId });

		const answer = await verb;
		// The same refusal an unknown lease id gets — no verb result exists — with a message
		// that says the call was stopped part-way rather than never started.
		expect(answer).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
		expect(answer).toMatchObject({
			message: expect.stringContaining('ended while this call was still running'),
		});

		// The point of the whole exercise: the reads stop. Everything scheduled has run, so a
		// verb still polling would have polled again by now.
		const readsWhenStopped = reads;
		await drainEventLoop();
		expect(reads).toBe(readsWhenStopped);
	});

	it('does not re-lend the device while the previous holder is still inside a device call', async () => {
		const read = createGate();
		const held = createGate();
		await serve({
			readScreen: async () => {
				reads += 1;
				read.reach();
				// Suspends the verb *inside* a backend call, where nothing can revoke it: this is
				// the half revocation cannot cover, and the half `settle` exists for.
				await held.reached;
				return [save];
			},
		});
		const holder = await connect();
		const leaseId = await acquire(holder);

		const verb = holder.request('wait_for', { leaseId, target: ABSENT, timeoutMs: 5_000 });
		await read.reached;
		await holder.request('release_device', { leaseId });

		// A second agent, on its own connection, asking for the device the first one just gave
		// back — the sequence a caller reaches by simply retrying after a timeout.
		const other = await connect();
		let answered = false;
		const grant = other
			.request('acquire_device', { serial: SERIAL, owner: 'pr-127-review', project: 'rover' })
			.then((outcome) => {
				answered = true;
				return outcome;
			});

		await drainEventLoop();
		// Nothing else is left to run, so this is "the host has not answered", not "not yet".
		expect(answered).toBe(false);

		held.reach();
		expect(await verb).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
		// And only then. The grant was queued behind the ex-holder's call, so the two agents
		// never had the device at once (PROJECT.md §2).
		expect(await grant).toMatchObject({ outcome: 'granted' });
	});
});
