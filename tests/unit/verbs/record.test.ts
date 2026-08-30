/**
 * `record_video`, over a backend that records what it was asked to do and a host that slices
 * what it recorded.
 *
 * The assertions that carry this verb are about things a green result cannot show:
 *
 * - **A backend without `canRecordVideo` is never touched.** The verb would otherwise still
 *   answer — the spine's after-state and a null artifact — and for this verb that softer
 *   answer is the one D11 forbids, because the payload *is* the answer. The difference
 *   between a loud `MissingCapabilityError` before anything is dispatched and a successful
 *   result carrying no recording is what `requires: ['canRecordVideo']` buys.
 * - **A recording over the bound is refused by name rather than trimmed**, and refused where
 *   the recording happened rather than after the spine has spent a screen read.
 * - **Frames that would not fit are refused whole, naming both numbers.** A shorter list would
 *   read as a recording in which nothing happened between two moments that are no longer
 *   adjacent, and nothing in the answer would say otherwise.
 * - **The frames are sliced from the recording that was pulled**, not from a second pass over
 *   the device: the extractor is handed the bytes the backend returned, and the call log below
 *   is what shows the device was touched once.
 *
 * The extractor is a parameter rather than an import (`FrameExtractor`), which is what keeps a
 * process spawn out of every client's module graph — so a test supplies its own rather than
 * mocking a module. Nothing here judges the recording itself. Whether the bytes are a
 * *finished* recording is the backend's question, asked of the bytes it pulled
 * (`UnfinishedRecordingError`), and whether the recording shows anything is the agent's.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '@/core/capabilities.js';
import type { DeviceBackend } from '@/core/device.js';
import { MissingCapabilityError } from '@/core/errors.js';
import { MAX_FRAME_BYTES } from '@/ipc/framing.js';
import type { VerbContext } from '@/verbs/context.js';
import { ArtifactTooLargeError, FramesTooLargeError } from '@/verbs/errors.js';
import {
	DEFAULT_FRAMES_PER_SECOND,
	DEFAULT_RECORDING_MS,
	FRAME_WIDTH_PX,
	type FrameExtractor,
	MAX_FRAMES,
	MAX_FRAMES_BYTES,
	MAX_FRAMES_PER_SECOND,
	MAX_RECORDING_MS,
	type RecordVideoVerbOptions,
	recordVideo,
} from '@/verbs/record.js';
import { MAX_ARTIFACT_BYTES } from '@/verbs/result.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockPngBytes,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

const save = createMockScreenElement({ id: 'save', text: 'Save' });

/**
 * The `ftyp` box every ISO base media file opens with, written out rather than imported.
 *
 * The verb layer cannot reach the backend that owns the other copy of this knowledge, and a
 * test that borrowed the implementation's own constant would agree with it whatever it said.
 */
const FTYP_HEADER = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70];

/** A recording of `byteLength` bytes that a reader would recognise as MP4 at the header. */
function recorded(byteLength: number): Uint8Array {
	const bytes = new Uint8Array(byteLength);
	bytes.set(FTYP_HEADER.slice(0, byteLength));
	// Not all zeroes past the header: a base64 round trip of a run of zeroes is the one
	// payload an off-by-one in the encoding would survive unnoticed.
	for (let at = FTYP_HEADER.length; at < byteLength; at += 1) bytes[at] = at % 251;
	return bytes;
}

interface Recording {
	readonly calls: string[];
	readonly durations: number[];
	readonly rates: number[];
	/** What the extractor was handed — the bytes the backend returned, or nothing yet. */
	readonly sliced: Uint8Array[];
	readonly context: VerbContext;
	readonly options: RecordVideoVerbOptions;
}

/**
 * A context whose backend records every call on one shared log, in order, and a host-side
 * extractor that logs what it was asked to slice.
 *
 * The extractor is supplied rather than imported, which is the verb's own contract: the
 * decoder behind the real one starts a process, and a process reached from `src/verbs/` would
 * be a process in every client's module graph (`src/daemon/frames.ts`).
 */
function recording(
	options: {
		capabilities?: Capabilities;
		video?: Uint8Array;
		frames?: readonly Uint8Array[];
		extractFrames?: FrameExtractor;
	} = {},
): Recording {
	const calls: string[] = [];
	const durations: number[] = [];
	const rates: number[] = [];
	const sliced: Uint8Array[] = [];
	const bytes = options.video ?? recorded(2_048);

	const backend = createMockDeviceBackend({
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
			calls.push('readScreen');
			return [save];
		}),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async (serial) => {
			calls.push('deviceInfo');
			return createMockDeviceInfo({ serial });
		}),
		recordVideo: vi.fn<NonNullable<DeviceBackend['recordVideo']>>(
			async (_serial, recordOptions) => {
				calls.push('recordVideo');
				durations.push(recordOptions.durationMs);
				return bytes;
			},
		),
	});

	const context = createMockVerbContext({
		backend,
		manifest: createMockCapabilityManifest({
			capabilities: options.capabilities ?? createMockCapabilities(),
		}),
	});

	const extractFrames: FrameExtractor =
		options.extractFrames ??
		(async (_serial, recorded_, extractOptions) => {
			calls.push('extractFrames');
			rates.push(extractOptions.framesPerSecond);
			sliced.push(recorded_);
			return [...(options.frames ?? [createMockPngBytes(), createMockPngBytes()])];
		});

	return { calls, durations, rates, sliced, context, options: { extractFrames } };
}

describe('record_video', () => {
	it('is on the spine: it records, slices, then reads the screen, then reads the device', async () => {
		const { calls, context, options } = recording();

		const result = await recordVideo(context, options);

		expect(result.verb).toBe('record_video');
		// The recording and the slicing first, then the spine's own capture — a verb that
		// assembled its own answer would show neither of the last two.
		expect(calls).toEqual(['recordVideo', 'extractFrames', 'readScreen', 'deviceInfo']);
		expect(result.after).toEqual({ kind: 'screen', elements: [save] });
		expect(result.device).toEqual(createMockDeviceInfo({ serial: context.serial }));
	});

	// It addresses no element, so the null is a fact about the verb rather than a resolution
	// that failed.
	it('addresses nothing on the screen, and says so with a null target', async () => {
		const { context, options } = recording();

		const result = await recordVideo(context, options);

		expect(result.target).toBeNull();
	});

	it('answers with the recorded bytes, base64-encoded and decoding back to them', async () => {
		const bytes = recorded(3_333);
		const { context, options } = recording({ video: bytes });

		const result = await recordVideo(context, options);

		if (!result.artifact) throw new Error('the record_video verb answered with no artifact');
		// Byte for byte, not merely the same length: base64 of a mangled buffer is the same
		// size as base64 of the right one.
		expect(new Uint8Array(Buffer.from(result.artifact.base64, 'base64'))).toEqual(bytes);
		expect(result.artifact.byteLength).toBe(3_333);
		expect(Buffer.from(result.artifact.base64, 'base64').byteLength).toBe(3_333);
	});

	it('names the media type off the bytes rather than off what it expected', async () => {
		const mp4 = recording({ video: recorded(64) });
		const unrecognised = recording({ video: Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]) });

		const recognised = await recordVideo(mp4.context, mp4.options);
		const unlabelled = await recordVideo(unrecognised.context, unrecognised.options);

		expect(recognised.artifact?.mediaType).toBe('video/mp4');
		// Not a failure and not a guess: the backend promised video bytes without naming a
		// container, so bytes nothing recognises are labelled as what they honestly are.
		expect(unlabelled.artifact?.mediaType).toBe('application/octet-stream');
	});

	it('returns bytes and never a path on the host (D19)', async () => {
		const { context, options } = recording();

		const result = await recordVideo(context, options);

		if (!result.artifact) throw new Error('the record_video verb answered with no artifact');
		expect(Object.keys(result.artifact).sort()).toEqual(['base64', 'byteLength', 'mediaType']);
		for (const frame of result.frames) {
			expect(Object.keys(frame).sort()).toEqual(['base64', 'byteLength', 'mediaType']);
		}
	});

	it('records for its own default when the caller named no duration', async () => {
		const { durations, context, options } = recording();

		await recordVideo(context, options);

		expect(durations).toEqual([DEFAULT_RECORDING_MS]);
	});

	it('records for exactly the duration the caller named', async () => {
		const { durations, context, options } = recording();

		await recordVideo(context, { ...options, durationMs: 1_234 });

		expect(durations).toEqual([1_234]);
	});

	/**
	 * `??` and not `||`: a zero the caller actually sent travels **unaltered** rather than
	 * being quietly replaced by the default, because a verb that substitutes a number the
	 * caller did not ask for is the same class of lie as one that trims an artifact. Where
	 * a zero is dangerous is in the mapping onto a backend's own granularity — one platform
	 * reads a zero time limit as "no limit" — and that is floored there, in the one place that
	 * knows the tool's meaning of it. The wire refuses it outright a layer above
	 * (`RecordVideoParamsSchema`), the way `read_logs` bounds `maxEntries`.
	 */
	it('passes a zero duration through unchanged rather than substituting its default', async () => {
		const { durations, context, options } = recording();

		await recordVideo(context, { ...options, durationMs: 0 });

		expect(durations).toEqual([0]);
	});

	it('refuses a recording over the bound rather than answering with a trimmed one', async () => {
		const oversized = new Uint8Array(MAX_ARTIFACT_BYTES + 1);
		const { calls, context, options } = recording({ video: oversized });

		const thrown = await recordVideo(context, options).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(ArtifactTooLargeError);
		expect(thrown).toMatchObject({
			serial: context.serial,
			byteLength: MAX_ARTIFACT_BYTES + 1,
			maxBytes: MAX_ARTIFACT_BYTES,
		});
		// And it refused where the recording happened, before the spine spent a screen read
		// reaching the same answer — and before a decoder was asked to slice bytes nobody can
		// be sent.
		expect(calls).toEqual(['recordVideo']);
	});

	/**
	 * D11's loud failure, and the reason this verb declares a capability at all: the payload
	 * is the answer, so a backend that cannot record has to say so before anything is
	 * dispatched rather than return a result whose artifact is null and whose after-state
	 * reads like a success.
	 */
	it('fails loudly on a backend that does not declare canRecordVideo (D11)', async () => {
		const { calls, context, options } = recording({
			capabilities: createMockCapabilities({ canRecordVideo: false }),
		});

		const thrown = await recordVideo(context, options).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(MissingCapabilityError);
		const message = (thrown as MissingCapabilityError).message;
		expect(message).toContain('canRecordVideo');
		expect(message).toContain(context.serial);
		expect(message).toContain(context.manifest.label);
		// And the backend was not touched at all — not even a screen read was attempted.
		expect(calls).toEqual([]);
	});

	/**
	 * The bound on duration and the bound on the answer are one derivation, and this is the
	 * end of it that this layer owns: a recording as long as this verb allows has to be able
	 * to fit one answer at *some* plausible rate. The backend's own bit rate is asserted
	 * against the same pair in its own suite.
	 */
	it('caps the duration below what one answer could never carry', () => {
		expect(MAX_RECORDING_MS).toBeGreaterThan(DEFAULT_RECORDING_MS);
		// 250 KB/s — the rate the first backend records at — for the full duration.
		expect((MAX_RECORDING_MS / 1_000) * 250 * 1_024).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
	});
});

describe('record_video answers with the frames sliced out of the recording', () => {
	it('slices the bytes the backend returned, rather than reading the device again', async () => {
		const bytes = recorded(4_096);
		const { calls, sliced, context, options } = recording({ video: bytes });

		await recordVideo(context, options);

		expect(sliced).toEqual([bytes]);
		// One pass over the device: the frames cost no second recording and no second read.
		expect(calls.filter((call) => call === 'recordVideo')).toEqual(['recordVideo']);
	});

	it('answers with the frames in order, each one image bytes and never a path', async () => {
		const first = createMockPngBytes({ payload: [0x11, 0x22] });
		const second = createMockPngBytes({ payload: [0x33, 0x44, 0x55] });
		const { context, options } = recording({ frames: [first, second] });

		const result = await recordVideo(context, options);

		expect(result.frames).toHaveLength(2);
		expect(result.frames.map((frame) => frame.mediaType)).toEqual(['image/png', 'image/png']);
		// Byte for byte and in order: base64 of the frames in the wrong order is the same size
		// as base64 of the right one, and a recording read backwards says the opposite thing.
		expect(
			result.frames.map((frame) => new Uint8Array(Buffer.from(frame.base64, 'base64'))),
		).toEqual([first, second]);
		expect(result.frames.map((frame) => frame.byteLength)).toEqual([
			first.byteLength,
			second.byteLength,
		]);
	});

	// The recording stays exactly where phase 1 put it: the frames are a field beside it, not a
	// second home for the bytes.
	it('leaves the recording on the artifact, where a capture already rides', async () => {
		const bytes = recorded(2_048);
		const { context, options } = recording({ video: bytes });

		const result = await recordVideo(context, options);

		expect(new Uint8Array(Buffer.from(result.artifact?.base64 ?? '', 'base64'))).toEqual(bytes);
		expect(result.artifact?.mediaType).toBe('video/mp4');
	});

	it('samples at its own default when the caller named no rate', async () => {
		const { rates, context, options } = recording();

		await recordVideo(context, options);

		expect(rates).toEqual([DEFAULT_FRAMES_PER_SECOND]);
	});

	it('samples at exactly the rate the caller named', async () => {
		const { rates, context, options } = recording();

		await recordVideo(context, { ...options, framesPerSecond: 1 });

		expect(rates).toEqual([1]);
	});

	/**
	 * A recording of a screen that never changed really does have nothing to sample, and that
	 * is the **only** thing an empty list may mean here. A host that could not look says so by
	 * name instead (`frame-extraction-unavailable`, `src/verbs/errors.ts`), which is why the
	 * extractor is a required parameter: there is no way to call this verb without saying who
	 * slices.
	 */
	it('answers with no frames when the extractor found none, and still with the recording', async () => {
		const { context, options } = recording({ frames: [] });

		const result = await recordVideo(context, options);

		expect(result.frames).toEqual([]);
		expect(result.artifact).not.toBeNull();
	});

	/**
	 * The budget refusal, naming both numbers — the stance `artifact-too-large` already takes.
	 * A shorter list would read as a recording in which nothing happened between two moments
	 * that are no longer adjacent, and nothing in the answer would say otherwise.
	 */
	it('refuses frames over the byte budget rather than answering with a shorter list', async () => {
		const heavy = createMockPngBytes({ payload: new Array(MAX_FRAMES_BYTES).fill(0x5a) });
		const { calls, context, options } = recording({ frames: [heavy] });

		const thrown = await recordVideo(context, options).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(FramesTooLargeError);
		expect(thrown).toMatchObject({
			serial: context.serial,
			frames: 1,
			byteLength: heavy.byteLength,
			maxBytes: MAX_FRAMES_BYTES,
		});
		// Both ways out are in the message, because the pair of numbers alone does not say which.
		expect((thrown as Error).message).toContain('Record for less time');
		// Refused where the slicing happened, so no screen read was spent on it.
		expect(calls).toEqual(['recordVideo', 'extractFrames']);
	});

	/**
	 * The bound is the verb's, not an extractor's, so it holds whichever host tool produced the
	 * frames — including one that has never heard of it. A bound enforced inside an
	 * implementation is one a second implementation is free to forget.
	 */
	it('applies the budget to an extractor that knows nothing about it', async () => {
		const { context, options } = recording({
			extractFrames: async () => [
				createMockPngBytes({ payload: new Array(MAX_FRAMES_BYTES).fill(0x01) }),
			],
		});

		await expect(recordVideo(context, options)).rejects.toBeInstanceOf(FramesTooLargeError);
	});

	// A refusal from the host tool travels rather than being swallowed into an empty list — the
	// verb adds nothing to it and takes nothing away.
	it('lets a refusal from the extractor through rather than answering with no frames', async () => {
		const refusal = new Error('the decoder is not installed on this host');
		const { calls, context, options } = recording({
			extractFrames: async () => {
				throw refusal;
			},
		});

		await expect(recordVideo(context, options)).rejects.toBe(refusal);
		expect(calls).toEqual(['recordVideo']);
	});

	/**
	 * The frame cap is derived so it cannot bite: the longest recording the wire admits, at the
	 * densest rate it admits, is exactly this many frames. Asserted rather than trusted, because
	 * a constant derived from another by hand is one the other is free to drift away from — and
	 * a cap that started biting would silently shorten a list rather than refuse one.
	 */
	it('caps the frame count at the longest recording times the densest sampling', () => {
		expect(MAX_FRAMES).toBe((MAX_RECORDING_MS / 1_000) * MAX_FRAMES_PER_SECOND);
		expect(MAX_FRAMES_PER_SECOND).toBeGreaterThan(DEFAULT_FRAMES_PER_SECOND);
	});

	/**
	 * The byte budget's own derivation, and it has one more term than `MAX_ARTIFACT_BYTES`':
	 * the recording travels in the **same** message as the frames cut out of it, both
	 * base64-encoded, and the screen read goes in beside them.
	 */
	it('leaves room for the recording, the frames and the rest of the answer in one message', () => {
		const encoded = (bytes: number) => Math.ceil(bytes / 3) * 4;

		expect(encoded(MAX_ARTIFACT_BYTES) + encoded(MAX_FRAMES_BYTES)).toBeLessThan(MAX_FRAME_BYTES);
		// And with real headroom rather than by a byte: the after-state is in there too.
		expect(encoded(MAX_ARTIFACT_BYTES) + encoded(MAX_FRAMES_BYTES)).toBeLessThan(
			MAX_FRAME_BYTES * 0.95,
		);
	});

	// Small enough to read *what changed* rather than to measure anything: the full-resolution
	// read of one moment is `screenshot`, and a full-width lossless frame is megabytes.
	it('scales frames down rather than carrying the panel at full width', () => {
		expect(FRAME_WIDTH_PX).toBeLessThan(720);
		expect(FRAME_WIDTH_PX).toBeGreaterThan(0);
	});
});
