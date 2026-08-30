/**
 * The two read verbs, over a backend that records what it was asked to do.
 *
 * These verbs do nothing to the device, so a result that *looks* right proves almost
 * nothing on its own — every assertion here is about something the shape cannot show:
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
 */

import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '@/core/capabilities.js';
import type { DeviceBackend, ScreenElement } from '@/core/device.js';
import { MissingCapabilityError } from '@/core/errors.js';
import type { VerbContext } from '@/verbs/context.js';
import { deviceInfo, readScreen } from '@/verbs/read.js';
import type { ActionResult } from '@/verbs/result.js';
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

interface Recording {
	readonly calls: string[];
	readonly context: VerbContext;
}

/** A context whose backend records every call on one shared log, in order. */
function recording(
	options: { screen?: readonly ScreenElement[]; capabilities?: Capabilities } = {},
): Recording {
	const calls: string[] = [];
	const screen = options.screen ?? [save, cancel];

	const backend = createMockDeviceBackend({
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
			calls.push('readScreen');
			return [...screen];
		}),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async (serial) => {
			calls.push('deviceInfo');
			return createMockDeviceInfo({ serial });
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

/** One call of each verb, for the properties both share. */
const READS: ReadonlyArray<[string, (context: VerbContext) => Promise<ActionResult>]> = [
	['read_screen', readScreen],
	['device_info', deviceInfo],
];

describe('both read verbs are on the spine', () => {
	it.each(
		READS,
	)('%s reads the screen once and the device once, in that order', async (_name, run) => {
		const { calls, context } = recording();

		await run(context);

		// The spine's own capture and nothing else: a read verb whose `act` did the reading
		// would show a third call here, and would be a second place deciding what an answer
		// looks like.
		expect(calls).toEqual(['readScreen', 'deviceInfo']);
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
