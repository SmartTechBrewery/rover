import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The host, one scripted answer per call. `useSession` is mocked rather than driven through the
 * real `SessionProvider` for `archive-levels.test.tsx`'s reason: what is in question here is what
 * this hook asks for, when, and how it folds the answer — the credential machinery has its own
 * suite.
 */
const { host } = vi.hoisted(() => ({ host: { call: vi.fn() } }));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({ call: host.call }),
}));

import { SEARCH_DEBOUNCE_MS, useArchiveSearch } from './archive-search.js';

function result(value: unknown) {
	return { ok: true as const, value: { type: 'result' as const, result: value } };
}

function searched(paths: readonly string[], truncated = false) {
	return result({
		outcome: 'searched',
		matches: paths.map((path) => ({ path: path.split('/'), kind: 'directory' })),
		truncated,
	});
}

/** The field and the state, as text — so what the card would draw is what is asserted. */
function SearchProbe() {
	const { text, setText, state } = useArchiveSearch();
	return (
		<>
			<input onChange={(event) => setText(event.target.value)} value={text} />
			<p>
				state: {state.status}
				{state.status === 'searched'
					? `:${state.matches.map((match) => match.path.join('/')).join(',')}${
							state.truncated ? ':truncated' : ''
						}`
					: ''}
			</p>
		</>
	);
}

function mount() {
	return render(<SearchProbe />);
}

/** One keystroke, or a paste — whatever the field's whole content becomes. */
function type(value: string): void {
	fireEvent.change(screen.getByRole('textbox'), { target: { value } });
}

/** Let the debounce fire and every pending promise settle. */
async function settle(afterMs = SEARCH_DEBOUNCE_MS): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(afterMs);
		await vi.advanceTimersByTimeAsync(0);
	});
}

function state(): string {
	return screen.getByText(/^state:/).textContent ?? '';
}

function textsAsked(): readonly string[] {
	return host.call.mock.calls.map((call) => (call[1] as { text: string }).text);
}

beforeEach(() => {
	host.call.mockReset();
	host.call.mockResolvedValue(searched([]));
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('what the field asks the host for', () => {
	// The criterion in one test: the panel must not issue a request per keystroke.
	it('issues one request for three characters typed inside the debounce window', async () => {
		mount();

		type('l');
		await settle(100);
		type('lo');
		await settle(100);
		type('log');
		await settle();

		expect(host.call).toHaveBeenCalledTimes(1);
		expect(host.call.mock.calls[0]?.[0]).toBe('search_archive');
		expect(host.call.mock.calls[0]?.[1]).toEqual({ text: 'log' });
	});

	it('asks again once the text settles on something else', async () => {
		mount();

		type('log');
		await settle();
		type('checkout');
		await settle();

		expect(textsAsked()).toEqual(['log', 'checkout']);
	});

	// Empty text is not a search of everything: it is the URL's own tree, and it costs nothing.
	it('issues nothing at all for an empty field', async () => {
		mount();

		await settle();

		expect(host.call).not.toHaveBeenCalled();
		expect(state()).toBe('state: idle');
	});

	it('returns to idle and issues nothing more when the field is cleared', async () => {
		mount();

		type('log');
		await settle();
		expect(host.call).toHaveBeenCalledTimes(1);

		type('');
		await settle();

		expect(host.call).toHaveBeenCalledTimes(1);
		expect(state()).toBe('state: idle');
	});

	// The text is never sent while it is in flight a second time: one request is out at a time,
	// because the debounce is what starts them and it is cleared on every change.
	it('says it is searching while the one request is out', async () => {
		host.call.mockReturnValue(new Promise(() => undefined));
		mount();

		type('log');
		await settle();

		expect(state()).toBe('state: searching');
		expect(host.call).toHaveBeenCalledTimes(1);
	});
});

describe('an answer to text nobody is asking about any more', () => {
	/*
	 * The one race this hook exists to lose safely: a slow answer for `log` arriving after a fast
	 * one for `login`. Rendering it would put a stale hit list under new text, which is a tree that
	 * disagrees with the field above it.
	 */
	it('is dropped rather than rendered', async () => {
		let answerFirst: ((value: unknown) => void) | undefined;
		host.call
			.mockImplementationOnce(async () => await new Promise((resolve) => (answerFirst = resolve)))
			.mockResolvedValue(searched(['checkout-app/login-flow']));
		mount();

		type('log');
		await settle();
		type('login');
		await settle();
		expect(state()).toBe('state: searched:checkout-app/login-flow');

		// `log`'s answer arrives late, naming something else entirely.
		await act(async () => {
			answerFirst?.(searched(['payments-web']));
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(state()).toBe('state: searched:checkout-app/login-flow');
	});

	/*
	 * And it is dropped **before the second request is even issued**, which is what moving the id
	 * with the text rather than with the timer buys: the change to `login` has no timer left to
	 * clear, so if `log`'s request were still the current one its answer would land under the new
	 * text for the whole of the debounce window.
	 */
	it('is dropped as soon as the text changes, not once its replacement goes out', async () => {
		let answerFirst: ((value: unknown) => void) | undefined;
		host.call
			.mockImplementationOnce(async () => await new Promise((resolve) => (answerFirst = resolve)))
			.mockResolvedValue(searched(['checkout-app/login-flow']));
		mount();

		type('log');
		await settle();
		expect(state()).toBe('state: searching');

		// The text moves on, and `login`'s own request is still inside its debounce window.
		type('login');
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS / 3);
			answerFirst?.(searched(['payments-web']));
			await vi.advanceTimersByTimeAsync(0);
		});

		// `log`'s hits never appear under `login`. The card stays on the previous state.
		expect(state()).toBe('state: searching');
		expect(host.call).toHaveBeenCalledTimes(1);

		await settle();
		expect(state()).toBe('state: searched:checkout-app/login-flow');
	});

	it('is dropped when the field was cleared while it was out', async () => {
		host.call.mockResolvedValue(searched(['checkout-app']));
		let answer: ((value: unknown) => void) | undefined;
		host.call.mockImplementationOnce(
			async () => await new Promise((resolve) => (answer = resolve)),
		);
		mount();

		type('log');
		await settle();
		type('');
		await settle();

		await act(async () => {
			answer?.(searched(['checkout-app']));
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(state()).toBe('state: idle');
	});
});

describe('what the host answered', () => {
	it('carries the matches and the truncation flag through', async () => {
		host.call.mockResolvedValue(searched(['checkout-app/login-flow'], true));
		mount();

		type('log');
		await settle();

		expect(state()).toBe('state: searched:checkout-app/login-flow:truncated');
	});

	// `matches: []` with `truncated: false` is *nothing matched*, and it is not a failure.
	it('reads an empty answer as nothing matched rather than as a failure', async () => {
		host.call.mockResolvedValue(searched([]));
		mount();

		type('log');
		await settle();

		expect(state()).toBe('state: searched:');
	});

	/*
	 * Nothing filed is nothing matched — the same fold `archive-levels.ts` makes at a level, and
	 * the reason *the host could not search the archive* is not said about an empty host.
	 */
	it('reads host `missing` as nothing matched', async () => {
		host.call.mockResolvedValue(result({ outcome: 'missing' }));
		mount();

		type('log');
		await settle();

		expect(state()).toBe('state: searched:');
	});

	// Everything unusable folds into one state, because what the card has to decide is narrower
	// than why — the fold `archive-levels.ts` documents.
	it('folds every unusable answer into failed', async () => {
		const unusable = [
			{ ok: true as const, value: { type: 'error' as const, error: { code: 'x', message: 'y' } } },
			result({ outcome: 'a new outcome' }),
			result({ outcome: 'searched', matches: [{ path: 'not-an-array' }], truncated: false }),
			{ ok: false as const, refusal: 'unanswered' as const },
			result({ outcome: 'unreadable' }),
		];

		for (const answer of unusable) {
			host.call.mockReset();
			host.call.mockResolvedValue(answer);
			const { unmount } = mount();

			type('log');
			await settle();

			expect(state()).toBe('state: failed');
			unmount();
		}
	});

	/*
	 * A `refused` sets nothing at all: `Session.call` has already fired `onRefusal` and the router
	 * is coming down, so *the host could not search the archive* would be the panel's last word
	 * being the wrong one.
	 */
	it('sets nothing at all for a refused session', async () => {
		host.call.mockResolvedValue({ ok: false, refusal: 'refused' });
		mount();

		type('log');
		await settle();

		expect(state()).toBe('state: searching');
	});
});
