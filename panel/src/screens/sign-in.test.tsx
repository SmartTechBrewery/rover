import type { SessionState } from '@panel/session/session-provider.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CheckingSession, SignInScreen } from './sign-in.js';

/**
 * `docs/DESIGN.md` §8, as far as it can be asserted rather than reviewed.
 *
 * The constraints pinned here are the ones that came back in the design's own iterations or that
 * cost something real when they slip: a host field (the obvious field to add, and wrong), a GET form
 * (which would put the token in a URL), a spinner, a refusal that hints which failure it was, and
 * self-service account creation on a product where users are issued on the host.
 */

const COLD: SessionState = { status: 'signed-out', after: 'arrival' };

function signInScreen(state: SessionState = COLD) {
	const onSubmit = vi.fn();
	const { container } = render(<SignInScreen onSubmit={onSubmit} state={state} />);
	return { container, onSubmit };
}

function tokenField(): HTMLInputElement {
	return screen.getByLabelText('Access token') as HTMLInputElement;
}

describe('the sign-in screen, default state', () => {
	it('is the wordmark, one input and one control — no shell, no navigation', () => {
		const { container } = signInScreen();

		expect(screen.getByText('ROVER_OS')).toBeDefined();
		expect(container.querySelectorAll('input')).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'Sign in' })).toBeDefined();
		expect(container.querySelector('nav')).toBeNull();
	});

	it('says where the token comes from', () => {
		signInScreen();

		expect(screen.getByText(/rover users add/)).toBeDefined();
	});

	// The obvious field to add, and it would be wrong: the panel is served by the machine it talks
	// to, so it already knows where it is (docs/DESIGN.md §8).
	it('has no host or address field, and no invented hostname line', () => {
		signInScreen();

		expect(screen.queryByLabelText(/host/i)).toBeNull();
		expect(screen.queryByLabelText(/address|server|url|port/i)).toBeNull();
		expect(screen.queryByText(/NODE_01/)).toBeNull();
	});

	// Users are issued on the host by an operator. The panel authenticates and never administers.
	it('offers no account creation, no reset and no link at all', () => {
		const { container } = signInScreen();

		expect(container.querySelectorAll('a')).toHaveLength(0);
		for (const forbidden of [/create/i, /sign up/i, /forgot/i, /reset/i, /email/i]) {
			expect(screen.queryByText(forbidden)).toBeNull();
		}
	});

	// A GET form would put the token in the URL — a browser's history, a proxy's log and a referrer
	// header, which is three places a credential may never be (PROJECT.md D20).
	it('is not a GET form', () => {
		const { container } = signInScreen();

		const form = container.querySelector('form') as HTMLFormElement;
		expect(form.method).toBe('post');
		expect(form.getAttribute('action')).toBeNull();
	});

	it('masks the token, in the monospace face, with a reveal that works both ways', () => {
		signInScreen();

		const field = tokenField();
		expect(field.type).toBe('password');
		expect(field.className).toContain('font-code-md');
		expect(field.getAttribute('autocomplete')).toBe('off');
		expect(field.getAttribute('spellcheck')).toBe('false');

		fireEvent.click(screen.getByRole('button', { name: 'Show the token' }));
		expect(tokenField().type).toBe('text');

		fireEvent.click(screen.getByRole('button', { name: 'Hide the token' }));
		expect(tokenField().type).toBe('password');
	});

	it('hands the typed token to its caller, once', () => {
		const { onSubmit } = signInScreen();

		fireEvent.change(tokenField(), { target: { value: 'a-machine-string' } });
		fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith('a-machine-string');
	});

	// A cold arrival says nothing about why it is here: that is the only difference between it and
	// a deliberate sign-out.
	it('carries no notice at all', () => {
		const { container } = signInScreen();

		expect(container.querySelectorAll('h2')).toHaveLength(0);
	});
});

describe('the sign-in screen, checking', () => {
	it('disables the control and changes its label, with no spinner', () => {
		const { container } = signInScreen({ status: 'checking', of: 'token' });

		const control = screen.getByRole('button', { name: 'Checking…' }) as HTMLButtonElement;
		expect(control.disabled).toBe(true);
		expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();

		expect(container.innerHTML).not.toContain('animate-');
		expect(container.querySelector('[role="progressbar"]')).toBeNull();
		expect(container.querySelector('svg[class*="spin"]')).toBeNull();
	});

	it('keeps the form mounted, so the field keeps what was typed', () => {
		const { container } = signInScreen({ status: 'checking', of: 'token' });

		expect(container.querySelector('form')).not.toBeNull();
		expect(tokenField()).toBeDefined();
	});

	// The boot probe is the other half of *checking*, and it has no form because whether one is
	// needed is exactly what it is deciding.
	it('is one quiet line and no form while the boot probe is in flight', () => {
		const { container } = render(<CheckingSession />);

		expect(screen.getByText('ROVER_OS')).toBeDefined();
		expect(container.querySelector('form')).toBeNull();
		expect(container.querySelectorAll('input')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('animate-');
		expect(screen.getByText(/Checking the session/)).toBeDefined();
	});
});

describe('the sign-in screen, refused', () => {
	it('shows one message, below the input, and hints at no particular failure', () => {
		signInScreen({ status: 'refused' });

		const message = screen.getByText(/did not sign you in/);
		expect(message.getAttribute('aria-live')).toBe('polite');
		expect(message.getAttribute('role')).toBeNull();

		for (const hint of [
			/unknown/i,
			/revoked/i,
			/malformed/i,
			/invalid/i,
			/expired/i,
			/no such user/i,
			/incorrect/i,
		]) {
			expect(screen.queryByText(hint)).toBeNull();
		}
	});

	it('is written in ordinary text, with no colour of alarm and no alert role', () => {
		const { container } = signInScreen({ status: 'refused' });

		const message = screen.getByText(/did not sign you in/);
		expect(message.className).not.toContain('error');
		expect(message.className).toContain('text-on-surface');
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it('keeps the field focused so the paste can be corrected in place', () => {
		signInScreen({ status: 'refused' });

		expect(document.activeElement).toBe(tokenField());
	});
});

describe('the sign-in screen, arriving from a session that ended', () => {
	it('says the session ended after a deliberate sign-out', () => {
		signInScreen({ status: 'signed-out', after: 'sign-out' });

		expect(screen.getByText('Signed out')).toBeDefined();
		expect(screen.getByText(/session ended on the host/)).toBeDefined();
	});

	// The deliberate exception to the uniform refusal (docs/DESIGN.md §8): this person
	// authenticated a moment ago, so the panel says plainly that their access ended — and never
	// claims which of a revoke, a rotate or a daemon restart it was.
	it('says access ended plainly, without claiming why', () => {
		signInScreen({ status: 'access-ended' });

		expect(screen.getByText('Access ended')).toBeDefined();
		expect(screen.getByText(/ask whoever runs the host/)).toBeDefined();

		for (const claim of [/revoked/i, /rotated/i, /restarted/i, /expired/i, /operator removed/i]) {
			expect(screen.queryByText(claim)).toBeNull();
		}
	});

	it('still offers the form, because signing in again is the way out of both', () => {
		for (const state of [
			{ status: 'signed-out', after: 'sign-out' } as const,
			{ status: 'access-ended' } as const,
		]) {
			const { container } = render(<SignInScreen onSubmit={vi.fn()} state={state} />);
			expect(container.querySelector('form')).not.toBeNull();
		}
	});
});
