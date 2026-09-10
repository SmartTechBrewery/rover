import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The host, scripted per scope. `useSession` is mocked rather than driven through the real
 * `SessionProvider` for `archive-levels.test.tsx`'s reason: what is in question here is only what
 * this hook asks for and how it folds the answer.
 */
const { host } = vi.hoisted(() => ({ host: { call: vi.fn() } }));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({ call: host.call }),
}));

import {
	type ArchiveSize,
	type GroupedSizeScope,
	useArchiveSize,
	useGroupedArchiveSize,
} from './archive-size.js';

function result(value: unknown) {
	return { ok: true as const, value: { type: 'result' as const, result: value } };
}

const MEASURED = result({ outcome: 'measured', bytes: 8_074_035, truncated: false });

/** Renders one scope's state as text, so the fold is assertable. */
function Size({ path }: { readonly path: readonly string[] | null }) {
	const size: ArchiveSize = useArchiveSize(path);
	return <p data-testid="size">{describe_(size)}</p>;
}

function describe_(size: ArchiveSize): string {
	return size.status === 'measured' ? `measured:${size.bytes}:${size.truncated}` : size.status;
}

/** Renders one grouped scope's state as text, on {@link Size}'s exact terms (#262). */
function GroupedSize({ scope }: { readonly scope: GroupedSizeScope | null }) {
	const size: ArchiveSize = useGroupedArchiveSize(scope);
	return <p data-testid="size">{describe_(size)}</p>;
}

const PROJECT = ['checkout-app'];
const GROUP: GroupedSizeScope = {
	scope: 'group',
	project: 'checkout-app',
	groupId: 'app-bar-top-space',
};

describe('the size of one scope', () => {
	it('asks `measure_archive` once, for the scope it was given and no other', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(MEASURED);

		render(<Size path={PROJECT} />);

		await waitFor(() => {
			expect(screen.getByTestId('size').textContent).toBe('measured:8074035:false');
		});
		expect(host.call.mock.calls).toEqual([['measure_archive', { path: PROJECT }]]);
	});

	// The artifact context, and every state with no scope: `null` asks for nothing, so the deepest
	// address on the screen costs no round trip at all.
	it('asks for nothing at all, and stays `loading`, for a `null` scope', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(MEASURED);

		render(<Size path={null} />);
		await act(async () => undefined);

		expect(host.call).not.toHaveBeenCalled();
		expect(screen.getByTestId('size').textContent).toBe('loading');
	});

	/*
	 * The assertion the hook's `asked` ref exists for. React 19's StrictMode runs an effect twice on
	 * mount, so a guard held in state would have made two walks of the archive for one screen —
	 * visible in the daemon's own log, and the one cost this badge is not allowed to have.
	 */
	it('asks once under StrictMode, not twice', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(MEASURED);

		render(
			<StrictMode>
				<Size path={PROJECT} />
			</StrictMode>,
		);

		await waitFor(() => expect(host.call).toHaveBeenCalled());
		expect(host.call).toHaveBeenCalledTimes(1);
	});

	/*
	 * A scope is measured on navigation and never on an interval, and a re-render naming the same
	 * scope is not a reason to walk it again. **The reason is no longer *the archive is finished
	 * data*** (#287): the drawn listings refresh on a clock while a lease is live, and this
	 * deliberately does not, because a measurement is a **disk walk per scope** and a badge that
	 * re-walked the archive every few seconds while runs land is a worse bug than a stale figure.
	 * So this gate stays, and it is now pinning a decision rather than a premise.
	 */
	it('asks nothing further on a re-render with the same scope', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(MEASURED);
		const { rerender } = render(<Size path={PROJECT} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));

		rerender(<Size path={['checkout-app']} />);
		await act(async () => undefined);

		expect(host.call).toHaveBeenCalledTimes(1);
	});

	// One call per scope, and the answer kept — so navigating deeper and back again is one walk per
	// address rather than one per visit.
	it('asks once per scope, and no second time for a scope it has answered', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(MEASURED);
		const { rerender } = render(<Size path={PROJECT} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));

		rerender(<Size path={['checkout-app', 'login-flow']} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(2));
		rerender(<Size path={PROJECT} />);
		await act(async () => undefined);

		expect(host.call).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId('size').textContent).toBe('measured:8074035:false');
	});

	// No deadline: a budget belongs to a repeating caller with an interval to spend, and this one
	// has neither (`host-client.ts`).
	it('sets no deadline on the request', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(MEASURED);

		render(<Size path={PROJECT} />);

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));
		expect(host.call.mock.calls[0]?.[2]).toBeUndefined();
	});
});

/**
 * **The second entry point** (#262) — the groups view's three scopes, which describe a subset of
 * the archive rather than a directory in it, so they name a second host method and not a path.
 *
 * Everything else about them is the entry point above's, because it is the same implementation:
 * one call per scope, the answer kept for the life of the screen, `null` asking for nothing, and
 * one call under StrictMode rather than two.
 */
describe('the size of one grouped scope', () => {
	it('asks `measure_archive_groups` once, with the scope it was given verbatim', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(MEASURED);

		render(<GroupedSize scope={GROUP} />);

		await waitFor(() => {
			expect(screen.getByTestId('size').textContent).toBe('measured:8074035:false');
		});
		expect(host.call.mock.calls).toEqual([['measure_archive_groups', GROUP]]);
	});

	// The three scopes go over the wire as the host's own params and nothing is composed here: a
	// `groupId` names no directory, so it is never joined into a path (R41, D22).
	it('asks each of the three scopes in the host’s own shape', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(MEASURED);
		const { rerender } = render(<GroupedSize scope={{ scope: 'all' }} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));

		rerender(<GroupedSize scope={{ scope: 'project', project: 'checkout-app' }} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(2));
		rerender(<GroupedSize scope={GROUP} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(3));

		expect(host.call.mock.calls.map((call) => call[1])).toEqual([
			{ scope: 'all' },
			{ scope: 'project', project: 'checkout-app' },
			GROUP,
		]);
	});

	it('asks for nothing at all, and stays `loading`, for a `null` scope', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(MEASURED);

		render(<GroupedSize scope={null} />);
		await act(async () => undefined);

		expect(host.call).not.toHaveBeenCalled();
		expect(screen.getByTestId('size').textContent).toBe('loading');
	});

	it('asks once under StrictMode, not twice', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(MEASURED);

		render(
			<StrictMode>
				<GroupedSize scope={GROUP} />
			</StrictMode>,
		);

		await waitFor(() => expect(host.call).toHaveBeenCalled());
		expect(host.call).toHaveBeenCalledTimes(1);
	});

	/*
	 * **Two groups of one project are two scopes and one group is one**, which is what the key's
	 * shape is for: the opaque `groupId` comes last, so no pair of projects and group ids can
	 * collide, and navigating back to a group it has answered for is free.
	 */
	it('asks once per group, and no second time for one it has answered', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(MEASURED);
		const { rerender } = render(<GroupedSize scope={GROUP} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));

		rerender(<GroupedSize scope={{ ...GROUP, groupId: 'basket-total' }} />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(2));
		rerender(<GroupedSize scope={{ ...GROUP }} />);
		await act(async () => undefined);

		expect(host.call).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId('size').textContent).toBe('measured:8074035:false');
	});

	// The same fold, because it is the same function: a grouped scope the host could not read is
	// `unmeasurable`, and a scope it measured as holding nothing grouped is a measured `0`.
	it('folds the host’s answer exactly as an address’s is folded', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(result({ outcome: 'measured', bytes: 0, truncated: false }));
		const { unmount } = render(<GroupedSize scope={{ scope: 'all' }} />);
		await act(async () => undefined);
		expect(screen.getByTestId('size').textContent).toBe('measured:0:false');
		unmount();

		host.call.mockReset();
		host.call.mockResolvedValue(result({ outcome: 'unreadable' }));
		render(<GroupedSize scope={{ scope: 'all' }} />);
		await act(async () => undefined);
		expect(screen.getByTestId('size').textContent).toBe('unmeasurable');
	});
});

describe('what one answer becomes', () => {
	/*
	 * One answer, one mount, and the mount taken down again — the states below are asserted several
	 * to a test and two mounts at once would each carry a `size` line.
	 *
	 * `act` rather than `waitFor`, because two of these cases stay `loading` for good: waiting for
	 * one to change would either time out or pass vacuously.
	 */
	async function sizeFrom(answer: unknown): Promise<string> {
		host.call.mockReset();
		host.call.mockResolvedValue(answer);
		const { unmount } = render(<Size path={PROJECT} />);
		await act(async () => undefined);
		const described = screen.getByTestId('size').textContent ?? '';
		unmount();
		return described;
	}

	it('is `loading` before anything comes back — never a zero', async () => {
		host.call.mockReset();
		host.call.mockReturnValue(new Promise(() => undefined));

		render(<Size path={PROJECT} />);

		expect(screen.getByTestId('size').textContent).toBe('loading');
	});

	it('carries the bytes and the bound the host answered with', async () => {
		expect(await sizeFrom(MEASURED)).toBe('measured:8074035:false');
		expect(await sizeFrom(result({ outcome: 'measured', bytes: 80, truncated: true }))).toBe(
			'measured:80:true',
		);
	});

	// The pair D6 forbids rendering alike, and the reason the fixture measures one directory twice:
	// a readable empty directory is a measurement, and a sealed one is not a size at all.
	it('keeps a measured zero apart from a size it could not take', async () => {
		expect(await sizeFrom(result({ outcome: 'measured', bytes: 0, truncated: false }))).toBe(
			'measured:0:false',
		);
		expect(await sizeFrom(result({ outcome: 'unreadable' }))).toBe('unmeasurable');
	});

	it('folds the host’s `missing` onto `absent`, which draws nothing', async () => {
		expect(await sizeFrom(result({ outcome: 'missing' }))).toBe('absent');
	});

	/*
	 * `useArchiveLevels`'s own fold: what the screen has to decide is narrower than why, and *the
	 * host could not measure this* is the sentence that is true either way.
	 */
	it('folds an error envelope, an unparseable answer and an unanswered request together', async () => {
		expect(
			await sizeFrom({
				ok: true,
				value: { type: 'error', error: { code: 'internal', message: 'no' } },
			}),
		).toBe('unmeasurable');
		expect(await sizeFrom(result({ outcome: 'measured', bytes: 'lots', truncated: false }))).toBe(
			'unmeasurable',
		);
		expect(await sizeFrom(result({ outcome: 'no such outcome' }))).toBe('unmeasurable');
		expect(await sizeFrom({ ok: false, refusal: 'unanswered' })).toBe('unmeasurable');
	});

	// `Session.call` has already fired `onRefusal` and the router is coming down; a badge claiming
	// the host could not measure would be the panel's last word being the wrong one.
	it('sets nothing at all on a refused session', async () => {
		expect(await sizeFrom({ ok: false, refusal: 'refused' })).toBe('loading');
	});
});
