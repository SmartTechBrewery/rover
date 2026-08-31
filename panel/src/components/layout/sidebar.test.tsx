import { render, screen, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { pathname } = vi.hoisted(() => ({ pathname: { current: '/devices' } }));

// A `Link` renders as a plain anchor so a destination is assertable without a router
// instance, and `useRouterState`'s selector just reads a pathname. Same shape as Swarm's own
// `sidebar.test.tsx`.
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		children,
		...rest
	}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
	useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
		select({ location: { pathname: pathname.current } }),
}));

import { Sidebar } from './sidebar.js';

function renderSidebar(at = '/devices') {
	pathname.current = at;
	return render(<Sidebar />).container;
}

describe('Sidebar', () => {
	it('carries the wordmark and the three nav items, in order', () => {
		renderSidebar();

		expect(screen.getByText('ROVER_OS')).toBeDefined();
		const items = screen.getAllByRole('listitem').map((li) => li.textContent);
		expect(items).toEqual(['Devices', 'Archive', 'System']);
	});

	it('gives the current destination the green accent and no other one', () => {
		renderSidebar('/devices');

		const active = screen.getByRole('link', { name: 'Devices' });
		expect(active.className).toContain('border-tertiary');
		expect(active.className).toContain('bg-tertiary-container');

		for (const label of ['Archive', 'System']) {
			const inactive = screen.getByRole('link', { name: label });
			expect(inactive.className).not.toContain('border-tertiary');
			expect(inactive.className).not.toContain('bg-tertiary-container');
		}
	});

	it('pins Profile at the foot, below its own divider', () => {
		const container = renderSidebar();

		const profile = screen.getByRole('link', { name: 'Profile' });
		const foot = profile.parentElement;
		expect(foot?.className).toContain('mt-auto');
		expect(foot?.className).toContain('border-t-2');
		// And it is genuinely last, not merely styled as if it were.
		const links = Array.from(container.querySelectorAll('a'));
		expect(links.at(-1)).toBe(profile);
	});

	// The shell carries no action (docs/DESIGN.md §7). The emitted design markup put a global
	// `FORCE RELEASE` button in the navigation chrome; an action belongs to the thing it acts
	// on, so this is asserted rather than reviewed.
	it('carries no action at all', () => {
		const container = renderSidebar();

		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);
		expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
	});

	// Rover is not a test framework, and the nav is where `Analytics` / `Diagnostics` keep
	// coming back (docs/DESIGN.md §3).
	it('promises no reporting product', () => {
		const container = renderSidebar();

		const nav = within(container.querySelector('nav') as HTMLElement);
		for (const forbidden of ['Analytics', 'Diagnostics', 'Documentation', 'Support']) {
			expect(nav.queryByText(forbidden)).toBeNull();
		}
	});
});
