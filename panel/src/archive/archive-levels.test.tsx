import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

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
function Levels({ paths }: { readonly paths: readonly (readonly string[])[] }) {
	const { levels, reread } = useArchiveLevels(() => paths);
	return (
		<>
			{/*
			 * The hook's one trigger, given a control here so a case can fire it. On the screen it
			 * has exactly one caller and it is not a control at all — a settled `Remove`
			 * (`routes/archive.tsx`), which is what keeps *no refresh control* true of §9.
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

	// The archive is finished data: a level is read on navigation and never on an interval, and a
	// re-render is not a reason to ask again.
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

	// No deadline: a budget belongs to a repeating caller with an interval to spend, and this one
	// has neither (`host-client.ts`).
	it('sets no deadline on the request', async () => {
		host.call.mockResolvedValue(listed('checkout-app'));

		render(<Levels paths={[[]]} />);

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));
		expect(host.call.mock.calls[0]?.[2]).toBeUndefined();
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
		// And nothing further: a re-read is one pass, not an interval (§9 — no polling).
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
