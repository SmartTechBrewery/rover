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

/** One device the way the host lists it, with only what a count and a card need varied. */
function device(serial: string, state = 'ready'): unknown {
	return {
		serial,
		platform: 'android',
		model: 'sdk_gphone64_arm64',
		osVersion: '15',
		osApiLevel: 35,
		state,
		attachment: 'this-host',
		heldBy: null,
	};
}

/**
 * A host that accepts the request and never answers it — **and honours the abort**, which is the
 * one contract a stub of `fetch` has to keep for #125 to be testable at all. A mock that ignored
 * the signal would report the wedge as fixed while a browser still froze on it.
 */
const HANGS = Symbol('accepted, never answered');

type ScriptedAnswer = Response | Error | typeof HANGS;

function hangs(signal: AbortSignal | undefined): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		signal?.addEventListener('abort', () =>
			reject(new DOMException('The operation was aborted.', 'AbortError')),
		);
	});
}

/**
 * A signed-in panel whose `/rpc` gives the listed answers in order, the last one repeating. Called
 * with none, `/rpc` never answers at all — which is how the state before the first answer is
 * reached, and it abandons the request when the caller does.
 *
 * The real `SessionProvider` is driven rather than stubbed, because half of what this provider does
 * is hand a refusal back to it: the bounce to *access ended* is asserted through the machine that
 * performs it rather than against a spy on a private.
 */
function hostAnswers(...answers: readonly ScriptedAnswer[]): void {
	window.localStorage.setItem(STORAGE_KEY, 'a-session-id');
	let next = 0;
	fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
		if (path === '/session') {
			return answered(200, { identifier: 'panel', displayName: 'Panel' });
		}
		if (answers.length === 0) {
			return await hangs(init?.signal ?? undefined);
		}
		const answer = answers[Math.min(next, answers.length - 1)];
		next += 1;
		if (answer === HANGS) {
			return await hangs(init?.signal ?? undefined);
		}
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

	/*
	 * The guard's own case: a host slower than the interval must not have requests stacked on it.
	 * Never two outstanding at once, and — since #125 — never zero for longer than the deadline.
	 *
	 * Three asks over three intervals rather than four, and the missing one is the guard doing its
	 * job: the deadline the *first* ask set is due at the same instant as the tick that would
	 * replace it, and after that first pairing the interval is the older timer of the two and fires
	 * while the request it would replace is still open. So a host that answers nothing at all is
	 * asked on every other interval, which is the cost of releasing the guard in `finally` alone —
	 * and a host that swallows **one** answer loses exactly one interval, which is the case that
	 * matters and the one the next test pins.
	 */
	it('drops an interval tick that arrives while the last one is still outstanding', async () => {
		vi.useFakeTimers();
		hostAnswers();

		mount();
		await settle();
		expect(asks()).toBe(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		});

		expect(asks()).toBe(3);
	});

	/*
	 * #125, at the seam the update was lost on. One request the host accepted and never answered
	 * used to hold the guard above for the life of the tab: the interval went on firing, every tick
	 * was dropped, no further `/rpc` ever left the browser, and the grid froze on the last good
	 * answer while the countdown went on ticking locally from `receivedAtMs`. Nothing on the screen
	 * said so and only a reload corrected it.
	 *
	 * Without the deadline this ends on `ready 3` with `asks()` stuck at 2 forever, however far the
	 * clock is advanced — which is the reported bug exactly.
	 */
	it('keeps polling after a request the host accepts and never answers', async () => {
		vi.useFakeTimers();
		hostAnswers(
			envelope(fixture),
			HANGS,
			envelope({ devices: [device('emulator-5554')], stale: false }),
		);

		mount();
		await settle();
		expect(screen.getByText(/list: ready 3/)).toBeDefined();

		// The tick that is swallowed. It goes out; nothing comes back.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_MS);
		});
		expect(asks()).toBe(2);
		expect(screen.getByText(/list: ready 3/)).toBeDefined();

		// Its budget runs out: the request is abandoned, and the screen says it has nothing current
		// rather than going on showing what it had.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_MS);
		});
		expect(screen.getByText(/list: unreachable/)).toBeDefined();

		// And the poll comes back on its own, with the host's new answer.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_MS);
		});
		expect(asks()).toBe(3);
		expect(screen.getByText(/list: ready 1/)).toBeDefined();
	});

	/*
	 * And the acceptance criterion the screen is actually judged on: with nothing touched, the state
	 * follows the host answer for answer. A detach is the middle step and an empty host the last —
	 * `stale: false` throughout, so none of it is the *no view* state wearing a disguise.
	 */
	it('follows the host across a detach, with the screen untouched', async () => {
		vi.useFakeTimers();
		hostAnswers(
			envelope({ devices: [device('emulator-5554'), device('emulator-5556')], stale: false }),
			envelope({ devices: [device('emulator-5554')], stale: false }),
			envelope({ devices: [], stale: false }),
		);

		mount();
		await settle();
		expect(screen.getByText(/list: ready 2/)).toBeDefined();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_MS);
		});
		expect(screen.getByText(/list: ready 1/)).toBeDefined();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_MS);
		});
		expect(screen.getByText(/list: ready 0/)).toBeDefined();
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
		fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
			if (path === '/session') {
				return answered(200, { identifier: 'panel', displayName: 'Panel' });
			}
			// The first ask fails outright, which is what puts the panel on the unreachable page;
			// every ask after it is accepted and never answered.
			if (asks() === 1) {
				throw new TypeError('Failed to fetch');
			}
			return await hangs(init?.signal ?? undefined);
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
