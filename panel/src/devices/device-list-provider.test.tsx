import { SessionProvider, useSession } from '@panel/session/session-provider.js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/panel/list-devices.json';
import { DeviceListProvider, POLL_MS, useDeviceList } from './device-list-provider.js';

const STORAGE_KEY = 'rover.panel.session';

const fetchMock = vi.fn();

function answered(status: number, body: unknown): Response {
	return { status, json: async () => body } as unknown as Response;
}

function envelope(result: unknown): Response {
	return answered(200, { protocolVersion: 1, id: '1', type: 'result', result });
}

/**
 * A signed-in panel whose `/rpc` gives the listed answers in order, the last one repeating. Called
 * with none, `/rpc` never answers at all — which is how the state before the first answer is
 * reached.
 *
 * The real `SessionProvider` is driven rather than stubbed, because half of what this provider does
 * is hand a refusal back to it: the bounce to *access ended* is asserted through the machine that
 * performs it rather than against a spy on a private.
 */
function hostAnswers(...answers: readonly (Response | Error)[]): void {
	window.localStorage.setItem(STORAGE_KEY, 'a-session-id');
	let next = 0;
	fetchMock.mockImplementation(async (path: string) => {
		if (path === '/session') {
			return answered(200, { identifier: 'panel', displayName: 'Panel' });
		}
		if (answers.length === 0) {
			return await new Promise<Response>(() => undefined);
		}
		const answer = answers[Math.min(next, answers.length - 1)];
		next += 1;
		if (answer instanceof Error) {
			throw answer;
		}
		return answer;
	});
}

function ListProbe() {
	const { state, refresh } = useDeviceList();
	return (
		<>
			<p>list: {state.status === 'ready' ? `ready ${state.devices.length}` : state.status}</p>
			{/* `RETRY CONNECTION`'s stand-in, so the press is asserted through the real provider. */}
			<button onClick={refresh} type="button">
				retry
			</button>
		</>
	);
}

/**
 * `app.tsx`'s own arrangement, and the arrangement matters: the poll is mounted **inside** the
 * signed-in branch, so it never races the boot probe for the session state.
 */
function Harness() {
	const { state } = useSession();
	return (
		<>
			<p>session: {state.status}</p>
			{state.status === 'signed-in' ? (
				<DeviceListProvider>
					<ListProbe />
				</DeviceListProvider>
			) : null}
		</>
	);
}

function mount() {
	return render(
		<SessionProvider>
			<Harness />
		</SessionProvider>,
	);
}

/** Let every pending promise settle without letting the poll interval fire. */
async function settle(): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
	});
}

describe('the device poll', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Nothing has come back yet is not an empty list, and must never render as one.
	it('starts by reading, not by showing an empty list', async () => {
		hostAnswers();

		mount();

		await waitFor(() => expect(screen.getByText(/list: loading/)).toBeDefined());
	});

	it('parses a real answer into the grid’s state', async () => {
		hostAnswers(envelope(fixture));

		mount();

		await waitFor(() => expect(screen.getByText(/list: ready 3/)).toBeDefined());
		const rpc = fetchMock.mock.calls.find(([path]) => path === '/rpc') as [string, RequestInit];
		expect(JSON.parse(rpc[1].body as string).method).toBe('list_devices');
		expect((rpc[1].headers as Record<string, string>).authorization).toBe('Bearer a-session-id');
	});

	// Nothing usable came back, in each of the three ways that can happen. §7's headline "must not
	// claim to know which" is exactly why they collapse into one state here.
	it('is unreachable when nothing answers', async () => {
		hostAnswers(new TypeError('Failed to fetch'));

		mount();

		await waitFor(() => expect(screen.getByText(/list: unreachable/)).toBeDefined());
	});

	it('is unreachable when the host answers an error envelope', async () => {
		hostAnswers(
			answered(200, {
				protocolVersion: 1,
				id: '1',
				type: 'error',
				error: { code: 'internal_error', message: 'no' },
			}),
		);

		mount();

		await waitFor(() => expect(screen.getByText(/list: unreachable/)).toBeDefined());
	});

	it('is unreachable when the result is not the shape this panel reads', async () => {
		hostAnswers(envelope({ devices: [{ serial: 'emulator-5554' }], stale: false }));

		mount();

		await waitFor(() => expect(screen.getByText(/list: unreachable/)).toBeDefined());
	});

	/*
	 * A refused session is the session machine's business, not this provider's: `Session.call` fires
	 * `onRefusal`, the panel goes to *access ended*, and `app.tsx` takes the router down. Reporting
	 * "unreachable" over that would make the panel's last word the wrong one.
	 */
	it('leaves a refused session to the session, and does not call it unreachable', async () => {
		hostAnswers(answered(401, { error: { code: 'unauthenticated' } }));

		mount();

		await waitFor(() => expect(screen.getByText(/session: access-ended/)).toBeDefined());
		expect(screen.queryByText(/list: unreachable/)).toBeNull();
		expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('comes back on its own when the host does', async () => {
		vi.useFakeTimers();
		hostAnswers(new TypeError('Failed to fetch'), envelope(fixture));

		mount();
		await settle();
		expect(screen.getByText(/list: unreachable/)).toBeDefined();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_MS);
		});

		expect(screen.getByText(/list: ready 3/)).toBeDefined();
	});

	/** How many times `/rpc` has been asked, which is what both guard tests are actually about. */
	function asks(): number {
		return fetchMock.mock.calls.filter(([path]) => path === '/rpc').length;
	}

	// The guard's own case: a host slower than the interval must not have requests stacked on it.
	it('drops an interval tick that arrives while the last one is still outstanding', async () => {
		vi.useFakeTimers();
		hostAnswers();

		mount();
		await settle();
		expect(asks()).toBe(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		});

		expect(asks()).toBe(1);
	});

	/*
	 * And the case the guard must **not** cover. `RETRY CONNECTION` is reachable exactly while the
	 * host is unreachable, and a request can be outstanding in that state — the state was set by the
	 * previous poll's failure while the next tick's request is still open against a host that
	 * accepts the connection and never answers. The button is not a spinner (§5), so a press the
	 * guard swallowed would leave no trace at all.
	 */
	it('asks on a deliberate refresh even with a request already outstanding', async () => {
		vi.useFakeTimers();
		window.localStorage.setItem(STORAGE_KEY, 'a-session-id');
		fetchMock.mockImplementation(async (path: string) => {
			if (path === '/session') {
				return answered(200, { identifier: 'panel', displayName: 'Panel' });
			}
			// The first ask fails outright, which is what puts the panel on the unreachable page;
			// every ask after it is accepted and never answered.
			if (asks() === 1) {
				throw new TypeError('Failed to fetch');
			}
			return await new Promise<Response>(() => undefined);
		});

		mount();
		await settle();
		expect(screen.getByText(/list: unreachable/)).toBeDefined();

		// One tick, whose request is still open when the press arrives.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_MS);
		});
		const outstanding = asks();

		await act(async () => {
			fireEvent.click(screen.getByText('retry'));
		});

		expect(asks()).toBe(outstanding + 1);
	});

	it('stops asking when it goes away', async () => {
		vi.useFakeTimers();
		hostAnswers(envelope(fixture));

		const { unmount } = mount();
		await settle();
		expect(screen.getByText(/list: ready 3/)).toBeDefined();

		unmount();
		const asked = fetchMock.mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		});

		expect(fetchMock.mock.calls).toHaveLength(asked);
	});
});
