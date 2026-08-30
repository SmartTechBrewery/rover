/**
 * The three read verbs, over a backend that records what it was asked to do.
 *
 * `read_screen` and `device_info` do nothing to the device, so a result that *looks* right
 * proves almost nothing on its own — every assertion here is about something the shape
 * cannot show:
 *
 * - **`read_screen` on a backend without `canReadScreen` throws and never touches it.** The
 *   verb would otherwise still answer, with the spine's `after: { kind: 'unavailable' }`,
 *   and that softer answer is the one D11 forbids for this verb in particular: for a read,
 *   the after-state is not context around an action, it is the whole answer. The difference
 *   between "loud `MissingCapabilityError` before anything is dispatched" and "a successful
 *   result carrying no screen" is what `requires: ['canReadScreen']` buys, so it is asserted
 *   directly rather than inferred from a green result.
 * - **`device_info` requires nothing**, so it answers on a backend that declares every flag
 *   `false` — and still names the device and its density (D14).
 * - **Both go through the spine**, which is the order the call log shows and the reason
 *   neither verb has to assemble a result of its own.
 *
 * `screenshot` is the one that does something, and its assertions are about the payload
 * instead: that the bytes arrive as bytes rather than as a path, that `byteLength` describes
 * what actually decodes out of the base64, that the bound is refused rather than trimmed to,
 * and that the bound is one the transport can carry.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '@/core/capabilities.js';
import type { DeviceBackend, ScreenElement } from '@/core/device.js';
import { MissingCapabilityError } from '@/core/errors.js';
import { MAX_FRAME_BYTES } from '@/ipc/framing.js';
import type { VerbContext } from '@/verbs/context.js';
import { ArtifactTooLargeError } from '@/verbs/errors.js';
import { deviceInfo, readScreen, screenshot } from '@/verbs/read.js';
import { type ActionResult, MAX_ARTIFACT_BYTES } from '@/verbs/result.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

const save = createMockScreenElement({
	id: 'save',
	text: 'Save',
	bounds: { x: 10, y: 20, width: 100, height: 40 },
});
const cancel = createMockScreenElement({ id: 'cancel', text: 'Cancel' });

/**
 * The eight bytes every PNG starts with (PNG 1.2 §3.1), written out rather than imported.
 *
 * The verb layer cannot reach the backend that owns the other copy of this constant, and a
 * test that borrowed the implementation's own would agree with it whatever it said.
 */
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A capture of `byteLength` bytes that a decoder would accept as a PNG at the signature. */
function capture(byteLength: number): Uint8Array {
	const bytes = new Uint8Array(byteLength);
	bytes.set(PNG_HEADER.slice(0, byteLength));
	// Not all zeroes past the header: a base64 round trip of a run of zeroes is the one
	// payload an off-by-one in the encoding would survive unnoticed.
	for (let at = PNG_HEADER.length; at < byteLength; at += 1) bytes[at] = at % 251;
	return bytes;
}

interface Recording {
	readonly calls: string[];
	readonly context: VerbContext;
}

/** A context whose backend records every call on one shared log, in order. */
function recording(
	options: {
		screen?: readonly ScreenElement[];
		capabilities?: Capabilities;
		capture?: Uint8Array;
	} = {},
): Recording {
	const calls: string[] = [];
	const screen = options.screen ?? [save, cancel];
	const bytes = options.capture ?? capture(2_048);

	const backend = createMockDeviceBackend({
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
			calls.push('readScreen');
			return [...screen];
		}),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async (serial) => {
			calls.push('deviceInfo');
			return createMockDeviceInfo({ serial });
		}),
		screenshot: vi.fn<DeviceBackend['screenshot']>(async () => {
			calls.push('screenshot');
			return bytes;
		}),
	});

	const context = createMockVerbContext({
		backend,
		manifest: createMockCapabilityManifest({
			capabilities: options.capabilities ?? createMockCapabilities(),
		}),
	});

	return { calls, context };
}

/** One call of each verb, for the properties all three share. */
const READS: ReadonlyArray<[string, (context: VerbContext) => Promise<ActionResult>]> = [
	['read_screen', readScreen],
	['device_info', deviceInfo],
	['screenshot', screenshot],
];

describe('all three read verbs are on the spine', () => {
	it.each([
		['read_screen', readScreen],
		['device_info', deviceInfo],
	] as const)('%s reads the screen once and the device once, in that order', async (_name, run) => {
		const { calls, context } = recording();

		await run(context);

		// The spine's own capture and nothing else: a read verb whose `act` did the reading
		// would show a third call here, and would be a second place deciding what an answer
		// looks like.
		expect(calls).toEqual(['readScreen', 'deviceInfo']);
	});

	it('screenshot captures first and then takes the same spine capture', async () => {
		const { calls, context } = recording();

		await screenshot(context);

		// The capture is the verb's own work and the two reads after it are the spine's — the
		// same two, in the same order, that a verb doing nothing at all already produces.
		expect(calls).toEqual(['screenshot', 'readScreen', 'deviceInfo']);
	});

	it.each(
		READS,
	)('%s addresses nothing on the screen, and says so with a null target', async (_name, run) => {
		const { context } = recording();

		const result = await run(context);

		// A fact about the verb rather than a resolution that failed — the same answer a
		// `scroll` with no region and an app verb already give.
		expect(result.target).toBeNull();
	});

	it.each(READS)('%s names the device and its density (D14)', async (_name, run) => {
		const { context } = recording();

		const result = await run(context);

		expect(result.device.serial).toBe(context.serial);
		expect(result.device.screen.density).toBeGreaterThan(0);
		expect(result.device.screen.densityScale).toBeGreaterThan(0);
	});
});

describe('read_screen', () => {
	it('answers with the elements the device is showing', async () => {
		const { context } = recording({ screen: [save, cancel] });

		const result = await readScreen(context);

		expect(result.verb).toBe('read_screen');
		// The texts and the rectangles, in the after-state every other verb already reports —
		// so an agent reads one shape whatever it asked for.
		expect(result.after).toEqual({ kind: 'screen', elements: [save, cancel] });
	});

	it('reads the screen inside the call rather than answering off anything cached', async () => {
		const { context } = recording({ screen: [save] });

		const first = await readScreen(context);
		const second = await readScreen(context);

		expect(context.backend.readScreen).toHaveBeenCalledTimes(2);
		expect(first.after).toEqual(second.after);
	});

	it('fails loudly on a backend that does not declare canReadScreen (D11)', async () => {
		const { calls, context } = recording({
			capabilities: createMockCapabilities({ canReadScreen: false }),
		});

		const thrown = await readScreen(context).catch((error: unknown) => error);

		// Not a result carrying an `unavailable` after-state, which is what this verb would
		// answer without `requires`: an agent reading that would have been told the read
		// happened and found nothing.
		expect(thrown).toBeInstanceOf(MissingCapabilityError);
		const message = (thrown as MissingCapabilityError).message;
		expect(message).toContain('canReadScreen');
		expect(message).toContain(context.serial);
		expect(message).toContain(context.manifest.label);
		// And the backend was not touched at all — the answer never depended on it.
		expect(calls).toEqual([]);
	});
});

describe('device_info', () => {
	it('reports the size, density, computed dp width and OS version the device gave', async () => {
		const { context } = recording();
		const expected = createMockDeviceInfo({ serial: context.serial });

		const result = await deviceInfo(context);

		expect(result.verb).toBe('device_info');
		expect(result.device).toEqual(expected);
		// The dp width is the exact quotient the device reported it as, not a rounded one.
		expect(result.device.screen.widthDp).toBe(
			expected.screen.widthPx / expected.screen.densityScale,
		);
	});

	it('needs no capability, so it answers on a backend that declares none', async () => {
		const { calls, context } = recording({
			capabilities: createMockCapabilities({
				canReadScreen: false,
				canInput: false,
				canControlNetwork: false,
			}),
		});

		const result = await deviceInfo(context);

		expect(result.verb).toBe('device_info');
		expect(result.device.serial).toBe(context.serial);
		// `deviceInfo` is a required backend method, so only the screen read is skipped — and
		// what stands in for it is the honest `unavailable` naming the capability that would
		// have answered, never an empty screen.
		expect(calls).toEqual(['deviceInfo']);
		expect(result.after).toMatchObject({ kind: 'unavailable', capability: 'canReadScreen' });
	});

	it('asks the device again rather than reporting what it said last time', async () => {
		const { context } = recording();

		await deviceInfo(context);
		await deviceInfo(context);

		// Two calls for two asks: a rotated device reports the dimensions it has now (D12(a)).
		expect(context.backend.deviceInfo).toHaveBeenCalledTimes(2);
	});
});

/**
 * The one read whose answer is a payload rather than a state.
 *
 * Nothing here looks at the pixels, because at this layer there is nothing to look at: a
 * black capture is a true answer about a device with screen capture blocked (PROJECT.md §6)
 * and the verb's own documentation says how to tell that from a broken one. What is
 * asserted instead is everything about the payload that a wrong answer would still *look*
 * right without — the encoding, the length, the absence of a path, and the refusal.
 */
describe('screenshot', () => {
	it('answers with the captured bytes, base64-encoded and decoding back to them', async () => {
		const bytes = capture(3_333);
		const { context } = recording({ capture: bytes });

		const result = await screenshot(context);

		expect(result.verb).toBe('screenshot');
		if (!result.artifact) throw new Error('the screenshot verb answered with no artifact');
		// Byte for byte, not merely the same length: base64 of a mangled buffer is the same
		// size as base64 of the right one.
		expect(new Uint8Array(Buffer.from(result.artifact.base64, 'base64'))).toEqual(bytes);
	});

	it('reports the length of the decoded bytes, not of the string carrying them', async () => {
		const { context } = recording({ capture: capture(3_333) });

		const result = await screenshot(context);

		if (!result.artifact) throw new Error('the screenshot verb answered with no artifact');
		const { base64, byteLength } = result.artifact;
		expect(byteLength).toBe(3_333);
		// The distinction the field exists for: the encoded string is a third longer, so a
		// `byteLength` taken off it would be wrong by exactly that and still look plausible.
		expect(base64.length).toBeGreaterThan(byteLength);
		expect(Buffer.from(base64, 'base64').byteLength).toBe(byteLength);
	});

	it('names the media type off the bytes rather than off what it expected', async () => {
		const png = recording({ capture: capture(64) });
		const notAnImage = recording({ capture: Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]) });

		const recognised = await screenshot(png.context);
		const unrecognised = await screenshot(notAnImage.context);

		expect(recognised.artifact?.mediaType).toBe('image/png');
		// Not a failure and not a guess: the backend promised image bytes without naming a
		// format, so bytes nothing recognises are labelled as what they honestly are.
		expect(unrecognised.artifact?.mediaType).toBe('application/octet-stream');
	});

	it('returns bytes and never a path on the host (D19)', async () => {
		const { context } = recording();

		const result = await screenshot(context);

		if (!result.artifact) throw new Error('the screenshot verb answered with no artifact');
		// The whole artifact is three fields, and none of them is a place: a filesystem
		// location means nothing on the machine reading this, and means something wrong on a
		// machine that happens to have that path.
		expect(Object.keys(result.artifact).sort()).toEqual(['base64', 'byteLength', 'mediaType']);
	});

	it('refuses a capture over the bound rather than answering with a trimmed one', async () => {
		const oversized = new Uint8Array(MAX_ARTIFACT_BYTES + 1);
		const { calls, context } = recording({ capture: oversized });

		const thrown = await screenshot(context).catch((error: unknown) => error);

		// A refusal naming both numbers — never an `ok` carrying the first four megabytes of a
		// picture, which decodes to a screen that is blank below a line and reads as something
		// the device did.
		expect(thrown).toBeInstanceOf(ArtifactTooLargeError);
		expect(thrown).toMatchObject({
			serial: context.serial,
			byteLength: MAX_ARTIFACT_BYTES + 1,
			maxBytes: MAX_ARTIFACT_BYTES,
		});
		// And it refused where the capture happened, before the spine spent a screen read
		// reaching the same answer.
		expect(calls).toEqual(['screenshot']);
	});

	it('accepts a capture exactly at the bound, so the limit is not off by one', async () => {
		const { context } = recording({ capture: capture(MAX_ARTIFACT_BYTES) });

		const result = await screenshot(context);

		expect(result.artifact?.byteLength).toBe(MAX_ARTIFACT_BYTES);
	});

	it('needs no capability, so it answers on a backend that declares none', async () => {
		const { context } = recording({
			capabilities: createMockCapabilities({
				canReadScreen: false,
				canInput: false,
				canControlNetwork: false,
			}),
		});

		const result = await screenshot(context);

		// `screenshot` is a required backend method, so there is no capability to assert — and
		// the screen it could not read is the honest `unavailable`, never an empty screen.
		expect(result.artifact?.byteLength).toBeGreaterThan(0);
		expect(result.after).toMatchObject({ kind: 'unavailable', capability: 'canReadScreen' });
	});

	it('captures inside the call rather than answering off anything cached', async () => {
		const { context } = recording();

		await screenshot(context);
		await screenshot(context);

		expect(context.backend.screenshot).toHaveBeenCalledTimes(2);
	});
});

/**
 * The bound is derived from the frame cap by hand, so the derivation is asserted rather than
 * left in a comment.
 *
 * `src/verbs/` may not import `src/ipc/` — the verb layer reaches `src/core/` and nothing
 * else, which is what keeps a client's module graph free of a backend
 * (`tests/unit/no-backend-in-a-client.test.ts`) — so the two constants cannot be defined in
 * terms of each other. A test can hold both, and this is the one place that notices if
 * either moves.
 */
describe('the artifact bound fits the transport it was chosen against', () => {
	it('leaves room for the base64 inflation and the rest of the answer', () => {
		// Base64 is four characters per three bytes, and the result travels in the same frame:
		// the elements of a screen read, the device, the envelope. A bound that only just fit
		// its own encoding would be a bound the first large screen read pushed over the cap.
		const encoded = Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4;

		expect(encoded).toBeLessThan(MAX_FRAME_BYTES);
		expect(MAX_FRAME_BYTES - encoded).toBeGreaterThan(1024 * 1024);
	});
});
