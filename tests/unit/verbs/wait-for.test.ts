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
import {
	DeviceVanishedError,
	MissingCapabilityError,
	UnreadableScreenError,
	WaitTimeoutError,
} from '@/core/errors.js';
import { parseDeviceSerial, parseElementId } from '@/core/ids.js';
import { DEFAULT_POLL_INTERVAL_MS } from '@/core/wait.js';
import type { VerbContext } from '@/verbs/context.js';
import { AmbiguousTargetError } from '@/verbs/errors.js';
import { DEFAULT_WAIT_TIMEOUT_MS, waitFor, waitUntilGone } from '@/verbs/wait-for.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockDeviceInfo,
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
 *
 * A step may be an `Error` instead of a screen, and the read then throws it. That is how a
 * device that has no window to describe yet is scripted: the read failing is the whole
 * shape of that poll, and nothing it could return would stand in for it.
 */
function contextShowing(...screens: (ScreenElement[] | Error)[]): VerbContext {
	let call = 0;
	const readScreen = vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
		const screen = screens[Math.min(call, screens.length - 1)] ?? [];
		call += 1;
		if (screen instanceof Error) throw screen;
		return screen;
	});
	return createMockVerbContext({ backend: createMockDeviceBackend({ readScreen }) });
}

/**
 * The transient read #299 is about — a device that is up and has not drawn a window yet,
 * which is what reading right after an application starts looks like.
 *
 * A fresh instance per step, because each poll meets its own read failing.
 */
function unreadable(): UnreadableScreenError {
	return new UnreadableScreenError(
		parseDeviceSerial('test-serial-1'),
		'the screen reader had no window to dump',
	);
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

	/** An identifier target polls like any other screen target (#329). */
	it('waits for an element by the identifier it carries', async () => {
		const terms = createMockScreenElement({
			id: 'terms',
			text: null,
			identifier: 'com.example:id/terms',
		});
		const context = contextShowing([save], [save, terms]);

		const result = await waitFor(
			context,
			{ by: 'identifier', identifier: 'com.example:id/terms' },
			fakeClock(),
		);

		expect(reads(context)).toBe(3);
		expect(result.target?.element).toEqual(terms);
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

	/**
	 * #308: an element under the on-screen keyboard is not one a caller can touch yet, and a
	 * keyboard animating closed is a screen still moving — so it is polled through, exactly as
	 * a clipped element is, rather than ending the wait on poll one.
	 */
	it('keeps polling an element under the on-screen keyboard until the keyboard is gone', async () => {
		const field = createMockScreenElement({
			id: 'field',
			text: 'Search',
			bounds: { x: 10, y: 600, width: 100, height: 40 },
		});
		const context = contextShowing([field]);
		const info = createMockDeviceInfo();
		vi.mocked(context.backend.deviceInfo).mockResolvedValueOnce({
			...info,
			screen: {
				...info.screen,
				keyboard: { shown: true, bounds: { x: 0, y: 500, width: 360, height: 300 } },
			},
		});

		const result = await waitFor(context, { by: 'text', text: 'Search' }, fakeClock());

		expect(result.target?.element).toEqual(field);
		// Two polls — covered, then clear — and the after-state's own read.
		expect(reads(context)).toBe(3);
	});

	it('says the element was under the keyboard when it never comes out from under it', async () => {
		const field = createMockScreenElement({
			id: 'field',
			text: 'Search',
			bounds: { x: 10, y: 600, width: 100, height: 40 },
		});
		const context = contextShowing([field]);
		const info = createMockDeviceInfo();
		vi.mocked(context.backend.deviceInfo).mockResolvedValue({
			...info,
			screen: {
				...info.screen,
				keyboard: { shown: true, bounds: { x: 0, y: 500, width: 360, height: 300 } },
			},
		});

		const thrown = await waitFor(
			context,
			{ by: 'text', text: 'Search' },
			{ ...fakeClock(), timeoutMs: 500 },
		).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(WaitTimeoutError);
		expect((thrown as WaitTimeoutError).found).toContain(
			'matching but under the on-screen keyboard at 0,500 360×300',
		);
		expect((thrown as WaitTimeoutError).polls).toBeGreaterThan(1);
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

	/**
	 * The bug in #299: a read that found no window to describe is the screen not being ready
	 * yet, which is the one thing a wait exists to absorb — and it used to end the wait on
	 * poll one, so an agent had to retry a `wait_for` by hand after a cold app launch.
	 */
	it('keeps polling a screen the device could not read yet', async () => {
		const context = contextShowing(unreadable(), unreadable(), [save]);
		const clock = fakeClock();

		const result = await waitFor(context, { by: 'text', text: 'Save' }, clock);

		// Three polls plus the state after, and two gaps — the wait ran to the read that
		// worked instead of stopping at the first that did not.
		expect(reads(context)).toBe(4);
		expect(clock.asked).toEqual([DEFAULT_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS]);
		expect(result.target?.element).toEqual(save);
	});

	it('says the screen was never readable when it never becomes readable', async () => {
		const context = contextShowing(unreadable());

		const thrown = await waitFor(
			context,
			{ by: 'text', text: 'Save' },
			{ ...fakeClock(), timeoutMs: 1_000 },
		).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(WaitTimeoutError);
		const timeout = thrown as WaitTimeoutError;
		// Nothing is swallowed: the deadline still arrives, and the message says the screen
		// could not be read rather than that the element was not on it — which is the
		// difference between "the app never came up" and "look for a different label".
		expect(timeout.found).toContain('could not be read');
		expect(timeout.found).toContain('had no window to dump');
		expect(timeout.found).not.toContain('an empty screen');
		expect(timeout.message).toContain("text containing 'Save'");
		expect(timeout.polls).toBe(5);
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

	// The other half of that: the one read error the loop absorbs did not make it a
	// catch-all. A device that left the host is not a screen that is not ready yet.
	it('propagates a device that vanished rather than polling for it to come back', async () => {
		const context = contextShowing(new DeviceVanishedError(parseDeviceSerial('test-serial-1')));

		await expect(
			waitFor(context, { by: 'text', text: 'Save' }, fakeClock()),
		).rejects.toBeInstanceOf(DeviceVanishedError);
		expect(reads(context)).toBe(1);
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

	it('names the elements that blocked it, not whatever the screen read happened to list first', async () => {
		// More than `describeScreen`'s excerpt limit, with the blocker last: summarising the
		// whole screen would excerpt the rows in read order and never mention 'Loading…' at
		// all, which is a timeout that does not say what it timed out on.
		const rows = Array.from({ length: 20 }, (_, at) =>
			createMockScreenElement({ id: `row-${at}`, text: `Row ${at}` }),
		);
		const context = contextShowing([...rows, spinner]);

		const thrown = await waitUntilGone(
			context,
			{ by: 'text', text: 'Loading…' },
			{
				...fakeClock(),
				timeoutMs: 1_000,
			},
		).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(WaitTimeoutError);
		const timeout = thrown as WaitTimeoutError;
		expect(timeout.waitedFor).toBe("text containing 'Loading…' to go away");
		expect(timeout.found).toContain("'Loading…'");
		// The one match, and the size of the screen it is still on — not an excerpt of rows.
		expect(timeout.found).toContain('1 element');
		expect(timeout.found).toContain('still on a screen of 21');
		expect(timeout.found).not.toContain('Row 0');
	});

	it('cannot be asked about a text index, and does not read one as gone when a sibling goes', async () => {
		const rows = ['a', 'b', 'c'].map((id) => createMockScreenElement({ id, text: 'Row' }));
		// The first row leaves; the row index 2 named is still plainly on the screen. Slots
		// renumber, elements do not, which is why the field that names a slot is a type error
		// here rather than one this verb accepts and silently drops (`AbsenceTarget`).
		const context = contextShowing(rows, rows.slice(1));

		const thrown = await waitUntilGone(
			context,
			// @ts-expect-error — an indexed text target is not an AbsenceTarget.
			{ by: 'text', text: 'Row', index: 2 },
			{ ...fakeClock(), timeoutMs: 1_000 },
		).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(WaitTimeoutError);
		// Still waiting on the matches themselves, never on "is slot 2 empty".
		expect((thrown as WaitTimeoutError).found).toContain('2 elements');
	});

	it('resolves when no element carries the identifier any more', async () => {
		const banner = createMockScreenElement({ id: 'banner', identifier: 'com.example:id/banner' });
		const context = contextShowing([banner, save], [save]);

		const result = await waitUntilGone(
			context,
			{ by: 'identifier', identifier: 'com.example:id/banner' },
			fakeClock(),
		);

		expect(reads(context)).toBe(3);
		expect(result.after).toEqual({ kind: 'screen', elements: [save] });
	});

	it('treats two matching elements as still there twice, not as an ambiguous request', async () => {
		const twice = createMockScreenElement({ id: 'spinner-2', text: 'Loading…' });
		const context = contextShowing([spinner, twice], [save]);

		// Resolving would refuse to choose between them; nothing here needs one chosen.
		const result = await waitUntilGone(context, { by: 'text', text: 'Loading…' }, fakeClock());

		expect(result.target).toBeNull();
		expect(result.after).toEqual({ kind: 'screen', elements: [save] });
	});

	/**
	 * The false-gone bug this translation has to avoid: an unreadable screen is "cannot tell
	 * yet", never "the element has left". Reading it as absence would answer that a spinner
	 * had gone from a screen nobody could see.
	 */
	it('does not read a screen it could not read as the element being gone', async () => {
		const context = contextShowing(unreadable(), [spinner], [save]);
		const clock = fakeClock();

		const result = await waitUntilGone(context, { by: 'text', text: 'Loading…' }, clock);

		// Three polls plus the state after. Ending on the first read would have resolved
		// before the spinner was ever observed, let alone gone.
		expect(reads(context)).toBe(4);
		expect(clock.asked).toEqual([DEFAULT_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS]);
		expect(result.after).toEqual({ kind: 'screen', elements: [save] });
	});

	it('times out saying the screen was never readable, not that the element went', async () => {
		const context = contextShowing(unreadable());

		const thrown = await waitUntilGone(
			context,
			{ by: 'text', text: 'Loading…' },
			{ ...fakeClock(), timeoutMs: 1_000 },
		).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(WaitTimeoutError);
		const timeout = thrown as WaitTimeoutError;
		expect(timeout.waitedFor).toBe("text containing 'Loading…' to go away");
		expect(timeout.found).toContain('could not be read');
		expect(timeout.found).not.toContain('still on a screen of');
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
