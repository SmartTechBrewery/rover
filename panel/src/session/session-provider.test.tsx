import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
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
 *
 * The last of those has a converse the tests below pin just as hard: **the panel never discards a
 * session id without the host's answer** (`docs/DESIGN.md` §8). A sign-out nothing answered ended
 * nothing, and an id kept by an unreachable boot probe is offered to the host before the next
 * sign-in overwrites it.
 *
 * A fourth property joined them with `Session.call`: a screen gets a *method* rather than the
 * credential, and the bounce on a `401` happens inside this module — so no screen can be written
 * that forgets it.
 */

const STORAGE_KEY = 'rover.panel.session';

const fetchMock = vi.fn();

function answered(status: number, body: unknown): Response {
	return { status, json: async () => body } as unknown as Response;
}

const IDENTITY = { identifier: 'panel', displayName: 'Panel' };

/** Every state as one readable string, so a test asserts on the machine and not on a render. */
function Probe() {
	const { state, signIn, signOut, onRefusal, call } = useSession();
	// What the last sign-out reported. `Profile` is the screen that has to say this out loud, and
	// the outcome is the only way it can (`session-provider.tsx`, `SignOutOutcome`).
	const [outcome, setOutcome] = useState('');
	// What the last `call` answered, in the same one-string style as the state above.
	const [answer, setAnswer] = useState('');

	return (
		<div>
			<span data-testid="state">
				{state.status === 'checking' ? `checking:${state.of}` : ''}
				{state.status === 'signed-out' ? `signed-out:${state.after}` : ''}
				{state.status === 'signed-in' ? `signed-in:${state.identity.displayName}` : ''}
				{state.status === 'refused' ? 'refused' : ''}
				{state.status === 'access-ended' ? 'access-ended' : ''}
			</span>
			<span data-testid="outcome">{outcome}</span>
			<span data-testid="answer">{answer}</span>
			<button onClick={() => void signIn('the-printed-token')} type="button">
				present
			</button>
			<button
				onClick={() => {
					void signOut().then(setOutcome);
				}}
				type="button"
			>
				end
			</button>
			<button onClick={onRefusal} type="button">
				bounce
			</button>
			<button
				onClick={() => {
					void call('list_devices', {}).then((given) =>
						setAnswer(given.ok ? `ok:${given.value.type}` : given.refusal),
					);
				}}
				type="button"
			>
				ask
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

function outcome(): string {
	return screen.getByTestId('outcome').textContent ?? '';
}

function answer(): string {
	return screen.getByTestId('answer').textContent ?? '';
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

	// A `DELETE` nothing answered ended nothing. Saying otherwise would be false *and* would throw
	// away the only id that can still end the session — `docs/DESIGN.md` §8's rule, and the reason
	// the browser holds a session id at all (`PROJECT.md` D30).
	it('stays signed in, and keeps the id, when a sign-out reaches nothing', async () => {
		fetchMock.mockResolvedValue(answered(200, { session: 'a-session-id', ...IDENTITY }));

		mount();
		press('present');
		await waitFor(() => expect(state()).toBe('signed-in:Panel'));

		fetchMock.mockReset();
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

		press('end');
		await waitFor(() => expect(outcome()).toBe('unreachable'));

		expect(state()).toBe('signed-in:Panel');
		expect(stored()).toBe('a-session-id');

		// And the retry the kept id exists for reaches the host with it.
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(answered(200, {}));

		press('end');
		await waitFor(() => expect(state()).toBe('signed-out:sign-out'));
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init.method).toBe('DELETE');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer a-session-id');
		expect(stored()).toBeNull();
	});

	// The other half, so the fix above cannot over-correct into never signing anybody out: a host
	// that will not take the id has already forgotten it, which is a finished sign-out.
	it('signs out on a 401, because a session the host forgot is already ended', async () => {
		fetchMock.mockResolvedValue(answered(200, { session: 'a-session-id', ...IDENTITY }));

		mount();
		press('present');
		await waitFor(() => expect(state()).toBe('signed-in:Panel'));

		fetchMock.mockReset();
		fetchMock.mockResolvedValue(answered(401, { error: { code: 'unauthenticated' } }));

		press('end');
		await waitFor(() => expect(state()).toBe('signed-out:sign-out'));

		expect(outcome()).toBe('ended');
		expect(stored()).toBeNull();
	});

	// The tail of "a boot probe that reaches nothing keeps the id": without this the host would
	// hold two live sessions for one person, and no browser could reach or end the older one.
	it('ends the id a kept session is replaced by, on the next sign-in', async () => {
		window.localStorage.setItem(STORAGE_KEY, 'a-kept-session');
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

		mount();
		await waitFor(() => expect(state()).toBe('signed-out:arrival'));

		fetchMock.mockReset();
		fetchMock.mockResolvedValue(answered(200, { session: 'a-new-session', ...IDENTITY }));

		press('present');
		await waitFor(() => expect(state()).toBe('signed-in:Panel'));

		expect(stored()).toBe('a-new-session');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		const [, minted] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(minted.method).toBe('POST');
		const [url, ended] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(url).toBe('/session');
		expect(ended.method).toBe('DELETE');
		expect((ended.headers as Record<string, string>).authorization).toBe('Bearer a-kept-session');
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

/**
 * The one way a screen reaches the host, and the reason it exists: the session id stays in a ref
 * here and a screen gets a method instead of a credential.
 */
describe('a call carrying the session', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	async function signedIn(): Promise<void> {
		fetchMock.mockResolvedValue(answered(200, { session: 'a-session-id', ...IDENTITY }));
		mount();
		press('present');
		await waitFor(() => expect(state()).toBe('signed-in:Panel'));
		fetchMock.mockReset();
	}

	it('presents the session in the header, and hands back the envelope unparsed', async () => {
		await signedIn();
		fetchMock.mockResolvedValue(
			answered(200, { protocolVersion: 1, id: '1', type: 'result', result: { anything: true } }),
		);

		press('ask');
		await waitFor(() => expect(answer()).toBe('ok:result'));

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/rpc');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer a-session-id');
		expect(JSON.parse(init.body as string).method).toBe('list_devices');
	});

	/*
	 * The bounce is performed here rather than at the call site, so a screen cannot be written that
	 * forgets it. One path to *access ended*, and it clears the same storage every other path does.
	 */
	it('bounces to access ended when the host refuses the session', async () => {
		await signedIn();
		fetchMock.mockResolvedValue(answered(401, { error: { code: 'unauthenticated' } }));

		press('ask');
		await waitFor(() => expect(state()).toBe('access-ended'));

		expect(answer()).toBe('refused');
		expect(stored()).toBeNull();
	});

	// An `error` envelope is a value, not a refusal: the two vocabularies are kept apart here and
	// each caller decides what an error means for the method it asked for (`host-client.ts`).
	it('hands an error envelope back as a value, and stays signed in', async () => {
		await signedIn();
		fetchMock.mockResolvedValue(
			answered(200, {
				protocolVersion: 1,
				id: '1',
				type: 'error',
				error: { code: 'internal_error', message: 'no' },
			}),
		);

		press('ask');
		await waitFor(() => expect(answer()).toBe('ok:error'));

		expect(state()).toBe('signed-in:Panel');
	});

	it('says nothing came back when nothing answered, and keeps the session', async () => {
		await signedIn();
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

		press('ask');
		await waitFor(() => expect(answer()).toBe('unanswered'));

		expect(state()).toBe('signed-in:Panel');
		expect(stored()).toBe('a-session-id');
	});

	// With no id held there is nothing to ask with, so nothing is asked: `unanswered` is the honest
	// answer, and no request reaches the host.
	it('asks nothing at all with no session held', async () => {
		mount();

		press('ask');
		await waitFor(() => expect(answer()).toBe('unanswered'));

		expect(fetchMock).not.toHaveBeenCalled();
	});
});
