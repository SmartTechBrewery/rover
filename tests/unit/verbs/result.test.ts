/**
 * The compact after-state (#330): what `captureAfterState` keeps of a screen read, and what it
 * says about what it left out.
 *
 * The rule is a **selection, not a judgement** (ai/RULES.md §1), so every assertion here is about
 * what an element carries — each of the six reasons on its own keeps one, nothing else does — and
 * about order being the backend's own. The honesty half is `omitted`: a compact list that comes
 * back empty must say how much screen it is standing in for, or it reads as a blank one.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeviceBackend, ScreenElement } from '@/core/device.js';
import { UnreadableScreenError } from '@/core/errors.js';
import { parseDeviceSerial } from '@/core/ids.js';
import type { VerbContext } from '@/verbs/context.js';
import { type AfterDetail, captureAfterState, carriesSomething } from '@/verbs/result.js';
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
		});
	});

	it('answers every element when asked for the full read, and omits nothing', async () => {
		const screen = [root, title, container, row, spacer];

		const after = await captureAfterState(contextReading(screen, 'full'));

		expect(after).toEqual({ kind: 'screen', detail: 'full', elements: screen, omitted: 0 });
	});

	it('says a screen of textless nodes is not a blank screen', async () => {
		const after = await captureAfterState(contextReading([root, container, spacer]));

		// An empty list alone would be indistinguishable from nothing on screen; the count is
		// what says there was a screen and none of it carried anything.
		expect(after).toEqual({ kind: 'screen', detail: 'compact', elements: [], omitted: 3 });
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

		expect(await captureAfterState(context)).toMatchObject({
			kind: 'failed',
			capability: 'canReadScreen',
		});
	});
});
