/**
 * What `captureAfterState` answers with — the compact selection (#330) and the wait that gets
 * it a screen worth reporting (#333).
 *
 * The compact rule is a **selection, not a judgement** (ai/RULES.md §1), so every assertion
 * about it is about what an element carries — each of the six reasons on its own keeps one,
 * nothing else does — and about order being the backend's own. The honesty half is `omitted`: a
 * compact list that comes back empty must say how much screen it is standing in for, or it
 * reads as a blank one.
 *
 * `settled` is the same kind of claim one layer out: two consecutive reads **matched**, which is
 * arithmetic over two reads and never a verdict about what they carry. The cases below pin the
 * three values apart — `true` only when two reads really agreed, `false` only when the bound
 * went by and they never did, `null` only when nobody asked — because a screen reported as
 * settled that was not is exactly the failure this wait exists to remove.
 *
 * **Not one test here waits on a real duration.** Time is an injected counter and the poll gap
 * is recorded rather than taken, the rule `tests/unit/core/wait.test.ts` keeps for the
 * vocabulary itself.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeviceBackend, ScreenElement } from '@/core/device.js';
import { UnreadableScreenError } from '@/core/errors.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { DEFAULT_POLL_INTERVAL_MS } from '@/core/wait.js';
import type { VerbContext } from '@/verbs/context.js';
import {
	AFTER_STATE_TIMEOUT_MS,
	type AfterDetail,
	type AfterStateOptions,
	captureAfterState,
	carriesSomething,
	sameElements,
} from '@/verbs/result.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

/** An element that carries nothing: no text, no label, no identifier, no interaction state. */
function bare(id: string, overrides: Partial<Omit<ScreenElement, 'id'>> = {}): ScreenElement {
	return createMockScreenElement({ id, text: null, ...overrides });
}

const root = bare('0');
const title = createMockScreenElement({ id: '0.0', text: 'Settings' });
const container = bare('0.1');
const row = bare('0.1.0', { clickable: true });
const spacer = bare('0.2', { enabled: true, selected: false });

/** A context whose backend reads `screen`, with `afterDetail` set only when given. */
function contextReading(screen: readonly ScreenElement[], afterDetail?: AfterDetail): VerbContext {
	return createMockVerbContext({
		backend: createMockDeviceBackend({
			readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => [...screen]),
		}),
		...(afterDetail === undefined ? {} : { afterDetail }),
	});
}

/**
 * A context whose backend answers each read from `reads` in order, repeating the last one for
 * every read after the list runs out — so "a screen that keeps changing" is a list of screens
 * and "a screen that settles" is a list that stops changing.
 *
 * A reading may be an `Error` to throw instead of a list, which is how the unreadable screen
 * (`UnreadableScreenError`) and the broken device (a plain `Error`) are told apart.
 */
function contextSequence(
	reads: ReadonlyArray<readonly ScreenElement[] | Error>,
	afterDetail?: AfterDetail,
): { context: VerbContext; count: () => number } {
	let at = 0;
	const context = createMockVerbContext({
		backend: createMockDeviceBackend({
			readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
				const reading = reads[Math.min(at, reads.length - 1)] as readonly ScreenElement[] | Error;
				at += 1;
				if (reading instanceof Error) throw reading;
				return [...reading];
			}),
		}),
		...(afterDetail === undefined ? {} : { afterDetail }),
	});
	return { context, count: () => at };
}

/**
 * The after-state wait's two seams plus a log of every gap it asked for.
 *
 * The clock advances a quarter of the bound per reading, so a condition that is never met
 * reaches the deadline in a handful of reads rather than in {@link AFTER_STATE_TIMEOUT_MS} of
 * them, and nothing here waits on a real duration.
 */
function fakeClock(): AfterStateOptions & { readonly asked: number[] } {
	const asked: number[] = [];
	let current = 1_000;
	return {
		asked,
		now: () => (current += AFTER_STATE_TIMEOUT_MS / 4),
		delay: async (ms: number) => void asked.push(ms),
	};
}

/** The same, with `settle: true` on it, for the verbs that wait for the screen to stop. */
function settling(): AfterStateOptions & { readonly asked: number[] } {
	return { ...fakeClock(), settle: true };
}

/** A screen of one row, at a given offset — a list a fling is still moving. */
function listAt(y: number): readonly ScreenElement[] {
	return [
		createMockScreenElement({ id: '0', text: 'Row', bounds: { x: 0, y, width: 360, height: 48 } }),
	];
}

describe('carriesSomething', () => {
	it.each([
		['text', { text: 'Save' }],
		['a label', { label: 'Close' }],
		['an identifier', { identifier: 'com.example:id/save' }],
		['a checkable state, even unchecked', { checked: false }],
		['clickable', { clickable: true }],
		['focus', { focused: true }],
	] as const)('keeps an element that carries %s and nothing else', (_reason, carried) => {
		expect(carriesSomething(bare('x', carried))).toBe(true);
	});

	it.each([
		['nothing at all', {}],
		['only selected', { selected: true }],
		['only enabled', { enabled: true }],
		['clickable: false', { clickable: false }],
		['focused: false', { focused: false }],
	] as const)('drops an element that carries %s', (_reason, carried) => {
		expect(carriesSomething(bare('x', carried))).toBe(false);
	});
});

describe('captureAfterState', () => {
	it('is compact by default: the carrying elements, in the backend’s order, and a count of the rest', async () => {
		const after = await captureAfterState(contextReading([root, title, container, row, spacer]));

		expect(after).toEqual({
			kind: 'screen',
			detail: 'compact',
			elements: [title, row],
			omitted: 3,
			settled: null,
		});
	});

	it('answers every element when asked for the full read, and omits nothing', async () => {
		const screen = [root, title, container, row, spacer];

		const after = await captureAfterState(contextReading(screen, 'full'));

		expect(after).toEqual({
			kind: 'screen',
			detail: 'full',
			elements: screen,
			omitted: 0,
			settled: null,
		});
	});

	it('says a screen of textless nodes is not a blank screen', async () => {
		const after = await captureAfterState(contextReading([root, container, spacer]));

		// An empty list alone would be indistinguishable from nothing on screen; the count is
		// what says there was a screen and none of it carried anything.
		expect(after).toEqual({
			kind: 'screen',
			detail: 'compact',
			elements: [],
			omitted: 3,
			settled: null,
		});
	});

	it.each([
		'compact',
		'full',
	] as const)('keeps the unavailable branch unchanged when detail is %s', async (detail) => {
		const context: VerbContext = {
			...contextReading([title], detail),
			manifest: createMockCapabilityManifest({
				capabilities: createMockCapabilities({ canReadScreen: false }),
			}),
		};

		expect(await captureAfterState(context)).toMatchObject({
			kind: 'unavailable',
			capability: 'canReadScreen',
		});
	});

	it.each([
		'compact',
		'full',
	] as const)('keeps the failed branch unchanged when detail is %s', async (detail) => {
		const serial = parseDeviceSerial('test-serial-1');
		const context = createMockVerbContext({
			afterDetail: detail,
			backend: createMockDeviceBackend({
				readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
					throw new UnreadableScreenError(serial, 'the dump was empty');
				}),
			}),
		});

		expect(await captureAfterState(context, fakeClock())).toMatchObject({
			kind: 'failed',
			capability: 'canReadScreen',
		});
	});
});

describe('sameElements', () => {
	it('is true for two reads of one screen, and says nothing about whether it is right', () => {
		// A measurement, not a judgement (ai/RULES.md §1): the two reads matched.
		expect(sameElements([root, title], [root, title])).toBe(true);
	});

	it('is false when a node moved, even by a pixel and with every other field equal', () => {
		// Bounds are what a fling moves, so they are what a textless list row changes by —
		// comparing anything less would call a moving screen still.
		expect(sameElements(listAt(100), listAt(101))).toBe(false);
	});

	it.each([
		['the length', [root, title], [root]],
		['an id', [bare('0')], [bare('1')]],
		['the text', [title], [createMockScreenElement({ id: '0.0', text: 'Network' })]],
		['a state field', [bare('0', { checked: false })], [bare('0', { checked: true })]],
		['the order', [root, title], [title, root]],
	] as const)('is false when %s differs', (_what, a, b) => {
		expect(sameElements(a, b)).toBe(false);
	});
});

describe('captureAfterState waits for a screen it can report (#333)', () => {
	const serial = parseDeviceSerial('test-serial-1');
	const notYet = () => new UnreadableScreenError(serial, 'null root node');

	it('polls through a read the device was not ready for, and answers the screen it then got', async () => {
		// The #299 case, now closed for every verb and not only for the two waits.
		const { context, count } = contextSequence([notYet(), [title]]);

		const after = await captureAfterState(context, fakeClock());

		expect(after).toMatchObject({ kind: 'screen', elements: [title], settled: null });
		expect(count()).toBe(2);
	});

	it('answers failed, naming the bound and the backend’s own reason, when it never becomes readable', async () => {
		const { context, count } = contextSequence([notYet()]);

		const after = await captureAfterState(context, fakeClock());

		expect(after).toMatchObject({ kind: 'failed', capability: 'canReadScreen' });
		expect(after).toHaveProperty('message', expect.stringContaining('null root node'));
		expect(after).toHaveProperty(
			'message',
			expect.stringContaining(`polling for ${AFTER_STATE_TIMEOUT_MS}ms`),
		);
		expect(after).toHaveProperty('message', expect.stringContaining(`(${count()} reads)`));
	});

	it('does not poll a device that broke — only the unreadable screen is a "not yet"', async () => {
		const { context, count } = contextSequence([new Error('device offline')]);

		const after = await captureAfterState(context, fakeClock());

		expect(after).toMatchObject({ kind: 'failed', capability: 'canReadScreen' });
		expect(after).toHaveProperty('message', expect.stringContaining('device offline'));
		expect(count()).toBe(1);
	});

	it('costs one read and no delay at all when it was not asked to settle', async () => {
		const clock = fakeClock();
		const { context, count } = contextSequence([[title]]);

		const after = await captureAfterState(context, clock);

		expect(after).toMatchObject({ settled: null });
		expect(count()).toBe(1);
		expect(clock.asked).toEqual([]);
	});

	it('settles on a static screen in two reads and one poll gap', async () => {
		const clock = settling();
		const { context, count } = contextSequence([[title]]);

		const after = await captureAfterState(context, clock);

		expect(after).toMatchObject({ kind: 'screen', elements: [title], settled: true });
		// The first read has nothing before it to compare against, so a settle is never one read.
		expect(count()).toBe(2);
		expect(clock.asked).toEqual([DEFAULT_POLL_INTERVAL_MS]);
	});

	it('reports a screen that never settled as one that did not, carrying its last read', async () => {
		// A list still travelling: every read moves it, so no two ever match.
		let y = 0;
		const context = createMockVerbContext({
			backend: createMockDeviceBackend({
				readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
					y += 10;
					return [...listAt(y)];
				}),
			}),
			afterDetail: 'full',
		});

		const after = await captureAfterState(context, settling());

		// Never `true`, which is the acceptance criterion: a screen that never settled is never
		// reported as a settled one. And never `failed` either — there *is* a screen to report.
		expect(after).toMatchObject({ kind: 'screen', settled: false });
		expect((after as { elements: readonly ScreenElement[] }).elements).toEqual(listAt(y));
	});

	it('answers failed rather than settled: false when there was never a screen to report', async () => {
		const { context } = contextSequence([notYet()]);

		const after = await captureAfterState(context, settling());

		// `settled: false` says "this screen was moving"; with no read at all there is no screen
		// to say it about, and the honest branch is the one that names the capability.
		expect(after).toMatchObject({ kind: 'failed', capability: 'canReadScreen' });
	});

	it('compares the whole read, so a screen whose only moving nodes are textless never settles', async () => {
		// Compacted, both reads are the same single row; the container underneath it moved, and
		// that is the node a fling drags. Comparing the compact lists would call this still.
		let y = 0;
		const context = createMockVerbContext({
			backend: createMockDeviceBackend({
				readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
					y += 10;
					return [title, bare('0.1', { bounds: { x: 0, y, width: 360, height: 48 } })];
				}),
			}),
		});

		const after = await captureAfterState(context, settling());

		expect(after).toMatchObject({
			kind: 'screen',
			detail: 'compact',
			elements: [title],
			omitted: 1,
			settled: false,
		});
	});

	it.each([
		['compact', [title], 1],
		['full', [title, container], 0],
	] as const)('applies the %s rule to the read it finally settles on', async (detail, elements, omitted) => {
		const { context } = contextSequence([[title, container]], detail);

		const after = await captureAfterState(context, settling());

		expect(after).toEqual({ kind: 'screen', detail, elements, omitted, settled: true });
	});
});
