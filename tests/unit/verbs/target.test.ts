/**
 * Target resolution — D12(a) as executable assertions.
 *
 * The headline one is the first: **every resolution reads the screen again.** The rest are
 * the cases where a resolver that "mostly works" is worse than one that refuses — two
 * matches, a stale element id, and a coordinate that is not on the device at all.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeviceBackend, ScreenElement } from '@/core/device.js';
import { MissingCapabilityError } from '@/core/errors.js';
import { parseElementId } from '@/core/ids.js';
import type { VerbContext } from '@/verbs/context.js';
import { AmbiguousTargetError, OffScreenPointError, TargetNotFoundError } from '@/verbs/errors.js';
import { centreOf, requireTarget, resolveTarget } from '@/verbs/target.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

/** A context whose screen read answers each of `screens` in turn, then repeats the last. */
function contextShowing(...screens: ScreenElement[][]): VerbContext {
	let call = 0;
	const readScreen = vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
		const screen = screens[Math.min(call, screens.length - 1)] ?? [];
		call += 1;
		return screen;
	});
	return createMockVerbContext({ backend: createMockDeviceBackend({ readScreen }) });
}

const save = createMockScreenElement({ id: 'save', text: 'Save' });
const cancel = createMockScreenElement({
	id: 'cancel',
	text: 'Cancel',
	bounds: { x: 200, y: 20, width: 100, height: 40 },
});

describe('resolveTarget', () => {
	it('reads the screen again on every resolution, so no coordinate outlives its call', async () => {
		const moved = createMockScreenElement({
			id: 'save',
			text: 'Save',
			bounds: { x: 10, y: 500, width: 100, height: 40 },
		});
		const context = contextShowing([save], [moved]);

		const first = await resolveTarget(context, { by: 'text', text: 'Save' });
		const second = await resolveTarget(context, { by: 'text', text: 'Save' });

		expect(context.backend.readScreen).toHaveBeenCalledTimes(2);
		expect(first?.point).toEqual({ x: 60, y: 40 });
		expect(second?.point).toEqual({ x: 60, y: 520 });
	});

	it('matches the element text', async () => {
		const context = contextShowing([save, cancel]);

		const resolved = await resolveTarget(context, { by: 'text', text: 'Cancel' });

		expect(resolved?.element?.id).toBe('cancel');
		expect(resolved?.source).toBe('screen');
		expect(resolved?.point).toEqual(centreOf(cancel));
	});

	it('matches the accessibility label too, which is often not the same string', async () => {
		const iconOnly = createMockScreenElement({ id: 'close', text: null, label: 'Close dialog' });
		const context = contextShowing([save, iconOnly]);

		const resolved = await resolveTarget(context, { by: 'text', text: 'Close dialog' });

		expect(resolved?.element?.id).toBe('close');
	});

	it('matches a substring by default and the whole string under `exact`', async () => {
		const context = contextShowing([save], [save]);

		expect(await resolveTarget(context, { by: 'text', text: 'Sav' })).not.toBeNull();
		expect(await resolveTarget(context, { by: 'text', text: 'Sav', exact: true })).toBeNull();
	});

	it('throws AmbiguousTargetError naming every candidate rather than taking the first', async () => {
		const twin = createMockScreenElement({
			id: 'save-2',
			text: 'Save',
			bounds: { x: 10, y: 400, width: 100, height: 40 },
		});
		const context = contextShowing([save, twin]);

		const thrown = await resolveTarget(context, { by: 'text', text: 'Save' }).catch(
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(AmbiguousTargetError);
		const error = thrown as AmbiguousTargetError;
		expect(error.candidates.map((candidate) => candidate.id)).toEqual(['save', 'save-2']);
		expect(error.message).toContain('[save]');
		expect(error.message).toContain('[save-2]');
		expect(error.message).toContain('index');
	});

	it('lets an explicit index disambiguate deliberately', async () => {
		const twin = createMockScreenElement({ id: 'save-2', text: 'Save' });
		const context = contextShowing([save, twin]);

		const resolved = await resolveTarget(context, { by: 'text', text: 'Save', index: 1 });

		expect(resolved?.element?.id).toBe('save-2');
	});

	it('answers null for an index past the last match', async () => {
		const context = contextShowing([save]);

		expect(await resolveTarget(context, { by: 'text', text: 'Save', index: 3 })).toBeNull();
	});

	it('answers null when nothing matches, rather than throwing', async () => {
		const context = contextShowing([save, cancel]);

		expect(await resolveTarget(context, { by: 'text', text: 'Delete' })).toBeNull();
	});

	it('resolves an element id against the screen that is there now', async () => {
		const context = contextShowing([save, cancel]);

		const resolved = await resolveTarget(context, { by: 'element', id: parseElementId('cancel') });

		expect(resolved?.point).toEqual(centreOf(cancel));
	});

	it('answers null for an element id that has left the screen, never its old bounds', async () => {
		const context = contextShowing([save], []);
		await resolveTarget(context, { by: 'element', id: parseElementId('save') });

		expect(await resolveTarget(context, { by: 'element', id: parseElementId('save') })).toBeNull();
	});

	it('refuses a text target on a backend that cannot read the screen', async () => {
		const context = createMockVerbContext({
			manifest: createMockCapabilityManifest({
				capabilities: createMockCapabilities({ canReadScreen: false }),
			}),
		});

		await expect(resolveTarget(context, { by: 'text', text: 'Save' })).rejects.toThrow(
			MissingCapabilityError,
		);
	});
});

describe('resolveTarget, by point', () => {
	it('does not read the screen, and says the point did not come from one', async () => {
		const context = contextShowing([save]);

		const resolved = await resolveTarget(context, { by: 'point', at: { x: 100, y: 200 } });

		expect(context.backend.readScreen).not.toHaveBeenCalled();
		expect(resolved).toEqual({
			source: 'caller-point',
			point: { x: 100, y: 200 },
			element: null,
		});
	});

	it('works on a backend that cannot read the screen at all — the documented fallback', async () => {
		const context = createMockVerbContext({
			manifest: createMockCapabilityManifest({
				capabilities: createMockCapabilities({ canReadScreen: false }),
			}),
		});

		const resolved = await resolveTarget(context, { by: 'point', at: { x: 1, y: 1 } });

		expect(resolved?.source).toBe('caller-point');
	});

	it.each([
		['past the right edge', { x: 360, y: 10 }],
		['past the bottom edge', { x: 10, y: 800 }],
		['negative', { x: -1, y: 10 }],
	])('throws OffScreenPointError for a point %s of a 360×800 screen', async (_name, at) => {
		const context = contextShowing([save]);

		const thrown = await resolveTarget(context, { by: 'point', at }).catch(
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(OffScreenPointError);
		expect((thrown as OffScreenPointError).message).toContain('360×800');
		expect((thrown as OffScreenPointError).message).toContain('test-serial-1');
	});
});

describe('requireTarget', () => {
	it('names what was looked for and what was on screen instead', async () => {
		const context = contextShowing([save, cancel]);

		const thrown = await requireTarget(context, { by: 'text', text: 'Delete' }).catch(
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(TargetNotFoundError);
		const error = thrown as TargetNotFoundError;
		expect(error.lookedFor).toContain("'Delete'");
		expect(error.found).toContain("'Save'");
		expect(error.found).toContain("'Cancel'");
	});

	it('says the screen was empty rather than saying nothing', async () => {
		const context = contextShowing([]);

		await expect(requireTarget(context, { by: 'text', text: 'Save' })).rejects.toThrow(
			/an empty screen/,
		);
	});

	it('bounds the excerpt, so a crowded screen is still readable', async () => {
		const crowded = Array.from({ length: 20 }, (_unused, at) =>
			createMockScreenElement({ id: `element-${at}`, text: `Item ${at}` }),
		);
		const context = contextShowing(crowded);

		const thrown = await requireTarget(context, { by: 'text', text: 'Save' }).catch(
			(error: unknown) => error,
		);

		const { found } = thrown as TargetNotFoundError;
		expect(found).toContain('20 elements');
		expect(found).toContain('and 12 more');
		expect(found).not.toContain('Item 9');
	});

	it('answers with the resolution when there is one', async () => {
		const context = contextShowing([save]);

		await expect(requireTarget(context, { by: 'text', text: 'Save' })).resolves.toEqual({
			source: 'screen',
			point: centreOf(save),
			element: save,
		});
	});
});
