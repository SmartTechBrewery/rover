import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The host, scripted per level. `useSession` is mocked rather than driven through the real
 * `SessionProvider` because what is in question here is only what this hook asks for and how it
 * folds the answer — the credential machinery has its own suite.
 */
const { host } = vi.hoisted(() => ({
	host: {
		call: vi.fn(),
	},
}));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({ call: host.call }),
}));

import {
	ARCHIVE_POLL_MS,
	type ArchiveLevel,
	type ArchiveLevels,
	levelAt,
	runContentsLevel,
	useArchiveLevels,
} from './archive-levels.js';
import type { ArchiveEntry } from './archive-listing.js';
import { keyOf } from './archive-path.js';

function result(value: unknown) {
	return { ok: true as const, value: { type: 'result' as const, result: value } };
}

function listed(...names: readonly string[]) {
	return result({
		outcome: 'listed',
		entries: names.map((name) => ({ kind: 'directory', name, childCount: 1, onlyChild: null })),
	});
}

/**
 * Renders one line per requested level, so the map is assertable as text.
 *
 * The hook takes a **selector over the levels read so far** rather than an array (#140 review), so
 * that a path derived from an answer and a path off the URL share one cache. A fixed list is the
 * degenerate selector, which is what every case below wants; `asks for a level derived from an
 * answer` is the one that exercises the derivation.
 */
function Levels({
	paths,
	writing = false,
}: {
	readonly paths: readonly (readonly string[])[];
	/**
	 * Whether a lease is live, which is what runs the clock (`live-writes.ts`, #287). Defaulted to
	 * `false` here so every case that predates the clock still pins *once per level* — the hook's
	 * own parameter has no default, precisely so no call site is opted out by accident.
	 */
	readonly writing?: boolean;
}) {
	const { levels, reread } = useArchiveLevels(() => paths, writing);
	return (
		<>
			{/*
			 * The hook's one *press-able* trigger, given a control here so a case can fire it. On the
			 * screen it has exactly one caller and it is not a control at all — a settled `Remove`
			 * (`routes/archive.tsx`) — and the clock has no caller to press either, which together
			 * are what keep *no refresh control* true of §9 (#287).
			 */}
			<button onClick={reread} type="button">
				reread
			</button>
			<ul>
				{paths.map((path) => (
					<li key={path.join('/')} data-testid={path.join('/') || 'root'}>
						{describeLevel(levels, path)}
					</li>
				))}
			</ul>
		</>
	);
}

function describeLevel(levels: ArchiveLevels, path: readonly string[]): string {
	const level = levelAt(levels, path);
	return level.status === 'listed'
		? `listed:${level.entries.map((entry) => entry.name).join(',')}`
		: level.status;
}

const ROOT_AND_PROJECT = [[], ['checkout-app']] as const;

/**
 * Let every pending promise settle without letting the clock fire — `device-list-provider.test.tsx`'s
 * own helper, copied for its reason: the interval and the request deadline are the same length, so
 * advancing by anything at all is advancing the tick.
 */
async function settle(): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
	});
}

/**
 * A host that accepts the request and never answers it — **answering `unanswered` when the caller
 * abandons it**, which is `host-client.ts`'s own contract for an aborted request and the whole
 * reason a deadline changes anything on screen.
 */
async function abandoned(
	_method: string,
	_params: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	return await new Promise((resolve) => {
		signal?.addEventListener('abort', () => resolve({ ok: false, refusal: 'unanswered' }));
	});
}

/** Fake timers are opted into per case; nothing here may leak them into the next file. */
afterEach(() => {
	vi.useRealTimers();
});

describe('the levels a selection needs', () => {
	it('asks once per level, and for no level it was not given', async () => {
		host.call.mockResolvedValue(listed('checkout-app'));

		render(<Levels paths={ROOT_AND_PROJECT} />);

		await waitFor(() => {
			expect(screen.getByTestId('checkout-app').textContent).toBe('listed:checkout-app');
		});
		expect(host.call).toHaveBeenCalledTimes(2);
		expect(host.call.mock.calls.map((call) => call[1])).toEqual([
			{ path: [] },
			{ path: ['checkout-app'] },
		]);
	});

	/*
	 * The assertion the whole hook is shaped around. React 19's StrictMode runs an effect twice on
	 * mount, so a guard held in state would have let every level be read twice — visible in the
	 * daemon's own log as two `readdir`s for one screen.
	 */
	it('asks once per level under StrictMode, not twice', async () => {
		host.call.mockResolvedValue(listed('checkout-app'));

		render(
			<StrictMode>
				<Levels paths={ROOT_AND_PROJECT} />
			</StrictMode>,
		);

		await waitFor(() => {
			expect(screen.getByTestId('root').textContent).toBe('listed:checkout-app');
		});
		expect(host.call).toHaveBeenCalledTimes(2);
	});

	/*
	 * A re-render is not a reason to ask again, and never was. What has changed since #287 is the
	 * reason: it is no longer *the archive is finished data*, which was false while a lease was
	 * live — the only thing that asks again is the clock, and the clock is gated on a live lease.
	 */
	it('asks nothing further on a re-render with the same levels', async () => {
		host.call.mockResolvedValue(listed('checkout-app'));
		const { rerender } = render(<Levels paths={ROOT_AND_PROJECT} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(2));

		rerender(<Levels paths={[[], ['checkout-app']]} />);
		await Promise.resolve();

		expect(host.call).toHaveBeenCalledTimes(2);
	});

	it('asks for the one level a deeper selection adds', async () => {
		host.call.mockResolvedValue(listed('login-flow'));
		const { rerender } = render(<Levels paths={ROOT_AND_PROJECT} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(2));

		rerender(<Levels paths={[[], ['checkout-app'], ['checkout-app', 'login-flow']]} />);

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(3));
		expect(host.call.mock.calls[2]?.[1]).toEqual({ path: ['checkout-app', 'login-flow'] });
	});

	/*
	 * **Every request carries the tick as its budget** (#125, #287) — rewritten in place from *sets
	 * no deadline on the request*, whose reason was that a budget belongs to a repeating caller
	 * with an interval to spend and this one had neither (`host-client.ts`). It has one now, and the
	 * deadline is what bounds the tick guard: without it, one request the host accepted and never
	 * answered would hold that guard for the life of the tab. The signal is given whether or not a
	 * lease is live, because a request outliving the gate closing is the same abandoned request.
	 */
	it('gives every request the tick’s own budget', async () => {
		host.call.mockResolvedValue(listed('checkout-app'));

		render(<Levels paths={[[]]} />);

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));
		expect(host.call.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
		expect((host.call.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(false);
	});

	// And the budget is spent: a level nothing answered for lands on `unreadable` at the deadline
	// rather than reading *Reading this level.* for the life of the tab.
	it('abandons a request nothing answered when its budget runs out', async () => {
		vi.useFakeTimers();
		host.call.mockImplementation(abandoned);

		render(<Levels paths={[[]]} />);
		await settle();
		expect(screen.getByTestId('root').textContent).toBe('loading');

		await act(async () => {
			await vi.advanceTimersByTimeAsync(ARCHIVE_POLL_MS);
		});

		expect((host.call.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(true);
		expect(screen.getByTestId('root').textContent).toBe('unreadable');
	});
});

/**
 * The clock — **every drawn level read again while a lease is live, and nothing at all otherwise**
 * (#287).
 *
 * A tick is the same request a settled `Remove`'s re-read makes, on the same nonce, which is why
 * the laziness rule and the *once per level* guard hold over it unchanged. What is new is when it
 * fires, what bounds it, and what it may not do to a level that already has an answer.
 *
 * Fake timers throughout, because the interval and the request deadline are the same length: the
 * pairing matters and is asserted rather than assumed.
 */
describe('while the archive is being written', () => {
	async function tick(): Promise<void> {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ARCHIVE_POLL_MS);
		});
	}

	function paths(): readonly unknown[] {
		return host.call.mock.calls.map((call) => call[1]);
	}

	// The laziness rule, restated for the tick: every level the selector names, and no level it
	// does not (#198). A poll of the archive is not something any caller here can ask for.
	it('asks for every drawn level again, and for no level it was not given', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(listed('checkout-app'));
		render(<Levels paths={ROOT_AND_PROJECT} writing={true} />);
		await settle();
		expect(host.call).toHaveBeenCalledTimes(2);

		await tick();

		expect(host.call).toHaveBeenCalledTimes(4);
		expect(paths()).toEqual([
			{ path: [] },
			{ path: ['checkout-app'] },
			{ path: [] },
			{ path: ['checkout-app'] },
		]);
	});

	// The idle cost, pinned: no lease live means no interval and no requests, however far the clock
	// is advanced. This is the decision #287 asked to be recorded rather than left implicit.
	it('asks nothing at all while no lease is live', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(listed('checkout-app'));
		render(<Levels paths={ROOT_AND_PROJECT} writing={false} />);
		await settle();
		expect(host.call).toHaveBeenCalledTimes(2);

		await tick();
		await tick();
		await tick();

		expect(host.call).toHaveBeenCalledTimes(2);
	});

	// The nonce doing its work: one request per level per tick, and StrictMode's double mount is
	// still one — which a clock built by clearing the `asked` guard would have lost.
	it('asks once per level per tick, including under StrictMode', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(listed('checkout-app'));
		render(
			<StrictMode>
				<Levels paths={ROOT_AND_PROJECT} writing={true} />
			</StrictMode>,
		);
		await settle();
		expect(host.call).toHaveBeenCalledTimes(2);

		await tick();

		// One interval and not two: StrictMode mounts the effect twice and the cleanup clears the
		// first interval, so a tick is two requests and never four.
		expect(host.call).toHaveBeenCalledTimes(4);
	});

	/*
	 * **A refresh is invisible until it lands.** The map is untouched until an answer arrives, so a
	 * level that has a listing never falls back to *Reading this level.* while it re-reads — which
	 * is the whole difference between a refresh and a reload.
	 */
	it('never reads `loading` over a level that already has an answer', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(listed('checkout-app'));
		render(<Levels paths={[[]]} writing={true} />);
		await settle();
		expect(screen.getByTestId('root').textContent).toBe('listed:checkout-app');

		let answerTheRefresh: (value: unknown) => void = () => undefined;
		host.call.mockReturnValueOnce(
			new Promise((resolve) => {
				answerTheRefresh = resolve;
			}),
		);
		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId('root').textContent).toBe('listed:checkout-app');

		await act(async () => {
			answerTheRefresh(listed('checkout-app', 'payments-web'));
		});

		expect(screen.getByTestId('root').textContent).toBe('listed:checkout-app,payments-web');
	});

	/*
	 * **A tick arriving while the last one's requests are still out is dropped, not queued** (#125).
	 * A host that stops answering is asked at most once per tick and never has two outstanding.
	 *
	 * The counts are the pairing the device poll's own test carries, and they are the pairing rather
	 * than an arbitrary sequence: **the deadline and the next tick fall due at the same instant**,
	 * and the interval was registered before that request's own budget was, so the tick is what
	 * fires first — it finds the request still out and is dropped, the budget then runs out, and the
	 * recovery is the tick **after** it. Which is why the guard is released in `finally` and not at
	 * the abort: releasing it there would let the abandoned request's answer land after the next
	 * tick's good one.
	 *
	 * So a host that stops answering costs one request per two ticks and never a backlog, which is
	 * the state #125 was actually about — there, an unbounded guard froze the screen for the life of
	 * the tab.
	 */
	it('drops a tick that arrives while the last one’s requests are still out', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(listed('checkout-app'));
		render(<Levels paths={[[]]} writing={true} />);
		await settle();
		expect(host.call).toHaveBeenCalledTimes(1);

		// The tick that is swallowed by the host: it goes out, and nothing comes back.
		host.call.mockImplementation(abandoned);
		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);

		// This tick finds it still out and is dropped; the request's budget then runs out.
		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);

		// And the clock comes back on its own, one request and not a backlog of the dropped ones.
		await tick();
		expect(host.call).toHaveBeenCalledTimes(3);
		await tick();
		expect(host.call).toHaveBeenCalledTimes(3);
		await tick();
		expect(host.call).toHaveBeenCalledTimes(4);
	});

	/*
	 * **A refresh that misses its budget leaves the level exactly where it was**, and is asked again
	 * on the next tick. Nothing answered over a level that has an answer is not news about the
	 * archive: the listing on screen is still the last thing the host confirmed.
	 */
	it('leaves a level alone when its refresh misses the budget, and asks again', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(listed('checkout-app'));
		render(<Levels paths={[[]]} writing={true} />);
		await settle();

		host.call.mockImplementation(abandoned);
		// The refresh goes out; nothing comes back, and its budget runs out on the tick after it —
		// which is itself dropped, the request having still been outstanding when it fired.
		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);
		await tick();
		// The `unanswered` landed on a level that already has a listing, so the listing stays.
		expect(screen.getByTestId('root').textContent).toBe('listed:checkout-app');
		expect(host.call).toHaveBeenCalledTimes(2);

		host.call.mockResolvedValue(listed('checkout-app', 'payments-web'));
		// And the next tick asks again, which is what makes the miss a miss rather than a state.
		await tick();

		expect(host.call).toHaveBeenCalledTimes(3);
		expect(screen.getByTestId('root').textContent).toBe('listed:checkout-app,payments-web');
	});

	// The host's **own** `unreadable` still replaces, which is what keeps that word meaning what it
	// means everywhere else: it is the answer to the question the screen just asked.
	it('replaces a level the host itself answers `unreadable` for on a tick', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(listed('checkout-app'));
		render(<Levels paths={[[]]} writing={true} />);
		await settle();
		expect(screen.getByTestId('root').textContent).toBe('listed:checkout-app');

		host.call.mockResolvedValue(result({ outcome: 'unreadable' }));
		await tick();

		expect(screen.getByTestId('root').textContent).toBe('unreadable');
	});

	// A run that lands appears without a reload — the acceptance criterion, at the hook's own level.
	it('draws a run that landed between two ticks', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(listed('20260910T091403Z-issue-287-1a2b3c4d'));
		render(<Levels paths={[[]]} writing={true} />);
		await settle();

		host.call.mockResolvedValue(
			listed('20260910T091403Z-issue-287-1a2b3c4d', '20260910T092911Z-issue-287-9f1c2ab4'),
		);
		await tick();

		expect(screen.getByTestId('root').textContent).toBe(
			'listed:20260910T091403Z-issue-287-1a2b3c4d,20260910T092911Z-issue-287-9f1c2ab4',
		);
	});

	// The clock stops when the last lease ends, which is the other half of the idle cost being
	// nothing: the gate closing clears the interval rather than leaving it running until unmount.
	it('stops asking once the last lease has ended', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(listed('checkout-app'));
		const { rerender } = render(<Levels paths={[[]]} writing={true} />);
		await settle();
		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);

		rerender(<Levels paths={[[]]} writing={false} />);
		await tick();
		await tick();

		expect(host.call).toHaveBeenCalledTimes(2);
	});

	// And it starts when a lease begins, without a remount: the gate is a prop of the render.
	it('starts asking once a lease begins', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(listed('checkout-app'));
		const { rerender } = render(<Levels paths={[[]]} writing={false} />);
		await settle();
		await tick();
		expect(host.call).toHaveBeenCalledTimes(1);

		rerender(<Levels paths={[[]]} writing={true} />);
		await tick();

		expect(host.call).toHaveBeenCalledTimes(2);
	});
});

/**
 * `reread()` — **one more request per drawn level, and one only** (#276).
 *
 * The one caller is a settled `Remove` on the Archive screen, which has just changed what is
 * filed, so the levels it still draws have to be `list_archive`'s answer again rather than the
 * panel's edit of what it had (§9). What makes that safe is the nonce: the guard is keyed on the
 * read that asked, so a second pass is one request per level and StrictMode's double mount is
 * still one.
 */
describe('reading every drawn level again', () => {
	function reread(): void {
		fireEvent.click(screen.getByRole('button', { name: 'reread' }));
	}

	it('asks once more for each level the screen still draws, and no more than once', async () => {
		host.call.mockResolvedValue(listed('checkout-app'));
		render(<Levels paths={ROOT_AND_PROJECT} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(2));

		act(() => reread());

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(4));
		expect(host.call.mock.calls.map((call) => call[1])).toEqual([
			{ path: [] },
			{ path: ['checkout-app'] },
			{ path: [] },
			{ path: ['checkout-app'] },
		]);
		// And nothing further: a re-read is one pass and not a clock of its own — the clock is
		// `writing`'s, which is `false` here (#287).
		await act(async () => undefined);
		expect(host.call).toHaveBeenCalledTimes(4);
	});

	/*
	 * The nonce and not a mutation of the guard, which is the whole reason the second press works at
	 * all: a `reread` built with a stale closure would set a value the state already held, and the
	 * effect would never run again (`registered-projects.ts` records the same trap).
	 */
	it('asks again on every press, not only on the first', async () => {
		host.call.mockResolvedValue(listed('checkout-app'));
		render(<Levels paths={[[]]} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));

		act(() => reread());
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(2));
		act(() => reread());

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(3));
	});

	// StrictMode's double mount is still one request per level per read, which is the property the
	// nonce buys and the one a cleared guard would have lost.
	it('is still one request per level under StrictMode', async () => {
		host.call.mockResolvedValue(listed('checkout-app'));
		render(
			<StrictMode>
				<Levels paths={ROOT_AND_PROJECT} />
			</StrictMode>,
		);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(2));

		act(() => reread());

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(4));
	});

	/*
	 * **A superseded answer lands on nothing.** Two reads of one level are not ordered by the
	 * requests that asked for them, so the first read's answer arriving after the second's must not
	 * overwrite it — a listing from before the delete, drawn after the one from after it.
	 */
	it('lets the newer answer stand when the older one arrives last', async () => {
		let answerFirstRead: (value: unknown) => void = () => undefined;
		host.call
			.mockReturnValueOnce(
				new Promise((resolve) => {
					answerFirstRead = resolve;
				}),
			)
			.mockResolvedValue(listed('after-the-delete'));
		render(<Levels paths={[[]]} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));

		act(() => reread());
		await waitFor(() =>
			expect(screen.getByTestId('root').textContent).toBe('listed:after-the-delete'),
		);
		await act(async () => {
			answerFirstRead(listed('before-the-delete'));
		});

		expect(screen.getByTestId('root').textContent).toBe('listed:after-the-delete');
	});

	// The host's answer to the question just asked, whatever it is: a level the host will no longer
	// confirm must not stay drawn out of a listing from before the delete.
	it('replaces a level the host can no longer read', async () => {
		host.call.mockResolvedValueOnce(listed('checkout-app'));
		render(<Levels paths={[[]]} />);
		await waitFor(() => expect(screen.getByTestId('root').textContent).toBe('listed:checkout-app'));

		host.call.mockResolvedValue(result({ outcome: 'unreadable' }));
		act(() => reread());

		await waitFor(() => expect(screen.getByTestId('root').textContent).toBe('unreadable'));
	});
});

describe('what one answer becomes', () => {
	/*
	 * One answer, one mount, and the mount taken down again — the states below are asserted several
	 * to a test and two mounts in the DOM at once would each carry a `root` line.
	 *
	 * `act` rather than `waitFor`, because one of these cases is a level that stays `loading` for
	 * good: waiting for it to change would either time out or pass vacuously.
	 */
	async function levelFrom(answer: unknown): Promise<string> {
		host.call.mockReset();
		host.call.mockResolvedValue(answer);
		const { unmount } = render(<Levels paths={[[]]} />);
		await act(async () => undefined);
		const described = screen.getByTestId('root').textContent ?? '';
		unmount();
		return described;
	}

	it('is `loading` before anything comes back — never an empty listing', async () => {
		host.call.mockReturnValue(new Promise(() => undefined));

		render(<Levels paths={[[]]} />);

		expect(screen.getByTestId('root').textContent).toBe('loading');
	});

	// `listed` with no entries is *the archive is empty*, and a level that is not there says the
	// same sentence to a reader: Rover writes a directory only when a verb produces bytes.
	it('folds an empty listing and a missing level into `empty`', async () => {
		expect(await levelFrom(result({ outcome: 'listed', entries: [] }))).toBe('empty');
		expect(await levelFrom(result({ outcome: 'missing' }))).toBe('empty');
	});

	it('keeps `unreadable` apart from `empty`', async () => {
		expect(await levelFrom(result({ outcome: 'unreadable' }))).toBe('unreadable');
	});

	/*
	 * The fold `device-list-provider.tsx` already makes and documents: what the screen has to
	 * decide is narrower than why, and *not readable* is the state whose copy is true either way.
	 */
	it('folds an error envelope, an unreadable answer and an unanswered request together', async () => {
		expect(
			await levelFrom({
				ok: true,
				value: { type: 'error', error: { code: 'internal', message: 'no' } },
			}),
		).toBe('unreadable');
		expect(await levelFrom(result({ outcome: 'no such outcome' }))).toBe('unreadable');
		expect(await levelFrom({ ok: false, refusal: 'unanswered' })).toBe('unreadable');
	});

	// `Session.call` has already fired `onRefusal` and the router is coming down; *not readable*
	// would be the panel's last word being the wrong one.
	it('sets nothing at all on a refused session', async () => {
		expect(await levelFrom({ ok: false, refusal: 'refused' })).toBe('loading');
	});
});

/**
 * The one place that knows a run holds one child (#159), tested directly because both halves of the
 * Archive screen compose an address out of it — the tree at the run's depth, and the screen for the
 * run's own card.
 */
describe('where a run’s contents are listed', () => {
	const RUN_NAME = '20260830T170501Z-issue-112-9f1c2ab4';
	const RUN = ['checkout-app', 'login-flow', RUN_NAME];

	function above(entry: ArchiveEntry): ArchiveLevels {
		const level: ArchiveLevel = { status: 'listed', entries: [entry] };
		return new Map([[keyOf(RUN.slice(0, -1)), level]]);
	}

	function run(onlyChild: string | null): ArchiveEntry {
		return { kind: 'directory', name: RUN_NAME, childCount: 1, onlyChild };
	}

	it('is the run’s own path plus the `onlyChild` the level above named', () => {
		expect(runContentsLevel(above(run('R5CT30ABCDE')), RUN)).toEqual([...RUN, 'R5CT30ABCDE']);
	});

	// No level to compose, and no guess to make: a run directory that is not one-device shaped is a
	// fact, and an address invented for it would be fetched and drawn as if it were one.
	it('is `null` for a run that names no single child', () => {
		expect(runContentsLevel(above(run(null)), RUN)).toBeNull();
	});

	it('is `null` until the level above has answered, and for one that cannot be read', () => {
		expect(runContentsLevel(new Map(), RUN)).toBeNull();
		const unreadable: ArchiveLevels = new Map<string, ArchiveLevel>([
			[keyOf(RUN.slice(0, -1)), { status: 'unreadable' }],
		]);
		expect(runContentsLevel(unreadable, RUN)).toBeNull();
	});

	// The level above lists it, but not as a directory — so there is nothing under it to address.
	it('is `null` for a name the level above lists as something other than a directory', () => {
		const file: ArchiveEntry = { kind: 'file', name: RUN_NAME, sizeBytes: 12 };
		expect(runContentsLevel(above(file), RUN)).toBeNull();
	});
});
