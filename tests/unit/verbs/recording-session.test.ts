/**
 * `start_recording` and `stop_recording` — one recording across two calls (#190).
 *
 * The assertions that carry this pair are about things a green result cannot show:
 *
 * - **A backend without `canControlRecording` is never touched**, and the capability is that one
 *   rather than `canRecordVideo`. A platform whose recorder is one command taking a duration
 *   gives a perfectly good `record_video` and cannot hold a recording open at all, so a verb
 *   gated on the wrong flag would be dispatched to a backend with no method behind it — a
 *   `TypeError` where D11 asks for a named refusal.
 * - **The recorder is started with a kill switch and never without one.** Until a lease's end
 *   tears one down, that limit is the only thing standing between a caller that walked away and a
 *   recorder running on under the next lease.
 * - **Nothing is held across a window on the stop.** `record_video` holds a still screen across
 *   the duration its caller asked for; this pair has no such number, so the plan it hands the
 *   normaliser is `holdForMs: null` *even for a still screen* — the one case where inventing one
 *   would look like an improvement and would be a length nobody measured.
 * - **The answer is `record_video`'s, field for field**, because a caller that has learned to read
 *   one recording answer reads both.
 *
 * The extractor and the normaliser are parameters rather than imports, exactly as they are for
 * `record_video` and for its reason: the real ones start a process, and a process reached from
 * `src/verbs/` would be a process in every client's module graph.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '@/core/capabilities.js';
import type { DeviceBackend } from '@/core/device.js';
import { MissingCapabilityError } from '@/core/errors.js';
import type { VerbContext } from '@/verbs/context.js';
import { FramesTooLargeError } from '@/verbs/errors.js';
import {
	DEFAULT_FRAMES_PER_SECOND,
	type FrameExtractor,
	MAX_FRAMES_BYTES,
	MAX_RECORDING_MS,
	type RecordingNormaliser,
} from '@/verbs/record.js';
import { NORMALISED_FRAME_RATE } from '@/verbs/recording-normalisation.js';
import {
	type StopRecordingVerbOptions,
	startRecording,
	stopRecording,
} from '@/verbs/recording-session.js';
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

interface Session {
	readonly calls: string[];
	/** The kill switch each `startRecording` was given. */
	readonly limits: number[];
	readonly rates: number[];
	/** What the extractor was handed — the bytes the backend returned. */
	readonly sliced: Uint8Array[];
	/** The plan the normaliser was given for each recording. */
	readonly holds: Array<number | null>;
	readonly context: VerbContext;
	readonly options: StopRecordingVerbOptions;
}

/**
 * A context whose backend records every call on one shared log, in order, plus a host-side
 * extractor and normaliser that log what they were asked for.
 *
 * The default normaliser hands its input straight back, so every assertion that is not about
 * normalisation reads as though the host had no such step.
 */
function session(
	options: { capabilities?: Capabilities; video?: Uint8Array; frames?: readonly Uint8Array[] } = {},
): Session {
	const calls: string[] = [];
	const limits: number[] = [];
	const rates: number[] = [];
	const sliced: Uint8Array[] = [];
	const holds: Array<number | null> = [];
	const bytes = options.video ?? createMockRecordingBytes();

	const backend = createMockDeviceBackend({
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
			calls.push('readScreen');
			return [save];
		}),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async (serial) => {
			calls.push('deviceInfo');
			return createMockDeviceInfo({ serial });
		}),
		startRecording: vi.fn<NonNullable<DeviceBackend['startRecording']>>(
			async (_serial, startOptions) => {
				calls.push('startRecording');
				limits.push(startOptions.maxDurationMs);
			},
		),
		stopRecording: vi.fn<NonNullable<DeviceBackend['stopRecording']>>(async () => {
			calls.push('stopRecording');
			return bytes;
		}),
	});

	const context = createMockVerbContext({
		backend,
		manifest: createMockCapabilityManifest({
			capabilities: options.capabilities ?? createMockCapabilities(),
		}),
	});

	const extractFrames: FrameExtractor = async (_serial, recorded, extractOptions) => {
		calls.push('extractFrames');
		rates.push(extractOptions.framesPerSecond);
		sliced.push(recorded);
		return [...(options.frames ?? [createMockPngBytes(), createMockPngBytes()])];
	};

	const normaliseRecording: RecordingNormaliser = async (_serial, recorded, normaliseOptions) => {
		calls.push('normaliseRecording');
		holds.push(normaliseOptions.holdForMs);
		return recorded;
	};

	return {
		calls,
		limits,
		rates,
		sliced,
		holds,
		context,
		options: { extractFrames, normaliseRecording },
	};
}

describe('start_recording', () => {
	it('is on the spine: it starts the recorder, then reads the screen and the device', async () => {
		const { calls, context } = session();

		const result = await startRecording(context);

		expect(result.verb).toBe('start_recording');
		expect(calls).toEqual(['startRecording', 'readScreen', 'deviceInfo']);
		expect(result.after).toEqual({ kind: 'screen', elements: [save] });
		expect(result.device).toEqual(createMockDeviceInfo({ serial: context.serial }));
	});

	// It addresses no element and produces no bytes: both nulls are facts about the verb rather
	// than something that failed.
	it('addresses nothing on the screen and answers with no artifact', async () => {
		const { context } = session();

		const result = await startRecording(context);

		expect(result.target).toBeNull();
		expect(result.artifact).toBeNull();
	});

	/**
	 * The kill switch, and the assertion is that it is *passed at all*: nothing waits on this
	 * recorder, so until the lease-end teardown lands it is the only thing that stops one whose
	 * caller went away. It is `MAX_RECORDING_MS` because that is what one answer can carry, which
	 * is the same reason `record_video` is capped there.
	 */
	it('gives the recorder the longest recording one answer can carry as its own limit', async () => {
		const { limits, context } = session();

		await startRecording(context);

		expect(limits).toEqual([MAX_RECORDING_MS]);
	});

	/**
	 * D11, and the capability is the new one rather than `canRecordVideo`: a backend that can
	 * capture a fixed-length recording may have no way to hold one open, and gating on the wrong
	 * flag would dispatch to a method that is not there.
	 */
	it('refuses a backend that does not declare canControlRecording, without touching it', async () => {
		const { calls, context } = session({
			capabilities: createMockCapabilities({ canControlRecording: false }),
		});

		const failure = startRecording(context);

		await expect(failure).rejects.toBeInstanceOf(MissingCapabilityError);
		await expect(failure).rejects.toThrow(/canControlRecording/);
		expect(calls).toEqual([]);
	});

	it('is not gated on canRecordVideo, which names a different method', async () => {
		const { context } = session({
			capabilities: createMockCapabilities({ canRecordVideo: false }),
		});

		await expect(startRecording(context)).resolves.toMatchObject({ verb: 'start_recording' });
	});
});

describe('stop_recording', () => {
	it('is on the spine: it stops, normalises, slices, then reads the screen and the device', async () => {
		const { calls, context, options } = session();

		const result = await stopRecording(context, options);

		expect(result.verb).toBe('stop_recording');
		expect(calls).toEqual([
			'stopRecording',
			'normaliseRecording',
			'extractFrames',
			'readScreen',
			'deviceInfo',
		]);
		expect(result.target).toBeNull();
	});

	it('answers with the recording, the frames, what it holds and how it was normalised', async () => {
		const bytes = createMockRecordingBytes({ sampleCount: 10, durationMs: 5_000 });
		const { context, options } = session({ video: bytes });

		const result = await stopRecording(context, options);

		if (!result.artifact) throw new Error('stop_recording answered with no artifact');
		expect(new Uint8Array(Buffer.from(result.artifact.base64, 'base64'))).toEqual(bytes);
		expect(result.frames).toHaveLength(2);
		expect(result.container).toEqual({ kind: 'samples', sampleCount: 10, durationMs: 5_000 });
		expect(result.normalisation.framesPerSecond).toBe(NORMALISED_FRAME_RATE);
	});

	// The frames come out of the bytes the backend pulled, not out of a second pass over the
	// device and not out of the normalised copy — which is what keeps the sampling following the
	// container's own timeline, and so keeps `MAX_FRAMES`' derivation where it is.
	it('slices the frames out of the recording that was pulled', async () => {
		const bytes = createMockRecordingBytes();
		const { sliced, context, options } = session({ video: bytes });

		await stopRecording(context, options);

		expect(sliced).toEqual([bytes]);
	});

	/**
	 * **The one substantive difference from `record_video`.** That verb holds a still screen
	 * across the window its caller asked for; this call named no window, so there is nothing to
	 * hold it across and the file keeps the recorder's own timeline. A number invented here would
	 * be a length nobody measured — which is exactly what it would look like if it were right.
	 */
	it('holds nothing across a window, even for a recording that declares no timeline', async () => {
		const still = createMockRecordingBytes({ sampleCount: 1, durationMs: 0 });
		const { holds, context, options } = session({ video: still });

		const result = await stopRecording(context, options);

		expect(holds).toEqual([null]);
		expect(result.container.kind).toBe('still-screen');
		expect(result.normalisation.timeline).toBe('container');
		expect(result.normalisation.durationMs).toBe(0);
		// And it says why, rather than leaving the length to be read as a fault.
		expect(result.normalisation.message).toMatch(/named none/);
	});

	it('samples at the verb’s own default when the caller did not say', async () => {
		const { rates, context, options } = session();

		await stopRecording(context, options);

		expect(rates).toEqual([DEFAULT_FRAMES_PER_SECOND]);
	});

	it('passes a rate the caller did send through unaltered', async () => {
		const { rates, context, options } = session();

		await stopRecording(context, { ...options, framesPerSecond: 4 });

		expect(rates).toEqual([4]);
	});

	/**
	 * Refused whole rather than trimmed, naming both numbers and the count: a frame list missing
	 * its middle reads as a recording in which nothing happened between two moments that are no
	 * longer adjacent, and nothing in the answer would say otherwise.
	 */
	it('refuses frames that do not fit beside the recording, naming both numbers', async () => {
		const heavy = createMockPngBytes({ payload: new Array(MAX_FRAMES_BYTES).fill(0x5a) });
		const { context, options } = session({ frames: [heavy] });

		const thrown = await stopRecording(context, options).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(FramesTooLargeError);
		expect(thrown).toMatchObject({
			serial: context.serial,
			frames: 1,
			byteLength: heavy.byteLength,
			maxBytes: MAX_FRAMES_BYTES,
		});
	});

	it('refuses a backend that does not declare canControlRecording, without touching it', async () => {
		const { calls, context, options } = session({
			capabilities: createMockCapabilities({ canControlRecording: false }),
		});

		const failure = stopRecording(context, options);

		await expect(failure).rejects.toBeInstanceOf(MissingCapabilityError);
		await expect(failure).rejects.toThrow(/canControlRecording/);
		expect(calls).toEqual([]);
	});
});
