import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import { isFinishedRecording } from '@/backends/ios-simulator/parsers/recording.js';
import { readProcessTable, runSimctlOnDevice } from '@/backends/ios-simulator/simctl.js';
import type { Device } from '@/core/device.js';
import {
	NoRecordingRunningError,
	RecordingAlreadyRunningError,
	UnfinishedRecordingError,
} from '@/core/errors.js';
import { type DeviceSerial, parseDeviceSerial, unwrap } from '@/core/ids.js';
import { readRecordingContainer } from '@/verbs/recording-container.js';

/**
 * The recorder against a real booted simulator — the half of this phase no mock can answer.
 *
 * The mocked suite beside it (`tests/unit/backends/ios-simulator/backend.test.ts`) proves the
 * argv, the order and every refusal with the process replaced. What this proves is what a mock
 * cannot: that a simulator answers this argv at all, that `Recording started` really arrives on
 * stderr, that `SIGINT` really finalises a file a decoder will open, and — the criterion the
 * whole phase turns on — that a recording of a screen that was *driven* comes back declaring more
 * than one sample.
 *
 * Gated on `ROVER_TEST_SIMULATOR` (`tests/device/setup.ts`), so a host with no booted simulator
 * **skips rather than fails** (ai/TESTING.md).
 *
 * **It boots nothing and shuts nothing down**, which is `docs/IOS.md` §8 trap 4's rule: a suite
 * that booted its own subject could take the operator's whole session with it. What it *does*
 * change is one setting, deliberately — the appearance, toggled to make the screen move for the
 * driven case — and it puts it back in `afterEach` on every path. Nothing is installed and
 * nothing is launched.
 *
 * **Only `SIGINT` is ever sent**, here as in the backend, and that is a rule this suite has to
 * keep as much as the code does: a killed recorder leaves CoreSimulator holding this device's
 * recording lock, and every later recording on it fails until the device is shut down and booted
 * again (`docs/IOS.md` §8). A suite that cleaned up with a kill would break the next run.
 *
 * It drives the backend class directly, outside any lease; `./verb-dispatch.test.ts` is where the
 * wire-level claim lives, which registration is what made possible.
 */
const backend = new IosSimulatorDeviceBackend();

/** A short recording: long enough to have a payload, short enough for a suite to wait on. */
const DURATION_MS = 2_000;

/** Where the backend derives a recording's path, restated so the suite can assert it is gone. */
const recordingPathOf = (serial: DeviceSerial): string =>
	join(tmpdir(), `rover-ios-recording-${unwrap(serial)}.mov`);

async function booted(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

/**
 * A simulator that is **not** booted, or `null` when this host has only one.
 *
 * The case that needs it says out loud that it did not run rather than passing quietly
 * (ai/RULES.md §6), which is `./screenshot.test.ts`'s stance on the same question.
 */
async function shutDown(): Promise<Device | null> {
	const down = (await backend.listDevices()).filter((device) => device.state !== 'ready');
	return down[0] ?? null;
}

/** Whether this host is running a recorder for `serial`, asked the way the backend asks. */
async function isRecording(serial: DeviceSerial): Promise<boolean> {
	return (await readProcessTable()).includes(`io ${unwrap(serial)} recordVideo`);
}

/** Whether the derived path holds anything at all. */
async function fileExists(serial: DeviceSerial): Promise<boolean> {
	return stat(recordingPathOf(serial)).then(
		() => true,
		() => false,
	);
}

/**
 * Leave nothing recording and nothing on disk, however a case ended, and put the appearance back.
 *
 * `discardRecording` is the teardown the daemon itself runs (D9), so using it here is not a
 * convenience: a case that failed part-way is exactly the abandoned recorder it exists for, and a
 * recorder left running would fail every case after it with the tool's own exit 16.
 */
afterEach(async () => {
	if (!process.env.ROVER_TEST_SIMULATOR) return;
	const device = (await backend.listDevices()).find((candidate) => candidate.state === 'ready');
	if (device === undefined) return;
	await backend.discardRecording(device.serial);
	await setAppearance(device.serial, 'light');
});

describe.skipIf(!process.env.ROVER_TEST_SIMULATOR)('the recorder against a real simulator', () => {
	/**
	 * The claim the whole method exists to make: the bytes that come back are a finished
	 * container, checked on what arrived rather than on an exit code — and `simctl` exits 0 on a
	 * recording that produced nothing.
	 */
	it('records a window and answers with a file a decoder will open', async () => {
		const device = await booted();

		const bytes = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

		expect(isFinishedRecording(bytes)).toBe(true);
		// QuickTime, brand `qt  ` — measured rather than assumed, and the reason the shared
		// container walk had to be checked against it rather than against an MP4.
		expect(new TextDecoder().decode(bytes.subarray(4, 12))).toBe('ftypqt  ');
		// A recording of a real screen is kilobytes at the very least. The floor is here for the
		// shape a write that produced nothing takes: a file of zero bytes that is really there.
		expect(bytes.byteLength).toBeGreaterThan(1024);
	});

	/** The shared walk reads this container: `moov`/`mvhd`/`trak`/`mdia`/`hdlr 'vide'`/`stsz`. */
	it('answers a recording the verb layer can describe', async () => {
		const device = await booted();

		const container = readRecordingContainer(
			await backend.recordVideo(device.serial, { durationMs: DURATION_MS }),
		);

		expect(container.kind).not.toBe('unreadable');
		if (container.kind === 'unreadable')
			throw new Error('the assertion above should have caught this');
		expect(container.sampleCount).toBeGreaterThan(0);
	});

	/**
	 * **The criterion the phase turns on.** A recorder emits a buffer only when the screen
	 * changes, so a capture of a still simulator comes back as one sample declaring a duration —
	 * true, and indistinguishable from a broken recorder by anything but this. Driving the screen
	 * is what shows the recording follows it: the appearance is toggled while the recording is
	 * open, which repaints the whole display and needs nothing installed.
	 */
	it('follows a screen that is driven, sample by sample', async () => {
		const device = await booted();

		await backend.startRecording(device.serial, { maxDurationMs: 15_000 });
		for (const appearance of ['dark', 'light', 'dark', 'light'] as const) {
			await setAppearance(device.serial, appearance);
		}
		const bytes = await backend.stopRecording(device.serial);

		const container = readRecordingContainer(bytes);
		expect(container.kind).toBe('samples');
		if (container.kind === 'unreadable')
			throw new Error('the assertion above should have caught this');
		expect(container.sampleCount).toBeGreaterThan(1);
		expect(container.durationMs).toBeGreaterThan(0);
	});

	/**
	 * The lifecycle, and the one property `recordVideo` cannot show: the recorder is still running
	 * when `startRecording` answers, and the machine says so.
	 */
	it('answers start while the recorder runs, and stop with the bytes', async () => {
		const device = await booted();

		await backend.startRecording(device.serial, { maxDurationMs: 15_000 });
		expect(await isRecording(device.serial)).toBe(true);

		const bytes = await backend.stopRecording(device.serial);

		expect(isFinishedRecording(bytes)).toBe(true);
		expect(await isRecording(device.serial)).toBe(false);
		// The scratch file goes with the answer: a recording left on a host that lends the same
		// device to somebody else next is what the cleanup is for.
		expect(await fileExists(device.serial)).toBe(false);
	});

	it('refuses a stop for a recording nothing ever started', async () => {
		const device = await booted();

		await expect(backend.stopRecording(device.serial)).rejects.toBeInstanceOf(
			NoRecordingRunningError,
		);
	});

	/**
	 * The refusal the process table decides. `simctl` would answer exit 16 *"Host recording is
	 * already in progress"* for the second recorder, which is a failed command rather than the
	 * actionable fact — so this asserts the name as well as the pids that make it actionable.
	 */
	it('refuses a second recording on a device that is already recording', async () => {
		const device = await booted();
		await backend.startRecording(device.serial, { maxDurationMs: 15_000 });

		const rejection = backend.startRecording(device.serial, { maxDurationMs: 15_000 });

		await expect(rejection).rejects.toBeInstanceOf(RecordingAlreadyRunningError);
		await expect(rejection).rejects.toThrow(/already recording/);
		// And the first recording is untouched by the refusal.
		expect(isFinishedRecording(await backend.stopRecording(device.serial))).toBe(true);
	});

	// It runs for every lease that ends and most leases never record anything (D9).
	it('discards nothing on an idle device, silently, and leaves no file', async () => {
		const device = await booted();

		await expect(backend.discardRecording(device.serial)).resolves.toBeUndefined();
		expect(await fileExists(device.serial)).toBe(false);
	});

	it('discards a recording the lease left running', async () => {
		const device = await booted();
		await backend.startRecording(device.serial, { maxDurationMs: 15_000 });

		await backend.discardRecording(device.serial);

		expect(await isRecording(device.serial)).toBe(false);
		expect(await fileExists(device.serial)).toBe(false);
	});

	/**
	 * **The trap the state check exists for, and the only place it can be demonstrated.** Against
	 * a `Shutdown` simulator `simctl io recordVideo` prints `Recording started`, runs for as long
	 * as it is left, exits **0** with `Recording completed. Writing to disk.` and leaves a
	 * zero-byte file (measured on macOS 26.6.2 / Xcode 26.6, 2026-09-08). Every signal the tool
	 * gives says it worked, so nothing downstream could catch it: the refusal is the check.
	 *
	 * The bound is five seconds against a refusal measured at ~0.15 s, deliberately loose: what it
	 * is here to catch is a recorder that ran, not a slow host.
	 */
	it('refuses a simulator that is not booted rather than recording nothing', async () => {
		const device = await shutDown();
		if (device === null) {
			console.warn(
				'no shut-down simulator on this host: the records-nothing refusal was NOT exercised',
			);
			return;
		}

		const started = Date.now();
		const rejection = backend.recordVideo(device.serial, { durationMs: DURATION_MS });

		await expect(rejection).rejects.toThrow(unwrap(device.serial));
		await expect(rejection).rejects.toThrow(/rather than ready/);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(await isRecording(device.serial)).toBe(false);
	});

	// The contract's own distinction from `describeDevice`'s `null`, on the real listing.
	it('throws for a device this host does not have at all', async () => {
		await expect(
			backend.recordVideo(parseDeviceSerial('00000000-0000-4000-8000-000000000000'), {
				durationMs: DURATION_MS,
			}),
		).rejects.toThrow(/no longer attached to this host/);
	});

	// Twice in a row, because a recording path that leaks a file, a handle or a device lock works
	// exactly once — which is precisely the failure a kill instead of an interrupt produces.
	it('can record again immediately afterwards', async () => {
		const device = await booted();

		await backend.recordVideo(device.serial, { durationMs: DURATION_MS });
		const again = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

		expect(isFinishedRecording(again)).toBe(true);
	});

	/**
	 * `UnfinishedRecordingError` is the answer to bytes that are not a playable file, and on this
	 * platform the shape that produces is a **zero-byte** one: `simctl` writes the whole container
	 * at the end, so a recording stopped before it had a frame leaves a file that is really there
	 * and holds nothing. Arranged by stopping the moment the start marker arrives.
	 */
	it('refuses a recording stopped before it had anything to write', async () => {
		const device = await booted();
		await backend.startRecording(device.serial, { maxDurationMs: 15_000 });

		const rejection = backend.stopRecording(device.serial);

		// Either shape is a true answer about the device: a recorder given a frame in the moment
		// between the marker and the signal produced a playable file, and one that was not left
		// nothing. What must never happen is the second being handed over as the first.
		const outcome: Uint8Array | unknown = await rejection.then(
			(bytes) => bytes,
			(error: unknown) => error,
		);
		if (outcome instanceof Error) {
			expect(outcome).toBeInstanceOf(UnfinishedRecordingError);
			expect(outcome.message).toMatch(/no index block/);
		} else {
			expect(isFinishedRecording(outcome as Uint8Array)).toBe(true);
		}
	});
});

/**
 * Repaint the whole display, which is this platform's cheapest way to make the screen move
 * without installing or launching anything.
 *
 * `simctl ui <device> appearance <mode>` is a device setting rather than a capture, so it is not
 * something the backend has a method for — the suite runs it itself, and puts it back.
 */
async function setAppearance(serial: DeviceSerial, appearance: 'dark' | 'light'): Promise<void> {
	await runSimctlOnDevice(serial, 'ui', ['appearance', appearance]);
}
