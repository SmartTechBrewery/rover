import { render, screen, waitFor } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate, and only the gate: which of the router and the sign-in screen is mounted.
 *
 * **This is the file the "no credential in a URL" claim rests on.** `docs/DESIGN.md` §8 and
 * `PROJECT.md` D30 both argue it structurally rather than carefully — the sign-in screen is not a
 * route, so there is no address a token could be attached to, no `?next=` to record and nothing to
 * redirect back to. Every other part of that argument is pinned somewhere (`sign-in.test.tsx` has
 * the POST form and the unnamed field, `session-storage.test.tsx` the one key, `host-client.ts`'s
 * tests the header-not-cookie credential); the branch that makes it *true* is here. Without this
 * file, mounting `RouterProvider` unconditionally, or dropping the boot arm so the form flashes
 * during the probe, would ship green.
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
		fetchMock.mockResolvedValue(answered(200, { identifier: 'panel', displayName: 'Panel' }));

		const { container } = render(<App />);

		await waitFor(() => expect(router()).not.toBeNull());
		expect(tokenField()).toBeNull();
		expect(container.querySelectorAll('input')).toHaveLength(0);
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
