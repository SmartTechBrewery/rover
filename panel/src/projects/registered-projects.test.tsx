import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The host, scripted per test. `useSession` is mocked rather than driven through the real
 * `SessionProvider` because what is in question here is only what this hook asks for and how it
 * folds the answer — the credential machinery has its own suite.
 */
const { host } = vi.hoisted(() => ({ host: { call: vi.fn() } }));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({ call: host.call }),
}));

import { useRegisteredProjects } from './registered-projects.js';

function result(value: unknown) {
	return { ok: true as const, value: { type: 'result' as const, result: value } };
}

function registered(project: string) {
	return {
		kind: 'registered',
		project,
		apps: [],
		hasInstall: false,
		services: [],
		hasTeardown: false,
	};
}

/** One line, so the hook's state is assertable as text. */
function Probe() {
	const state = useRegisteredProjects();
	return (
		<p data-testid="state">
			{state.status === 'listed'
				? `listed:${state.projects.map((project) => project.project).join(',')}`
				: state.status}
		</p>
	);
}

describe('the one request this screen makes', () => {
	it('asks `list_projects` once, with no parameter at all', async () => {
		host.call.mockResolvedValue(result({ outcome: 'listed', projects: [registered('a')] }));

		render(<Probe />);

		await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('listed:a'));
		expect(host.call.mock.calls).toEqual([['list_projects', {}]]);
	});

	/*
	 * React 19's StrictMode runs a mount effect twice, so a guard held in state would have let the
	 * root be read twice — visible in the daemon's own log as two `readdir`s for one screen.
	 */
	it('asks once under StrictMode, not twice', async () => {
		host.call.mockResolvedValue(result({ outcome: 'listed', projects: [registered('a')] }));

		render(
			<StrictMode>
				<Probe />
			</StrictMode>,
		);

		await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('listed:a'));
		expect(host.call).toHaveBeenCalledTimes(1);
	});

	// A registration changes when a person edits a file on the host, and this screen makes no
	// claim to see that happen (`docs/DESIGN.md` §10): one fetch on navigation, and no interval.
	it('asks nothing further on a re-render', async () => {
		host.call.mockResolvedValue(result({ outcome: 'listed', projects: [registered('a')] }));
		const { rerender } = render(<Probe />);
		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));

		rerender(<Probe />);
		await act(async () => undefined);

		expect(host.call).toHaveBeenCalledTimes(1);
	});

	// No deadline: a budget belongs to a repeating caller with an interval to spend, and this one
	// has neither (`host-client.ts`).
	it('sets no deadline on the request', async () => {
		host.call.mockResolvedValue(result({ outcome: 'listed', projects: [registered('a')] }));

		render(<Probe />);

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));
		expect(host.call.mock.calls[0]?.[2]).toBeUndefined();
	});

	// An answer that outlives the screen lands on nothing rather than on an unmounted tree.
	it('sets nothing when the answer arrives after the screen is gone', async () => {
		let answer: (value: unknown) => void = () => undefined;
		host.call.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const { unmount } = render(<Probe />);
		unmount();

		answer(result({ outcome: 'listed', projects: [registered('a')] }));

		await expect(act(async () => undefined)).resolves.toBeUndefined();
	});
});

describe('what one answer becomes', () => {
	/** One answer, one mount, taken down again so two probes are never in the DOM at once. */
	async function stateFrom(value: unknown): Promise<string> {
		host.call.mockReset();
		host.call.mockResolvedValue(value);
		const { unmount } = render(<Probe />);
		// `act` rather than `waitFor`: one of these cases stays `loading` for good, and waiting for
		// it to change would either time out or pass vacuously.
		await act(async () => undefined);
		const described = screen.getByTestId('state').textContent ?? '';
		unmount();
		return described;
	}

	it('is `loading` before anything comes back — never an empty listing', () => {
		host.call.mockReturnValue(new Promise(() => undefined));

		render(<Probe />);

		expect(screen.getByTestId('state').textContent).toBe('loading');
	});

	it('keeps the registrations in the host’s own order', async () => {
		expect(
			await stateFrom(
				result({
					outcome: 'listed',
					projects: [
						registered('checkout-web'),
						{ kind: 'unreadable', project: 'legacy-kiosk' },
						registered('rover-sandbox'),
					],
				}),
			),
		).toBe('listed:checkout-web,legacy-kiosk,rover-sandbox');
	});

	/*
	 * §10's deliberate fold: a host with no projects root and a host whose root holds nothing are
	 * the same sentence to a reader, and the same next step — `rover init`.
	 */
	it('folds an empty listing and a missing root into `empty`', async () => {
		expect(await stateFrom(result({ outcome: 'listed', projects: [] }))).toBe('empty');
		expect(await stateFrom(result({ outcome: 'missing' }))).toBe('empty');
	});

	it('keeps `unreadable` apart from `empty`', async () => {
		expect(await stateFrom(result({ outcome: 'unreadable' }))).toBe('unreadable');
	});

	/*
	 * The fold `device-list-provider.tsx` and `archive-levels.ts` both already make: what the
	 * screen has to decide is narrower than why, and *not readable* is true either way.
	 */
	it('folds an error envelope, an unparseable result and an unanswered request together', async () => {
		expect(
			await stateFrom({
				ok: true,
				value: { type: 'error', error: { code: 'internal', message: 'no' } },
			}),
		).toBe('unreadable');
		expect(await stateFrom(result({ outcome: 'partially listed' }))).toBe('unreadable');
		expect(await stateFrom({ ok: false, refusal: 'unanswered' })).toBe('unreadable');
	});

	// `Session.call` has already fired `onRefusal` and the router is coming down; *not readable*
	// would be the panel's last word being the wrong one.
	it('sets nothing at all on a refused session', async () => {
		expect(await stateFrom({ ok: false, refusal: 'refused' })).toBe('loading');
	});
});
