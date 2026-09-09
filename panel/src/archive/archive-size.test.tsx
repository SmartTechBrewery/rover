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

import { type ArchiveSize, useArchiveSize } from './archive-size.js';

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

const PROJECT = ['checkout-app'];

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

	// The archive is finished data: a scope is measured on navigation and never on an interval, and
	// a re-render naming the same scope is not a reason to walk it again.
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
