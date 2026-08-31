import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { pathname } = vi.hoisted(() => ({ pathname: { current: '/devices' } }));

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
	// The shell's own `<Outlet />` stands in for whatever route is mounted; these tests are
	// about the furniture around it, so a page header is rendered beside it explicitly.
	Outlet: () => null,
}));

import { AppShell } from './app-shell.js';
import { PageHeader } from './page-header.js';

function renderShell() {
	const { container } = render(
		<>
			<AppShell />
			<PageHeader trail={[{ label: 'Devices' }]} description="Monitoring attached devices." />
		</>,
	);
	return container;
}

describe('AppShell', () => {
	// docs/DESIGN.md §3: the sidebar and the content area share one height, and neither column
	// ever paints background below where the other ends. A flex row whose minimum is the
	// viewport is what achieves that; the assertions below are on the mechanism, because the
	// symptom itself is not reachable from jsdom.
	it('is one flex row with the viewport as its minimum height', () => {
		const container = renderShell();

		const root = container.firstElementChild as HTMLElement;
		expect(root.className).toContain('flex');
		expect(root.className).toContain('min-h-screen');
		expect(root.className).toContain('md:flex-row');
	});

	// docs/DESIGN.md §4's worst bug: a sidebar carrying two positioning models while `<main>`
	// still offset for one of them.
	it('gives the sidebar one positioning model and no offset to compensate for', () => {
		const container = renderShell();

		const nav = container.querySelector('nav[aria-label="Main"]') as HTMLElement;
		for (const forbidden of ['fixed', 'sticky', 'absolute']) {
			expect(nav.className.split(/\s+/)).not.toContain(forbidden);
		}

		const main = container.querySelector('main') as HTMLElement;
		expect(main.className).not.toMatch(/\bm[lr]-/);
		expect(main.className).toContain('min-w-0');
	});

	// docs/DESIGN.md §5: the scanline is chrome texture and must never overlay a region that
	// will render a screenshot, a video frame or a log dump — which is what the content area
	// is for.
	it('confines the scanline to the navigation chrome', () => {
		const container = renderShell();

		const nav = container.querySelector('nav[aria-label="Main"]') as HTMLElement;
		expect(nav.querySelectorAll('.scanline').length).toBeGreaterThan(0);

		const main = container.querySelector('main') as HTMLElement;
		expect(main.querySelectorAll('.scanline')).toHaveLength(0);
		// And never as a fixed full-viewport layer in a blend mode, as the design's own markup
		// applied it.
		for (const layer of Array.from(container.querySelectorAll('.scanline'))) {
			expect(layer.className).not.toContain('fixed');
			expect(layer.className).not.toContain('mix-blend');
		}
	});

	it('accents the active nav item and the current breadcrumb segment the same way', () => {
		const container = renderShell();

		const active = screen.getByRole('link', { name: 'Devices' });
		const current = container.querySelector('[aria-current="page"]:not(a)') as HTMLElement;

		expect(active.className).toContain('border-tertiary');
		expect(current.className).toContain('text-tertiary');
		expect(current.textContent).toBe('Devices');
	});

	// docs/DESIGN.md §3: the breadcrumb is the page's identity, so there is no heading
	// repeating it one line below.
	it('has no page title', () => {
		const container = renderShell();

		expect(container.querySelector('h1')).toBeNull();
	});
});
