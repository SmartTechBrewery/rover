import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/*
 * A `Link` is a plain anchor, and it **resolves `params` into the href** the way
 * `directory-tree.test.tsx`'s does: a segment of the Archive screen's trail addresses `/archive/$`
 * and carries its level in `_splat`, so a mock that dropped `params` would render every one of them
 * at the same address and see nothing.
 */
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		params,
		children,
		...rest
	}: {
		to: string;
		params?: { _splat?: string };
		children: ReactNode;
	} & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={`${to.replace('$', '')}${params?._splat ?? ''}`} {...rest}>
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

	/*
	 * **Two segments of one path may be the same word.** A project and a test name are free text and
	 * `checkout-app/checkout-app` is a real address, which is why a segment is keyed by its
	 * destination rather than by its label — a label key collides the two, and React then renders one
	 * of them for both.
	 */
	it('keeps two segments that share a label apart, each at its own address', () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		render(
			<Breadcrumb
				trail={[
					{ label: 'Archive', to: '/archive' },
					{ label: 'checkout-app', to: '/archive/$', params: { _splat: 'checkout-app' } },
					{
						label: 'checkout-app',
						to: '/archive/$',
						params: { _splat: 'checkout-app/checkout-app' },
					},
					{ label: '20260830T170501Z-issue-112-9f1c2ab4' },
				]}
			/>,
		);

		const repeated = screen.getAllByRole('link', { name: 'checkout-app' });
		expect(repeated.map((link) => link.getAttribute('href'))).toEqual([
			'/archive/checkout-app',
			'/archive/checkout-app/checkout-app',
		]);
		// A duplicate key is reported and nothing else, so this is the assertion that fails on one.
		expect(logged).not.toHaveBeenCalled();
		logged.mockRestore();
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
