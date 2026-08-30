/**
 * The six input verbs, over a backend that records what it was asked to do.
 *
 * Two things are asserted here that a correct-looking result cannot show. The first is
 * **order** — the screen read before the gesture, the state after it *after* it — which is
 * `tests/unit/verbs/perform.test.ts`'s method and is what says these verbs are on the spine
 * rather than merely shaped like it. The second is the **arguments the backend received**: a
 * long press that reached the device as two different points is a swipe, a `scroll 'down'`
 * that dragged downwards moves the list the wrong way, and both answer with a result that
 * reads exactly like success.
 *
 * The two keyboard verbs are the same claim from the other side: what has to be asserted about
 * `type_text` is that the string arrived **unchanged**, because a verb that escaped it would
 * also answer with a result that reads exactly like success — and the escaping would show up
 * on the device's screen rather than in any test that only reads the answer.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '@/core/capabilities.js';
import {
	type DeviceBackend,
	DeviceKeySchema,
	type Point,
	type ScreenElement,
} from '@/core/device.js';
import { MissingCapabilityError, UnsupportedTextError } from '@/core/errors.js';
import { parseElementId } from '@/core/ids.js';
import type { VerbContext } from '@/verbs/context.js';
import { TargetNotFoundError } from '@/verbs/errors.js';
import {
	LONG_PRESS_DURATION_MS,
	longPress,
	pressKey,
	SCROLL_DURATION_MS,
	type ScrollDirection,
	SWIPE_DURATION_MS,
	scroll,
	swipe,
	tap,
	typeText,
} from '@/verbs/input.js';
import type { ActionResult } from '@/verbs/result.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

/** Centre (60, 40), and a rectangle big enough to have a middle half of its own. */
const save = createMockScreenElement({
	id: 'save',
	text: 'Save',
	bounds: { x: 10, y: 20, width: 100, height: 40 },
});
const cancel = createMockScreenElement({
	id: 'cancel',
	text: 'Cancel',
	bounds: { x: 200, y: 300, width: 40, height: 20 },
});

/**
 * The long-press timeout the capture device reported (PROJECT.md §6): a drag in place of
 * 390 ms raised the menu, 380 ms did not, and the device's own setting reads 400.
 *
 * The verb's default has to sit above it with room to spare, because the number is per-device
 * configuration rather than a platform constant.
 */
const MEASURED_LONG_PRESS_TIMEOUT_MS = 400;

interface Drag {
	readonly from: Point;
	readonly to: Point;
	readonly durationMs: number;
}

interface Recording {
	readonly calls: string[];
	readonly taps: Point[];
	readonly drags: Drag[];
	/** Every string the backend was asked to type, in order and exactly as it received it. */
	readonly typed: string[];
	readonly keys: string[];
	readonly context: VerbContext;
}

/** A context whose backend records every call on one shared log, in order. */
function recording(
	options: { screen?: readonly ScreenElement[]; capabilities?: Capabilities } = {},
): Recording {
	const calls: string[] = [];
	const taps: Point[] = [];
	const drags: Drag[] = [];
	const typed: string[] = [];
	const keys: string[] = [];
	const screen = options.screen ?? [save];

	const backend = createMockDeviceBackend({
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
			calls.push('readScreen');
			return [...screen];
		}),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async (serial) => {
			calls.push('deviceInfo');
			return createMockDeviceInfo({ serial });
		}),
		tap: vi.fn<NonNullable<DeviceBackend['tap']>>(async (_serial, at) => {
			calls.push('tap');
			taps.push(at);
		}),
		swipe: vi.fn<NonNullable<DeviceBackend['swipe']>>(async (_serial, from, to, durationMs) => {
			calls.push('swipe');
			drags.push({ from, to, durationMs });
		}),
		typeText: vi.fn<NonNullable<DeviceBackend['typeText']>>(async (_serial, text) => {
			calls.push('typeText');
			typed.push(text);
		}),
		pressKey: vi.fn<NonNullable<DeviceBackend['pressKey']>>(async (_serial, key) => {
			calls.push('pressKey');
			keys.push(key);
		}),
	});

	const context = createMockVerbContext({
		backend,
		manifest: createMockCapabilityManifest({
			capabilities: options.capabilities ?? createMockCapabilities(),
		}),
	});

	return { calls, taps, drags, typed, keys, context };
}

/**
 * Each direction, the axis it moves along, and the sign of `from - to` along that axis.
 *
 * A positive sign is a finger travelling towards the origin — up the screen, or leftwards —
 * which is how the content underneath it comes the other way.
 */
const AGAINST_THE_CONTENT: ReadonlyArray<[ScrollDirection, 'x' | 'y', 1 | -1]> = [
	['up', 'y', -1],
	['down', 'y', 1],
	['left', 'x', -1],
	['right', 'x', 1],
];

/** One call of each verb, for the properties all six share. */
const INPUT_VERBS: ReadonlyArray<[string, (context: VerbContext) => Promise<ActionResult>]> = [
	['tap', (context) => tap(context, { by: 'text', text: 'Save' })],
	['long_press', (context) => longPress(context, { by: 'text', text: 'Save' })],
	[
		'swipe',
		(context) => swipe(context, { by: 'text', text: 'Save' }, { by: 'text', text: 'Cancel' }),
	],
	['scroll', (context) => scroll(context, 'down')],
	['type_text', (context) => typeText(context, 'hello')],
	['press_key', (context) => pressKey(context, 'home')],
];

describe('every input verb is on the spine', () => {
	it.each(
		INPUT_VERBS,
	)('%s reads the state after the action, after it (D12(c))', async (_name, run) => {
		const { calls, context } = recording({ screen: [save, cancel] });

		const result = await run(context);

		// The last two calls are the post-state and the device the result names — nothing this
		// module does happens after them.
		expect(calls.slice(-2)).toEqual(['readScreen', 'deviceInfo']);
		expect(result.after).toEqual({ kind: 'screen', elements: [save, cancel] });
	});

	it.each(
		INPUT_VERBS,
	)('%s is refused before the device is touched at all (D11)', async (_name, run) => {
		const { calls, context } = recording({
			screen: [save, cancel],
			capabilities: createMockCapabilities({ canInput: false }),
		});

		await expect(run(context)).rejects.toThrow(MissingCapabilityError);
		// Not even the screen read: the answer is the same either way.
		expect(calls).toEqual([]);
	});
});

describe('tap', () => {
	it('taps the point it resolved from a read taken inside the call', async () => {
		const { calls, taps, context } = recording();

		const result = await tap(context, { by: 'text', text: 'Save' });

		expect(calls).toEqual(['readScreen', 'deviceInfo', 'tap', 'readScreen', 'deviceInfo']);
		expect(taps).toEqual([{ x: 60, y: 40 }]);
		expect(result.verb).toBe('tap');
		expect(result.target).toEqual({ source: 'screen', point: { x: 60, y: 40 }, element: save });
	});

	it('addresses an element by id as readily as by text', async () => {
		const { taps, context } = recording({ screen: [save, cancel] });

		await tap(context, { by: 'element', id: parseElementId('cancel') });

		expect(taps).toEqual([{ x: 220, y: 310 }]);
	});

	it('takes a coordinate as the documented fallback, and says it was one', async () => {
		const { calls, taps, context } = recording();

		const result = await tap(context, { by: 'point', at: { x: 100, y: 200 } });

		expect(taps).toEqual([{ x: 100, y: 200 }]);
		expect(result.target?.source).toBe('caller-point');
		// No screen read before the tap: a point is the one address with no screen behind it.
		expect(calls).toEqual(['deviceInfo', 'tap', 'readScreen', 'deviceInfo']);
	});

	it('never taps when nothing on the screen matches', async () => {
		const { calls, context } = recording({ screen: [cancel] });

		const thrown = await tap(context, { by: 'text', text: 'Save' }).catch(
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(TargetNotFoundError);
		expect((thrown as TargetNotFoundError).found).toContain("'Cancel'");
		expect(calls).not.toContain('tap');
	});
});

describe('long_press', () => {
	it('drags from a point to that same point, held past the platform threshold', async () => {
		const { drags, context } = recording();

		await longPress(context, { by: 'text', text: 'Save' });

		expect(drags).toHaveLength(1);
		const [held] = drags;
		// Two *equal* points and a duration: a long press is a drag in place, never a key event
		// carrying a long-press flag (PROJECT.md §6).
		expect(held?.from).toEqual({ x: 60, y: 40 });
		expect(held?.to).toEqual(held?.from);
		expect(held?.durationMs).toBe(LONG_PRESS_DURATION_MS);
		expect(held?.durationMs).toBeGreaterThan(MEASURED_LONG_PRESS_TIMEOUT_MS);
	});

	it('presses no key and taps nothing', async () => {
		const { context } = recording();

		await longPress(context, { by: 'text', text: 'Save' });

		expect(context.backend.pressKey).not.toHaveBeenCalled();
		expect(context.backend.tap).not.toHaveBeenCalled();
	});

	it('holds for as long as a caller with a slower device asks', async () => {
		const { drags, context } = recording();

		await longPress(context, { by: 'text', text: 'Save' }, { durationMs: 1_500 });

		expect(drags[0]?.durationMs).toBe(1_500);
	});
});

describe('swipe', () => {
	it('drags between two targets, each resolved from its own read', async () => {
		const { calls, drags, context } = recording({ screen: [save, cancel] });

		await swipe(context, { by: 'text', text: 'Save' }, { by: 'text', text: 'Cancel' });

		expect(drags).toEqual([
			{ from: { x: 60, y: 40 }, to: { x: 220, y: 310 }, durationMs: SWIPE_DURATION_MS },
		]);
		// Two reads before the gesture and neither after it until the post-state: the spine
		// resolves `from`, the action resolves `to`, and nothing has happened in between.
		expect(calls).toEqual([
			'readScreen',
			'deviceInfo',
			'readScreen',
			'deviceInfo',
			'swipe',
			'readScreen',
			'deviceInfo',
		]);
	});

	it('reports the end it started from, which is the target the caller aimed at', async () => {
		const { context } = recording({ screen: [save, cancel] });

		const result = await swipe(
			context,
			{ by: 'text', text: 'Save' },
			{ by: 'text', text: 'Cancel' },
		);

		expect(result.verb).toBe('swipe');
		expect(result.target?.element?.id).toBe('save');
	});

	it('never drags when the destination is not on the screen', async () => {
		const { calls, context } = recording({ screen: [save] });

		const thrown = await swipe(
			context,
			{ by: 'text', text: 'Save' },
			{ by: 'text', text: 'Cancel' },
		).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(TargetNotFoundError);
		expect(calls).not.toContain('swipe');
	});

	it("takes a caller's duration over its own default", async () => {
		const { drags, context } = recording({ screen: [save, cancel] });

		await swipe(
			context,
			{ by: 'text', text: 'Save' },
			{ by: 'text', text: 'Cancel' },
			{ durationMs: 0 },
		);

		// Zero is a flick, and a legitimate thing to ask for.
		expect(drags[0]?.durationMs).toBe(0);
	});
});

describe('scroll', () => {
	it('drags upwards for down, because the direction is where the content goes', async () => {
		const { drags, context } = recording();

		await scroll(context, 'down');

		const [drag] = drags;
		// The sign is the whole assertion: the finger travels up the screen, so what is further
		// down the list comes into view.
		expect((drag?.from.y ?? 0) - (drag?.to.y ?? 0)).toBeGreaterThan(0);
		expect(drag?.from.x).toBe(drag?.to.x);
	});

	it.each(
		AGAINST_THE_CONTENT,
	)('drags against the content for %s', async (direction, axis, sign) => {
		const { drags, context } = recording();

		await scroll(context, direction);

		const [drag] = drags;
		const travelled = (drag?.from[axis] ?? 0) - (drag?.to[axis] ?? 0);
		expect(Math.sign(travelled)).toBe(sign);
		// The other axis does not move: a scroll is one gesture along one axis.
		const still = axis === 'y' ? 'x' : 'y';
		expect(drag?.from[still]).toBe(drag?.to[still]);
	});

	it('crosses the screen the device reports when no region is named', async () => {
		const { calls, drags, context } = recording();

		await scroll(context, 'down');

		// The screen is 360×800dp (`createMockDeviceInfo`), so a quarter in from each edge is
		// 200 and 600 with the drag down the middle at x = 180.
		expect(drags).toEqual([
			{ from: { x: 180, y: 600 }, to: { x: 180, y: 200 }, durationMs: SCROLL_DURATION_MS },
		]);
		// No screen read before the gesture: nothing was targeted, so nothing was resolved.
		expect(calls).toEqual(['deviceInfo', 'swipe', 'readScreen', 'deviceInfo']);
	});

	it('crosses the region it was given, and asks the device for no screen box at all', async () => {
		const { calls, drags, context } = recording();

		await scroll(context, 'down', { target: { by: 'text', text: 'Save' } });

		// `save` is 10,20 100×40, so a quarter in from each edge is y 30 and 50, x 60.
		expect(drags).toEqual([
			{ from: { x: 60, y: 50 }, to: { x: 60, y: 30 }, durationMs: SCROLL_DURATION_MS },
		]);
		// The region came from the element the spine already resolved: the only `deviceInfo`
		// calls are the range check that resolution does and the device the result names.
		expect(calls).toEqual(['readScreen', 'deviceInfo', 'swipe', 'readScreen', 'deviceInfo']);
	});

	it('drags slowly enough not to fling, and takes an override', async () => {
		const { drags, context } = recording();

		await scroll(context, 'down');
		await scroll(context, 'down', { durationMs: 50 });

		expect(drags[0]?.durationMs).toBe(SCROLL_DURATION_MS);
		expect(drags[0]?.durationMs).toBeGreaterThan(SWIPE_DURATION_MS);
		expect(drags[1]?.durationMs).toBe(50);
	});

	it('names the region it scrolled in the result, and nothing when it scrolled the screen', async () => {
		const { context } = recording();

		const inRegion = await scroll(context, 'down', {
			target: { by: 'element', id: parseElementId('save') },
		});
		const wholeScreen = await scroll(context, 'down');

		expect(inRegion.verb).toBe('scroll');
		expect(inRegion.target?.element?.id).toBe('save');
		// A verb that addressed no element says so with a null target, rather than inventing one.
		expect(wholeScreen.target).toBeNull();
	});

	it('never drags when the region it was pointed at is not on the screen', async () => {
		const { calls, context } = recording({ screen: [cancel] });

		const thrown = await scroll(context, 'down', { target: { by: 'text', text: 'Save' } }).catch(
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(TargetNotFoundError);
		expect(calls).not.toContain('swipe');
	});
});

/**
 * The escaping cases the first backend measured (PROJECT.md §6) plus the ones a verb author is
 * most likely to "help" with. Every one of them must arrive at the backend byte for byte.
 */
const PASSED_THROUGH = [
	'hello',
	'hello world',
	'  leading and trailing  ',
	"don't",
	'a&b|c;d $e `f` "g" (h) *?[i]',
	'100%',
	'a%sb',
	'%s',
	'zażółć gęślą jaźń',
	'日本語 🙂',
	'line\nbreak\ttab',
	'',
];

describe('type_text', () => {
	it("hands the backend the caller's string and nothing of its own", async () => {
		const { calls, typed, context } = recording();

		const result = await typeText(context, 'hello world');

		// No screen read before the typing: this verb addresses no element, so there is nothing
		// to resolve and nothing to read a screen for.
		expect(calls).toEqual(['typeText', 'readScreen', 'deviceInfo']);
		expect(typed).toEqual(['hello world']);
		expect(result.verb).toBe('type_text');
	});

	it.each(PASSED_THROUGH)('passes %j through byte for byte', async (text) => {
		const { typed, context } = recording();

		await typeText(context, text);

		// Identity, asserted on the exact string rather than on a shape: a verb that quoted,
		// trimmed or percent-escaped anything here would answer with a result that reads like
		// success while the device typed something else. What a device cannot type is the
		// backend's refusal, and this layer holds no opinion about which strings those are.
		expect(typed).toEqual([text]);
	});

	it('addresses no element, so its target is null rather than invented', async () => {
		const { context } = recording();

		const result = await typeText(context, 'hello');

		expect(result.target).toBeNull();
	});

	it('taps nothing and presses no key, whatever the string looks like', async () => {
		const { calls, context } = recording();

		await typeText(context, 'home');

		expect(calls).not.toContain('tap');
		expect(calls).not.toContain('pressKey');
		expect(calls).not.toContain('swipe');
	});

	it("lets a backend's refusal out, rather than answering as though it typed", async () => {
		const { context } = recording();
		const refusal = new UnsupportedTextError(
			context.serial,
			'café',
			['U+00E9 ("é")'],
			'this device only types printable ASCII',
		);
		vi.mocked(context.backend.typeText as NonNullable<DeviceBackend['typeText']>).mockRejectedValue(
			refusal,
		);

		// `toVerbFailure` turns it into an `unsupported-text` answer at the daemon
		// (`tests/unit/verbs/failure.test.ts`); what matters here is that the verb does not
		// swallow it and report a successful action.
		await expect(typeText(context, 'café')).rejects.toThrow(UnsupportedTextError);
	});
});

describe('press_key', () => {
	it('presses the key it was given, on a device it never read the screen of', async () => {
		const { calls, keys, context } = recording();

		const result = await pressKey(context, 'back');

		expect(keys).toEqual(['back']);
		expect(calls).toEqual(['pressKey', 'readScreen', 'deviceInfo']);
		expect(result.verb).toBe('press_key');
	});

	it.each(DeviceKeySchema.options)('carries %s to the backend unchanged', async (key) => {
		const { keys, context } = recording();

		await pressKey(context, key);

		// The whole vocabulary, read off the schema rather than listed again: a key added to
		// `DeviceKeySchema` without a way through this verb is red here rather than silent.
		expect(keys).toEqual([key]);
	});

	it('addresses no element, so its target is null rather than invented', async () => {
		const { context } = recording();

		const result = await pressKey(context, 'home');

		// A key press has no element behind it, and that is a fact about the verb rather than a
		// resolution that failed — which is why it is `null` and not an error.
		expect(result.target).toBeNull();
	});

	it('reports the state after the press, which is the only evidence home did anything', async () => {
		const { context } = recording({ screen: [cancel] });

		const result = await pressKey(context, 'home');

		expect(result.after).toEqual({ kind: 'screen', elements: [cancel] });
	});

	it('says so honestly when the device cannot report what the press did', async () => {
		const { context } = recording({
			capabilities: createMockCapabilities({ canReadScreen: false }),
		});

		const result = await pressKey(context, 'recents');

		// Never an empty element list, which would read as a blank screen — the capability that
		// would have answered, named.
		expect(result.after).toEqual({
			kind: 'unavailable',
			capability: 'canReadScreen',
			message: expect.stringContaining('canReadScreen'),
		});
	});

	it('injects no touch event: a key press is not a tap anywhere', async () => {
		const { calls, context } = recording();

		await pressKey(context, 'back');

		expect(calls).not.toContain('tap');
		expect(calls).not.toContain('swipe');
	});
});
