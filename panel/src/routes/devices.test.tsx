import type { ListedDevice } from '@panel/devices/device-list.js';
import type { DeviceList, DeviceListState } from '@panel/devices/device-list-provider.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `breadcrumb.test.tsx`'s shape: a `Link` is a plain anchor so the screen renders without a router
// instance, and `createRoute` is here because this module builds one at import.
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

// The poll has its own suite (`device-list-provider.test.tsx`), which is what lets this one be
// about the mapping from a state to what is on the screen, one state per test.
const { list } = vi.hoisted(() => ({ list: { current: undefined as DeviceList | undefined } }));
vi.mock('@panel/devices/device-list-provider.js', () => ({
	useDeviceList: () => list.current,
}));

/*
 * The card's force-release control reads the session for the identity it attributes the call with
 * (#122, D28), so this screen cannot render without one. `answer` is what the host says to the one
 * request the panel makes — set per test, so each of the four answers can be shown reaching this
 * screen, or not reaching it.
 */
const { host } = vi.hoisted(() => ({
	host: {
		answer: undefined as unknown,
		refusal: undefined as 'refused' | 'unanswered' | undefined,
	},
}));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({
		state: {
			status: 'signed-in',
			identity: { identifier: 'karolina', displayName: 'Karolina Waldon' },
		},
		call: async () =>
			host.refusal === undefined
				? { ok: true, value: { type: 'result', result: host.answer } }
				: { ok: false, refusal: host.refusal },
	}),
}));

import { DevicesScreen } from './devices.js';

const LEASE: NonNullable<ListedDevice['heldBy']> = {
	serial: 'emulator-5554',
	owner: 'issue-113',
	project: 'rover',
	testName: 'the devices grid',
	grantedAt: '2026-08-31T14:02:41.219Z',
	expiresInMs: 542_318,
};

const HELD: ListedDevice = {
	serial: 'emulator-5554',
	platform: 'android',
	model: 'sdk_gphone64_arm64',
	osVersion: '16',
	state: 'ready',
	heldBy: LEASE,
};

const FREE: ListedDevice = {
	serial: '39041FDJH00A7X',
	platform: 'android',
	model: 'Pixel 7 Pro',
	osVersion: '14',
	state: 'ready',
	heldBy: null,
};

/**
 * Held, and reported `offline` by the host — a phone that lost its cable or its authorisation
 * mid-lease (#124). The lease is real and ends like any other; the device the lease was on is one
 * the host would still refuse `not-ready`, so nothing about it may read as free.
 */
const HELD_OFFLINE: ListedDevice = { ...HELD, state: 'offline' };

/** Attached and listed, holding no lease, and refused a lease by the host (#123). */
const UNAUTHORIZED: ListedDevice = {
	serial: 'emulator-5558',
	platform: 'android',
	model: null,
	osVersion: null,
	state: 'unauthorized',
	heldBy: null,
};

function showing(state: DeviceListState, refresh: () => void = () => undefined) {
	list.current = { state, refresh };
	return render(<DevicesScreen />);
}

function ready(devices: readonly ListedDevice[], stale = false): DeviceListState {
	return { status: 'ready', devices, stale, receivedAtMs: Date.now() };
}

/** The grid is the cards' one parent, so it is reached through a card rather than by class. */
function gridOf(container: HTMLElement): HTMLElement {
	return container.querySelector('article')?.parentElement as HTMLElement;
}

/**
 * The three numbers §4's column ceiling is made of, read back out of the grid's class list: the
 * track floor from its `minmax`, and the column count and card maximum from the `calc` its
 * `max-w-` carries. Reading them rather than restating them is what makes the assertion that
 * uses it about the rule and not about a string.
 *
 * The two shapes are written as regexes and never spelled out in prose here, because Tailwind
 * scans this file too: a class-shaped example in a comment is a candidate like any other, and a
 * placeholder inside one emits an unparseable declaration into the built stylesheet.
 */
function gridGeometry(grid: HTMLElement): { columns: number; cardMax: number; floor: number } {
	const track = /minmax\((\d+)px,1fr\)/.exec(grid.className);
	const cap = /max-w-\[calc\((\d+)\*(\d+)px\+/.exec(grid.className);
	if (track === null || cap === null) {
		throw new Error(`no track floor or grid maximum in '${grid.className}'`);
	}

	return { columns: Number(cap[1]), cardMax: Number(cap[2]), floor: Number(track[1]) };
}

/** The one line and the counter slot are the same shape in every state (`docs/DESIGN.md` §3). */
function describing(): HTMLElement {
	return screen.getByText('Monitoring attached physical and virtual devices.');
}

describe('before the host has answered', () => {
	it('says it is reading, with no spinner and no empty list', () => {
		const { container } = showing({ status: 'loading' });

		expect(screen.getByText("Reading the host's device list.")).toBeDefined();
		expect(screen.queryByText('No devices attached')).toBeNull();
		expect(container.querySelectorAll('article')).toHaveLength(0);
		expect(screen.queryByText(/held/)).toBeNull();
	});
});

describe('with devices attached', () => {
	it('renders one card per device, in a grid whose columns follow the content width', () => {
		const { container } = showing(ready([HELD, FREE]));

		expect(container.querySelectorAll('article')).toHaveLength(2);
		expect(gridOf(container).className).toContain(
			'grid-cols-[repeat(auto-fill,minmax(300px,1fr))]',
		);
		// A breakpoint reads the viewport, which includes the sidebar — the mistake §4 records as
		// the worst bug of the first four iterations, in a second form.
		expect(gridOf(container).className).not.toMatch(/\b(?:sm|md|lg|xl|2xl):grid-cols-/);
	});

	/*
	 * One device is one card in a three-column grid, not a banner (#126). `auto-fit` collapses the
	 * tracks it has no card for and stretches the survivor across the whole content width, where a
	 * card carrying a serial, a model, a state and a lease block stops reading as one of a set;
	 * `auto-fill` keeps them.
	 */
	it('gives a lone card one track rather than the whole content width', () => {
		const { container } = showing(ready([HELD]));

		expect(container.querySelectorAll('article')).toHaveLength(1);
		expect(gridOf(container).className).toContain('auto-fill');
		expect(gridOf(container).className).not.toContain('auto-fit');
	});

	/*
	 * **The ceiling is arithmetic, so the arithmetic is what is pinned** (#126) — jsdom lays nothing
	 * out, and a window width is not something this suite can vary anyway.
	 *
	 * A fourth track needs `4 × floor + 3 × gutter`; the grid's maximum is `3 × cardMax + 2 × gutter`.
	 * The gutter appears on both sides and a wider one only ever makes the fourth track harder to
	 * fit, so dropping it leaves the strictest form of the same question — `4 × floor ≥ 3 × cardMax`
	 * — and no window width at which a fourth column can be laid out. No breakpoint is involved in
	 * saying so. The numbers are read back out of the class list rather than repeated here, so
	 * raising the card maximum past what the floor can hold fails in this suite rather than in a
	 * browser on a 2560 px screen.
	 */
	it('leaves no room for a fourth column, however wide the window is', () => {
		const { columns, cardMax, floor } = gridGeometry(gridOf(showing(ready([HELD])).container));

		expect(columns).toBe(3);
		expect(columns * cardMax).toBeLessThanOrEqual((columns + 1) * floor);
		// And all three still fit inside that maximum, or the ceiling would quietly be two.
		expect(floor).toBeLessThanOrEqual(cardMax);
	});

	// Derived from the very array the cards come from, so agreeing is structural.
	it('counts held and free to match the cards', () => {
		showing(ready([HELD, FREE, { ...FREE, serial: 'R5CT10ABCDE' }]));

		expect(screen.getByText('1 held')).toBeDefined();
		expect(screen.getByText('2 free')).toBeDefined();
		expect(screen.queryByText(/not ready/)).toBeNull();
	});

	/*
	 * A device the host would refuse `not-ready` is not part of the free pool, and the badge must
	 * not claim it is. The three terms sum to the grid, so the counter still agrees with the cards.
	 */
	it('keeps a device the host cannot lease out of the free count', () => {
		showing(ready([HELD, FREE, UNAUTHORIZED]));

		expect(screen.getByText('1 held')).toBeDefined();
		expect(screen.getByText('1 free')).toBeDefined();
		expect(screen.getByText('1 not ready')).toBeDefined();
	});

	it('keeps the describing line every other state has', () => {
		showing(ready([HELD]));

		expect(describing()).toBeDefined();
	});
});

describe('with the host view not current', () => {
	/*
	 * D6: `stale` is about the host's view of the *hardware*. A lease is the daemon's own
	 * bookkeeping and has no view that could go stale, so the first attempt's blanked `--:--` threw
	 * away the one part of the screen still worth trusting.
	 */
	it('caveats the list once, and leaves every lease field exact', () => {
		showing(ready([HELD], true));

		expect(screen.getByText('HOST VIEW NOT CURRENT')).toBeDefined();
		expect(screen.getByText(/The lease details below are still accurate/)).toBeDefined();
		expect(screen.getByText('2026-08-31T14:02:41.219Z')).toBeDefined();
		expect(screen.getByText('issue-113')).toBeDefined();
		expect(screen.queryByText('--:--')).toBeNull();
	});

	it('quiets the grid as a set rather than rewriting the cards', () => {
		const { container } = showing(ready([HELD], true));

		const grid = container.querySelector('article')?.parentElement as HTMLElement;
		expect(grid.className).toContain('opacity-75');
		expect(screen.queryByText('UNCERTAIN')).toBeNull();
	});

	it('still counts the devices it is showing', () => {
		showing(ready([HELD, FREE], true));

		expect(screen.getByText('1 held')).toBeDefined();
		expect(screen.getByText('1 free')).toBeDefined();
	});
});

/*
 * **The criterion most worth pinning on this screen.** An empty list with `stale` set means *no
 * view*, not *no devices* — the two are visually identical and mean the opposite, so a person
 * reading "nothing is attached" walks to the machine and finds a phone in the socket (D6, §10).
 */
describe('the two empty states', () => {
	it('do not say the same thing', () => {
		showing(ready([]));
		const attached = document.body.textContent ?? '';

		showing(ready([], true));
		const noView = (document.body.textContent ?? '').slice(attached.length);

		expect(attached).toContain('No devices attached');
		expect(attached).not.toContain('HOST VIEW NOT CURRENT');
		expect(noView).toContain('HOST VIEW NOT CURRENT');
		expect(noView).not.toContain('No devices attached');
	});

	// `0 held · 0 free` would describe an empty pool, which is the claim the second one refuses.
	it('show no counter', () => {
		for (const state of [ready([]), ready([], true)]) {
			const { unmount } = showing(state);
			expect(screen.queryByText(/held$/)).toBeNull();
			expect(screen.queryByText(/free$/)).toBeNull();
			unmount();
		}
	});
});

describe('nothing attached', () => {
	// Normal, common and *finished* (D21): Rover never plugs in a phone, a person does.
	it('says what would change it, with no colour or ornament of alarm', () => {
		const { container } = showing(ready([]));

		expect(screen.getByText('No devices attached')).toBeDefined();
		expect(screen.getByText(/USB debugging enabled or start an emulator/)).toBeDefined();
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
		expect(container.textContent).not.toContain('standby');
	});
});

describe('a stale view with an empty list', () => {
	it('says the host cannot say, and that this is not the same as nothing attached', () => {
		const { container } = showing(ready([], true));

		expect(screen.getByText('HOST VIEW NOT CURRENT')).toBeDefined();
		expect(screen.getByText(/Rover cannot say what is attached/)).toBeDefined();
		expect(screen.getByText(/a phone may well be plugged in/)).toBeDefined();
		// Host state that resolves itself, and the poll is already asking: no control here.
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	// The banner exists to caveat a list; with no list there is nothing to caveat, so the whole
	// content area is the message, said once.
	it('is one block, not a banner over one', () => {
		showing(ready([], true));

		expect(screen.getAllByText('HOST VIEW NOT CURRENT')).toHaveLength(1);
		expect(screen.queryByText(/The lease details below are still accurate/)).toBeNull();
	});

	it('takes a different surface from nothing attached', () => {
		const { container: noView } = showing(ready([], true));
		const surfaceOfNoView = (noView.querySelector('section') as HTMLElement).className;

		const { container: attached } = showing(ready([]));
		const surfaceOfAttached = (attached.querySelector('section > div') as HTMLElement).className;

		expect(surfaceOfNoView).toContain('bg-surface-variant');
		expect(surfaceOfAttached).toContain('bg-surface-container-lowest');
	});
});

/**
 * The one operator action's three outcomes, above the grid (`docs/DESIGN.md` §7).
 *
 * **They must not collapse into one.** A lease that ended, a lease that had already ended on its
 * own and a device that is not on this host any more are three different pieces of news, and the
 * last two both mean "nothing was released" while meaning nothing else alike. Each is asserted on
 * its own words here for exactly that reason.
 */
describe('a force-release the host answered', () => {
	beforeEach(() => {
		host.answer = undefined;
		host.refusal = undefined;
	});

	/** Confirm on the first held card, and wait for the line the answer produced. */
	async function forceRelease(): Promise<void> {
		fireEvent.click(screen.getAllByRole('button', { name: 'Force release' })[0] as HTMLElement);
		const inDialog = screen.getAllByRole('button', { name: 'Force release' });
		fireEvent.click(inDialog[inDialog.length - 1] as HTMLElement);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	}

	/*
	 * The card becoming free *is* the outcome, so the poll is asked again rather than waited for —
	 * that is what makes it visible without a reload. The line names the lease that ended, which the
	 * card no longer shows once it is free.
	 */
	it('says the lease ended, and asks the poll for the card that is now free', async () => {
		host.answer = {
			outcome: 'released',
			heldBy: { ...LEASE, owner: 'issue-113', project: 'rover' },
		};
		const refresh = vi.fn();
		showing(ready([HELD, FREE]), refresh);

		await forceRelease();

		expect(screen.getByText(/The lease issue-113 held on/)).toBeDefined();
		expect(screen.getByText(/for rover has ended/)).toBeDefined();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	// News, not a failure: the lease ended on its own between the page loading and the click, and
	// the card is free either way.
	it('says a lease that had already ended was not one it ended', async () => {
		host.answer = { outcome: 'refused', reason: 'not-held' };
		const refresh = vi.fn();
		showing(ready([HELD]), refresh);

		await forceRelease();

		expect(screen.getByText(/had already ended on its own/)).toBeDefined();
		expect(screen.getByText(/nothing to release/)).toBeDefined();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	/*
	 * The one claim neither line may make on its own authority (#124). The daemon ends a held lease
	 * before it ever looks at the hardware, so both of these answers arrive for a device the host
	 * reports `offline` — and the host would refuse the next `acquire` on it `not-ready`, which is
	 * what the card and the *not ready* counter on this same screen say. The line stops at what
	 * really settled; `force-release-notice.test.tsx` pins it against the card's own words.
	 */
	it.each([
		['the lease ended', { outcome: 'released', heldBy: LEASE }],
		['the lease had already ended', { outcome: 'refused', reason: 'not-held' }],
	])('does not call a device the host would refuse free (%s)', async (_case, answer) => {
		host.answer = answer;
		showing(ready([HELD_OFFLINE]));

		await forceRelease();

		// The news itself is unchanged — only the availability clause is absent.
		expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDefined();
		expect(screen.queryByText(/is free/)).toBeNull();
	});

	/*
	 * The device is not on this host any more, so there is nothing to release *or to show* — which
	 * is why this line is above the grid and not on the card: by the time it is read, the card is
	 * gone. Two host-side reasons, one fact for the person reading it (D6, D18).
	 */
	it.each([
		['gone'],
		['not-attached'],
	])('says a device that is not here is not listed (%s)', async (reason) => {
		host.answer = { outcome: 'refused', reason };
		showing(ready([HELD]));

		await forceRelease();

		expect(screen.getByText(/no longer attached to this host/)).toBeDefined();
		expect(screen.getByText(/It is no longer listed/)).toBeDefined();
	});

	// The card it was about can leave the grid entirely, and the line explaining why must outlive
	// it — including when it was the only device on the host.
	it('keeps the line when the answer emptied the grid', async () => {
		host.answer = { outcome: 'refused', reason: 'gone' };
		const { rerender } = showing(ready([HELD]));
		await forceRelease();

		// The device really was the only one, so the poll it asked for comes back with nothing to
		// show. The line explaining why must not have been inside the grid it just emptied.
		list.current = { state: ready([]), refresh: () => undefined };
		rerender(<DevicesScreen />);

		expect(screen.getByText('No devices attached')).toBeDefined();
		expect(screen.getByText(/no longer attached to this host/)).toBeDefined();
	});

	// It stays until dismissed rather than until the next poll: a line the poll clears is a line the
	// operator may never have read, and this is the only place the panel says why nothing happened.
	it('stays until it is dismissed', async () => {
		host.answer = { outcome: 'refused', reason: 'not-held' };
		showing(ready([HELD]));
		await forceRelease();

		fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

		expect(screen.queryByText(/had already ended on its own/)).toBeNull();
	});

	// §5, once more: nothing here has gone wrong, and nothing here is red.
	it('says all of it in ordinary text, announced politely', async () => {
		host.answer = { outcome: 'refused', reason: 'gone' };
		const { container } = showing(ready([HELD]));

		await forceRelease();

		const said = screen.getByText(/no longer attached to this host/);
		expect(said.closest('[aria-live="polite"]')).not.toBeNull();
		expect(container.innerHTML).not.toContain('error');
	});

	/*
	 * The fourth case, which is not an outcome and never reaches this screen: nothing was released,
	 * so the dialog stays open with its own line and the grid says nothing at all (§8).
	 */
	it('says nothing above the grid for an ask that reached nothing', async () => {
		host.refusal = 'unanswered';
		const refresh = vi.fn();
		showing(ready([HELD]), refresh);

		fireEvent.click(screen.getAllByRole('button', { name: 'Force release' })[0] as HTMLElement);
		const inDialog = screen.getAllByRole('button', { name: 'Force release' });
		fireEvent.click(inDialog[inDialog.length - 1] as HTMLElement);

		await waitFor(() => expect(screen.getByText(/nothing was released/i)).toBeDefined());
		expect(screen.getByRole('dialog')).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
		expect(refresh).not.toHaveBeenCalled();
	});
});
