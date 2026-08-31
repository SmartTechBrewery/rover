import { SessionProvider } from '@panel/session/session-provider.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same shape as `breadcrumb.test.tsx`: a `Link` is a plain anchor so the screen renders without a
// router instance. `createRoute` has to be here too, because this module builds one at import.
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
		select({ location: { pathname: '/profile' } }),
}));

import { ProfileScreen } from './profile.js';

const STORAGE_KEY = 'rover.panel.session';

const fetchMock = vi.fn();

function answered(status: number, body: unknown): Response {
	return { status, json: async () => body } as unknown as Response;
}

/** A signed-in panel: the id is in storage and the boot probe answers with who holds it. */
async function signedIn() {
	window.localStorage.setItem(STORAGE_KEY, 'a-session-id');
	fetchMock.mockResolvedValue(answered(200, { identifier: 'panel', displayName: 'Panel' }));

	const rendered = render(
		<SessionProvider>
			<ProfileScreen />
		</SessionProvider>,
	);
	await waitFor(() => expect(screen.getByText('Panel')).toBeDefined());
	return rendered;
}

describe('the Profile screen', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('says who you are signed in as', async () => {
		await signedIn();

		expect(screen.getByText('Display name')).toBeDefined();
		expect(screen.getByText('Panel')).toBeDefined();
		expect(screen.getByText('Identifier')).toBeDefined();
		expect(screen.getByText('panel')).toBeDefined();
	});

	// The whole point of holding a session rather than the token: signing out ends it on the host
	// (`PROJECT.md` D30), so it cannot be revived by anything that had already read storage.
	it('reaches the host to end the session, with the session id in the header', async () => {
		await signedIn();

		fetchMock.mockReset();
		fetchMock.mockResolvedValue(answered(200, {}));

		fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/session');
		expect(init.method).toBe('DELETE');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer a-session-id');
		expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
	});

	// A `DELETE` nothing answered ended nothing, so this screen may not announce a sign-out: it is
	// still signed in, the id is still the only thing that can end the session, and the control is
	// there to try again with (`docs/DESIGN.md` §8).
	it('says the host could not be reached, and stays signed in, when the sign-out reaches nothing', async () => {
		await signedIn();

		fetchMock.mockReset();
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

		fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

		await waitFor(() => expect(screen.getByText(/Nothing answered on the host/)).toBeDefined());
		// Still signed in, still holding the id, and the control is ready for the retry.
		expect(screen.getByText('Panel')).toBeDefined();
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe('a-session-id');
		const control = screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement;
		expect(control.disabled).toBe(false);
	});

	// §5 has no exception for progress, so the pending state is the disabled control with a changed
	// label — not a spinner.
	it('disables the control while the host is being told, with no spinner', async () => {
		await signedIn();

		let release: (value: Response) => void = () => undefined;
		fetchMock.mockReset();
		fetchMock.mockReturnValue(
			new Promise<Response>((resolve) => {
				release = resolve;
			}),
		);

		fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

		const pending = screen.getByRole('button', { name: 'Signing out…' }) as HTMLButtonElement;
		expect(pending.disabled).toBe(true);

		release(answered(200, {}));
		await waitFor(() => expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull());
	});

	// The panel authenticates and never administers (`docs/DESIGN.md` §8), and nothing here shows
	// the credential itself.
	it('carries one control, and nothing that administers a user', async () => {
		const { container } = await signedIn();

		expect(container.querySelectorAll('button')).toHaveLength(1);
		expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('a-session-id');
		for (const forbidden of [/revoke/i, /rotate/i, /issue/i, /role/i, /delete/i]) {
			expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
		}
	});
});
