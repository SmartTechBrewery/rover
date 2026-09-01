import { DevicesScreen } from '@panel/routes/devices.js';
import { SessionProvider } from '@panel/session/session-provider.js';
import { act, render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceListProvider, POLL_MS } from './device-list-provider.js';

/**
 * The Devices screen following the host, one poll at a time and with nothing touched (#125).
 *
 * **A separate file from `routes/devices.test.tsx` because that one mocks this provider away.** Its
 * whole design is a hand-written `DeviceListState` per test, which is the right shape for asserting
 * which state renders which content and the wrong shape for asserting that a *changing* answer
 * reaches the screen at all — the bug reported in #125 was invisible to both suites precisely
 * because neither ran a sequence through the real poll.
 *
 * So everything below the mocked router is real: the session, the poll, the screen, the cards and
 * the counter. The only thing scripted is what `/rpc` says, and the only thing that ever advances
 * is the clock.
 */

// `devices.test.tsx`'s router stand-in, verbatim: a `Link` is a plain anchor so the screen renders
// without a router instance, and `createRoute` is here because that module builds one at import.
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		children,
		...rest
	}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
	Outlet: () => null,
	createRoute: (options: unknown) => ({ options }),
	createRootRoute: (options: unknown) => ({ options }),
	useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
		select({ location: { pathname: '/devices' } }),
}));

const STORAGE_KEY = 'rover.panel.session';

const fetchMock = vi.fn();

function answered(status: number, body: unknown): Response {
	return { status, json: async () => body } as unknown as Response;
}

function envelope(devices: readonly unknown[], stale = false): Response {
	return answered(200, {
		protocolVersion: 1,
		id: '1',
		type: 'result',
		result: { devices, stale },
	});
}

function device(serial: string, state = 'ready'): unknown {
	return {
		serial,
		platform: 'android',
		model: 'sdk_gphone64_arm64',
		osVersion: '15',
		osApiLevel: 35,
		state,
		attachment: 'this-host',
		heldBy: null,
	};
}

/** `/rpc` answers these in order, one per poll, the last one repeating. */
function hostAnswers(...answers: readonly Response[]): void {
	window.localStorage.setItem(STORAGE_KEY, 'a-session-id');
	let next = 0;
	fetchMock.mockImplementation(async (path: string) => {
		if (path === '/session') {
			return answered(200, { identifier: 'panel', displayName: 'Panel' });
		}
		const answer = answers[Math.min(next, answers.length - 1)];
		next += 1;
		return answer;
	});
}

function mount() {
	return render(
		<SessionProvider>
			<DeviceListProvider>
				<DevicesScreen />
			</DeviceListProvider>
		</SessionProvider>,
	);
}

/** The first answer landing, without letting the interval fire. */
async function settle(): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
	});
}

/** One poll interval, and nothing else — no press, no reload, no `refresh()`. */
async function untouched(): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(POLL_MS);
	});
}

function counter(): string {
	// The three terms live in the page header's right-hand slot; the whole document is enough to
	// read them off, and reading them off the DOM is what makes "the counter followed" a claim
	// about the screen rather than about the array behind it.
	return document.body.textContent ?? '';
}

describe('the devices screen, live', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		window.localStorage.clear();
	});

	it('drops a detached device’s card within one poll', async () => {
		hostAnswers(
			envelope([device('emulator-5554'), device('emulator-5556')]),
			envelope([device('emulator-5554')]),
		);

		mount();
		await settle();
		expect(screen.getByText('emulator-5554')).toBeDefined();
		expect(screen.getByText('emulator-5556')).toBeDefined();
		expect(counter()).toContain('2 free');

		await untouched();

		expect(screen.getByText('emulator-5554')).toBeDefined();
		expect(screen.queryByText('emulator-5556')).toBeNull();
		expect(counter()).toContain('1 free');
	});

	it('adds an attached device’s card within one poll', async () => {
		hostAnswers(
			envelope([device('emulator-5554')]),
			envelope([device('emulator-5554'), device('emulator-5556')]),
		);

		mount();
		await settle();
		expect(screen.queryByText('emulator-5556')).toBeNull();

		await untouched();

		expect(screen.getByText('emulator-5556')).toBeDefined();
		expect(counter()).toContain('2 free');
	});

	/*
	 * A state change is not a card leaving and another arriving: the same serial stays on screen and
	 * says something different. The counter has to follow it in both directions, and its `not ready`
	 * term is present only while there is one to report.
	 */
	it('follows a device’s state changing and changing back', async () => {
		hostAnswers(
			envelope([device('emulator-5554'), device('emulator-5556')]),
			envelope([device('emulator-5554'), device('emulator-5556', 'unauthorized')]),
			envelope([device('emulator-5554'), device('emulator-5556')]),
		);

		mount();
		await settle();
		expect(counter()).toContain('2 free');
		expect(counter()).not.toContain('not ready');

		await untouched();

		expect(screen.getByText('emulator-5556')).toBeDefined();
		expect(screen.getByText('unauthorized')).toBeDefined();
		expect(counter()).toContain('1 free');
		expect(counter()).toContain('1 not ready');

		await untouched();

		expect(screen.queryByText('unauthorized')).toBeNull();
		expect(counter()).toContain('2 free');
		expect(counter()).not.toContain('not ready');
	});

	/*
	 * The screen's other states, reached the same way — by a poll landing rather than by a state
	 * handed to the screen. None of them may be reached by a change that merely stopped the poll,
	 * which is what asserting them *after* an interval is for (`docs/DESIGN.md` §7).
	 */
	it('reaches “No devices attached” when the last device leaves, not “No view”', async () => {
		hostAnswers(envelope([device('emulator-5554')]), envelope([]));

		mount();
		await settle();
		await untouched();

		expect(screen.getByText('No devices attached')).toBeDefined();
		expect(screen.queryByText('HOST VIEW NOT CURRENT')).toBeNull();
	});

	it('raises the banner over the grid when the host’s view goes stale', async () => {
		hostAnswers(envelope([device('emulator-5554')]), envelope([device('emulator-5554')], true));

		mount();
		await settle();
		expect(screen.queryByText('HOST VIEW NOT CURRENT')).toBeNull();

		await untouched();

		expect(screen.getByText('HOST VIEW NOT CURRENT')).toBeDefined();
		expect(screen.getByText('emulator-5554')).toBeDefined();
		expect(screen.queryByText('No devices attached')).toBeNull();
	});

	it('says “No view” for an empty stale list, and never “No devices attached”', async () => {
		hostAnswers(envelope([device('emulator-5554')]), envelope([], true));

		mount();
		await settle();
		await untouched();

		expect(screen.getByText('HOST VIEW NOT CURRENT')).toBeDefined();
		expect(screen.queryByText('No devices attached')).toBeNull();
	});
});
