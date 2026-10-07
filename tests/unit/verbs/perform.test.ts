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
import type { DeviceBackend, DeviceInfo } from '@/core/device.js';
import { MissingCapabilityError } from '@/core/errors.js';
import { parseAppId } from '@/core/ids.js';
import { DEFAULT_POLL_INTERVAL_MS } from '@/core/wait.js';
import { capabilityMethod, type VerbContext } from '@/verbs/context.js';
import {
	AppNotInForegroundError,
	CoveredByKeyboardError,
	TargetNotFoundError,
	UnaddressableElementError,
} from '@/verbs/errors.js';
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
	info: DeviceInfo = createMockDeviceInfo(),
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
			return info;
		}),
	});
	return createMockVerbContext({
		backend,
		manifest: createMockCapabilityManifest({ capabilities }),
	});
}

/**
 * The same, with an on-screen keyboard over the lower half of the 360×800 mock screen and
 * `Save` laid out inside it — the geometry the resolution's keyboard check is about.
 */
function coveredContext(calls: string[]): VerbContext {
	const covered = createMockScreenElement({
		id: 'save',
		text: 'Save',
		bounds: { x: 60, y: 580, width: 80, height: 40 },
	});
	const backend = createMockDeviceBackend({
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
			calls.push('readScreen');
			return [covered];
		}),
		tap: vi.fn<NonNullable<DeviceBackend['tap']>>(async () => {
			calls.push('tap');
		}),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async () => {
			calls.push('deviceInfo');
			const info = createMockDeviceInfo();
			return {
				...info,
				screen: {
					...info.screen,
					keyboard: { shown: true, bounds: { x: 0, y: 400, width: 360, height: 400 } },
				},
			};
		}),
	});
	return createMockVerbContext({ backend, manifest: createMockCapabilityManifest() });
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
		expect(result.after).toEqual({
			kind: 'screen',
			detail: 'compact',
			elements: [save],
			omitted: 0,
			settled: null,
		});
	});

	it('forwards the after-state options to the capture, so a verb can ask the screen to settle', async () => {
		const asked: number[] = [];
		let current = 1_000;
		const context = recordingContext([]);

		const result = await performAction(context, {
			verb: 'fake_scroll',
			requires: ['canInput'],
			target: { by: 'text', text: 'Save' },
			afterState: {
				settle: true,
				now: () => (current += 1),
				delay: async (ms: number) => void asked.push(ms),
			},
			act: tapAction(context),
		});

		// The spine passes the options through rather than deciding anything about them: the
		// settle is the verb's, and the seams are the test's (#333).
		expect(result.after).toMatchObject({ kind: 'screen', settled: true });
		expect(asked).toEqual([DEFAULT_POLL_INTERVAL_MS]);
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

	/**
	 * `resolve` exists for `scroll`, whose spine target is a region rather than the point it
	 * touches (#318 review). It is opt-in, so the pair below pins both halves: the default
	 * still refuses a covered target, and a verb that asks for the exemption gets it — which is
	 * what keeps `tap` and `long_press` from inheriting `scroll`'s.
	 */
	it('refuses a target whose resolved point is under the keyboard, by default', async () => {
		const calls: string[] = [];
		const context = coveredContext(calls);

		const thrown = await performAction(context, {
			verb: 'fake_tap',
			requires: ['canInput'],
			target: { by: 'text', text: 'Save' },
			act: tapAction(context),
		}).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(CoveredByKeyboardError);
		expect(calls).toEqual(['readScreen', 'deviceInfo']);
	});

	it('resolves that same target without the keyboard check when a verb asks', async () => {
		const calls: string[] = [];
		const context = coveredContext(calls);

		const result = await performAction(context, {
			verb: 'fake_scroll',
			requires: ['canInput'],
			target: { by: 'text', text: 'Save' },
			resolve: { touchStartsHere: false },
			act: tapAction(context),
		});

		expect(result.target?.element?.id).toBe('save');
		expect(calls).toEqual(['readScreen', 'deviceInfo', 'tap', 'readScreen', 'deviceInfo']);
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

	describe('expectApp (#332)', () => {
		const expected = parseAppId('com.example.app');
		const elsewhere = createMockDeviceInfo({ foregroundApp: 'com.android.launcher3' });

		it('performs nothing when another application is in front, naming both', async () => {
			const calls: string[] = [];
			const context = recordingContext(calls, [save], createMockCapabilities(), elsewhere);
			const act = vi.fn(async () => {});

			const refusal = performAction(context, {
				verb: 'fake_tap',
				requires: ['canInput'],
				expectApp: expected,
				target: { by: 'text', text: 'Save' },
				act,
			});

			await expect(refusal).rejects.toThrow(AppNotInForegroundError);
			await expect(refusal).rejects.toMatchObject({
				serial: 'test-serial-1',
				expectedApp: 'com.example.app',
				foregroundApp: 'com.android.launcher3',
			});
			// One fresh read and nothing else: no screen read for the target, no tap.
			expect(calls).toEqual(['deviceInfo']);
			expect(act).not.toHaveBeenCalled();
		});

		it('refuses when the device cannot say what is in front, rather than acting', async () => {
			const calls: string[] = [];
			const unanswered = createMockDeviceInfo({ foregroundApp: null });
			const context = recordingContext(calls, [save], createMockCapabilities(), unanswered);
			const act = vi.fn(async () => {});

			const refusal = performAction(context, {
				verb: 'fake_key_press',
				requires: ['canInput'],
				expectApp: expected,
				act,
			});

			await expect(refusal).rejects.toMatchObject({
				name: 'AppNotInForegroundError',
				foregroundApp: null,
				message: expect.stringContaining('did not say'),
			});
			expect(act).not.toHaveBeenCalled();
		});

		it('acts when the expected application is in front, checking it before resolving', async () => {
			const calls: string[] = [];
			const context = recordingContext(calls);

			await performAction(context, {
				verb: 'fake_tap',
				requires: ['canInput'],
				expectApp: expected,
				target: { by: 'text', text: 'Save' },
				act: tapAction(context),
			});

			expect(calls).toEqual([
				'deviceInfo',
				'readScreen',
				'deviceInfo',
				'tap',
				'readScreen',
				'deviceInfo',
			]);
		});

		it('consults the manifest before the foreground', async () => {
			const calls: string[] = [];
			const context = recordingContext(
				calls,
				[save],
				createMockCapabilities({ canInput: false }),
				elsewhere,
			);

			await expect(
				performAction(context, {
					verb: 'fake_tap',
					requires: ['canInput'],
					expectApp: expected,
					target: { by: 'text', text: 'Save' },
					act: vi.fn(async () => {}),
				}),
			).rejects.toThrow(MissingCapabilityError);
			expect(calls).toEqual([]);
		});
	});
});
