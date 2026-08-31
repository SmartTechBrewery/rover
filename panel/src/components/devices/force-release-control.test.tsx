import type { ListedDevice } from '@panel/devices/device-list.js';
import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The session the control reads: the identity it attributes the call with, and the one call it
 * makes. `answer` is what the host says back, set per test.
 */
const { host } = vi.hoisted(() => ({
	host: {
		answer: { ok: true, value: { type: 'result', result: {} } } as HostAnswer<RpcEnvelope>,
		call: vi.fn(),
	},
}));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({
		state: {
			status: 'signed-in',
			identity: { identifier: 'karolina', displayName: 'Karolina Waldon' },
		},
		call: host.call,
	}),
}));

import { ForceReleaseControl } from './force-release-control.js';

/**
 * The control, and what it does with each of the four answers.
 *
 * Where the settled ones are *said* is not here — the card is about to go free or leave the grid, so
 * a settled answer is reported up and said above it (`force-release-notice.tsx`,
 * `docs/DESIGN.md` §7). What stays here is the one that settled nothing.
 */

const RECEIVED_AT_MS = 1_000_000;

const DEVICE: ListedDevice = {
	serial: 'emulator-5554',
	platform: 'android',
	model: 'sdk_gphone64_arm64',
	osVersion: '16',
	state: 'ready',
	heldBy: null,
};

const LEASE: NonNullable<ListedDevice['heldBy']> = {
	serial: 'emulator-5554',
	owner: 'issue-113',
	project: 'rover',
	testName: 'the devices grid',
	grantedAt: '2026-08-31T14:02:41.219Z',
	expiresInMs: 765_000,
};

function control(onSettled = vi.fn()) {
	const rendered = render(
		<ForceReleaseControl
			device={DEVICE}
			lease={LEASE}
			onSettled={onSettled}
			receivedAtMs={RECEIVED_AT_MS}
		/>,
	);
	return { ...rendered, onSettled };
}

/** The control on the card, which is not the one in the dialog's footer. */
function onTheCard(): HTMLElement {
	return screen.getAllByRole('button', { name: 'Force release' })[0] as HTMLElement;
}

function confirm(): void {
	const buttons = screen.getAllByRole('button', { name: 'Force release' });
	fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
}

beforeEach(() => {
	host.call.mockReset();
	host.call.mockImplementation(async () => host.answer);
});

describe('the control on the card', () => {
	// Recessive, like `Profile`'s sign-out: a control that ends something is not the loudest thing
	// on its screen. And nowhere red, however destructive it is (§5).
	it('is recessive, and not red', () => {
		control();

		const button = onTheCard();
		expect(button.className).not.toContain('bg-primary');
		expect(button.className).not.toContain('error');
		expect(button.className).toContain('border-outline-variant');
	});

	// Nothing is asked of the host until the operator has been asked (§7).
	it('asks before it does anything', () => {
		control();

		fireEvent.click(onTheCard());

		expect(screen.getByRole('dialog')).toBeDefined();
		expect(host.call).not.toHaveBeenCalled();
	});

	/*
	 * The dialog is mounted on `document.body` rather than inside this control (#124). `devices.tsx`
	 * puts `opacity-75` on the grid wrapper while the host's view is stale, and CSS opacity applies
	 * to every descendant including a `fixed` one — so an inline dialog would come up at 75% with
	 * the grid showing through it. §7 quiets the stale grid *as a set*, and a modal is not part of
	 * that set.
	 */
	it('opens the dialog outside the tree the stale grid quiets', () => {
		const { container } = control();

		fireEvent.click(onTheCard());

		const dialog = screen.getByRole('dialog');
		expect(container.contains(dialog)).toBe(false);
		expect(document.body.contains(dialog)).toBe(true);
	});

	it('closes the dialog on cancel, and returns focus to itself', () => {
		control();
		fireEvent.click(onTheCard());

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.activeElement).toBe(onTheCard());
		expect(host.call).not.toHaveBeenCalled();
	});
});

describe('confirming', () => {
	// D28: the actor is the signed-in user's identifier, so the daemon's audit line names a person
	// rather than a browser. Never a constant like `panel`, and never a free-text field.
	it('attributes the call to the signed-in user', async () => {
		host.answer = {
			ok: true,
			value: { type: 'result', result: { outcome: 'released', heldBy: LEASE } },
		};
		control();
		fireEvent.click(onTheCard());

		confirm();

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));
		expect(host.call).toHaveBeenCalledWith('force_release_device', {
			serial: 'emulator-5554',
			actor: 'karolina',
		});
	});

	it.each([
		['a lease that ended', { outcome: 'released', heldBy: LEASE }],
		['a lease that had already ended', { outcome: 'refused', reason: 'not-held' }],
		['a device that has gone', { outcome: 'refused', reason: 'gone' }],
	])('closes the dialog and reports %s upward', async (_case, result) => {
		host.answer = { ok: true, value: { type: 'result', result } };
		const { onSettled } = control();
		fireEvent.click(onTheCard());

		confirm();

		await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
		expect(onSettled.mock.calls[0]?.[0]).toEqual(result);
		expect(onSettled.mock.calls[0]?.[1]).toEqual(DEVICE);
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});

/**
 * The request that reached nothing. **Nothing was released, so nothing closes and nothing is
 * claimed** (§8): the dialog stays where it is, the control comes back, and the same ask can be
 * made again.
 */
describe('the ask that reached nothing', () => {
	it('keeps the dialog open, says so, and re-enables the control', async () => {
		host.answer = { ok: false, refusal: 'unanswered' };
		const { onSettled } = control();
		fireEvent.click(onTheCard());

		confirm();

		await waitFor(() => expect(screen.getByText(/nothing was released/i)).toBeDefined());
		expect(screen.getByRole('dialog')).toBeDefined();
		expect(onSettled).not.toHaveBeenCalled();
		const inDialog = screen.getAllByRole('button', { name: 'Force release' });
		expect((inDialog[inDialog.length - 1] as HTMLElement).getAttribute('disabled')).toBeNull();
	});

	// A second ask is a real second request, and the line from the first does not sit under it.
	it('clears the line when the ask is made again', async () => {
		host.answer = { ok: false, refusal: 'unanswered' };
		control();
		fireEvent.click(onTheCard());
		confirm();
		await waitFor(() => expect(screen.getByText(/nothing was released/i)).toBeDefined());

		host.answer = {
			ok: true,
			value: { type: 'result', result: { outcome: 'released', heldBy: LEASE } },
		};
		confirm();

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(host.call).toHaveBeenCalledTimes(2);
	});

	/*
	 * The host refused the session instead. `Session.call` has already fired the bounce and the
	 * router is coming down, so this control says nothing at all — the poll leaves the same silence,
	 * and a line about a lease would be the panel's last word being the wrong one.
	 */
	it('says nothing when the session itself was refused', async () => {
		host.answer = { ok: false, refusal: 'refused' };
		const { onSettled } = control();
		fireEvent.click(onTheCard());

		confirm();

		await waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));
		expect(onSettled).not.toHaveBeenCalled();
		expect(screen.queryByText(/nothing was released/i)).toBeNull();
	});
});
