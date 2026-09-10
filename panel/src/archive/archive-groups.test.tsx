import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The host, scripted per answer. `useSession` is mocked rather than driven through the real
 * `SessionProvider` because what is in question here is only what this hook asks for, when, and how
 * it folds the answer — the credential machinery has its own suite. `archive-levels.test.tsx`'s
 * harness, copied for the reason it exists.
 */
const { host } = vi.hoisted(() => ({
	host: {
		call: vi.fn(),
	},
}));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({ call: host.call }),
}));

import { GROUPS_WALK_MS, useArchiveGroups } from './archive-groups.js';

function result(value: unknown) {
	return { ok: true as const, value: { type: 'result' as const, result: value } };
}

/** One run of a group, as `list_archive_groups` carries it (#181). */
function run(testName: string, name: string) {
	return { path: ['checkout-app', testName, name, 'R5CT30ABCDE'], artifacts: [] };
}

/** One grouping answer, over as many runs of `login-flow` as a case names. */
function grouped(...runs: readonly string[]) {
	return result({
		outcome: 'listed',
		truncated: false,
		groups: [
			{
				project: 'checkout-app',
				groupId: 'app-bar-top-space',
				runs: runs.map((name) => run('login-flow', name)),
			},
		],
	});
}

const RUN = '20260830T170501Z-issue-112-9f1c2ab4';
const NEWER = '20260910T091403Z-issue-288-1a2b3c4d';

/**
 * Renders the arrangement as one assertable line, plus the hook's one *press-able* trigger.
 *
 * On the screen that trigger has exactly one caller and is not a control at all — a settled
 * `Remove` on a group's card (`routes/archive.tsx`) — and the clock has no caller to press either,
 * which together are what keep *no refresh control* true of §9 (#288).
 */
function Groups({
	wanted = true,
	writing = false,
}: {
	readonly wanted?: boolean;
	/**
	 * Whether a lease is live, which is what runs the clock (`live-writes.ts`, #287, #288).
	 * Defaulted to `false` here so every case that predates the clock still pins *one walk per
	 * screen* — the hook's own parameter has no default, precisely so no call site is opted out by
	 * accident.
	 */
	readonly writing?: boolean;
}) {
	const { groups, reread } = useArchiveGroups(wanted, writing);
	return (
		<>
			<button onClick={reread} type="button">
				reread
			</button>
			<p data-testid="groups">{describe_(groups)}</p>
		</>
	);
}

function describe_(groups: ReturnType<typeof useArchiveGroups>['groups']): string {
	if (groups.status !== 'listed') {
		return groups.status;
	}
	const runs = groups.groups.flatMap((group) => group.runs.map((each) => each.path[2]));
	return `listed:${runs.join(',')}`;
}

function arrangement(): string {
	return screen.getByTestId('groups').textContent ?? '';
}

/**
 * Let every pending promise settle without letting the clock fire — `archive-levels.test.tsx`'s own
 * helper, copied for its reason: the interval and the walk's deadline are the same length, so
 * advancing by anything at all is advancing the tick.
 */
async function settle(): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
	});
}

/**
 * A host that accepts the walk and never answers it — **answering `unanswered` when the caller
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

/**
 * The mount — **one walk, and only in the view that reads it** (#181), which is what this hook was
 * before it had a clock and what it still is with the gate shut.
 */
describe('the arrangement a groups view needs', () => {
	it('walks the archive once, and answers with the groups it named', async () => {
		host.call.mockResolvedValue(grouped(RUN));

		render(<Groups />);

		await waitFor(() => expect(arrangement()).toBe(`listed:${RUN}`));
		expect(host.call).toHaveBeenCalledTimes(1);
		expect(host.call.mock.calls[0]?.[0]).toBe('list_archive_groups');
		expect(host.call.mock.calls[0]?.[1]).toEqual({});
	});

	/*
	 * The assertion the hook is shaped around. React 19's StrictMode runs an effect twice on mount,
	 * so a guard held in state would have let the whole archive be walked twice — visible in the
	 * daemon's own log.
	 */
	it('walks once under StrictMode, not twice', async () => {
		host.call.mockResolvedValue(grouped(RUN));

		render(
			<StrictMode>
				<Groups />
			</StrictMode>,
		);

		await waitFor(() => expect(arrangement()).toBe(`listed:${RUN}`));
		expect(host.call).toHaveBeenCalledTimes(1);
	});

	// The `All` view's rule: both views are one component, so a reader who never opens this one must
	// not spend a walk of the whole archive on it.
	it('asks for nothing at all while the view does not want it', async () => {
		host.call.mockResolvedValue(grouped(RUN));

		render(<Groups wanted={false} />);
		await act(async () => undefined);

		expect(host.call).not.toHaveBeenCalled();
		expect(arrangement()).toBe('loading');
	});

	/*
	 * **No clock, no budget** (#125, #289 review) — `archive-levels.ts`' rule at this method's
	 * cadence: with the gate shut nothing will ask again, so abandoning a walk at thirty seconds
	 * would cache *not readable* over a host that was merely slow, correctable only by a reload.
	 */
	it('gives the walk no budget while no lease is live', async () => {
		host.call.mockResolvedValue(grouped(RUN));

		render(<Groups />);

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));
		expect(host.call.mock.calls[0]?.[2]).toBeUndefined();
	});
});

/**
 * The clock — **the archive's groupings walked again while a lease is live, and nothing at all
 * otherwise** (#288).
 *
 * A tick is the same walk a settled `Remove`'s re-read makes, on the same nonce, which is why the
 * `All` view's gate and the *once per mount* guard hold over it unchanged. What is new is when it
 * fires, what bounds it, and what it may not do to an arrangement that already has an answer.
 *
 * Fake timers throughout, because the interval and the walk's deadline are the same length: the
 * pairing matters and is asserted rather than assumed.
 */
describe('while the archive is being written', () => {
	async function tick(): Promise<void> {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(GROUPS_WALK_MS);
		});
	}

	it('walks the archive again on every tick', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(grouped(RUN));
		render(<Groups writing={true} />);
		await settle();
		expect(host.call).toHaveBeenCalledTimes(1);

		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);
		await tick();
		expect(host.call).toHaveBeenCalledTimes(3);
	});

	// The acceptance criterion at the hook's own level: a run filed under the group the reader is
	// looking at appears without a reload.
	it('draws a run that landed under the group between two ticks', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(grouped(RUN));
		render(<Groups writing={true} />);
		await settle();
		expect(arrangement()).toBe(`listed:${RUN}`);

		host.call.mockResolvedValue(grouped(RUN, NEWER));
		await tick();

		expect(arrangement()).toBe(`listed:${RUN},${NEWER}`);
	});

	/*
	 * **Nothing at all in the `All` view, however far the clock runs.** `wanted` gates the interval
	 * as it gates the mount, so a reader who never opens the groups view pays for no tick — which is
	 * the whole reason this cadence can be afforded at all.
	 */
	it('asks nothing at all in the `All` view, however far the clock runs', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(grouped(RUN));
		render(<Groups wanted={false} writing={true} />);
		await settle();

		await tick();
		await tick();
		await tick();

		expect(host.call).not.toHaveBeenCalled();
	});

	// The idle cost, pinned: no lease live means no interval and no walks, however long the reader
	// sits in this view.
	it('asks nothing further while no lease is live', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(grouped(RUN));
		render(<Groups writing={false} />);
		await settle();
		expect(host.call).toHaveBeenCalledTimes(1);

		await tick();
		await tick();
		await tick();

		expect(host.call).toHaveBeenCalledTimes(1);
	});

	/*
	 * **The gated walk is the one with a budget**, and it is spent (#125, #289 review). This is the
	 * guard's bound: a walk the host accepted and never answered is abandoned at one tick's length,
	 * so `outstanding` cannot be held for the life of the tab and the next tick is due.
	 */
	it('gives the walk the tick’s own budget while a lease is live', async () => {
		vi.useFakeTimers();
		host.call.mockImplementation(abandoned);

		render(<Groups writing={true} />);
		await settle();
		expect(host.call.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);

		await tick();

		expect((host.call.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(true);
		// And the clock, not a reload, is what asks again — the arrangement is not cached as
		// `unreadable` for the life of the screen the way an ungated abandonment would cache it.
		expect(host.call.mock.calls.length).toBeGreaterThan(1);
	});

	/*
	 * **A tick arriving while the last walk is still out is dropped, not queued** (#125). A host
	 * slower than the cadence is never walking the archive twice at once, which is the one thing
	 * this method's cost makes unaffordable.
	 *
	 * The counts are the pairing `archive-levels.test.tsx` carries and they are the pairing rather
	 * than an arbitrary sequence: **the deadline and the next tick fall due at the same instant**,
	 * and the interval was registered before that walk's own budget was, so the tick fires first —
	 * it finds the walk still out and is dropped, the budget then runs out, and the recovery is the
	 * tick **after** it.
	 */
	it('drops a tick that arrives while the last walk is still out', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(grouped(RUN));
		render(<Groups writing={true} />);
		await settle();
		expect(host.call).toHaveBeenCalledTimes(1);

		// The tick that is swallowed by the host: it goes out, and nothing comes back.
		host.call.mockImplementation(abandoned);
		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);

		// This tick finds it still out and is dropped; the walk's budget then runs out.
		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);

		// And the clock comes back on its own, one walk and not a backlog of the dropped ones.
		await tick();
		expect(host.call).toHaveBeenCalledTimes(3);
		await tick();
		expect(host.call).toHaveBeenCalledTimes(3);
		await tick();
		expect(host.call).toHaveBeenCalledTimes(4);
	});

	/*
	 * **A walk is invisible until it lands.** The arrangement is untouched until an answer arrives,
	 * so a view that has one never falls back to *Reading the testing groups on this host's
	 * archive.* — which is the whole difference between a refresh and a reload, and here it is the
	 * difference between a refresh and the reader's tree, card and place all going at once.
	 */
	it('never reads `loading` over an arrangement that already has an answer', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(grouped(RUN));
		render(<Groups writing={true} />);
		await settle();
		expect(arrangement()).toBe(`listed:${RUN}`);

		let answerTheWalk: (value: unknown) => void = () => undefined;
		host.call.mockReturnValueOnce(
			new Promise((resolve) => {
				answerTheWalk = resolve;
			}),
		);
		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);
		expect(arrangement()).toBe(`listed:${RUN}`);

		await act(async () => {
			answerTheWalk(grouped(RUN, NEWER));
		});

		expect(arrangement()).toBe(`listed:${RUN},${NEWER}`);
	});

	/*
	 * **A walk that misses its budget leaves the arrangement exactly where it was**, and is asked
	 * again on the next tick. Nothing answered over an arrangement that has an answer is not news
	 * about the archive: what is drawn is still the last thing the host confirmed.
	 */
	it('leaves the arrangement alone when a walk misses its budget, and asks again', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(grouped(RUN));
		render(<Groups writing={true} />);
		await settle();

		host.call.mockImplementation(abandoned);
		// The walk goes out; nothing comes back, and its budget runs out on the tick after it —
		// which is itself dropped, the walk having still been outstanding when it fired.
		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);
		await tick();
		// The `unanswered` landed on an arrangement that already has one, so it stays.
		expect(arrangement()).toBe(`listed:${RUN}`);
		expect(host.call).toHaveBeenCalledTimes(2);

		host.call.mockResolvedValue(grouped(RUN, NEWER));
		// And the next tick asks again, which is what makes the miss a miss rather than a state.
		await tick();

		expect(host.call).toHaveBeenCalledTimes(3);
		expect(arrangement()).toBe(`listed:${RUN},${NEWER}`);
	});

	// With nothing yet it is today's `unreadable`, which is where the very first walk landed before
	// there was a clock — there is no arrangement to leave standing.
	it('is `unreadable` when the first walk of all misses its budget', async () => {
		vi.useFakeTimers();
		host.call.mockImplementation(abandoned);
		render(<Groups writing={true} />);
		await settle();
		expect(arrangement()).toBe('loading');

		await tick();

		expect(arrangement()).toBe('unreadable');
	});

	// The host's **own** `unreadable` still replaces, which is what keeps that word meaning what it
	// means everywhere else: it is the answer to the question the screen just asked (#277).
	it('replaces the arrangement the host itself answers `unreadable` for on a tick', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(grouped(RUN));
		render(<Groups writing={true} />);
		await settle();
		expect(arrangement()).toBe(`listed:${RUN}`);

		host.call.mockResolvedValue(result({ outcome: 'unreadable' }));
		await tick();

		expect(arrangement()).toBe('unreadable');
	});

	// The nonce doing its work: one walk per tick, and StrictMode's double mount is still one — one
	// interval and not two, which a clock built by clearing the `asked` guard would have lost.
	it('walks once per tick under StrictMode, and runs one interval', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(grouped(RUN));
		render(
			<StrictMode>
				<Groups writing={true} />
			</StrictMode>,
		);
		await settle();
		expect(host.call).toHaveBeenCalledTimes(1);

		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);
		await tick();
		expect(host.call).toHaveBeenCalledTimes(3);
	});

	// The clock stops when the last lease ends, which is the other half of the idle cost being
	// nothing: the gate closing clears the interval rather than leaving it running until unmount.
	it('stops walking once the last lease has ended', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(grouped(RUN));
		const { rerender } = render(<Groups writing={true} />);
		await settle();
		await tick();
		expect(host.call).toHaveBeenCalledTimes(2);

		rerender(<Groups writing={false} />);
		await tick();
		await tick();

		expect(host.call).toHaveBeenCalledTimes(2);
	});

	// And it starts when a lease begins, without a remount: the gate is a prop of the render.
	it('starts walking once a lease begins', async () => {
		vi.useFakeTimers();
		host.call.mockResolvedValue(grouped(RUN));
		const { rerender } = render(<Groups writing={false} />);
		await settle();
		await tick();
		expect(host.call).toHaveBeenCalledTimes(1);

		rerender(<Groups writing={true} />);
		await tick();

		expect(host.call).toHaveBeenCalledTimes(2);
	});

	/*
	 * **A walk issued before the gate opened does not hold the guard** (#289 review). It has no
	 * budget, because nothing was going to ask it again when it went out; counting it would let one
	 * such walk drop every tick for the rest of the tab, which is #125 reached through the gate
	 * opening rather than through the clock.
	 */
	it('keeps ticking when a walk from before the gate opened never answers', async () => {
		vi.useFakeTimers();
		host.call.mockImplementation(abandoned);
		const { rerender } = render(<Groups writing={false} />);
		await settle();
		expect(host.call).toHaveBeenCalledTimes(1);

		rerender(<Groups writing={true} />);
		await settle();
		await tick();

		expect(host.call).toHaveBeenCalledTimes(2);
	});
});

/**
 * `reread()` — **one more walk, and one only** (#277), which the clock changes nothing about.
 *
 * The one caller is a settled `Remove` on a group's card, which has just changed what is filed, so
 * the arrangement it still draws has to be `list_archive_groups`' answer again rather than the
 * panel's edit of what it had (§9).
 */
describe('walking the groupings again', () => {
	function reread(): void {
		fireEvent.click(screen.getByRole('button', { name: 'reread' }));
	}

	it('asks once more, and no more than once', async () => {
		host.call.mockResolvedValue(grouped(RUN));
		render(<Groups />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));

		act(() => reread());

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(2));
		// And nothing further: a re-read is one walk and not a clock of its own — the clock is
		// `writing`'s, which is `false` here (#288).
		await act(async () => undefined);
		expect(host.call).toHaveBeenCalledTimes(2);
	});

	it('asks again on every press, not only on the first', async () => {
		host.call.mockResolvedValue(grouped(RUN));
		render(<Groups />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));

		act(() => reread());
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(2));
		act(() => reread());

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(3));
	});

	/*
	 * **A superseded answer lands on nothing.** Two walks are not ordered by the requests that asked
	 * for them, so the first walk's answer arriving after the second's must not overwrite it — an
	 * arrangement from before the delete, drawn after the one from after it.
	 */
	it('lets the newer answer stand when the older one arrives last', async () => {
		let answerFirstWalk: (value: unknown) => void = () => undefined;
		host.call
			.mockReturnValueOnce(
				new Promise((resolve) => {
					answerFirstWalk = resolve;
				}),
			)
			.mockResolvedValue(grouped(NEWER));
		render(<Groups />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));

		act(() => reread());
		await waitFor(() => expect(arrangement()).toBe(`listed:${NEWER}`));
		await act(async () => {
			answerFirstWalk(grouped(RUN));
		});

		expect(arrangement()).toBe(`listed:${NEWER}`);
	});

	// The host's answer to the question just asked, whatever it is: an arrangement the host will no
	// longer confirm must not stay drawn out of an answer from before the delete.
	it('replaces the arrangement the host can no longer read', async () => {
		host.call.mockResolvedValueOnce(grouped(RUN));
		render(<Groups />);
		await waitFor(() => expect(arrangement()).toBe(`listed:${RUN}`));

		host.call.mockResolvedValue(result({ outcome: 'unreadable' }));
		act(() => reread());

		await waitFor(() => expect(arrangement()).toBe('unreadable'));
	});
});

describe('what one answer becomes', () => {
	/*
	 * One answer, one mount, and the mount taken down again — the states below are asserted several
	 * to a test and two mounts in the DOM at once would each carry a `groups` line.
	 *
	 * `act` rather than `waitFor`, because one of these cases is an arrangement that stays `loading`
	 * for good: waiting for it to change would either time out or pass vacuously.
	 */
	async function groupsFrom(answer: unknown): Promise<string> {
		host.call.mockReset();
		host.call.mockResolvedValue(answer);
		const { unmount } = render(<Groups />);
		await act(async () => undefined);
		const described = arrangement();
		unmount();
		return described;
	}

	it('is `loading` before anything comes back — never an empty arrangement', async () => {
		host.call.mockReturnValue(new Promise(() => undefined));

		render(<Groups />);

		expect(arrangement()).toBe('loading');
	});

	// *Nothing has ever been archived here* and *nothing here named a group* are the same sentence
	// to a reader standing in a view that draws groups.
	it('folds an empty walk and a missing archive into `empty`', async () => {
		expect(await groupsFrom(result({ outcome: 'listed', groups: [], truncated: false }))).toBe(
			'empty',
		);
		expect(await groupsFrom(result({ outcome: 'missing' }))).toBe('empty');
	});

	it('folds an error envelope, an unreadable answer and an unanswered walk together', async () => {
		expect(
			await groupsFrom({
				ok: true,
				value: { type: 'error', error: { code: 'internal', message: 'no' } },
			}),
		).toBe('unreadable');
		expect(await groupsFrom(result({ outcome: 'no such outcome' }))).toBe('unreadable');
		expect(await groupsFrom({ ok: false, refusal: 'unanswered' })).toBe('unreadable');
	});

	// `Session.call` has already fired `onRefusal` and the router is coming down; *not readable*
	// would be the panel's last word being the wrong one.
	it('sets nothing at all on a refused session', async () => {
		expect(await groupsFrom({ ok: false, refusal: 'refused' })).toBe('loading');
	});
});
