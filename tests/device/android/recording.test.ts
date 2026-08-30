import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import { isFinishedRecording } from '@/backends/android/parsers/screenrecord.js';
import type { Device } from '@/core/device.js';
import { extractFrames } from '@/daemon/frames.js';
import { FrameExtractionFailedError } from '@/verbs/errors.js';
import {
	FRAME_WIDTH_PX,
	MAX_FRAMES,
	MAX_FRAMES_BYTES,
	MAX_FRAMES_PER_SECOND,
	MAX_RECORDING_MS,
} from '@/verbs/record.js';

/**
 * `screenrecord` against a real attached device. Skips rather than fails when there is none
 * (`tests/device/setup.ts`, ai/TESTING.md).
 *
 * **This is the only place the `moov` claim can actually be checked.** Everything the unit
 * suites assert about ordering is asserted over a mocked runner, which cannot say whether
 * the device answers this argv at all, whether the recorder is really gone by the time its
 * adb client returns, or whether the bytes that cross the bridge are still a playable file.
 * A recording pulled early is not a shorter video — it is a file with no index, which no
 * player will open — so "the pull happened after the recorder exited" is the property, and
 * a real encoder is the only thing that can demonstrate it.
 *
 * **Read-only with respect to the screen**: it records whatever is on the device, launches
 * nothing and changes no setting, so it is safe against a device someone else is looking at.
 * **It drives the backend class directly, outside any lease** — the sixth suite on
 * ai/TESTING.md's temporary exemption list, alongside `./screenshot.test.ts`. Leases do
 * exist and a daemon will lend one; the only reason this suite does not take one is that
 * the helper that acquires and releases a lease around a suite has not been written and
 * this suite has not been converted onto it. `./verb-dispatch.test.ts` records through a
 * lease, and that is where the wire-level claim lives.
 *
 * **The frame extraction is here too, and it is the only place it can be checked** (#82).
 * Everything the unit suites assert about it is asserted over a mocked process, which cannot
 * say whether a real decoder reads a real recording off a pipe at all. It can: a recorder on
 * this platform writes its index box *before* the payload, so the whole file is decodable
 * from a stream with no host temp file anywhere (PROJECT.md §6). Those cases gate on
 * `ROVER_TEST_FRAME_EXTRACTION` and the run **says so loudly** when the program is missing
 * (`tests/device/setup.ts`) rather than passing in silence.
 *
 * Nothing below hardcodes a size, a model or a byte count off one device — every assertion
 * is a property of whatever is attached.
 */
const execFileAsync = promisify(execFile);
const ADB_TIMEOUT_MS = 10_000;

/** The device-side scratch path the backend owns, named here to assert it is gone after. */
const RECORDING_PATH = '/sdcard/rover-recording.mp4';

/** A short recording: long enough to have a payload, short enough for a suite to wait on. */
const DURATION_MS = 2_000;

/** The sampling rate the frame cases ask for — named, so the count assertion can use it. */
const FRAMES_PER_SECOND = 2;

const backend = new AndroidDeviceBackend();

async function firstUsableDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
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

describe.skipIf(!process.env.ROVER_TEST_DEVICE)('record_video against a real device', () => {
	/**
	 * The recipe proof, and the headline criterion of the whole change: what comes back is a
	 * **finished** recording, because the pull did not happen until the encoder had written
	 * its index. Nothing else about these bytes — not the length, not the exit code — can
	 * tell that from a recording pulled a moment too early.
	 */
	it('answers with a recording that is finished by the time it gets here', async () => {
		const device = await firstUsableDevice();

		const bytes = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

		expect(isFinishedRecording(bytes)).toBe(true);
		// A real encode of a real screen is kilobytes at the very least. The floor is here for
		// the shape a truncated stream takes when it happens to keep its header.
		expect(bytes.byteLength).toBeGreaterThan(4 * 1024);
	}, 60_000);

	// The cleanup, on the device rather than in the call log: a multi-megabyte file left on
	// hardware that goes to somebody else next is what the `finally` exists to prevent.
	it('leaves no scratch file behind on the device', async () => {
		const device = await firstUsableDevice();

		await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

		expect(await listScratchFile(device.serial)).toMatch(/No such file or directory/);
	}, 60_000);

	// Two recordings in a row, because a path that leaks a file or a recorder process works
	// exactly once — and the second one is the case a stale scratch file would corrupt.
	it('can be called again immediately', async () => {
		const device = await firstUsableDevice();

		await backend.recordVideo(device.serial, { durationMs: DURATION_MS });
		const second = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

		expect(isFinishedRecording(second)).toBe(true);
	}, 120_000);
});

/**
 * The extraction against a real recording off a real device — the half no mock can assert.
 *
 * Gated on the host having the decoder, and the run says so loudly when it does not
 * (`tests/device/setup.ts`), because a case that quietly does not run reads as one that
 * passed (ai/RULES.md §6).
 */
describe.skipIf(!process.env.ROVER_TEST_DEVICE || !process.env.ROVER_TEST_FRAME_EXTRACTION)(
	'slicing a real recording into frames',
	() => {
		/**
		 * The headline criterion of phase 2, and three claims a mocked process cannot make: that a
		 * real decoder reads this platform's recording **off a pipe**, that what it writes back
		 * splits into whole images, and that they are the size this host asked for.
		 */
		it('answers with frames a reader would accept, at the width it asked for', async () => {
			const device = await firstUsableDevice();
			const recording = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

			const frames = await extractFrames(device.serial, recording, {
				framesPerSecond: FRAMES_PER_SECOND,
			});

			// Never empty: a recording of a screen that never moved still has one sample in it, and
			// an empty list is what this whole phase exists to make impossible (ai/RULES.md §2).
			expect(frames.length).toBeGreaterThan(0);
			// The ceiling is `MAX_FRAMES` and **not** the rate times the duration, which was
			// measured and is not a bound at all: `screenrecord` gives a still screen a container
			// duration far longer than the capture was asked for — 27.61 s for a 15 s recording on
			// an API 35 emulator (PROJECT.md §6) — and `fps` samples the timeline the container
			// declares. Asserting the product here would be asserting a device's timing.
			expect(frames.length).toBeLessThanOrEqual(MAX_FRAMES);

			for (const frame of frames) {
				expect(isPng(frame)).toBe(true);
				expect(ihdrWidth(frame)).toBe(FRAME_WIDTH_PX);
			}
			// And the whole set fits one answer, which is what the bound is for.
			expect(frames.reduce((total, frame) => total + frame.byteLength, 0)).toBeLessThanOrEqual(
				MAX_FRAMES_BYTES,
			);
		}, 90_000);

		/**
		 * The count bound, at the two values most likely to reach it — and the only place a real
		 * decoder can be asked whether it reaches it at all.
		 *
		 * `-frames:v` at the bound itself would make ffmpeg stop writing and exit **0**, which is
		 * a frame list cut short that nothing downstream can tell from a complete one. So the
		 * decoder is asked for one frame *more* than the bound, and either answer here is a pass:
		 * a count within the bound, or the named failure. What may never happen is the third
		 * thing — an `ok` answer that stopped exactly where the decoder was told to.
		 *
		 * On the emulator this was measured against, it is the refusing branch: a fifteen-second
		 * capture of a mostly-still screen declares a 27.61 s timeline (PROJECT.md §6), and four
		 * frames a second over that is roughly a hundred slots.
		 */
		it('refuses by name rather than answering with a list that stopped at the cap', async () => {
			const device = await firstUsableDevice();
			const recording = await backend.recordVideo(device.serial, {
				durationMs: MAX_RECORDING_MS,
			});

			const answer: Uint8Array[] | Error = await extractFrames(device.serial, recording, {
				framesPerSecond: MAX_FRAMES_PER_SECOND,
			}).catch((error: Error) => error);

			if (answer instanceof Error) {
				expect(answer).toBeInstanceOf(FrameExtractionFailedError);
				expect(answer.message).toContain(`more than the ${MAX_FRAMES} frames`);
				// And it says which way out, because the pair of numbers alone does not.
				expect(answer.message).toContain('Record for less time');
				return;
			}
			expect(answer.length).toBeGreaterThan(0);
			expect(answer.length).toBeLessThanOrEqual(MAX_FRAMES);
		}, 120_000);

		// The rate is honoured rather than merely accepted: half the sampling over the same
		// recording is fewer frames, which is the one thing a fixed-rate extractor would fail.
		it('samples at the rate it was asked for', async () => {
			const device = await firstUsableDevice();
			const recording = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

			const dense = await extractFrames(device.serial, recording, { framesPerSecond: 4 });
			const sparse = await extractFrames(device.serial, recording, { framesPerSecond: 1 });

			expect(sparse.length).toBeLessThanOrEqual(dense.length);
			expect(sparse.length).toBeGreaterThan(0);
		}, 120_000);

		// No host temp file, so nothing to clean up and no path that could reach an answer (D19).
		// The one thing a file-based extractor would leave behind is a file, and the recording's own
		// scratch path is the only one this repository ever writes.
		it('leaves nothing on the device behind either', async () => {
			const device = await firstUsableDevice();
			const recording = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

			await extractFrames(device.serial, recording, { framesPerSecond: FRAMES_PER_SECOND });

			expect(await listScratchFile(device.serial)).toMatch(/No such file or directory/);
		}, 90_000);
	},
);

/** The eight bytes every PNG starts with (PNG 1.2 §3.1), read rather than assumed. */
function isPng(bytes: Uint8Array): boolean {
	return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
		(byte, index) => bytes[index] === byte,
	);
}

/**
 * The width in a PNG's `IHDR`, which is the first chunk and always at the same offset: the
 * signature (8), the chunk length and type (8), then `width:uint32` (PNG 1.2 §4.1.1).
 */
function ihdrWidth(bytes: Uint8Array): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
}
