import type { TestRemoval } from '@panel/archive/delete-archived-test.js';
import { BADGE_SHAPE, BADGE_TYPE } from '@panel/components/archive/header-badge.js';
import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The session the control reads: the identity it attributes the call with, and every call it or its
 * dialog makes. `answer` is what the host says back to `delete_archived_test`, set per test; the
 * dialog's one read is answered so the confirmation renders without a pending row.
 */
const { host } = vi.hoisted(() => ({
	host: {
		answer: { ok: true, value: { type: 'result', result: {} } } as HostAnswer<RpcEnvelope>,
		calls: [] as unknown[][],
	},
}));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({
		state: {
			status: 'signed-in',
			identity: { identifier: 'karolina', displayName: 'Karolina Waldon' },
		},
		call: async (method: string, params: unknown): Promise<HostAnswer<RpcEnvelope>> => {
			host.calls.push([method, params]);
			if (method === 'measure_archive') {
				return {
					ok: true,
					value: {
						type: 'result',
						result: { outcome: 'measured', bytes: 4_180_532, truncated: false },
					},
				};
			}
			return host.answer;
		},
	}),
}));

import { RemoveControl } from './remove-control.js';

/**
 * The control, and what it does with each of the answers.
 *
 * Where the settled ones are *said* is not here — three of the four take the card the control is on
 * out from under the answer, so a settled outcome is reported up and said above the content area
 * (`remove-notice.tsx`, `routes/archive.tsx`, `docs/DESIGN.md` §9). What stays here is the one that
 * settled nothing.
 */

const DELETED = {
	outcome: 'deleted',
	archive: 'removed',
	keptTests: 'removed',
	freedBytes: 4_180_532,
	keptTestsRemoved: 1,
};

const TEST: TestRemoval = {
	project: 'checkout-web',
	testName: 'login-flow',
	runs: 42,
	kept: true,
	card: 'test',
};

function control(onSettled = vi.fn(), removal: TestRemoval = TEST) {
	const rendered = render(<RemoveControl onSettled={onSettled} removal={removal} />);
	return { ...rendered, onSettled };
}

/** The control on the card, which is not the one in the dialog's footer. */
function onTheCard(): HTMLElement {
	return screen.getByRole('button', { name: 'Remove test login-flow' });
}

/**
 * Press the control and let the dialog's read land.
 *
 * The flush is not incidental: the confirmation asks `measure_archive` as it mounts, so without it
 * that answer sets state outside `act` and every assertion below runs under a warning instead of
 * against the rendered dialog.
 */
async function ask(): Promise<void> {
	fireEvent.click(onTheCard());
	await act(async () => undefined);
}

function confirm(): void {
	fireEvent.click(screen.getByRole('button', { name: 'Remove test' }));
}

function deleteCalls(): unknown[][] {
	return host.calls.filter(([method]) => method === 'delete_archived_test');
}

beforeEach(() => {
	host.calls = [];
	host.answer = { ok: true, value: { type: 'result', result: DELETED } };
});

/**
 * **§10's badge treatment and not a new one**, taken out of `header-badge.tsx` so this control and
 * the Projects card's cannot drift apart by a border width — the `error` accent on the glyph and the
 * words and never a fill, the frame neutral until the pointer is on it, and the test in the
 * accessible name because the visible word is the same on every card.
 */
describe('the control in the strip', () => {
	it('takes the header badge’s own shape and type', () => {
		control();

		const { className } = onTheCard();
		for (const shared of [...BADGE_SHAPE.split(' '), ...BADGE_TYPE.split(' ')]) {
			expect(className).toContain(shared);
		}
	});

	it('accents in `error` without filling with it', () => {
		control();

		const { className } = onTheCard();
		expect(className).toContain('text-error');
		expect(className).toContain('hover:border-error');
		expect(className).toContain('border-outline-variant');
		expect(className).not.toContain('bg-error');
	});

	// It is a word and a glyph, and the pair has to survive a strip that already holds a name and a
	// tick: the control never shrinks, so the heading is what wraps (`level-contents.tsx`).
	it('never shrinks, so the name beside it is what wraps', () => {
		control();

		expect(onTheCard().className).toContain('shrink-0');
	});

	it('names the test it is about, and hides the glyph from a reader that has the word', () => {
		control();

		const button = onTheCard();
		expect(button.textContent).toBe('Remove');
		const glyph = button.querySelector('svg');
		expect(glyph).not.toBeNull();
		expect(glyph?.getAttribute('aria-hidden')).toBe('true');
	});

	/*
	 * The visible word is `Remove` on every card, so the accessible name is what tells two of them
	 * apart — checked against a 40-character run-shaped name, which is the length that forced §9's
	 * *the sentence did not fit* finding, and against a test name of the same length.
	 */
	it('carries the whole of a long test name in its accessible name', () => {
		const long = '20260830T170501Z-issue-112-9f1c2ab4-long';
		control(vi.fn(), { ...TEST, testName: long });

		expect(screen.getByRole('button', { name: `Remove test ${long}` }).textContent).toBe('Remove');
	});

	// Nothing is asked of the host until the operator has been asked (§7).
	it('asks before it deletes anything', async () => {
		control();

		await ask();

		expect(screen.getByRole('dialog')).toBeDefined();
		expect(deleteCalls()).toHaveLength(0);
	});

	/*
	 * The dialog is mounted on `document.body` rather than inside this control —
	 * `force-release-control.tsx`'s recorded reason, and it bites harder here: this control's
	 * ancestors include a card whose own `<section>` carries `overflow-hidden`
	 * (`contents-card.tsx`).
	 */
	it('opens the dialog outside the card’s own tree', async () => {
		const { container } = control();

		await ask();

		const dialog = screen.getByRole('dialog');
		expect(container.contains(dialog)).toBe(false);
		expect(document.body.contains(dialog)).toBe(true);
	});

	it('closes the dialog on cancel, and returns focus to itself', async () => {
		control();
		await ask();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.activeElement).toBe(onTheCard());
		expect(deleteCalls()).toHaveLength(0);
	});
});

describe('confirming', () => {
	// D28: the actor is the signed-in user's identifier, so the daemon's audit line names a person
	// rather than a browser. Never a constant like `panel`, and never a free-text field.
	it('attributes the call to the signed-in user, and names the test by its two components', async () => {
		control();
		await ask();

		confirm();

		await waitFor(() => expect(deleteCalls()).toHaveLength(1));
		expect(deleteCalls()[0]).toEqual([
			'delete_archived_test',
			{ project: 'checkout-web', testName: 'login-flow', actor: 'karolina' },
		]);
		expect(JSON.stringify(deleteCalls()[0])).not.toContain('panel');
		// The components and never a path (D19) — the host composes every path from its own roots.
		expect(JSON.stringify(deleteCalls()[0])).not.toContain('path');
	});

	// One press is one request, whatever the answer: nothing here retries and nothing polls.
	it('asks the host once for one confirmed press', async () => {
		control();
		await ask();

		confirm();

		await waitFor(() => expect(deleteCalls()).toHaveLength(1));
		await act(async () => undefined);
		expect(deleteCalls()).toHaveLength(1);
	});

	it.each([
		['a test that went', DELETED],
		['an address there was nothing at', { outcome: 'not-found' }],
		[
			'a delete that left a half behind',
			{
				outcome: 'partial',
				archive: 'failed',
				keptTests: 'absent',
				freedBytes: 0,
				keptTestsRemoved: 0,
			},
		],
		['a live lease', { outcome: 'refused', reason: 'lease-live' }],
	])('closes the dialog and reports %s upward', async (_case, result) => {
		host.answer = { ok: true, value: { type: 'result', result } };
		const { onSettled } = control();
		await ask();

		confirm();

		await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
		expect(onSettled.mock.calls[0]?.[0]).toEqual(result);
		expect(onSettled.mock.calls[0]?.[1]).toEqual(TEST);
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});

/**
 * The request that reached nothing. **Nothing was deleted, so nothing closes and nothing is
 * claimed**: the dialog stays where it is, the control comes back, and the same ask can be made
 * again. Nothing is said above the content area either, because nothing settled.
 */
describe('the ask that reached nothing', () => {
	it('keeps the dialog open, says so, and re-enables the control', async () => {
		host.answer = { ok: false, refusal: 'unanswered' };
		const { onSettled } = control();
		await ask();

		confirm();

		await waitFor(() => expect(screen.getByText(/nothing was deleted/i)).toBeDefined());
		expect(screen.getByRole('dialog')).toBeDefined();
		expect(onSettled).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Remove test' }).getAttribute('disabled')).toBeNull();
	});

	// A second ask is a real second request, and the line from the first does not sit under it.
	it('clears the line when the ask is made again', async () => {
		host.answer = { ok: false, refusal: 'unanswered' };
		control();
		await ask();
		confirm();
		await waitFor(() => expect(screen.getByText(/nothing was deleted/i)).toBeDefined());

		host.answer = { ok: true, value: { type: 'result', result: DELETED } };
		confirm();

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(deleteCalls()).toHaveLength(2);
	});

	/*
	 * The host refused the session instead. `Session.call` has already fired the bounce and the
	 * router is coming down, so this control says nothing at all — a line about a test would be the
	 * panel's last word being the wrong one.
	 */
	it('says nothing when the session itself was refused', async () => {
		host.answer = { ok: false, refusal: 'refused' };
		const { onSettled } = control();
		await ask();

		confirm();

		await waitFor(() => expect(deleteCalls()).toHaveLength(1));
		expect(onSettled).not.toHaveBeenCalled();
		expect(screen.queryByText(/nothing was deleted/i)).toBeNull();
	});
});
