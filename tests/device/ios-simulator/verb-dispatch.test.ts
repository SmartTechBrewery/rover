// Side-effect import: exactly what `src/daemon/main.ts` does. Without it the daemon this suite
// starts would have an empty registry and lend nothing — and until this phase it had no
// `ios-simulator` line to load, which is why this suite could not exist before now.
import '@/backends/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { IOS_SIMULATOR_PLATFORM_ID } from '@/backends/ios-simulator/devices.js';
import { isFinishedRecording } from '@/backends/ios-simulator/parsers/recording.js';
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
 * Host-side verb execution against a real simulator: a daemon on a temp socket, a lease taken over
 * it, and a verb dispatched by the process that owns the device (D19, R21).
 *
 * **This suite is what registration made possible**, and it is the thing every earlier phase of
 * this backend could not do: until `src/backends/ios-simulator/index.ts` landed there was no
 * manifest, so a daemon had nothing to lend and every iOS suite had to drive the backend class
 * directly. `./recording.test.ts` still does, one layer down; what is new here is that the bytes
 * came off a lease, over a socket, from the host holding the hardware.
 *
 * **The two things it is really for:**
 *
 * - **the recording over the wire**, which is the second verb on this platform whose answer
 *   crosses the boundary as bytes. What only a device can prove is that the file is *finished*
 *   when it arrives — `simctl` exits 0 on a recording that produced nothing at all, so neither the
 *   exit code nor the length separates the two.
 * - **the honest refusal**, which is what `ios-simulator` is the repository's first registered
 *   example of. `set_wifi` and `set_airplane_mode` come back as `missing-capability` naming
 *   `canControlNetwork` — *not* as a cosmetic status bar, which `simctl status_bar override
 *   --wifiMode failed` would happily draw (`ai/RULES.md` §2,
 *   `src/backends/ios-simulator/capabilities.ts`). Every earlier assertion of that shape in this
 *   repository was made against a synthetic backend; this one is against a device.
 *
 * Gated on `ROVER_TEST_SIMULATOR` (`tests/device/setup.ts`), so a host with no booted simulator
 * **skips rather than fails** (ai/TESTING.md). The recording cases carry a second gate,
 * `ROVER_TEST_FRAME_EXTRACTION`: `record_video` and `stop_recording` answer with the normalised
 * recording *and* the frames sliced out of it or with neither, so there is no half of either left
 * to check on a host with no decoder — and the run says so loudly rather than passing in silence.
 *
 * **It boots nothing, shuts nothing down, installs nothing and launches nothing.** A recording of
 * a screen nobody touched is a true answer about the device and is all this suite asks for; the
 * driven case is `./recording.test.ts`'s, where the appearance it changes is put back.
 */
const INVENTORY_TIMEOUT_MS = 20_000;
const INVENTORY_POLL_MS = 100;

/** A short recording, `./recording.test.ts`'s number for its reason. */
const RECORDING_MS = 2_000;

/**
 * The client's own bound, raised past its 30 s default: `record_video` spends the whole recording
 * before it starts transferring anything, and the stop normalises and slices before it answers.
 */
const RECORDING_REQUEST_TIMEOUT_MS = 60_000;

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
const leases: Array<{ client: IpcClient; leaseId: LeaseId }> = [];

/** A daemon of this repository's own making, on a socket nobody else uses. */
async function startHost(): Promise<IpcClient> {
	temp = await createTempSocket();
	const daemon = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		keptTestsPath: temp.keptTestsPath,
		retention: temp.retention,
	});
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
 * The first free, ready **simulator** the daemon reports.
 *
 * Filtered by platform, unlike the Android suite's equivalent, because a Mac with an Android
 * device attached reports both and this suite's subject is one of them. That filter is a test's
 * business rather than shared code's — nothing under `src/` outside a backend's own folder may
 * name a platform (`ai/RULES.md` §2, `tests/unit/no-platform-names.test.ts`), and it reads the id
 * off the backend's own module rather than restating the string.
 *
 * Polled rather than read once: the inventory is a subscription, and the host's first frame
 * arrives a moment after it starts watching. A condition with a deadline, not a sleep.
 */
async function freeSimulator(client: IpcClient): Promise<ListedDevice> {
	return waitForCondition<ListedDevice>({
		what: 'the host to report a free, ready simulator',
		timeoutMs: INVENTORY_TIMEOUT_MS,
		pollIntervalMs: INVENTORY_POLL_MS,
		probe: async (): Promise<Observation<ListedDevice>> => {
			const { devices, stale } = await client.request('list_devices', {});
			const free = devices.find(
				(device) =>
					device.platform === IOS_SIMULATOR_PLATFORM_ID &&
					device.state === 'ready' &&
					device.heldBy === null,
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
		owner: 'issue-230',
		project: 'rover',
		testName: 'ios-verb-dispatch',
	});
	if (outcome.outcome !== 'granted') {
		throw new Error(`The host refused a lease on '${serial}': ${outcome.message}`);
	}
	leases.push({ client, leaseId: outcome.lease.leaseId });
	return outcome.lease.leaseId;
}

/**
 * Release every lease, which is also what runs the teardown this phase added: `discardRecording`
 * on release and on expiry alike (D9). So a case that left a recorder running is cleaned up by
 * the very thing it is testing — and a recorder left behind would fail every later case with the
 * tool's own exit 16.
 */
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

describe.skipIf(!process.env.ROVER_TEST_SIMULATOR)(
	'a daemon runs verbs on its own simulator',
	() => {
		/**
		 * The join, on the cheapest verb that proves it: the socket, a real simulator re-verified
		 * through its backend at the grant (D6), the registry lookup and the answer coming back.
		 */
		it('lends a simulator and answers a verb against the device its lease names', async () => {
			const client = await startHost();
			const device = await freeSimulator(client);
			const leaseId = await lease(client, device.serial);

			const info = await client.request('device_info', { leaseId });

			expect(info).toMatchObject({
				outcome: 'ok',
				result: {
					verb: 'device_info',
					device: { serial: device.serial, platform: IOS_SIMULATOR_PLATFORM_ID },
				},
			});
		});

		/**
		 * **The refusal this backend is the repository's first real example of.** A simulator uses
		 * the host's network stack, so the only truthful `set_wifi` would change the networking of
		 * the machine lending devices to other people — and the cosmetic thing `simctl` *will* do
		 * is exactly the plausible-looking result `ai/RULES.md` §2 forbids. What a caller gets
		 * instead names the capability, the device and the backend, which is the difference between
		 * "stop asking" and "try again".
		 */
		it.each([
			'set_wifi',
			'set_airplane_mode',
		] as const)('refuses %s as a missing capability rather than drawing an icon', async (verb) => {
			const client = await startHost();
			const device = await freeSimulator(client);
			const leaseId = await lease(client, device.serial);

			const refused = await client.request(verb, { leaseId, enabled: false });

			expect(refused).toMatchObject({
				outcome: 'failed',
				failure: {
					kind: 'missing-capability',
					capability: 'canControlNetwork',
					serial: device.serial,
					platform: IOS_SIMULATOR_PLATFORM_ID,
				},
			});
		});

		/**
		 * The recording over the wire. What only a device can prove is that the file is finished
		 * when it arrives: `simctl` exits 0 on a recording that produced nothing, so
		 * `isFinishedRecording` over the bytes that came back through the socket is the assertion.
		 *
		 * Gated on the decoder, because the verb answers with the normalised recording and its
		 * frames or with neither.
		 */
		it.skipIf(!process.env.ROVER_TEST_FRAME_EXTRACTION)(
			'records the real screen as bytes that are finished by the time they arrive',
			async () => {
				const client = await startHost();
				const device = await freeSimulator(client);
				const leaseId = await lease(client, device.serial);

				const recorded = await client.request(
					'record_video',
					{ leaseId, durationMs: RECORDING_MS },
					{ timeoutMs: RECORDING_REQUEST_TIMEOUT_MS },
				);

				expect(recorded).toMatchObject({
					outcome: 'ok',
					// A recording addresses nothing on the screen — it *is* the screen (D12(a)).
					result: { verb: 'record_video', target: null, device: { serial: device.serial } },
				});
				if (recorded.outcome !== 'ok') {
					throw new Error('the assertion above should have caught this');
				}
				const { artifact } = recorded.result;
				if (!artifact) {
					throw new Error(`the recording answered with no artifact: ${JSON.stringify(recorded)}`);
				}

				// Bytes, and only bytes: three fields, none of them a path on the host (D19).
				expect(Object.keys(artifact).sort()).toEqual(['base64', 'byteLength', 'mediaType']);
				const bytes = new Uint8Array(Buffer.from(artifact.base64, 'base64'));
				expect(bytes.byteLength).toBe(artifact.byteLength);
				expect(isFinishedRecording(bytes)).toBe(true);
				expect(recorded.result.frames.length).toBeGreaterThan(0);
			},
		);

		/**
		 * The held-open lifecycle over one lease, which is the shape an agent actually drives: start,
		 * do something, stop. Nothing is touched on the screen in between — this suite installs and
		 * launches nothing — so what it proves is the *lifecycle* rather than the motion, and the
		 * motion is `./recording.test.ts`'s.
		 */
		it.skipIf(!process.env.ROVER_TEST_FRAME_EXTRACTION)(
			'starts a recording and stops it under the same lease',
			async () => {
				const client = await startHost();
				const device = await freeSimulator(client);
				const leaseId = await lease(client, device.serial);

				const started = await client.request('start_recording', { leaseId });
				const info = await client.request('device_info', { leaseId });
				const stopped = await client.request(
					'stop_recording',
					{ leaseId },
					{ timeoutMs: RECORDING_REQUEST_TIMEOUT_MS },
				);

				expect(started).toMatchObject({ outcome: 'ok', result: { verb: 'start_recording' } });
				expect(info).toMatchObject({ outcome: 'ok' });
				expect(stopped).toMatchObject({ outcome: 'ok', result: { verb: 'stop_recording' } });
				if (stopped.outcome !== 'ok') {
					throw new Error('the assertion above should have caught this');
				}
				const bytes = new Uint8Array(Buffer.from(stopped.result.artifact?.base64 ?? '', 'base64'));
				expect(isFinishedRecording(bytes)).toBe(true);
			},
		);

		/**
		 * The refusal a second start gets, over the wire rather than off the class — and the reason
		 * this is worth a case here at all is that it is decided from the **host's process table**,
		 * so a daemon that had forgotten about the recording still answers it correctly.
		 */
		it('refuses a second start on a device the host is already recording', async () => {
			const client = await startHost();
			const device = await freeSimulator(client);
			const leaseId = await lease(client, device.serial);

			const started = await client.request('start_recording', { leaseId });
			const again = await client.request('start_recording', { leaseId });

			expect(started).toMatchObject({ outcome: 'ok' });
			expect(again).toMatchObject({
				outcome: 'failed',
				failure: { kind: 'recording-already-running', serial: device.serial },
			});
		});

		/**
		 * The teardown, over a lease: releasing is what stops a recorder the agent left running
		 * (D9), and on this platform that matters more than on the other one — the limit
		 * `start_recording` armed lives in this daemon, so nothing on the device would stop it.
		 *
		 * Asserted by asking the **machine** afterwards, through the same list the host answers
		 * from: the device is free again and a start on a fresh lease is accepted, which it would
		 * not be if a recorder were still holding the device's recording lock.
		 */
		it('stops a recorder the released lease left running', async () => {
			const client = await startHost();
			const device = await freeSimulator(client);
			const leaseId = await lease(client, device.serial);
			expect(await client.request('start_recording', { leaseId })).toMatchObject({
				outcome: 'ok',
			});

			await client.request('release_device', { leaseId });
			leases.length = 0;

			const next = await lease(client, device.serial);
			expect(await client.request('start_recording', { leaseId: next })).toMatchObject({
				outcome: 'ok',
			});
		});
	},
);
