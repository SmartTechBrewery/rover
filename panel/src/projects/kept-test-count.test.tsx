import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The host, scripted per test. `useSession` is mocked rather than driven through the real
 * `SessionProvider` because what is in question here is only what this hook asks for and how it
 * folds the answer.
 */
const { host } = vi.hoisted(() => ({ host: { call: vi.fn() } }));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({ call: host.call }),
}));

import { useKeptTestCount } from './kept-test-count.js';

function result(value: unknown) {
	return { ok: true as const, value: { type: 'result' as const, result: value } };
}

/** One line, so the hook's state is assertable as text. */
function Probe({ project = 'checkout-web' }: { readonly project?: string }) {
	const count = useKeptTestCount(project);
	return (
		<p data-testid="count">
			{count.status === 'counted' ? `counted:${count.count}` : count.status}
		</p>
	);
}

/** One answer, one mount, taken down again so two probes are never in the DOM at once. */
async function countFrom(value: unknown, project = 'checkout-web'): Promise<string> {
	host.call.mockReset();
	host.call.mockResolvedValue(value);
	const { unmount } = render(<Probe project={project} />);
	// `act` rather than `waitFor`: one of these cases stays `loading` for good, and waiting for it
	// to change would either time out or pass vacuously.
	await act(async () => undefined);
	const described = screen.getByTestId('count').textContent ?? '';
	unmount();
	return described;
}

const THREE = result({
	outcome: 'listed',
	tests: [
		{ project: 'checkout-web', testName: 'the checkout flow' },
		{ project: 'checkout-web', testName: 'the basket' },
		// Another project reusing one of the same test names, which is exactly why the store keys a
		// test on the pair (`PROJECT.md` §10, D33).
		{ project: 'rover-sandbox', testName: 'the checkout flow' },
	],
});

describe('the one read this makes', () => {
	it('asks `list_kept_tests` once, with no parameter at all', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(THREE);

		render(<Probe />);

		await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('counted:2'));
		expect(host.call.mock.calls).toEqual([['list_kept_tests', {}]]);
	});

	/*
	 * React 19's StrictMode runs a mount effect twice, and the panel is mounted inside one
	 * (`main.tsx`), so a guard held in state would read the host's store twice for one dialog —
	 * visible in the daemon's own log.
	 */
	it('asks once under StrictMode, not twice', async () => {
		host.call.mockReset();
		host.call.mockResolvedValue(THREE);

		render(
			<StrictMode>
				<Probe />
			</StrictMode>,
		);

		await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('counted:2'));
		expect(host.call).toHaveBeenCalledTimes(1);
	});

	// An answer that outlives the dialog lands on nothing rather than on an unmounted tree.
	it('sets nothing when the answer arrives after the dialog is gone', async () => {
		host.call.mockReset();
		let answer: (value: unknown) => void = () => undefined;
		host.call.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const { unmount } = render(<Probe />);
		unmount();

		answer(THREE);

		await expect(act(async () => undefined)).resolves.toBeUndefined();
	});
});

describe('what one answer becomes', () => {
	// The filter is the whole of what this hook adds: the method answers the host's entire set, and
	// the dialog is about one project.
	it('counts this project’s tests and no other project’s', async () => {
		expect(await countFrom(THREE, 'checkout-web')).toBe('counted:2');
		expect(await countFrom(THREE, 'rover-sandbox')).toBe('counted:1');
	});

	/*
	 * **`0` is an answer, not an absence.** *None of this project's tests are kept* is the fact that
	 * stops the dialog's next line being alarming, so it is counted and said.
	 */
	it('counts a project with nothing kept as zero rather than as unknown', async () => {
		expect(await countFrom(THREE, 'legacy-kiosk')).toBe('counted:0');
		expect(await countFrom(result({ outcome: 'listed', tests: [] }))).toBe('counted:0');
	});

	/*
	 * Everything unusable folds into `unknown`, and the fold matters in one direction only: an
	 * `unreadable` store drawn as `0` would claim something about the operator's own decisions that
	 * nothing has established.
	 */
	it('folds an unreadable store, an error envelope, an unparseable result and no reply into `unknown`', async () => {
		expect(await countFrom(result({ outcome: 'unreadable' }))).toBe('unknown');
		expect(
			await countFrom({
				ok: true,
				value: { type: 'error', error: { code: 'internal', message: 'no' } },
			}),
		).toBe('unknown');
		expect(await countFrom(result({ outcome: 'partially listed' }))).toBe('unknown');
		expect(await countFrom({ ok: false, refusal: 'unanswered' })).toBe('unknown');
	});

	// `Session.call` has already fired `onRefusal` and the router is coming down; *the host cannot
	// say* would be the panel's last word being the wrong one.
	it('sets nothing at all on a refused session', async () => {
		expect(await countFrom({ ok: false, refusal: 'refused' })).toBe('loading');
	});

	it('is `loading` before anything comes back — never a count of none', () => {
		host.call.mockReset();
		host.call.mockReturnValue(new Promise(() => undefined));

		render(<Probe />);

		expect(screen.getByTestId('count').textContent).toBe('loading');
	});
});
