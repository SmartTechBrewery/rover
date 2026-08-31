import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionProvider, useSession } from './session-provider.js';

/**
 * The session as a machine, driven through a mocked `fetch` against the host's real answers
 * (`src/daemon/http-listen.ts`): `200` and a small object, or the one `401`.
 *
 * Three properties are the point of the file. A reload does not ask for the token again. A `401` on
 * a live session lands on *access ended* and clears what the browser was holding. And a sign-out
 * reaches the host **before** the browser forgets, because the whole reason the panel holds a
 * session id rather than the token is that ending one is something the host does.
 */

const STORAGE_KEY = 'rover.panel.session';

const fetchMock = vi.fn();

function answered(status: number, body: unknown): Response {
	return { status, json: async () => body } as unknown as Response;
}

const IDENTITY = { identifier: 'panel', displayName: 'Panel' };

/** Every state as one readable string, so a test asserts on the machine and not on a render. */
function Probe() {
	const { state, signIn, signOut, onRefusal } = useSession();

	return (
		<div>
			<span data-testid="state">
				{state.status === 'checking' ? `checking:${state.of}` : ''}
				{state.status === 'signed-out' ? `signed-out:${state.after}` : ''}
				{state.status === 'signed-in' ? `signed-in:${state.identity.displayName}` : ''}
				{state.status === 'refused' ? 'refused' : ''}
				{state.status === 'access-ended' ? 'access-ended' : ''}
			</span>
			<button onClick={() => void signIn('the-printed-token')} type="button">
				present
			</button>
			<button onClick={() => void signOut()} type="button">
				end
			</button>
			<button onClick={onRefusal} type="button">
				bounce
			</button>
		</div>
	);
}

function mount() {
	return render(
		<SessionProvider>
			<Probe />
		</SessionProvider>,
	);
}

function state(): string {
	return screen.getByTestId('state').textContent ?? '';
}

function stored(): string | null {
	return window.localStorage.getItem(STORAGE_KEY);
}

function press(label: string): void {
	fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('the session provider', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('arrives signed out, and asks the host nothing, when nothing was stored', async () => {
		mount();

		expect(state()).toBe('signed-out:arrival');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('holds the session across a reload: the boot probe restores it', async () => {
		fetchMock.mockResolvedValue(answered(200, { session: 'a-session-id', ...IDENTITY }));

		const first = mount();
		press('present');
		await waitFor(() => expect(state()).toBe('signed-in:Panel'));
		expect(stored()).toBe('a-session-id');

		// The reload: a fresh mount, the same storage, and no token to present this time.
		first.unmount();
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(answered(200, IDENTITY));

		mount();
		await waitFor(() => expect(state()).toBe('signed-in:Panel'));

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/session');
		expect(init.method).toBe('GET');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer a-session-id');
	});

	// The token is what the operator issued and what the CLI uses. It is exchanged once and never
	// written down (PROJECT.md D30).
	it('stores the session id and never the token', async () => {
		fetchMock.mockResolvedValue(answered(200, { session: 'a-session-id', ...IDENTITY }));

		mount();
		press('present');
		await waitFor(() => expect(state()).toBe('signed-in:Panel'));

		expect(window.localStorage.length).toBe(1);
		expect(stored()).toBe('a-session-id');
		for (let index = 0; index < window.localStorage.length; index += 1) {
			const key = window.localStorage.key(index) as string;
			expect(window.localStorage.getItem(key)).not.toContain('the-printed-token');
		}
	});

	it('shows the pending half of checking while a token is in flight', async () => {
		let release: (value: Response) => void = () => undefined;
		fetchMock.mockReturnValue(
			new Promise<Response>((resolve) => {
				release = resolve;
			}),
		);

		mount();
		press('present');

		expect(state()).toBe('checking:token');

		release(answered(200, { session: 'a-session-id', ...IDENTITY }));
		await waitFor(() => expect(state()).toBe('signed-in:Panel'));
	});

	it('refuses a token the host would not take, and stores nothing', async () => {
		fetchMock.mockResolvedValue(answered(401, { error: { code: 'unauthenticated' } }));

		mount();
		press('present');

		await waitFor(() => expect(state()).toBe('refused'));
		expect(stored()).toBeNull();
	});

	// A host that never answered has said nothing about the credential, so the same one message
	// covers both — docs/DESIGN.md §8's uniform refusal.
	it('refuses the same way when nothing answered at all', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

		mount();
		press('present');

		await waitFor(() => expect(state()).toBe('refused'));
	});

	it('lands on access ended when a stored session is no longer accepted, and clears it', async () => {
		window.localStorage.setItem(STORAGE_KEY, 'a-revoked-session');
		fetchMock.mockResolvedValue(answered(401, { error: { code: 'unauthenticated' } }));

		mount();
		expect(state()).toBe('checking:boot');

		await waitFor(() => expect(state()).toBe('access-ended'));
		expect(stored()).toBeNull();
	});

	// An unreachable host is not evidence about the session, so the id survives it: a daemon
	// restarting must not sign someone out of a session it is about to accept again.
	it('keeps a stored session when the boot probe reaches nothing', async () => {
		window.localStorage.setItem(STORAGE_KEY, 'a-session-id');
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

		mount();

		await waitFor(() => expect(state()).toBe('signed-out:arrival'));
		expect(stored()).toBe('a-session-id');
	});

	it('bounces any later refusal to access ended, through one path', async () => {
		fetchMock.mockResolvedValue(answered(200, { session: 'a-session-id', ...IDENTITY }));

		mount();
		press('present');
		await waitFor(() => expect(state()).toBe('signed-in:Panel'));

		press('bounce');

		await waitFor(() => expect(state()).toBe('access-ended'));
		expect(stored()).toBeNull();
	});

	it('ends the session on the host before the browser forgets it', async () => {
		fetchMock.mockResolvedValue(answered(200, { session: 'a-session-id', ...IDENTITY }));

		mount();
		press('present');
		await waitFor(() => expect(state()).toBe('signed-in:Panel'));

		const seenWhileEnding: (string | null)[] = [];
		fetchMock.mockReset();
		fetchMock.mockImplementation(async () => {
			// What storage still holds at the moment the host is being told. A sign-out that
			// cleared first would be a `localStorage.removeItem` with a live credential behind it.
			seenWhileEnding.push(stored());
			return answered(200, {});
		});

		press('end');
		await waitFor(() => expect(state()).toBe('signed-out:sign-out'));

		expect(seenWhileEnding).toEqual(['a-session-id']);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/session');
		expect(init.method).toBe('DELETE');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer a-session-id');
		expect(stored()).toBeNull();
	});

	it('asks the host to end a session exactly once, however many times it is asked', async () => {
		fetchMock.mockResolvedValue(answered(200, { session: 'a-session-id', ...IDENTITY }));

		mount();
		press('present');
		await waitFor(() => expect(state()).toBe('signed-in:Panel'));

		fetchMock.mockReset();
		fetchMock.mockResolvedValue(answered(200, {}));

		press('end');
		press('end');
		await waitFor(() => expect(state()).toBe('signed-out:sign-out'));

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	// A refusal answering a request that outlived its session is not news for anyone reading the
	// screen, and must not overwrite what a deliberate sign-out just said.
	it('ignores a refusal that arrives once nothing is live', async () => {
		mount();

		press('bounce');

		expect(state()).toBe('signed-out:arrival');
	});
});
