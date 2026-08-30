/**
 * `record_video`, over a backend that records what it was asked to do.
 *
 * The two assertions that carry this verb are about things a green result cannot show:
 *
 * - **A backend without `canRecordVideo` is never touched.** The verb would otherwise still
 *   answer — the spine's after-state and a null artifact — and for this verb that softer
 *   answer is the one D11 forbids, because the payload *is* the answer. The difference
 *   between a loud `MissingCapabilityError` before anything is dispatched and a successful
 *   result carrying no recording is what `requires: ['canRecordVideo']` buys.
 * - **A recording over the bound is refused by name rather than trimmed**, and refused where
 *   the recording happened rather than after the spine has spent a screen read.
 *
 * Nothing here judges the recording itself. Whether the bytes are a *finished* recording is
 * the backend's question, asked of the bytes it pulled (`UnfinishedRecordingError`), and
 * whether the recording shows anything is the agent's.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '@/core/capabilities.js';
import type { DeviceBackend } from '@/core/device.js';
import { MissingCapabilityError } from '@/core/errors.js';
import type { VerbContext } from '@/verbs/context.js';
import { ArtifactTooLargeError } from '@/verbs/errors.js';
import { DEFAULT_RECORDING_MS, MAX_RECORDING_MS, recordVideo } from '@/verbs/record.js';
import { MAX_ARTIFACT_BYTES } from '@/verbs/result.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockDeviceInfo,
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
	readonly context: VerbContext;
}

/** A context whose backend records every call on one shared log, in order. */
function recording(options: { capabilities?: Capabilities; video?: Uint8Array } = {}): Recording {
	const calls: string[] = [];
	const durations: number[] = [];
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

	return { calls, durations, context };
}

describe('record_video', () => {
	it('is on the spine: it records, then reads the screen, then reads the device', async () => {
		const { calls, context } = recording();

		const result = await recordVideo(context);

		expect(result.verb).toBe('record_video');
		// The recording first, then the spine's own capture — a verb that assembled its own
		// answer would show neither of the last two.
		expect(calls).toEqual(['recordVideo', 'readScreen', 'deviceInfo']);
		expect(result.after).toEqual({ kind: 'screen', elements: [save] });
		expect(result.device).toEqual(createMockDeviceInfo({ serial: context.serial }));
	});

	// It addresses no element, so the null is a fact about the verb rather than a resolution
	// that failed.
	it('addresses nothing on the screen, and says so with a null target', async () => {
		const { context } = recording();

		const result = await recordVideo(context);

		expect(result.target).toBeNull();
	});

	it('answers with the recorded bytes, base64-encoded and decoding back to them', async () => {
		const bytes = recorded(3_333);
		const { context } = recording({ video: bytes });

		const result = await recordVideo(context);

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

		const recognised = await recordVideo(mp4.context);
		const unlabelled = await recordVideo(unrecognised.context);

		expect(recognised.artifact?.mediaType).toBe('video/mp4');
		// Not a failure and not a guess: the backend promised video bytes without naming a
		// container, so bytes nothing recognises are labelled as what they honestly are.
		expect(unlabelled.artifact?.mediaType).toBe('application/octet-stream');
	});

	it('returns bytes and never a path on the host (D19)', async () => {
		const { context } = recording();

		const result = await recordVideo(context);

		if (!result.artifact) throw new Error('the record_video verb answered with no artifact');
		expect(Object.keys(result.artifact).sort()).toEqual(['base64', 'byteLength', 'mediaType']);
	});

	it('records for its own default when the caller named no duration', async () => {
		const { durations, context } = recording();

		await recordVideo(context);

		expect(durations).toEqual([DEFAULT_RECORDING_MS]);
	});

	it('records for exactly the duration the caller named', async () => {
		const { durations, context } = recording();

		await recordVideo(context, { durationMs: 1_234 });

		expect(durations).toEqual([1_234]);
	});

	it('refuses a recording over the bound rather than answering with a trimmed one', async () => {
		const oversized = new Uint8Array(MAX_ARTIFACT_BYTES + 1);
		const { calls, context } = recording({ video: oversized });

		const thrown = await recordVideo(context).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(ArtifactTooLargeError);
		expect(thrown).toMatchObject({
			serial: context.serial,
			byteLength: MAX_ARTIFACT_BYTES + 1,
			maxBytes: MAX_ARTIFACT_BYTES,
		});
		// And it refused where the recording happened, before the spine spent a screen read
		// reaching the same answer.
		expect(calls).toEqual(['recordVideo']);
	});

	/**
	 * D11's loud failure, and the reason this verb declares a capability at all: the payload
	 * is the answer, so a backend that cannot record has to say so before anything is
	 * dispatched rather than return a result whose artifact is null and whose after-state
	 * reads like a success.
	 */
	it('fails loudly on a backend that does not declare canRecordVideo (D11)', async () => {
		const { calls, context } = recording({
			capabilities: createMockCapabilities({ canRecordVideo: false }),
		});

		const thrown = await recordVideo(context).catch((error: unknown) => error);

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
