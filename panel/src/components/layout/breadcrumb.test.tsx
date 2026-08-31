import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

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
}));

import { Breadcrumb } from './breadcrumb.js';

describe('Breadcrumb', () => {
	it('is the screen name alone at the root, in the green accent, and not a link', () => {
		const { container } = render(<Breadcrumb trail={[{ label: 'Devices' }]} />);

		const current = screen.getByText('Devices');
		expect(current.tagName).toBe('SPAN');
		expect(current.getAttribute('aria-current')).toBe('page');
		expect(current.className).toContain('text-tertiary');
		expect(container.querySelectorAll('a')).toHaveLength(0);
		expect(container.textContent).toBe('Devices');
	});

	it('states depth as Parent > Child, with the last segment still not a link', () => {
		const { container } = render(
			<Breadcrumb trail={[{ label: 'Archive', to: '/archive' }, { label: 'checkout-app' }]} />,
		);

		expect(container.textContent).toBe('Archive>checkout-app');

		const parent = screen.getByRole('link', { name: 'Archive' });
		expect(parent.getAttribute('href')).toBe('/archive');
		expect(parent.className).toContain('text-on-surface-variant');

		const child = screen.getByText('checkout-app');
		expect(child.tagName).toBe('SPAN');
		expect(child.getAttribute('aria-current')).toBe('page');

		// The separator is an arrow, never a slash, and it is not announced.
		const separator = screen.getByText('>');
		expect(separator.getAttribute('aria-hidden')).toBe('true');
	});

	// docs/DESIGN.md §3: nothing but path segments. The Archive screen opens its path with a
	// `SUCCESS` chip; this is the assertion that keeps one out of the implementation.
	it('holds nothing but path segments and separators', () => {
		const { container } = render(
			<Breadcrumb trail={[{ label: 'Archive', to: '/archive' }, { label: 'checkout-app' }]} />,
		);

		const list = container.querySelector('ol') as HTMLElement;
		expect(Array.from(list.children).map((li) => li.tagName)).toEqual(['LI', 'LI', 'LI']);
		// One element per segment or separator, and no ornament nested inside any of them.
		for (const item of Array.from(list.children)) {
			expect(item.querySelectorAll('*').length).toBeLessThanOrEqual(1);
		}
	});
});
