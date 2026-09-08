import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The host, scripted per call. `useSession` is mocked rather than driven through the real
 * `SessionProvider` for `archive-levels.test.tsx`'s reason: what is in question here is what this
 * hook asks for, and what it draws from the answer.
 */
const { host } = vi.hoisted(() => ({
	host: {
		call: vi.fn(),
		state: {
			status: 'signed-in',
			identity: { identifier: 'karolina', displayName: 'Karolina' },
		} as unknown,
	},
}));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({ state: host.state, call: host.call }),
}));

import { type PinState, type TestPath, testKeyOf, usePinnedTests } from './pinned-tests.js';

/**
 * The key one `Keep` tick is held under, and the hook that holds the host's answer to it.
 *
 * That the two cards share one flag is asserted where both are on one screen
 * (`routes/archive.test.tsx`); the wire itself is asserted against the two-project fixture
 * (`kept-tests.test.ts`). What this file pins is the identity and the traffic — one read per mount,
 * one write per press however many tests it stood over, and nothing drawn from an answer the panel
 * did not get.
 */
describe('the key a pinned test is held under', () => {
	/*
	 * **`project` is in the key because a test name is not an identity.** The archive's top level
	 * partitions exactly so two projects may reuse one name (`PROJECT.md` §10), and a key that
	 * dropped it would tick `login-flow` in every project at once — invisible until somebody had two.
	 */
	it('tells one project’s test from another’s of the same name', () => {
		expect(testKeyOf(['checkout-app', 'login-flow'])).not.toBe(
			testKeyOf(['payments-web', 'login-flow']),
		);
	});

	it('is the same key for the same test, whichever card asked', () => {
		expect(testKeyOf(['checkout-app', 'login-flow'])).toBe(
			testKeyOf(['checkout-app', 'login-flow']),
		);
	});

	/*
	 * **The join cannot be forged out of the components.** `keyOf` joins on NUL, which is one of the
	 * two characters an archive path component may not contain, so no pair of names can collide with
	 * a different pair. A `/` join would have: `['a/b', 'c']` and `['a', 'b/c']` are different tests
	 * and would have been one key.
	 */
	it('cannot be collided by a name that contains a separator', () => {
		expect(testKeyOf(['a/b', 'c'])).not.toBe(testKeyOf(['a', 'b/c']));
		expect(testKeyOf(['a', 'login-flow'])).not.toBe(testKeyOf(['a-login', 'flow']));
	});
});

const LOGIN: TestPath = ['checkout-app', 'login-flow'];
const BASKET: TestPath = ['checkout-app', 'basket'];
/** The group's two tests, as a group's tick stands over them. */
const BOTH: readonly TestPath[] = [LOGIN, BASKET];

function ref(test: TestPath) {
	return { project: test[0], testName: test[1] };
}

function result(value: unknown) {
	return { ok: true as const, value: { type: 'result' as const, result: value } };
}

/** `list_kept_tests` answers this set, and every press answers it too unless a case says otherwise. */
function keeping(...tests: readonly TestPath[]) {
	return result({ outcome: 'listed', tests: tests.map(ref) });
}

function written(...tests: readonly TestPath[]) {
	return result({ outcome: 'set', tests: tests.map(ref) });
}

/** What one state is, as one word — including the state that is *no control at all*. */
function drawn(state: PinState | null): string {
	if (state === null) {
		return 'no-control';
	}
	if (state.mixed === true) {
		return 'mixed';
	}
	return state.checked ? 'kept' : 'not-kept';
}

/**
 * One test's tick and a group's, both off one mount — which is the arrangement the screen has
 * (`routes/archive.tsx`), and the only one in which *one press, all of its tests* is assertable.
 */
function Ticks({ tests = BOTH }: { readonly tests?: readonly TestPath[] }) {
	const pinned = usePinnedTests();
	const one = pinned.stateFor(tests[0] as TestPath);
	const all = pinned.stateForAll(tests);
	return (
		<>
			<span data-testid="one">{drawn(one)}</span>
			<span data-testid="all">{drawn(all)}</span>
			<button onClick={() => one?.toggle()} type="button">
				press one
			</button>
			<button onClick={() => all?.toggle()} type="button">
				press all
			</button>
		</>
	);
}

const one = () => screen.getByTestId('one').textContent;
const all = () => screen.getByTestId('all').textContent;
const press = (which: 'one' | 'all') =>
	fireEvent.click(screen.getByRole('button', { name: `press ${which}` }));

describe('reading the set', () => {
	it('asks the host once, for the whole set, taking nothing', async () => {
		host.call.mockResolvedValue(keeping(LOGIN));

		render(<Ticks />);

		await waitFor(() => expect(one()).toBe('kept'));
		expect(host.call).toHaveBeenCalledTimes(1);
		expect(host.call).toHaveBeenCalledWith('list_kept_tests', {});
	});

	/*
	 * The assertion the read is shaped around, and `archive-groups.ts`'s own: React 19's StrictMode
	 * runs an effect twice on mount, so a guard held in state would have read the store twice for
	 * one screen — visible in the daemon's log, and two reads of a file one press rewrites.
	 */
	it('asks once under StrictMode, not twice', async () => {
		host.call.mockResolvedValue(keeping(LOGIN));

		render(
			<StrictMode>
				<Ticks />
			</StrictMode>,
		);

		await waitFor(() => expect(one()).toBe('kept'));
		expect(host.call).toHaveBeenCalledTimes(1);
	});

	// No polling and no refresh: the set only changes when this screen changes it, so a re-render is
	// not a reason to ask again (`archive-groups.ts`).
	it('asks nothing further on a re-render', async () => {
		host.call.mockResolvedValue(keeping(LOGIN));
		const { rerender } = render(<Ticks />);
		await waitFor(() => expect(one()).toBe('kept'));

		rerender(<Ticks />);
		await Promise.resolve();

		expect(host.call).toHaveBeenCalledTimes(1);
	});

	// A host that keeps nothing is an answer, and every tick on the screen is *not kept* — which is
	// a different thing from a set nobody has answered for.
	it('draws every tick off a host that keeps nothing', async () => {
		host.call.mockResolvedValue(keeping());

		render(<Ticks />);

		await waitFor(() => expect(one()).toBe('not-kept'));
		expect(all()).toBe('not-kept');
	});

	/*
	 * **No checkbox at all until the set has answered, and none if it cannot be read.** An unticked
	 * box for a test the panel cannot ask about says *this is not kept*, which is a claim about the
	 * operator's own decision that nothing has established (`docs/DESIGN.md` §9).
	 */
	it('draws no control while the read is still out', () => {
		host.call.mockReturnValue(new Promise(() => undefined));

		render(<Ticks />);

		expect(one()).toBe('no-control');
		expect(all()).toBe('no-control');
	});

	it.each([
		['a store the host cannot read', result({ outcome: 'unreadable' })],
		['a host that answered nothing at all', { ok: false as const, refusal: 'unanswered' as const }],
		['an answer this panel cannot parse', result({ outcome: 'listed' })],
		['a refused session', { ok: false as const, refusal: 'refused' as const }],
	])('draws no control for %s', async (_case, answer) => {
		host.call.mockResolvedValue(answer);

		render(<Ticks />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));

		expect(one()).toBe('no-control');
		expect(all()).toBe('no-control');
	});
});

describe('one press', () => {
	it('is one call, naming the test, the direction and who pressed it', async () => {
		host.call.mockResolvedValue(keeping());
		render(<Ticks />);
		await waitFor(() => expect(one()).toBe('not-kept'));
		host.call.mockResolvedValue(written(LOGIN));

		press('one');

		await waitFor(() => expect(one()).toBe('kept'));
		expect(host.call).toHaveBeenCalledTimes(2);
		expect(host.call).toHaveBeenLastCalledWith('set_kept_tests', {
			tests: [ref(LOGIN)],
			kept: true,
			actor: 'karolina',
		});
	});

	it('stops keeping a test it was already keeping', async () => {
		host.call.mockResolvedValue(keeping(LOGIN));
		render(<Ticks />);
		await waitFor(() => expect(one()).toBe('kept'));
		host.call.mockResolvedValue(written());

		press('one');

		await waitFor(() => expect(one()).toBe('not-kept'));
		expect(host.call).toHaveBeenLastCalledWith('set_kept_tests', {
			tests: [ref(LOGIN)],
			kept: false,
			actor: 'karolina',
		});
	});

	/*
	 * **The tick is the host's answer and not the press.** Nothing is written optimistically, so the
	 * set the host answered with is what is drawn even when it is not what the press asked for —
	 * R29, and the reason a failed write needs nothing unwound.
	 */
	it('draws the set the host answered rather than the one it asked for', async () => {
		host.call.mockResolvedValue(keeping());
		render(<Ticks />);
		await waitFor(() => expect(one()).toBe('not-kept'));
		host.call.mockResolvedValue(written(BASKET));

		press('one');

		await waitFor(() => expect(all()).toBe('mixed'));
		expect(one()).toBe('not-kept');
	});

	it.each([
		['the host did not write it', result({ outcome: 'unwritable' })],
		['its cap refused the press', result({ outcome: 'refused', reason: 'too-many' })],
		['nothing came back', { ok: false as const, refusal: 'unanswered' as const }],
		['the session was refused', { ok: false as const, refusal: 'refused' as const }],
	])('leaves the tick where it was when %s', async (_case, answer) => {
		host.call.mockResolvedValue(keeping(LOGIN));
		render(<Ticks />);
		await waitFor(() => expect(one()).toBe('kept'));
		host.call.mockResolvedValue(answer);

		press('one');
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(2));

		expect(one()).toBe('kept');
	});
});

describe('a group’s press', () => {
	it('is one request carrying every test in the group, never one per test', async () => {
		host.call.mockResolvedValue(keeping());
		render(<Ticks />);
		await waitFor(() => expect(all()).toBe('not-kept'));
		host.call.mockResolvedValue(written(...BOTH));

		press('all');

		await waitFor(() => expect(all()).toBe('kept'));
		// Two tests, one call — the whole point of the write taking an array (`kept-tests.ts`).
		expect(host.call).toHaveBeenCalledTimes(2);
		expect(host.call).toHaveBeenLastCalledWith('set_kept_tests', {
			tests: [ref(LOGIN), ref(BASKET)],
			kept: true,
			actor: 'karolina',
		});
	});

	// `mixed` comes from counting kept tests and from no group flag — there is none, on the wire or
	// here, and the truth is which tests are kept.
	it('says part-kept when some of its tests are kept', async () => {
		host.call.mockResolvedValue(keeping(LOGIN));

		render(<Ticks />);

		await waitFor(() => expect(all()).toBe('mixed'));
		expect(one()).toBe('kept');
	});

	/** From part-kept, one press keeps the rest rather than clearing the ones already kept. */
	it('keeps the remainder from part-kept', async () => {
		host.call.mockResolvedValue(keeping(LOGIN));
		render(<Ticks />);
		await waitFor(() => expect(all()).toBe('mixed'));
		host.call.mockResolvedValue(written(...BOTH));

		press('all');

		await waitFor(() => expect(all()).toBe('kept'));
		expect(host.call).toHaveBeenLastCalledWith('set_kept_tests', {
			tests: [ref(LOGIN), ref(BASKET)],
			kept: true,
			actor: 'karolina',
		});
	});

	it('stops keeping all of them from kept', async () => {
		host.call.mockResolvedValue(keeping(...BOTH));
		render(<Ticks />);
		await waitFor(() => expect(all()).toBe('kept'));
		host.call.mockResolvedValue(written());

		press('all');

		await waitFor(() => expect(all()).toBe('not-kept'));
		expect(host.call).toHaveBeenLastCalledWith('set_kept_tests', {
			tests: [ref(LOGIN), ref(BASKET)],
			kept: false,
			actor: 'karolina',
		});
	});
});
