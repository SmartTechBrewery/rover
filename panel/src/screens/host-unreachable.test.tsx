import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HostUnreachable } from './host-unreachable.js';

describe('the host unreachable page', () => {
	/*
	 * A refused connection, a timeout, a powered-off machine and a daemon that is not running are
	 * indistinguishable from here, so the headline may not claim to know which — and an earlier
	 * revision's `ERR_CODE: 0x80004005` was a Windows HRESULT from an operating system this product
	 * does not run on, which is worse than no code because somebody would quote it in a bug report.
	 */
	it('says exactly HOST UNREACHABLE, with no second clause and no code', () => {
		const { container } = render(<HostUnreachable onRetry={() => undefined} />);

		expect(screen.getByRole('heading', { name: 'HOST UNREACHABLE' })).toBeDefined();
		expect(container.textContent).not.toContain('//');
		expect(container.textContent).not.toContain('OFFLINE');
		expect(container.textContent).not.toContain('ERR');
		expect(container.textContent).not.toMatch(/0x[0-9a-f]+/i);
	});

	// Retrying a read is harmless and it is the one useful thing to do from here.
	it('retries when asked', () => {
		const retry = vi.fn();
		render(<HostUnreachable onRetry={retry} />);

		fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));

		expect(retry).toHaveBeenCalledTimes(1);
	});

	// §7: the sidebar, the navigation and the breadcrumb are gone, not dimmed. This page renders in
	// place of the router (`app.tsx`), so it carries none of them itself either.
	it('carries no shell of its own', () => {
		const { container } = render(<HostUnreachable onRetry={() => undefined} />);

		expect(container.querySelector('nav')).toBeNull();
		expect(screen.queryByRole('link')).toBeNull();
	});

	// The one place in the panel that uses the `error` tokens — §5 leaves red unused so it stays
	// meaningful, and this is the fault the reserve was kept for. Border and headline, no glow.
	it('spends the error colour on the border and the headline only', () => {
		const { container } = render(<HostUnreachable onRetry={() => undefined} />);

		expect(screen.getByRole('heading', { name: 'HOST UNREACHABLE' }).className).toContain(
			'text-error',
		);
		expect(container.innerHTML).not.toContain('shadow-[');
	});
});
