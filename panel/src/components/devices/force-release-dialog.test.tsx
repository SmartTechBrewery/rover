import type { ListedDevice } from '@panel/devices/device-list.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ForceReleaseDialog } from './force-release-dialog.js';

/**
 * The asking, against the settled screen (`docs/DESIGN.md` §7, Stitch
 * `d86e794af4de4639979bc65104e2ec57`).
 *
 * Most of what is asserted here is recorded in §7 precisely because a later pass would otherwise
 * "fix" it: that `Cancel` is the prominent control and `Force Release` the recessive one, that the
 * header is `secondary-container` and not red, and that the number is `TIME TO AUTO RELEASE`.
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
	// Twelve minutes and forty-five seconds, so the digits are the design's own.
	expiresInMs: 765_000,
};

function asking(
	overrides: {
		readonly device?: ListedDevice;
		readonly lease?: NonNullable<ListedDevice['heldBy']>;
		readonly ending?: boolean;
		readonly unanswered?: boolean;
		readonly onCancel?: () => void;
		readonly onConfirm?: () => void;
	} = {},
) {
	// The countdown reads `Date.now()`, so the base is pinned rather than the clock.
	vi.spyOn(Date, 'now').mockReturnValue(RECEIVED_AT_MS);
	return render(
		<ForceReleaseDialog
			device={overrides.device ?? DEVICE}
			ending={overrides.ending ?? false}
			lease={overrides.lease ?? LEASE}
			onCancel={overrides.onCancel ?? (() => undefined)}
			onConfirm={overrides.onConfirm ?? (() => undefined)}
			receivedAtMs={RECEIVED_AT_MS}
			unanswered={overrides.unanswered ?? false}
		/>,
	);
}

describe('what the confirmation says', () => {
	it('identifies what is about to end', () => {
		asking();

		expect(screen.getByText('sdk_gphone64_arm64')).toBeDefined();
		// Its own field, never folded into `Pixel 8 (emulator-5554)`: the serial is the identity.
		expect(screen.getByText('Serial')).toBeDefined();
		expect(screen.getByText('emulator-5554')).toBeDefined();
		expect(screen.getByText('issue-113')).toBeDefined();
		expect(screen.getByText('rover')).toBeDefined();
		expect(screen.getByText('the devices grid')).toBeDefined();
	});

	// Third recurrence of §2's rule: bare `TEST` reads as a category and makes this a test runner.
	it('says TEST NAME and never a bare TEST', () => {
		const { container } = asking();

		expect(screen.getByText('Test name')).toBeDefined();
		expect(container.textContent).not.toMatch(/\bTest\b(?!\s*name)/i);
	});

	// Required (D22, as amended #129): the dialog always has one to show, and no `—` stands in.
	it('renders the test name of the lease it would end', () => {
		asking({ lease: { ...LEASE, testName: 'the checkout flow' } });

		expect(screen.getByText('Test name')).toBeDefined();
		expect(screen.getByText('the checkout flow')).toBeDefined();
		expect(screen.queryByText('—')).toBeNull();
	});

	/*
	 * **`TIME TO AUTO RELEASE`, not "remaining time"**, and it is phase 1's countdown reading the
	 * card's own `expiresInMs` and `receivedAtMs` — so the number here and the number on the card
	 * cannot disagree, because there is only one of them. Never `00:00` either, which would say the
	 * lease has already ended.
	 */
	it('names the number TIME TO AUTO RELEASE, and shows the card’s own', () => {
		const { container } = asking();

		expect(screen.getByText('Time to auto release')).toBeDefined();
		expect(screen.getByText('12:45')).toBeDefined();
		expect(container.textContent).not.toContain('Remaining');
		expect(container.textContent).not.toContain('00:00');
	});

	// It is not softened, and §7 says so in as many words.
	it('says in plain words what confirming does', () => {
		const { container } = asking();

		expect(container.textContent).toContain('immediately');
		expect(container.textContent).toContain('restored to a clean state');
		expect(container.textContent).toContain('fails on its next request');
	});

	/*
	 * The scaffolding strip an earlier revision carried, the same mistake as the sign-in screen's
	 * `DEBUG // UI STATES`. It was removed from the design and must not come back through here.
	 */
	it('carries no outcome-snippets reference strip', () => {
		const { container } = asking();

		expect(container.textContent).not.toContain('Outcome Snippets');
		expect(container.textContent).not.toContain('Reference');
	});
});

describe('which control is the prominent one', () => {
	/*
	 * Recorded in §7 so it is not "fixed" later by promoting the destructive action: the safe exit
	 * is the easier target. `Cancel` is filled with the primary colour; `Force release` is a border
	 * and nothing else.
	 */
	it('fills Cancel and leaves Force release recessive', () => {
		asking();

		const cancel = screen.getByRole('button', { name: 'Cancel' });
		const release = screen.getByRole('button', { name: 'Force release' });

		expect(cancel.className).toContain('bg-primary');
		expect(release.className).not.toContain('bg-primary');
		expect(release.className).toContain('border-outline');
	});

	// §5: a destructive action is the closest thing to an exception to the no-red rule and it still
	// is not one. Leaving red unused keeps it meaningful if something ever genuinely needs it.
	it('is nowhere red', () => {
		const { container } = asking();

		expect(container.innerHTML).not.toContain('error');
		expect(container.innerHTML).toContain('secondary-container');
	});

	// §5's pending state: a disabled control whose label changed, never a spinner.
	it('disables the control and changes its label while the ask is out', () => {
		asking({ ending: true });

		const release = screen.getByRole('button', { name: 'Ending…' });
		expect(release.getAttribute('disabled')).not.toBeNull();
		expect(screen.queryByRole('button', { name: 'Force release' })).toBeNull();
		// Cancel stays usable: the operator can always leave.
		expect(screen.getByRole('button', { name: 'Cancel' }).getAttribute('disabled')).toBeNull();
	});
});

describe('the ways out', () => {
	it('is a labelled modal dialog', () => {
		asking();

		const dialog = screen.getByRole('dialog');
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
			'Confirm force release',
		);
	});

	// Focus lands on the safe exit rather than on the destructive control — the same choice the
	// filled/recessive pair makes with a mouse, made again for a keyboard.
	it('moves focus onto Cancel when it opens', () => {
		asking();

		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
	});

	it.each([
		['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
		['the header’s close control', () => fireEvent.click(screen.getByLabelText('Close'))],
		['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
	])('cancels on %s, and asks the host nothing', (_way, act) => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();
		asking({ onCancel, onConfirm });

		act();

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('confirms only when the recessive control is pressed', () => {
		const onConfirm = vi.fn();
		asking({ onConfirm });

		fireEvent.click(screen.getByRole('button', { name: 'Force release' }));

		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	// The backdrop is not a control: a stray click outside a destructive confirmation does nothing.
	it('does not cancel on a click outside the dialog', () => {
		const onCancel = vi.fn();
		const { container } = asking({ onCancel });

		fireEvent.click(container.firstElementChild as HTMLElement);

		expect(onCancel).not.toHaveBeenCalled();
	});
});

/**
 * The fourth case, which is not an outcome (§8). Nothing was released, so the dialog is still here,
 * the control is usable again, and the line says exactly that — it does not claim an ending, and it
 * does not tell the operator to try again on a page the poll is about to replace.
 */
describe('the ask that reached nothing', () => {
	it('says nothing was released, in the dialog, with no colour of alarm', () => {
		asking({ unanswered: true });

		const said = screen.getByText(/nothing was released/i);
		expect(said.getAttribute('aria-live')).toBe('polite');
		expect(said.className).not.toContain('error');
		expect(said.textContent).toContain('still open');
		expect(
			screen.getByRole('button', { name: 'Force release' }).getAttribute('disabled'),
		).toBeNull();
	});

	// The region exists before its text does, or it is announced unreliably.
	it('keeps the live region present when there is nothing to say', () => {
		const { container } = asking();

		const regions = container.querySelectorAll('[aria-live="polite"]');
		expect(regions).toHaveLength(1);
		expect(regions[0]?.textContent).toBe('');
	});
});
