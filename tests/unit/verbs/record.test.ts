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
 *   the device and not from the normalised copy: the extractor is handed the bytes the backend
 *   returned, and the call log below is what shows the device was touched once. Slicing the
 *   normalised recording instead would move the timeline the sampling follows, which is the
 *   derivation `MAX_FRAMES` rests on (PROJECT.md §6).
 * - **The artifact is the normalised recording, and the byte bound is checked on it** (#185).
 *   Re-encoding changes the byte count, so a bound checked on the pulled bytes would be a bound
 *   on something other than what is answered with — in both directions.
 *
 * The extractor and the normaliser are parameters rather than imports (`FrameExtractor`,
 * `RecordingNormaliser`), which is what keeps a process spawn out of every client's module graph
 * — so a test supplies its own rather than mocking a module. Nothing here judges the recording itself. Whether the bytes are a
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
	type RecordingNormaliser,
	type RecordVideoVerbOptions,
	recordVideo,
} from '@/verbs/record.js';
import { NORMALISED_FRAME_RATE } from '@/verbs/recording-normalisation.js';
import { MAX_ARTIFACT_BYTES } from '@/verbs/result.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockPngBytes,
	createMockRecordingBytes,
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
	/** What the normaliser was handed, and the plan it was given for each. */
	readonly normalised: Uint8Array[];
	readonly holds: Array<number | null>;
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
		normaliseRecording?: RecordingNormaliser;
	} = {},
): Recording {
	const calls: string[] = [];
	const durations: number[] = [];
	const rates: number[] = [];
	const sliced: Uint8Array[] = [];
	const normalised: Uint8Array[] = [];
	const holds: Array<number | null> = [];
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

	// The default normaliser hands its input straight back, so every assertion that is not about
	// normalisation reads exactly as it did before the host gained this step. A test that is
	// about it supplies one that returns different bytes.
	const normaliseRecording: RecordingNormaliser =
		options.normaliseRecording ??
		(async (_serial, recorded_, normaliseOptions) => {
			calls.push('normaliseRecording');
			normalised.push(recorded_);
			holds.push(normaliseOptions.holdForMs);
			return recorded_;
		});

	return {
		calls,
		durations,
		rates,
		sliced,
		normalised,
		holds,
		context,
		options: { extractFrames, normaliseRecording },
	};
}

describe('record_video', () => {
	it('is on the spine: it records, normalises, slices, then reads the screen and the device', async () => {
		const { calls, context, options } = recording();

		const result = await recordVideo(context, options);

		expect(result.verb).toBe('record_video');
		// The recording, the normalisation and the slicing first, then the spine's own capture —
		// a verb that assembled its own answer would show neither of the last two.
		expect(calls).toEqual([
			'recordVideo',
			'normaliseRecording',
			'extractFrames',
			'readScreen',
			'deviceInfo',
		]);
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
		// be sent. The normalisation is the one step ahead of it, because the bound is on the
		// bytes that would actually be answered with.
		expect(calls).toEqual(['recordVideo', 'normaliseRecording']);
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
	 * There is no recording left that legitimately samples to nothing — the one case there was,
	 * a screen that never changed, is covered by `round=up` in the extractor — so an `ok` answer
	 * always carries frames. A host that could not look says so by name instead
	 * (`frame-extraction-…`, `src/verbs/errors.ts`), which is why the extractor is a required
	 * parameter: there is no way to call this verb without saying who slices, and the one
	 * implementation refuses rather than answering with an empty list
	 * (`tests/unit/daemon/frames.test.ts`).
	 *
	 * This layer still passes on whatever the extractor answered rather than second-guessing it:
	 * the schema admits an empty array so that a host bug arrives as the named failure the host
	 * sent, not as a client that cannot parse the reply.
	 */
	it('passes an extractor’s answer through untouched, and always with the recording', async () => {
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
		expect(calls).toEqual(['recordVideo', 'normaliseRecording', 'extractFrames']);
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
		expect(calls).toEqual(['recordVideo', 'normaliseRecording']);
	});

	/**
	 * The frame cap is derived so it cannot bite, and the `+ 1` is the whole of the derivation's
	 * point: sampling rounds *up*, so the longest recording the wire admits at the densest rate
	 * it admits fills slots `0…duration × rate` — one frame more than the bare product. Asserted
	 * rather than trusted, because a constant derived from another by hand is one the other is
	 * free to drift away from, and a cap that started biting would shorten a list rather than
	 * refuse one.
	 */
	it('caps the frame count one above the longest recording times the densest sampling', () => {
		expect(MAX_FRAMES).toBe((MAX_RECORDING_MS / 1_000) * MAX_FRAMES_PER_SECOND + 1);
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

/**
 * The answer says what the recording **contains** (#183).
 *
 * The gap this closes is not a check that was missing — every check the verb makes passes for a
 * capture of a screen that never moved — it is that the answer said nothing at all about the
 * file. An agent that ffprobed one, found a single frame of zero duration and could not square
 * it with an `ok` filed a defect against a tool that was working correctly.
 *
 * The parse itself has its own suite (`./recording-container.test.ts`). What is asserted here is
 * that the field reaches the answer, that the still-screen case is still an `ok` answer with its
 * frame, and that reading it cost no second pass over the device and no second host hook.
 */
describe('record_video says what the recording holds', () => {
	it('carries the container’s sample count and declared duration on the answer', async () => {
		const { context, options } = recording({
			video: createMockRecordingBytes({ sampleCount: 42, durationMs: 3_000 }),
		});

		const result = await recordVideo(context, options);

		expect(result.container).toEqual({ kind: 'samples', sampleCount: 42, durationMs: 3_000 });
	});

	/**
	 * The numbers come off the container, never from what the caller asked for. PROJECT.md §6
	 * has a 15 s capture declaring 27.61 s, so the two are different facts and an answer that
	 * echoed the request would be a plausible-looking wrong one.
	 */
	it('reads the duration off the file rather than echoing the one it was asked for', async () => {
		const { context, options } = recording({
			video: createMockRecordingBytes({ sampleCount: 2, durationMs: 27_610 }),
		});

		const result = await recordVideo(context, { ...options, durationMs: MAX_RECORDING_MS });

		expect(result.container).toMatchObject({ durationMs: 27_610 });
	});

	it('names a recording of a screen that never changed, and still answers ok with its frame', async () => {
		const { calls, context, options } = recording({
			video: createMockRecordingBytes({ sampleCount: 1, durationMs: 0 }),
			frames: [createMockPngBytes()],
		});

		const result = await recordVideo(context, options);

		expect(result.container).toMatchObject({ kind: 'still-screen', sampleCount: 1, durationMs: 0 });
		// A capture of an idle screen is a true answer about the device, so it is reported rather
		// than refused: the recording is still on the artifact and the one frame `round=up`
		// extracted is still beside it.
		expect(result.artifact).not.toBeNull();
		expect(result.frames).toHaveLength(1);
		// And nothing was asked of the device or of the host a second time to learn any of it —
		// the walk is over bytes already in hand.
		expect(calls).toEqual([
			'recordVideo',
			'normaliseRecording',
			'extractFrames',
			'readScreen',
			'deviceInfo',
		]);
	});

	/**
	 * A backend "promises video bytes without saying in which container", so bytes this host
	 * cannot parse are an anticipated future rather than a bug. Saying so is the honest answer;
	 * throwing would add the refusal #183 rules out, and a zero would be the plausible-looking
	 * empty result ai/RULES.md §2 forbids.
	 */
	it('answers unreadable rather than refusing bytes it cannot parse', async () => {
		const { context, options } = recording({ video: recorded(2_048) });

		const result = await recordVideo(context, options);

		expect(result.container.kind).toBe('unreadable');
		expect(result.artifact).not.toBeNull();
		expect(result.frames).not.toHaveLength(0);
	});

	/**
	 * The one shape of container that used to reach a `DataView` read before its bounds were
	 * checked: a `moov` at the end of the file whose only child is an `mvhd` header with no body
	 * at all. The `RangeError` escaped the verb entirely — out of `performAction`, into `answer()`
	 * — and the agent got an `internal_error` instead of a recording the host had already pulled
	 * intact. It answers `unreadable` and keeps the bytes, like every other container it cannot
	 * read.
	 */
	it('keeps a recording whose movie header has no body, rather than throwing it away', async () => {
		// A box header: its length — under 256 here, so three zero bytes and the count — and its
		// four type characters.
		const header = (size: number, type: string): number[] => [
			0,
			0,
			0,
			size,
			...[...type].map((character) => character.charCodeAt(0)),
		];
		// `ftyp` with an eight-byte brand, then a `moov` whose whole content is an eight-byte
		// `mvhd` — so the movie header's body would start one past the last byte of the file.
		const empty = Uint8Array.from([
			...header(16, 'ftyp'),
			...[...'isom0000'].map((character) => character.charCodeAt(0)),
			...header(16, 'moov'),
			...header(8, 'mvhd'),
		]);
		const { context, options } = recording({ video: empty });

		const result = await recordVideo(context, options);

		expect(result.container).toMatchObject({ kind: 'unreadable' });
		expect(result.artifact).not.toBeNull();
	});
});

/**
 * The recording is normalised on the host before it is answered with (#185).
 *
 * The gap this closes is that the artifact was whatever the encoder wrote, and what a device
 * recorder writes is not a constant-rate video: a capture of a screen that did not change is a
 * structurally valid MP4 with one sample of zero duration, which no player shows anything for,
 * and an ordinary capture declares a timeline that is not the one that was asked for.
 *
 * The decision itself has its own suite (`./recording-normalisation.test.ts`). What is asserted
 * here is what this layer owns: that it is the **normalised** bytes that are answered with and
 * bounded, that the frames and `container` still come off the **pulled** ones, and that a host
 * that could not normalise never quietly hands the original over.
 */
describe('record_video answers with the normalised recording', () => {
	/** A normaliser whose output is unmistakably not its input. */
	const rewrites =
		(bytes: Uint8Array): RecordingNormaliser =>
		async () =>
			bytes;

	it('puts the normalised bytes on the artifact rather than the ones that were pulled', async () => {
		const pulled = recorded(2_048);
		const normalisedBytes = recorded(1_024);
		const { context, options } = recording({
			video: pulled,
			normaliseRecording: rewrites(normalisedBytes),
		});

		const result = await recordVideo(context, options);

		// Byte for byte: a length check alone would pass for the pulled bytes truncated.
		expect(new Uint8Array(Buffer.from(result.artifact?.base64 ?? '', 'base64'))).toEqual(
			normalisedBytes,
		);
	});

	it('hands the normaliser the pulled recording and the plan for it', async () => {
		const pulled = createMockRecordingBytes({ sampleCount: 1, durationMs: 0 });
		const { normalised, holds, context, options } = recording({ video: pulled });

		await recordVideo(context, { ...options, durationMs: 6_000 });

		expect(normalised).toEqual([pulled]);
		// A container declaring no timeline is held across the window that was asked for.
		expect(holds).toEqual([6_000]);
	});

	it('leaves a recording that declared a timeline on its own, and says so', async () => {
		const { holds, context, options } = recording({
			video: createMockRecordingBytes({ sampleCount: 2, durationMs: 27_610 }),
		});

		const result = await recordVideo(context, { ...options, durationMs: MAX_RECORDING_MS });

		expect(holds).toEqual([null]);
		expect(result.normalisation).toEqual({
			timeline: 'container',
			durationMs: 27_610,
			framesPerSecond: NORMALISED_FRAME_RATE,
			message: expect.any(String),
		});
	});

	/**
	 * The two fields are about two different files, and this is the pair that shows it: the
	 * pulled bytes are still *named* as a still screen — which is what #183 exists for, and what
	 * reading the container off the normalised copy would erase — while the answer says the file
	 * being handed over follows the requested window instead.
	 */
	it('says the container is a still screen and the answer is the requested window', async () => {
		const { context, options } = recording({
			video: createMockRecordingBytes({ sampleCount: 1, durationMs: 0 }),
			frames: [createMockPngBytes()],
		});

		const result = await recordVideo(context, { ...options, durationMs: 6_000 });

		expect(result.container).toMatchObject({ kind: 'still-screen', durationMs: 0 });
		expect(result.normalisation).toMatchObject({ timeline: 'requested', durationMs: 6_000 });
	});

	/**
	 * The frames come off the **pulled** recording, which is what keeps the sampling following
	 * the container's timeline and so keeps `MAX_FRAMES`' derivation where it is. Slicing the
	 * normalised copy would sample a 15 s still-screen capture into 61 near-identical frames
	 * instead of one — over `MAX_FRAMES_BYTES`, and an `ok` answer turned into a refusal.
	 */
	it('slices the pulled recording, never the normalised one', async () => {
		const pulled = recorded(4_096);
		const { sliced, context, options } = recording({
			video: pulled,
			normaliseRecording: rewrites(recorded(512)),
		});

		await recordVideo(context, options);

		expect(sliced).toEqual([pulled]);
	});

	/**
	 * The bound is on what is actually answered with, in both directions. A source over the bound
	 * that the normaliser brings under it is an `ok` answer — refusing it would refuse bytes
	 * nobody was ever going to send.
	 */
	it('admits an over-sized source that the normalisation brought under the bound', async () => {
		const { context, options } = recording({
			video: new Uint8Array(MAX_ARTIFACT_BYTES + 1),
			normaliseRecording: rewrites(recorded(2_048)),
		});

		const result = await recordVideo(context, options);

		expect(result.artifact?.byteLength).toBe(2_048);
	});

	/** And the other direction: a re-encode that grew past the bound is refused on its own length. */
	it('refuses on the normalised length rather than on the length that was pulled', async () => {
		const { calls, context, options } = recording({
			video: recorded(2_048),
			normaliseRecording: rewrites(new Uint8Array(MAX_ARTIFACT_BYTES + 1)),
		});

		const thrown = await recordVideo(context, options).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(ArtifactTooLargeError);
		expect(thrown).toMatchObject({
			byteLength: MAX_ARTIFACT_BYTES + 1,
			maxBytes: MAX_ARTIFACT_BYTES,
		});
		// And no screen read and no decoder were spent on an answer nobody can be sent. (The
		// normaliser here is this test's own, so it leaves no entry on the shared log.)
		expect(calls).toEqual(['recordVideo']);
	});

	/**
	 * A refusal from the host tool travels rather than being swallowed — and the extractor is
	 * never reached, because the answer is the normalised video and its frames or neither. A verb
	 * that caught this and answered with the pulled bytes would be the silently un-normalised
	 * file the whole change exists against.
	 */
	it('lets a refusal from the normaliser through rather than answering with the original', async () => {
		const refusal = new Error('the encoder is not installed on this host');
		const { calls, context, options } = recording({
			normaliseRecording: async () => {
				throw refusal;
			},
		});

		await expect(recordVideo(context, options)).rejects.toBe(refusal);
		expect(calls).toEqual(['recordVideo']);
	});
});
