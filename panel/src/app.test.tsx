import { render, screen, waitFor } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate, and only the gate: which of the router, the sign-in screen and the host-unreachable page
 * is mounted.
 *
 * **This is the file the "no credential in a URL" claim rests on.** `docs/DESIGN.md` §8 and
 * `PROJECT.md` D30 both argue it structurally rather than carefully — the sign-in screen is not a
 * route, so there is no address a token could be attached to, no `?next=` to record and nothing to
 * redirect back to. Every other part of that argument is pinned somewhere (`sign-in.test.tsx` has
 * the POST form and the unnamed field, `session-storage.test.tsx` the one key, `host-client.ts`'s
 * tests the header-not-cookie credential); the branch that makes it *true* is here. Without this
 * file, mounting `RouterProvider` unconditionally, or dropping the boot arm so the form flashes
 * during the probe, would ship green.
 *
 * **The second gate is here for the same kind of reason.** `docs/DESIGN.md` §7 says the sidebar, the
 * navigation and the breadcrumb are *gone, not dimmed* when the host cannot be reached — and a route
 * component cannot remove the shell its parent route renders. Swapping the router for that page is
 * what makes the rule literally true, so this is where it is asserted.
 */

// The router is stubbed to a marker, because what is asserted here is *whether* it is mounted and
// never what it renders. `createRootRoute` has to answer `addChildren`, since `route-tree.ts`
// builds the tree at import time — and the rest of the surface is here because the route modules
// and the shell import it as they load.
vi.mock('@tanstack/react-router', () => ({
	createRouter: (options: unknown) => ({ options }),
	RouterProvider: () => <div data-testid="router" />,
	createRootRoute: (options: unknown) => ({ options, addChildren: () => ({ options }) }),
	createRoute: (options: unknown) => ({ options }),
	Navigate: () => null,
	Outlet: () => null,
	Link: ({
		to,
		children,
		...rest
	}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
	useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
		select({ location: { pathname: '/' } }),
}));

import { App } from './app.js';

const STORAGE_KEY = 'rover.panel.session';

const fetchMock = vi.fn();

function answered(status: number, body: unknown): Response {
	return { status, json: async () => body } as unknown as Response;
}

const IDENTITY = { identifier: 'panel', displayName: 'Panel' };

/**
 * A host that accepts the stored session and answers `list_devices` however the test says.
 *
 * Path-aware on purpose: with one answer for both routes, an `/rpc` reply that is not an envelope
 * would put the panel on the unreachable page and every assertion about the router below would be
 * about the wrong thing.
 */
function hostAnswers(rpc: Response | Error): void {
	fetchMock.mockImplementation(async (path: string) => {
		if (path === '/session') {
			return answered(200, IDENTITY);
		}
		if (rpc instanceof Error) {
			throw rpc;
		}
		return rpc;
	});
}

function devices(list: unknown[]): Response {
	return answered(200, {
		protocolVersion: 1,
		id: '1',
		type: 'result',
		result: { devices: list, stale: false },
	});
}

function router(): HTMLElement | null {
	return screen.queryByTestId('router');
}

function tokenField(): HTMLElement | null {
	return screen.queryByLabelText('Access token');
}

describe('the panel gate', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('renders the sign-in screen and no router when nothing was stored', () => {
		render(<App />);

		expect(tokenField()).not.toBeNull();
		expect(router()).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// The boot probe is the one state with no form: a field that appeared and then vanished would
	// invite a paste into an input about to be replaced (`docs/DESIGN.md` §8).
	it('renders the boot probe, and no form, while a stored id is being checked', () => {
		window.localStorage.setItem(STORAGE_KEY, 'a-session-id');
		fetchMock.mockReturnValue(new Promise<Response>(() => undefined));

		render(<App />);

		expect(screen.getByText(/Checking the session this browser was holding/)).toBeDefined();
		expect(tokenField()).toBeNull();
		expect(router()).toBeNull();
	});

	it('renders the router, and nothing that takes a credential, once the probe answers', async () => {
		window.localStorage.setItem(STORAGE_KEY, 'a-session-id');
		hostAnswers(devices([]));

		const { container } = render(<App />);

		await waitFor(() => expect(router()).not.toBeNull());
		await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === '/rpc')).toBe(true));
		expect(router()).not.toBeNull();
		expect(tokenField()).toBeNull();
		expect(container.querySelectorAll('input')).toHaveLength(0);
	});

	// A poll that has not answered yet leaves the router where it is. A page that blinked out on
	// every slow first request would be worse than the state it was reporting.
	it('keeps the router while the first device poll is still out', async () => {
		window.localStorage.setItem(STORAGE_KEY, 'a-session-id');
		fetchMock.mockImplementation(async (path: string) => {
			if (path === '/session') {
				return answered(200, IDENTITY);
			}
			return await new Promise<Response>(() => undefined);
		});

		render(<App />);

		await waitFor(() => expect(router()).not.toBeNull());
		expect(screen.queryByText('HOST UNREACHABLE')).toBeNull();
	});

	/*
	 * `docs/DESIGN.md` §7: a state that leaves the navigation nothing to reach is the whole page.
	 * The router is not dimmed behind the message — it is not mounted, so no nav link is left in the
	 * DOM or in the tab order behind an opaque layer.
	 */
	it('replaces the router entirely when the host stops answering', async () => {
		window.localStorage.setItem(STORAGE_KEY, 'a-session-id');
		hostAnswers(new TypeError('Failed to fetch'));

		render(<App />);

		await waitFor(() => expect(screen.getByText('HOST UNREACHABLE')).toBeDefined());
		expect(router()).toBeNull();
		expect(tokenField()).toBeNull();
	});

	// A stored id the host refuses is *access ended*, which is a state of the same screen and still
	// not a route — so the router must not appear on the way through it.
	it('keeps the router unmounted when the host refuses the stored id', async () => {
		window.localStorage.setItem(STORAGE_KEY, 'a-revoked-session');
		fetchMock.mockResolvedValue(answered(401, { error: { code: 'unauthenticated' } }));

		render(<App />);

		await waitFor(() => expect(screen.getByText('Access ended')).toBeDefined());
		expect(router()).toBeNull();
		expect(tokenField()).not.toBeNull();
	});
});
