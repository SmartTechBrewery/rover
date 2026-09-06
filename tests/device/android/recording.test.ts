import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import { isFinishedRecording } from '@/backends/android/parsers/screenrecord.js';
import type { Device, ScreenElement } from '@/core/device.js';
import { NoRecordingRunningError, RecordingAlreadyRunningError } from '@/core/errors.js';
import { type DeviceSerial, unwrap } from '@/core/ids.js';
import { extractFrames } from '@/daemon/frames.js';
import { normaliseRecording } from '@/daemon/normalise.js';
import { FrameExtractionFailedError } from '@/verbs/errors.js';
import {
	FRAME_WIDTH_PX,
	MAX_FRAMES,
	MAX_FRAMES_BYTES,
	MAX_FRAMES_PER_SECOND,
	MAX_RECORDING_MS,
} from '@/verbs/record.js';
import { readRecordingContainer } from '@/verbs/recording-container.js';
import { NORMALISED_MAX_BIT_RATE_BPS, planNormalisation } from '@/verbs/recording-normalisation.js';
import { MAX_ARTIFACT_BYTES } from '@/verbs/result.js';

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
 * **Read-only with respect to the screen, with one deliberate exception** (#190): the
 * `start_recording` / `stop_recording` cases *drive* the device between the two calls, because
 * that is the whole of what they are for — a recording of a screen nobody touched is the
 * still-screen answer, and it is what proved the old shape unusable. What they drive is `home`
 * and two vertical swipes, so nothing is launched, nothing is installed, no setting is changed
 * and the device is put back on its home screen afterwards. Everything else here still records
 * whatever is in front of it and touches nothing.
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
 * **So is the normalisation** (#185), on the same flag, because it drives the same program.
 * What a mocked process cannot say is the whole of what that change claims: that a recording of
 * a screen that never moved comes back as a file with a real timeline in it, that one with
 * motion keeps every sample the recorder wrote, and that what the muxer writes is still
 * decodable from a pipe — which is `+faststart`'s only job and the one property PROJECT.md §6
 * records as load-bearing for everything downstream.
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

/**
 * The window the overlap case records for. Longer than {@link DURATION_MS} on purpose: that
 * case asserts the recording was *still running* when the screen read came back, and a
 * `uiautomator dump` on a loaded device takes a second or two of it. Six seconds is headroom
 * over a real dump rather than a number tuned to one emulator's timing.
 */
const OVERLAP_DURATION_MS = 6_000;

/** The sampling rate the frame cases ask for — named, so the count assertion can use it. */
const FRAMES_PER_SECOND = 2;

/**
 * How long a swipe that is meant to be *seen* takes, in milliseconds.
 *
 * Slower than a flick on purpose: the recorder emits a buffer only when the screen changes, so
 * what a driving case needs is a transition that lasts long enough to produce several of them.
 * It is a number this suite owns rather than a verb-layer default, because nothing here goes
 * through the verb layer.
 */
const DRIVEN_SWIPE_MS = 300;

/** The two unit conversions the rate-ceiling assertion needs, spelled out rather than inline. */
const MS_PER_SECOND = 1_000;
const BITS_PER_BYTE = 8;

/**
 * What the rate-ceiling assertion allows above `NORMALISED_MAX_BIT_RATE_BPS` × the container's
 * declared duration: the MP4's own boxes, and the VBV overshoot `-bufsize` admits by design —
 * the buffer is the rate itself, so a quarter of a megabyte of it. Generous rather than tuned,
 * because a device case that goes red on encoder slack is worse than one that admits some.
 */
const RATE_CEILING_SLACK_BYTES = 512 * 1024;

const backend = new AndroidDeviceBackend();

async function firstUsableDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

/**
 * Drive the device so there is something in the recording, and put it back where it started.
 *
 * `home`, a swipe up, the screen read the whole issue is about, a swipe down, `home` again — a
 * transition at each end, so the recorder has something to encode. The coordinates come off
 * `deviceInfo` rather than being written down: this suite hardcodes no size (see the header), and
 * `swipe` takes dp.
 *
 * It answers with what the read saw, so a caller can assert that the read worked *and* that the
 * recording it overlapped survived — a read that answered by spoiling the recording would be worse
 * than one that waited.
 */
async function driveAndRead(serial: DeviceSerial): Promise<ScreenElement[]> {
	const { screen } = await backend.deviceInfo(serial);
	const x = screen.widthDp / 2;
	const low = { x, y: screen.heightDp * 0.7 };
	const high = { x, y: screen.heightDp * 0.3 };

	await backend.pressKey(serial, 'home');
	await backend.swipe(serial, low, high, DRIVEN_SWIPE_MS);
	const elements = await backend.readScreen(serial);
	await backend.swipe(serial, high, low, DRIVEN_SWIPE_MS);
	await backend.pressKey(serial, 'home');
	return elements;
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

	/**
	 * The claim #184 phase 1 turns on, and the only place it can be made: the unit suite
	 * asserts it over a mocked runner, which cannot say whether `uiautomator dump` and
	 * `screenrecord` coexist on a real device at all.
	 *
	 * Three things at once — the read answers with a screen, the recording it overlapped is
	 * still *finished* when it arrives, and the scratch file is gone afterwards — because a
	 * read that answered by corrupting the recording would be worse than one that waited.
	 *
	 * Read-only with respect to the screen, like the rest of this suite: it reads whatever is
	 * on the device and changes nothing.
	 */
	it('answers a screen read while a recording is still running', async () => {
		const device = await firstUsableDevice();
		let finished = false;
		const recording = backend
			.recordVideo(device.serial, { durationMs: OVERLAP_DURATION_MS })
			.finally(() => {
				finished = true;
			});

		const elements = await backend.readScreen(device.serial);

		expect(elements.length).toBeGreaterThan(0);
		// The read did not queue behind the recorder: the recording is still in flight.
		expect(finished).toBe(false);
		expect(isFinishedRecording(await recording)).toBe(true);
		expect(await listScratchFile(device.serial)).toMatch(/No such file or directory/);
	}, 60_000);

	/**
	 * What the answer now says the recording contains (#183) — read off a real recorder's
	 * output rather than off a fixture or a hand-built file.
	 *
	 * Gated on the device flag **only**: the walk needs no decoder, so this case has nothing to
	 * do with `ROVER_TEST_FRAME_EXTRACTION`.
	 *
	 * **No relationship is asserted between these numbers, the duration asked for, and how many
	 * frames come out.** Whichever screen happens to be on the device decides all three, and a
	 * still one is a legitimate answer — PROJECT.md §6 records a 15 s capture declaring 27.61 s.
	 * Asserting the product would be asserting a device's timing.
	 */
	it('says how many samples the recording holds and what duration it declares', async () => {
		const device = await firstUsableDevice();

		const bytes = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });
		const container = readRecordingContainer(bytes);

		// A real recorder's own container, so this walk must be able to read it — `unreadable`
		// here would mean the parse does not understand what the device actually writes.
		expect(container.kind).not.toBe('unreadable');
		if (container.kind === 'unreadable') return;
		expect(container.sampleCount).toBeGreaterThanOrEqual(1);
		expect(container.durationMs).toBeGreaterThanOrEqual(0);
	}, 60_000);
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

/**
 * The normalisation against a real recording off a real device (#185) — the half no mock can
 * assert, on the same gate as the extraction because it drives the same program.
 *
 * Whichever screen happens to be on the device decides which branch each case takes, so every
 * assertion below is a property of *whatever came back* rather than of a screen this suite
 * arranged. In particular **nothing here relates a frame count to a duration times a rate**:
 * PROJECT.md §6 rules that out as an assertion about a device's timing, and normalising does not
 * change that.
 */
describe.skipIf(!process.env.ROVER_TEST_DEVICE || !process.env.ROVER_TEST_FRAME_EXTRACTION)(
	'normalising a real recording into a file that plays',
	() => {
		/**
		 * The headline criterion: whatever the recorder wrote, what comes back declares a real
		 * timeline and more than the one sample a still screen arrives as. On a device sitting
		 * idle this is the hold branch — the case the whole change exists for, and the one that
		 * used to come back as `duration 0.000000` / `nb_frames 1`.
		 */
		it('answers with a recording whose container declares a timeline a viewer can trust', async () => {
			const device = await firstUsableDevice();
			const recording = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });
			const plan = planNormalisation(readRecordingContainer(recording), DURATION_MS);

			const normalised = await normaliseRecording(device.serial, recording, {
				holdForMs: plan.holdForMs,
			});
			const container = readRecordingContainer(normalised);

			// Read back with the same walk the verb uses, so this is the answer a client would get
			// rather than a second opinion from another tool.
			expect(container.kind).toBe('samples');
			if (container.kind !== 'samples') return;
			expect(container.durationMs).toBeGreaterThan(0);
			expect(container.sampleCount).toBeGreaterThan(1);
		}, 120_000);

		/**
		 * `+faststart`'s only job, and the reason it is not optional: the `moov` has to sit before
		 * the payload or nothing downstream can read this file from a stream. Feeding it to the
		 * frame extractor is the executable proof, because that is exactly what `ffmpeg -i pipe:0`
		 * requires (PROJECT.md §6).
		 */
		it('writes a file that is still decodable from a pipe, index before payload', async () => {
			const device = await firstUsableDevice();
			const recording = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });
			const plan = planNormalisation(readRecordingContainer(recording), DURATION_MS);

			const normalised = await normaliseRecording(device.serial, recording, {
				holdForMs: plan.holdForMs,
			});
			const frames = await extractFrames(device.serial, normalised, {
				framesPerSecond: FRAMES_PER_SECOND,
			});

			expect(frames.length).toBeGreaterThan(0);
			expect(isPng(frames[0] as Uint8Array)).toBe(true);
		}, 120_000);

		/**
		 * The bound the answer is actually held to. Re-encoding changes the byte count, so this is
		 * the number `artifact-too-large` would be decided on — and the rate ceiling exists so
		 * that a normal recording stays well inside it rather than becoming a refusal that the
		 * un-normalised bytes would not have been.
		 *
		 * **Which bound holds depends on the branch, so the assertion asks the plan which one it
		 * is on.** Only the *hold* branch is bounded by `MAX_ARTIFACT_BYTES` by construction:
		 * `MAX_RECORDING_MS` at `NORMALISED_MAX_BIT_RATE_BPS` is 3.75 MB inside 4 MiB. The
		 * container branch keeps the recorder's own timeline, and `NORMALISED_MAX_BIT_RATE_BPS`'
		 * own documentation says the ceiling "is not a guarantee" there — a 15 s ask whose
		 * container declares more than ~16.8 s goes over, and PROJECT.md §6 measures a real 15 s
		 * still-screen capture declaring 27.61 s. Asserting `MAX_ARTIFACT_BYTES` unconditionally
		 * would go red on a device that was merely busy, for the implementation behaving exactly
		 * as documented. So the container branch asserts the property the code *does* promise:
		 * the byte count is consistent with the timeline the container itself declares, at the
		 * rate ceiling.
		 */
		it('stays inside what one answer can carry, at the longest recording the wire admits', async () => {
			const device = await firstUsableDevice();
			const recording = await backend.recordVideo(device.serial, {
				durationMs: MAX_RECORDING_MS,
			});
			const container = readRecordingContainer(recording);
			const plan = planNormalisation(container, MAX_RECORDING_MS);

			const normalised = await normaliseRecording(device.serial, recording, {
				holdForMs: plan.holdForMs,
			});

			expect(normalised.byteLength).toBeGreaterThan(0);
			if (plan.holdForMs !== null) {
				expect(normalised.byteLength).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
				return;
			}
			// The container branch. An unreadable container lands here too and declares no
			// duration to hold the rate against, so there is nothing to assert beyond the
			// non-empty file above — and an unreadable one is its own case elsewhere.
			if (container.kind !== 'samples') return;
			const atTheCeiling =
				(container.durationMs / MS_PER_SECOND) * (NORMALISED_MAX_BIT_RATE_BPS / BITS_PER_BYTE);
			expect(normalised.byteLength).toBeLessThanOrEqual(atTheCeiling + RATE_CEILING_SLACK_BYTES);
		}, 180_000);

		// No host path reaches an answer and nothing is left on the device either: the normaliser
		// owns its scratch directory and removes it, and the only device-side path this repository
		// ever writes is the recording's own (D19).
		it('leaves nothing behind on the device or in what it answers with', async () => {
			const device = await firstUsableDevice();
			const recording = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

			await normaliseRecording(device.serial, recording, { holdForMs: null });

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

/**
 * The recording held open across two calls (#190) — the half `record_video` cannot demonstrate,
 * against a device rather than against a mocked runner.
 *
 * What only a device can say here is everything the recipe rests on: that a recorder launched
 * detached really outlives its adb client, that the interrupt really makes it write its index,
 * and — the criterion the whole issue turns on — that **what happened on the screen between the
 * two calls is in the recording**. A one-frame answer is exactly what proved the old shape
 * unusable, so the assertion is more than one sample, a non-zero duration and more than one
 * frame; nothing here relates the frame count to a duration times a rate, which PROJECT.md §6
 * rules out as an assertion about a device's timing.
 *
 * This is the block that drives the device, within the bounds the header states.
 */
describe.skipIf(!process.env.ROVER_TEST_DEVICE)('a recording started and stopped', () => {
	// The device must not be left recording by a case that threw part-way: the next one would be
	// refused by name, correctly, and the suite would report a cascade instead of the one failure.
	afterEach(async () => {
		const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
		for (const device of ready) {
			await backend.stopRecording(device.serial).catch(() => undefined);
		}
	});

	/**
	 * The headline criterion. The device is driven *inside* the recording — which is only possible
	 * because the scratch-path queue excludes per file (#184 phase 1) — and what comes back
	 * declares more than the single sample a screen nobody touched produces.
	 */
	it('captures what happened on the screen between the two calls', async () => {
		const device = await firstUsableDevice();

		await backend.startRecording(device.serial, { maxDurationMs: MAX_RECORDING_MS });
		const elements = await driveAndRead(device.serial);
		const bytes = await backend.stopRecording(device.serial);

		// The read answered while the recording was open, and the recording survived it.
		expect(elements.length).toBeGreaterThan(0);
		expect(isFinishedRecording(bytes)).toBe(true);
		const container = readRecordingContainer(bytes);
		expect(container.kind).not.toBe('unreadable');
		if (container.kind === 'unreadable') return;
		// More than one sample and a real timeline: this is the assertion that separates "the
		// device was driven and it was recorded" from the still screen every other check passes for.
		expect(container.sampleCount).toBeGreaterThan(1);
		expect(container.durationMs).toBeGreaterThan(0);
	}, 90_000);

	/**
	 * The cleanup, on the device: a multi-megabyte file left on hardware that goes to somebody
	 * else next is what the `finally` in the stop exists to prevent.
	 *
	 * **It drives the device rather than stopping straight away**, and that is not padding. A stop
	 * that arrives before the encoder has written a frame leaves a zero-byte file and is refused as
	 * `unfinished-recording` (PROJECT.md §6) — which is correct behaviour and cleans up just the
	 * same, but whether an immediate stop lands on that side is the device's timing rather than
	 * anything this asserts. Driving makes the successful stop the case under test; the refusal
	 * path's own cleanup is pinned over a mocked runner in
	 * `tests/unit/backends/android/backend.test.ts`, where it can be reached on purpose.
	 */
	it('leaves no scratch file behind on the device', async () => {
		const device = await firstUsableDevice();

		await backend.startRecording(device.serial, { maxDurationMs: MAX_RECORDING_MS });
		await driveAndRead(device.serial);
		await backend.stopRecording(device.serial);

		expect(await listScratchFile(device.serial)).toMatch(/No such file or directory/);
	}, 90_000);

	// Two lifecycles in a row, because a path that leaks a recorder or a file works exactly once —
	// and the second one is the case a stale scratch file would corrupt. Driven for the reason
	// above: what is under test is the second lifecycle, not how fast this device's encoder is.
	it('can be started again immediately after a stop', async () => {
		const device = await firstUsableDevice();

		await backend.startRecording(device.serial, { maxDurationMs: MAX_RECORDING_MS });
		await driveAndRead(device.serial);
		await backend.stopRecording(device.serial);
		await backend.startRecording(device.serial, { maxDurationMs: MAX_RECORDING_MS });
		await driveAndRead(device.serial);
		const second = await backend.stopRecording(device.serial);

		expect(isFinishedRecording(second)).toBe(true);
	}, 120_000);

	/**
	 * The refusal, against a device that really is recording — which is the only place the probe
	 * behind it can be checked at all. It names the pids, and those come off the device rather
	 * than out of anything this host remembered (D6).
	 */
	it('refuses a second recording by name, naming the device and the pids', async () => {
		const device = await firstUsableDevice();
		await backend.startRecording(device.serial, { maxDurationMs: MAX_RECORDING_MS });

		const failure = await backend
			.startRecording(device.serial, { maxDurationMs: MAX_RECORDING_MS })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(RecordingAlreadyRunningError);
		expect((failure as RecordingAlreadyRunningError).pids.length).toBeGreaterThan(0);
		expect(String(failure)).toContain(unwrap(device.serial));
	}, 90_000);

	// And the same refusal covers the fixed-length verb during an open session, because it is one
	// fact about the device rather than a rule about a call. It used to be a ten-second timeout.
	it('refuses a fixed-length recording during an open session, by the same name', async () => {
		const device = await firstUsableDevice();
		await backend.startRecording(device.serial, { maxDurationMs: MAX_RECORDING_MS });

		const failure = await backend
			.recordVideo(device.serial, { durationMs: DURATION_MS })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(RecordingAlreadyRunningError);
	}, 90_000);

	// The narrow failure: no recorder and nothing left behind. A recorder that stopped itself is
	// deliberately not this, because the file it left is complete.
	it('refuses a stop with nothing recording, naming the device', async () => {
		const device = await firstUsableDevice();

		const failure = await backend.stopRecording(device.serial).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(NoRecordingRunningError);
		expect(String(failure)).toContain(unwrap(device.serial));
	}, 60_000);

	/**
	 * The other half of the headline criterion, on the host's own gate: a recording of a driven
	 * screen slices into **more than one** frame. One frame is what a still screen produces, and
	 * an answer that could not tell the two apart is the thing this phase exists to fix.
	 */
	it.skipIf(!process.env.ROVER_TEST_FRAME_EXTRACTION)(
		'slices the driven recording into more than one frame',
		async () => {
			const device = await firstUsableDevice();

			await backend.startRecording(device.serial, { maxDurationMs: MAX_RECORDING_MS });
			await driveAndRead(device.serial);
			const bytes = await backend.stopRecording(device.serial);

			const frames = await extractFrames(device.serial, bytes, {
				framesPerSecond: FRAMES_PER_SECOND,
			});

			expect(frames.length).toBeGreaterThan(1);
			expect(frames.length).toBeLessThanOrEqual(MAX_FRAMES);
			for (const frame of frames) expect(isPng(frame)).toBe(true);
		},
		120_000,
	);
});
