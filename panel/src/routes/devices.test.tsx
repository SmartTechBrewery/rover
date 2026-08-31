import type { ListedDevice } from '@panel/devices/device-list.js';
import type { DeviceList, DeviceListState } from '@panel/devices/device-list-provider.js';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

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
	heldBy: LEASE,
};

const FREE: ListedDevice = {
	serial: '39041FDJH00A7X',
	platform: 'android',
	model: 'Pixel 7 Pro',
	osVersion: '14',
	heldBy: null,
};

function showing(state: DeviceListState) {
	list.current = { state, refresh: () => undefined };
	return render(<DevicesScreen />);
}

function ready(devices: readonly ListedDevice[], stale = false): DeviceListState {
	return { status: 'ready', devices, stale, receivedAtMs: Date.now() };
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
		const grid = container.querySelector('article')?.parentElement as HTMLElement;
		expect(grid.className).toContain('grid-cols-[repeat(auto-fit,minmax(300px,1fr))]');
		expect(grid.className).not.toMatch(/\bmd:grid-cols-/);
	});

	// Derived from the very array the cards come from, so agreeing is structural.
	it('counts held and free to match the cards', () => {
		showing(ready([HELD, FREE, { ...FREE, serial: 'R5CT10ABCDE' }]));

		expect(screen.getByText('1 held')).toBeDefined();
		expect(screen.getByText('2 free')).toBeDefined();
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
 * reading "nothing is attached" walks to the machine and finds a phone in the socket (D6, §9).
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
