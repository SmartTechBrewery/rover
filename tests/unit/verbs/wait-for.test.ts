/**
 * The two screen waits (D12(b) meeting D12(a) and D12(c)).
 *
 * The headline assertion is the second one: **every poll reads the screen again.** A wait
 * that re-checks a list it read once is the stale-coordinate failure with a timer attached,
 * and it passes every test that only looks at the value it returned — so these count reads.
 *
 * **Not one test here waits on a duration.** The clock is a counter the fake poll gap moves
 * by exactly what was asked for, so a timeout arrives at its deadline rather than after a
 * real five seconds.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeviceBackend, ScreenElement } from '@/core/device.js';
import { MissingCapabilityError, WaitTimeoutError } from '@/core/errors.js';
import { parseElementId } from '@/core/ids.js';
import { DEFAULT_POLL_INTERVAL_MS } from '@/core/wait.js';
import type { VerbContext } from '@/verbs/context.js';
import { AmbiguousTargetError } from '@/verbs/errors.js';
import { DEFAULT_WAIT_TIMEOUT_MS, waitFor, waitUntilGone } from '@/verbs/wait-for.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

const save = createMockScreenElement({ id: 'save', text: 'Save' });
const spinner = createMockScreenElement({
	id: 'spinner',
	text: 'Loading…',
	bounds: { x: 200, y: 20, width: 100, height: 40 },
});

/**
 * Time as a counter the poll gap advances, so a wait ends at its deadline and not after a
 * real duration. `asked` is what the wait asked to sleep between checks — the assertion
 * that an already-true condition costs no gap at all.
 */
function fakeClock(startMs = 1_000) {
	let current = startMs;
	const asked: number[] = [];
	return {
		asked,
		now: () => current,
		delay: async (ms: number): Promise<void> => {
			asked.push(ms);
			current += ms;
		},
	};
}

/**
 * A context whose screen read answers each of `screens` in turn, then repeats the last —
 * the scripted device these tests are about.
 */
function contextShowing(...screens: ScreenElement[][]): VerbContext {
	let call = 0;
	const readScreen = vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
		const screen = screens[Math.min(call, screens.length - 1)] ?? [];
		call += 1;
		return screen;
	});
	return createMockVerbContext({ backend: createMockDeviceBackend({ readScreen }) });
}

/** How many times the device was asked what is on its screen. */
function reads(context: VerbContext): number {
	return vi.mocked(context.backend.readScreen as NonNullable<DeviceBackend['readScreen']>).mock
		.calls.length;
}

describe('waitFor', () => {
	it('answers from one read, with no gap at all, when the target is already there', async () => {
		const context = contextShowing([save]);
		const clock = fakeClock();

		const result = await waitFor(context, { by: 'text', text: 'Save' }, clock);

		expect(clock.asked).toEqual([]);
		// Two reads: the poll that found it, and the state after — never one read serving as
		// both, which would report a screen from before the wait ended.
		expect(reads(context)).toBe(2);
		expect(result.target).toEqual({ source: 'screen', point: { x: 60, y: 40 }, element: save });
	});

	it('reads the screen again on every poll, which is the whole point of the verb', async () => {
		const context = contextShowing([], [spinner], [spinner, save]);
		const clock = fakeClock();

		const result = await waitFor(context, { by: 'text', text: 'Save' }, clock);

		// Three polls plus the state after. A cached read would have answered `not found`
		// forever from the first empty screen.
		expect(reads(context)).toBe(4);
		expect(clock.asked).toEqual([DEFAULT_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS]);
		expect(result.target?.element).toEqual(save);
	});

	it('answers with the same ActionResult every other action does (D12(c), D14)', async () => {
		const context = contextShowing([save, spinner]);

		const result = await waitFor(context, { by: 'text', text: 'Save' }, fakeClock());

		expect(result.verb).toBe('wait_for');
		expect(result.device.serial).toBe('test-serial-1');
		expect(result.device.screen.density).toBe(480);
		expect(result.after).toEqual({ kind: 'screen', elements: [save, spinner] });
	});

	it('times out naming what it waited for and what was on screen instead', async () => {
		const context = contextShowing([spinner]);
		const clock = fakeClock();

		const thrown = await waitFor(
			context,
			{ by: 'text', text: 'Save' },
			{
				...clock,
				timeoutMs: 1_000,
			},
		).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(WaitTimeoutError);
		const timeout = thrown as WaitTimeoutError;
		expect(timeout.waitedFor).toBe("text containing 'Save'");
		expect(timeout.found).toContain("'Loading…'");
		expect(timeout.message).toContain("text containing 'Save'");
		expect(timeout.message).toContain("'Loading…'");
		// Five checks 250ms apart is the deadline, exactly — not a poll interval past it.
		expect(timeout.polls).toBe(5);
		expect(clock.asked).toEqual([250, 250, 250, 250]);
	});

	it('uses its own documented default timeout when the caller does not name one', async () => {
		const context = contextShowing([]);

		const thrown = await waitFor(context, { by: 'text', text: 'Save' }, fakeClock()).catch(
			(error: unknown) => error,
		);

		expect((thrown as WaitTimeoutError).timeoutMs).toBe(DEFAULT_WAIT_TIMEOUT_MS);
	});

	it('keeps polling an element that is on screen but not yet somewhere it can be acted on', async () => {
		// The captured inverted bounds from PROJECT.md §6 — a row still clipped out of its
		// scrolling container, which one more poll resolves.
		const clipped = createMockScreenElement({
			id: 'save',
			text: 'Save',
			bounds: { x: 96, y: 2798, width: 303, height: -14 },
		});
		const context = contextShowing([clipped], [save]);

		const result = await waitFor(context, { by: 'text', text: 'Save' }, fakeClock());

		expect(result.target?.element).toEqual(save);
	});

	it('says the element was there but unreachable when it never becomes addressable', async () => {
		const clipped = createMockScreenElement({
			id: 'save',
			text: 'Save',
			bounds: { x: 96, y: 2798, width: 303, height: -14 },
		});
		const context = contextShowing([clipped]);

		const thrown = await waitFor(
			context,
			{ by: 'text', text: 'Save' },
			{
				...fakeClock(),
				timeoutMs: 500,
			},
		).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(WaitTimeoutError);
		expect((thrown as WaitTimeoutError).found).toContain('clipped out of view');
	});

	it('refuses an ambiguous target rather than polling until it times out', async () => {
		const context = contextShowing([save, createMockScreenElement({ id: 'save-2', text: 'Save' })]);

		// More polling cannot specify an under-specified request, so this is not a "not yet".
		await expect(
			waitFor(context, { by: 'text', text: 'Save' }, fakeClock()),
		).rejects.toBeInstanceOf(AmbiguousTargetError);
	});

	it('propagates a screen read that failed instead of counting it as "not yet"', async () => {
		const context = createMockVerbContext({
			backend: createMockDeviceBackend({
				readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
					throw new Error('device offline');
				}),
			}),
		});

		// A device that broke is not a screen without the element on it, and reporting it as a
		// timeout would tell the agent to wait longer for a device that is not answering.
		await expect(waitFor(context, { by: 'text', text: 'Save' }, fakeClock())).rejects.toThrow(
			'device offline',
		);
	});

	it('fails by name on a backend that cannot read the screen, without polling it once', async () => {
		const context = contextShowing([save]);
		const screenless = createMockVerbContext({
			backend: context.backend,
			manifest: createMockCapabilityManifest({
				capabilities: createMockCapabilities({ canReadScreen: false }),
			}),
		});

		await expect(
			waitFor(screenless, { by: 'text', text: 'Save' }, fakeClock()),
		).rejects.toBeInstanceOf(MissingCapabilityError);
		expect(reads(context)).toBe(0);
	});
});

describe('waitUntilGone', () => {
	it('resolves when the element leaves a freshly read screen', async () => {
		const context = contextShowing([spinner, save], [spinner, save], [save]);
		const clock = fakeClock();

		const result = await waitUntilGone(context, { by: 'text', text: 'Loading…' }, clock);

		// "Gone" is absent from a read taken now, not absent from the read we already had.
		expect(reads(context)).toBe(4);
		expect(clock.asked).toEqual([DEFAULT_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS]);
		expect(result.verb).toBe('wait_until_gone');
		// Nothing left to name: what was waited for is an absence.
		expect(result.target).toBeNull();
		expect(result.after).toEqual({ kind: 'screen', elements: [save] });
	});

	it('times out while the element is still there, and says which screen it was still on', async () => {
		const context = contextShowing([spinner, save]);

		const thrown = await waitUntilGone(
			context,
			{ by: 'text', text: 'Loading…' },
			{
				...fakeClock(),
				timeoutMs: 1_000,
			},
		).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(WaitTimeoutError);
		expect((thrown as WaitTimeoutError).waitedFor).toBe("text containing 'Loading…' to go away");
		expect((thrown as WaitTimeoutError).found).toContain("'Loading…'");
	});

	it('treats two matching elements as still there twice, not as an ambiguous request', async () => {
		const twice = createMockScreenElement({ id: 'spinner-2', text: 'Loading…' });
		const context = contextShowing([spinner, twice], [save]);

		// Resolving would refuse to choose between them; nothing here needs one chosen.
		const result = await waitUntilGone(context, { by: 'text', text: 'Loading…' }, fakeClock());

		expect(result.target).toBeNull();
		expect(result.after).toEqual({ kind: 'screen', elements: [save] });
	});

	it('fails by name on a backend that cannot read the screen, without polling it once', async () => {
		const context = contextShowing([spinner]);
		const screenless = createMockVerbContext({
			backend: context.backend,
			manifest: createMockCapabilityManifest({
				capabilities: createMockCapabilities({ canReadScreen: false }),
			}),
		});

		await expect(
			waitUntilGone(screenless, { by: 'element', id: parseElementId('spinner') }, fakeClock()),
		).rejects.toBeInstanceOf(MissingCapabilityError);
		expect(reads(context)).toBe(0);
	});
});
