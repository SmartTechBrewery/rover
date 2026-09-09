import { BADGE_SHAPE, BADGE_TYPE } from '@panel/components/archive/header-badge.js';
import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The session the control reads: the identity it attributes the call with, and every call it or
 * its dialog makes. `answer` is what the host says back to `delete_project`, set per test; the
 * dialog's two reads are answered so the confirmation renders without a pending row.
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
						result: { outcome: 'measured', bytes: 7_723_471, truncated: false },
					},
				};
			}
			if (method === 'list_kept_tests') {
				return { ok: true, value: { type: 'result', result: { outcome: 'listed', tests: [] } } };
			}
			return host.answer;
		},
	}),
}));

import { DeleteProjectControl } from './delete-project-control.js';

/**
 * The control, and what it does with each of the answers.
 *
 * Where the settled ones are *said* is not here — the card is about to disappear underneath the
 * answer, so a settled outcome is reported up and said above the list
 * (`delete-project-notice.tsx`, `docs/DESIGN.md` §7). What stays here is the one that settled
 * nothing.
 */

const DELETED = {
	outcome: 'deleted',
	registration: 'removed',
	archive: 'removed',
	keptTests: 'removed',
	freedBytes: 7_723_471,
	keptTestsRemoved: 3,
};

function control(onSettled = vi.fn()) {
	const rendered = render(
		<DeleteProjectControl className="ml-auto" onSettled={onSettled} project="checkout-web" />,
	);
	return { ...rendered, onSettled };
}

/** The control on the card, which is not the one in the dialog's footer. */
function onTheCard(): HTMLElement {
	return screen.getByRole('button', { name: 'Delete project checkout-web' });
}

/**
 * Press the control and let the dialog's two reads land.
 *
 * The flush is not incidental: the confirmation asks `measure_archive` and `list_kept_tests` as it
 * mounts, so without it those answers set state outside `act` and every assertion below runs under
 * a warning instead of against the rendered dialog.
 */
async function ask(): Promise<void> {
	fireEvent.click(onTheCard());
	await act(async () => undefined);
}

function confirm(): void {
	fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
}

function deleteCalls(): unknown[][] {
	return host.calls.filter(([method]) => method === 'delete_project');
}

beforeEach(() => {
	host.calls = [];
	host.answer = { ok: true, value: { type: 'result', result: DELETED } };
});

/**
 * **The affordance is unchanged**, which is what §10's phase-ahead-of-the-action was for: the badge
 * treatment out of `header-badge.tsx`, the `error` accent on the glyph and the words and never a
 * fill, the frame neutral until the pointer is on it, and the identifier in the accessible name.
 */
describe('the control on the card', () => {
	it('takes the header badge’s own shape and type', () => {
		control();

		const { className } = onTheCard();
		for (const shared of [...BADGE_SHAPE.split(' '), ...BADGE_TYPE.split(' ')]) {
			expect(className).toContain(shared);
		}
	});

	it('accents in `error` without filling with it, and keeps the strip’s arrangement', () => {
		control();

		const { className } = onTheCard();
		expect(className).toContain('text-error');
		expect(className).toContain('hover:border-error');
		expect(className).toContain('border-outline-variant');
		expect(className).not.toContain('bg-error');
		expect(className).toContain('ml-auto');
	});

	it('names the project it is about, and hides the glyph from a reader that has the words', () => {
		control();

		const button = onTheCard();
		expect(button.textContent).toBe('Delete project');
		const glyph = button.querySelector('svg');
		expect(glyph).not.toBeNull();
		expect(glyph?.getAttribute('aria-hidden')).toBe('true');
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
	 * `force-release-control.tsx`'s recorded reason: a dialog rendered inline inherits every
	 * treatment an ancestor carries, and a modal asking about one destructive action is never part
	 * of a treatment of the list behind it.
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
	it('attributes the call to the signed-in user, and names the project by identifier', async () => {
		control();
		await ask();

		confirm();

		await waitFor(() => expect(deleteCalls()).toHaveLength(1));
		expect(deleteCalls()[0]).toEqual([
			'delete_project',
			{ project: 'checkout-web', actor: 'karolina' },
		]);
		expect(JSON.stringify(deleteCalls()[0])).not.toContain('panel');
	});

	it.each([
		['a project that went', DELETED],
		['a project there was no registration for', { outcome: 'not-registered' }],
		[
			'a delete that left a half behind',
			{
				outcome: 'partial',
				registration: 'removed',
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
		expect(onSettled.mock.calls[0]?.[1]).toBe('checkout-web');
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});

/**
 * The request that reached nothing. **Nothing was deleted, so nothing closes and nothing is
 * claimed**: the dialog stays where it is, the control comes back, and the same ask can be made
 * again.
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
		expect(
			screen.getByRole('button', { name: 'Delete project' }).getAttribute('disabled'),
		).toBeNull();
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
	 * router is coming down, so this control says nothing at all — a line about a project would be
	 * the panel's last word being the wrong one.
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
