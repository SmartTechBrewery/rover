/**
 * The spine, driven by a fake action — no concrete verb exists yet (R12, R13), and the
 * three rules it enforces are the same whatever the action turns out to be.
 *
 * What the assertions are actually about is **order**: the manifest before anything, the
 * screen read before the action, and the state after it *after* it. Each of those is
 * invisible in a result that looks right, which is why they are asserted against the call
 * log rather than against the value.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeviceBackend } from '@/core/device.js';
import { MissingCapabilityError } from '@/core/errors.js';
import { capabilityMethod, type VerbContext } from '@/verbs/context.js';
import { TargetNotFoundError, UnaddressableElementError } from '@/verbs/errors.js';
import { performAction } from '@/verbs/perform.js';
import type { ResolvedTarget } from '@/verbs/result.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

const save = createMockScreenElement({ id: 'save', text: 'Save' });

/** A context that records every backend call in order, on one shared log. */
function recordingContext(
	calls: string[],
	screen = [save],
	capabilities = createMockCapabilities(),
): VerbContext {
	const backend = createMockDeviceBackend({
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
			calls.push('readScreen');
			return screen;
		}),
		tap: vi.fn<NonNullable<DeviceBackend['tap']>>(async () => {
			calls.push('tap');
		}),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async () => {
			calls.push('deviceInfo');
			return createMockDeviceInfo();
		}),
	});
	return createMockVerbContext({
		backend,
		manifest: createMockCapabilityManifest({ capabilities }),
	});
}

/** What a verb author writes: fetch the gated method, act on the point resolved for it. */
function tapAction(context: VerbContext) {
	return async (target: ResolvedTarget | null): Promise<void> => {
		const tap = capabilityMethod(context, 'canInput', 'tap');
		await tap(context.serial, target?.point ?? { x: 0, y: 0 });
	};
}

describe('performAction', () => {
	it('reads the state after the action, after the action', async () => {
		const calls: string[] = [];
		const context = recordingContext(calls);

		await performAction(context, {
			verb: 'fake_tap',
			requires: ['canInput'],
			target: { by: 'text', text: 'Save' },
			act: tapAction(context),
		});

		// `deviceInfo` before the tap is the screen the resolved point is range-checked
		// against; the one after is the device the result names (D14), read again because an
		// action can rotate it.
		expect(calls).toEqual(['readScreen', 'deviceInfo', 'tap', 'readScreen', 'deviceInfo']);
	});

	it('names the device and its density in the result (D14)', async () => {
		const context = recordingContext([]);

		const result = await performAction(context, {
			verb: 'fake_tap',
			requires: ['canInput'],
			target: { by: 'text', text: 'Save' },
			act: tapAction(context),
		});

		expect(result.verb).toBe('fake_tap');
		expect(result.device.serial).toBe('test-serial-1');
		expect(result.device.screen.density).toBe(480);
		expect(result.device.screen.densityScale).toBe(3);
		expect(result.target).toEqual({ source: 'screen', point: { x: 60, y: 40 }, element: save });
		expect(result.after).toEqual({ kind: 'screen', elements: [save] });
	});

	it('hands the action the target it resolved', async () => {
		const context = recordingContext([]);
		const act = vi.fn(async () => {});

		await performAction(context, {
			verb: 'fake_tap',
			requires: ['canInput'],
			target: { by: 'text', text: 'Save' },
			act,
		});

		expect(act).toHaveBeenCalledWith({ source: 'screen', point: { x: 60, y: 40 }, element: save });
	});

	it('consults the manifest before anything is dispatched', async () => {
		const calls: string[] = [];
		const context = recordingContext(calls, [save], createMockCapabilities({ canInput: false }));
		const act = vi.fn(async () => {});

		await expect(
			performAction(context, {
				verb: 'fake_tap',
				requires: ['canInput'],
				target: { by: 'text', text: 'Save' },
				act,
			}),
		).rejects.toThrow(MissingCapabilityError);

		// Not even the screen read: the answer is the same either way, and the device is
		// never touched to reach it.
		expect(calls).toEqual([]);
		expect(act).not.toHaveBeenCalled();
	});

	it('answers an explicit unavailable after-state on a backend that cannot read the screen', async () => {
		const calls: string[] = [];
		const context = recordingContext(
			calls,
			[save],
			createMockCapabilities({ canReadScreen: false }),
		);

		const result = await performAction(context, {
			verb: 'fake_tap',
			requires: ['canInput'],
			target: { by: 'point', at: { x: 100, y: 200 } },
			act: tapAction(context),
		});

		expect(result.after).toEqual({
			kind: 'unavailable',
			capability: 'canReadScreen',
			message: expect.stringContaining('canReadScreen'),
		});
		// An empty element list would read as a blank screen, which is the silent
		// degradation D11 forbids.
		expect(calls).not.toContain('readScreen');
		expect(result.target?.source).toBe('caller-point');
	});

	it('fails with what was on screen instead when the target is gone', async () => {
		const context = recordingContext(
			[],
			[createMockScreenElement({ id: 'cancel', text: 'Cancel' })],
		);
		const act = vi.fn(async () => {});

		const thrown = await performAction(context, {
			verb: 'fake_tap',
			requires: ['canInput'],
			target: { by: 'text', text: 'Save' },
			act,
		}).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(TargetNotFoundError);
		expect((thrown as TargetNotFoundError).found).toContain("'Cancel'");
		expect(act).not.toHaveBeenCalled();
	});

	it('never dispatches at an element that cannot be acted on', async () => {
		// The captured inverted bounds from PROJECT.md §6 — a row scrolled out of its list.
		const context = recordingContext(
			[],
			[
				createMockScreenElement({
					id: 'row',
					text: 'Save',
					bounds: { x: 96, y: 2798, width: 303, height: -14 },
				}),
			],
		);
		const act = vi.fn(async () => {});

		const thrown = await performAction(context, {
			verb: 'fake_tap',
			requires: ['canInput'],
			target: { by: 'text', text: 'Save' },
			act,
		}).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(UnaddressableElementError);
		expect(act).not.toHaveBeenCalled();
		expect(context.backend.tap).not.toHaveBeenCalled();
	});

	it('answers a failed after-state when the read after the action rejects, not an exception', async () => {
		let reads = 0;
		const context = createMockVerbContext({
			backend: createMockDeviceBackend({
				readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
					reads += 1;
					if (reads > 1) {
						throw new Error('device offline');
					}
					return [save];
				}),
			}),
		});

		const result = await performAction(context, {
			verb: 'fake_tap',
			requires: ['canInput'],
			target: { by: 'text', text: 'Save' },
			act: tapAction(context),
		});

		// The action already ran. Throwing here would leave the agent unable to tell whether
		// it landed, which is the one thing D12(c) exists to rule out.
		expect(result.after).toEqual({
			kind: 'failed',
			capability: 'canReadScreen',
			message: expect.stringContaining('device offline'),
		});
		expect(result.target?.element?.id).toBe('save');
	});

	it('runs a verb that addresses no element, and says so with a null target', async () => {
		const calls: string[] = [];
		const context = recordingContext(calls);
		const act = vi.fn(async () => {});

		const result = await performAction(context, {
			verb: 'fake_key_press',
			requires: ['canInput'],
			act,
		});

		expect(act).toHaveBeenCalledWith(null);
		expect(result.target).toBeNull();
		// One read, and it is the state after — nothing was resolved, so nothing needed
		// checking against the screen's dimensions either.
		expect(calls).toEqual(['readScreen', 'deviceInfo']);
	});
});
