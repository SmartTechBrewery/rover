import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseCountdown } from './lease-countdown.js';

/**
 * The one piece of motion in the panel, and the one property worth pinning about it: **the number
 * goes back up** when activity renews the lease (`PROJECT.md` D8), without a reload and without the
 * component being remounted.
 */
describe('LeaseCountdown', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function digits(): string {
		return screen.getByText(/\d\d:\d\d/).textContent ?? '';
	}

	it('falls by one second a second', () => {
		render(<LeaseCountdown expiresInMs={120_000} receivedAtMs={1_000_000} />);

		expect(digits()).toBe('02:00');

		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(digits()).toBe('01:59');

		act(() => {
			vi.advanceTimersByTime(3_000);
		});
		expect(digits()).toBe('01:56');
	});

	// The renewal. A later poll carrying more time is all it takes: no reload, no remount, and
	// nothing that has to notice the renewal happened.
	it('goes back up when a later poll carries a renewed lease', () => {
		const { rerender, container } = render(
			<LeaseCountdown expiresInMs={120_000} receivedAtMs={1_000_000} />,
		);
		const before = container.firstElementChild;

		act(() => {
			vi.advanceTimersByTime(30_000);
		});
		expect(digits()).toBe('01:30');

		rerender(<LeaseCountdown expiresInMs={600_000} receivedAtMs={1_030_000} />);

		expect(digits()).toBe('10:00');
		expect(container.firstElementChild).toBe(before);
	});

	it('stops ticking when it goes away', () => {
		const { unmount } = render(<LeaseCountdown expiresInMs={120_000} receivedAtMs={1_000_000} />);

		unmount();

		expect(vi.getTimerCount()).toBe(0);
	});

	// §7: this number is not dressed as urgent. Expiry is normal and renewable, and orange is this
	// palette's warning colour — the design's own demo script turns the timer orange under a minute
	// and that is deliberately not reproduced.
	it('does not change colour as the time runs out', () => {
		const { rerender, container } = render(
			<LeaseCountdown expiresInMs={600_000} receivedAtMs={1_000_000} />,
		);
		const roomy = (container.firstElementChild as HTMLElement).className;

		rerender(<LeaseCountdown expiresInMs={4_000} receivedAtMs={1_000_000} />);

		expect((container.firstElementChild as HTMLElement).className).toBe(roomy);
		expect(roomy).not.toContain('error');
		expect(roomy).not.toContain('secondary-container');
	});
});
