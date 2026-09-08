import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/* `devices.test.tsx`'s shape: this module builds a route at import, so the router is stubbed. */
vi.mock('@tanstack/react-router', () => ({
	Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
	createRoute: (options: unknown) => ({ options }),
	createRootRoute: (options: unknown) => ({ options }),
	Outlet: () => null,
	useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
		select({ location: { pathname: '/system' } }),
}));

import { DEFAULT_DISK_BUDGET_MB, DEFAULT_MAX_AGE_DAYS } from '@panel/system/retention-settings.js';
import { SystemScreen } from './system.js';

/**
 * The settings destination (`docs/DESIGN.md` §3, §13) — **`System`, and not a fifth nav item.**
 *
 * §3 settles four destinations and says that `System` stands in for settings; this screen fills the
 * placeholder that promised exactly that. What is asserted below is the two settings, their
 * defaults, and the two things this screen must not do while no host method **writes** either
 * number: offer a control that appears to save, or claim a deadline it cannot know. The host does
 * enforce these two bounds now (#238) — from its own environment, swept by `rover sweep` — which
 * is why the copy asserted here no longer says nothing sweeps the archive.
 */

const disk = () => screen.getByLabelText('Disk space for test data') as HTMLInputElement;
const days = () => screen.getByLabelText('Delete tests after') as HTMLInputElement;

describe('the System screen', () => {
	it('shows both settings, with their units and their defaults', () => {
		render(<SystemScreen />);

		expect(disk().value).toBe(String(DEFAULT_DISK_BUDGET_MB));
		expect(days().value).toBe(String(DEFAULT_MAX_AGE_DAYS));
		// The unit is beside the field rather than in the value, so it is on screen but not typed.
		expect(screen.getByText('MB')).toBeDefined();
		expect(screen.getByText('days')).toBeDefined();
	});

	/*
	 * **The fields are editable and hold digits only.** Enforced on the way in, so the field cannot
	 * hold `1.5` or a pasted `12 MB` at all — `retention-settings.test.ts` covers the rule, and this
	 * covers that the screen is wired to it.
	 */
	it('takes a new number, and only digits', () => {
		render(<SystemScreen />);

		fireEvent.change(disk(), { target: { value: '512' } });
		expect(disk().value).toBe('512');

		fireEvent.change(days(), { target: { value: '1.5' } });
		expect(days().value).toBe('15');
	});

	/*
	 * **No control that appears to save.** Nothing on the host takes either number, so a `Save`
	 * would be the first thing on this screen to lie — the objection §11 already makes to a button
	 * on a destination that is not built. The two fields are the only interactive elements here.
	 */
	it('offers nothing to press', () => {
		const { container } = render(<SystemScreen />);

		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.querySelectorAll('a')).toHaveLength(0);
		expect(container.querySelectorAll('input')).toHaveLength(2);
	});

	/*
	 * **It says where the numbers stand, in words and without alarm.** Nothing here saves them and
	 * the host reads its own; that is not a fault, so it is ordinary quiet text — no `role="alert"`,
	 * no error colour, no spinner (§7).
	 *
	 * **And it must not claim the host has no retention mechanism**, which is what this asserted
	 * until #238 and is now false: the host enforces both bounds and `rover sweep` runs them. The
	 * negative assertion is deliberate — the old sentence is exactly the kind that survives a
	 * feature landing, because nothing else on the screen changes when it does.
	 */
	it('says plainly that nothing here saves the numbers, and claims no more than that', () => {
		const { container } = render(<SystemScreen />);

		expect(screen.getByText(/not saved anywhere/)).toBeDefined();
		expect(screen.getByText(/The host reads its own/)).toBeDefined();
		expect(container.textContent).not.toContain('no retention mechanism');
		expect(container.textContent).not.toContain('nothing on this host is sweeping');
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('animate-');
		expect(container.innerHTML).not.toContain('text-error');
	});

	/*
	 * **The pair is one rule with two bounds**, said once under both fields — and the `Keep` tick is
	 * named here because it is the exemption from both, which is the one thing a reader cannot work
	 * out from this screen alone.
	 */
	it('says which bound acts, and that a kept test is exempt from both', () => {
		render(<SystemScreen />);

		expect(screen.getByText(/reached first is the one that acts/)).toBeDefined();
		expect(screen.getByText(/is exempt from both/)).toBeDefined();
	});

	/*
	 * **An unfinished field says what is missing, and is not dressed as an error.** A cleared field
	 * is how a number is replaced; `error` is this palette's critical step and nothing has gone
	 * wrong (§5).
	 */
	it('asks for a whole number when a field is cleared, without colouring it', () => {
		const { container } = render(<SystemScreen />);

		fireEvent.change(disk(), { target: { value: '' } });

		expect(screen.getByText('Enter a whole number of MB above zero.')).toBeDefined();
		expect(container.innerHTML).not.toContain('text-error');
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
	});

	/*
	 * **The arrangement, which is a decision rather than a default.** The title is in the card's
	 * header strip the way every other card on this panel wears its own; the two notes say what the
	 * card is for and so are read *before* the numbers they are about; and a subtle rule separates
	 * what the card says from what it lets you set.
	 */
	it('puts its title in a strip, then the notes, then a rule, then the fields', () => {
		const { container } = render(<SystemScreen />);

		const card = container.querySelector('section') as HTMLElement;
		const strip = card.firstElementChild as HTMLElement;
		expect(strip.querySelector('h2')?.textContent).toBe('Archive settings');
		expect(strip.className).toContain('bg-surface-container-high');

		// The order inside the body: two notes, the rule, then the grid holding both fields.
		const body = card.children[1] as HTMLElement;
		const shape = [...body.children].map((child) => child.tagName);
		expect(shape).toEqual(['P', 'P', 'HR', 'DIV']);
		expect(body.querySelectorAll('div input')).toHaveLength(2);
	});

	/*
	 * **And no number of days is claimed anywhere.** The archive's own popover cannot say *in 14
	 * days* because the panel has no window to print (§9); this screen is where the window is
	 * *typed*, so the only digits on it are the two the reader can see in the fields.
	 */
	it('no longer says it is not built', () => {
		const { container } = render(<SystemScreen />);

		expect(container.textContent).not.toContain('Not built yet');
	});
});
