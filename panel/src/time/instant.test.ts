import { describe, expect, it, vi } from 'vitest';
import { formatInstant } from './instant.js';

const GRANTED = '2026-08-31T14:02:41.219Z';

describe('formatInstant', () => {
	it("reads a host instant in the reader's own zone, to the minute", () => {
		expect(formatInstant(GRANTED, 'Europe/Warsaw')).toBe('2026-08-31 16:02');
	});

	/*
	 * **The inversion of the rule this module replaced** (#223). Two readers are deliberately shown
	 * *different* strings for one instant, because re-expressing an unambiguous UTC instant in
	 * another zone is exact — the two clocks never have to agree (D17, R29).
	 *
	 * It is also what would fail if a formatter were ever cached at module scope: the first zone
	 * asked for would answer for every zone after it.
	 */
	it('gives readers in different zones the correct different strings', () => {
		expect(formatInstant(GRANTED, 'Pacific/Kiritimati')).toBe('2026-09-01 04:02');
		expect(formatInstant(GRANTED, 'Pacific/Niue')).toBe('2026-08-31 03:02');
		expect(formatInstant(GRANTED, 'Europe/Warsaw')).toBe('2026-08-31 16:02');
	});

	/*
	 * **The digits, their order and their separators are this module's, not a locale's.** Every
	 * assertion here is a shape a locale would have got wrong: the year leads, the separators are
	 * `-` and `:`, the clock runs to 23 with no `PM`, and midnight is `00` rather than `24`. The
	 * pinned `en-US` would itself have rendered `08/31/2026, 16:02`.
	 */
	it('keeps one order, one set of separators and a 24-hour clock', () => {
		expect(formatInstant(GRANTED, 'UTC')).toBe('2026-08-31 14:02');
		expect(formatInstant('2026-01-05T04:07:00Z', 'UTC')).toBe('2026-01-05 04:07');
		expect(formatInstant('2026-12-31T00:00:00Z', 'UTC')).toBe('2026-12-31 00:00');
		expect(formatInstant('2026-12-31T23:59:00Z', 'UTC')).toBe('2026-12-31 23:59');
	});

	/*
	 * **A rewrite through `toLocaleString()` must not pass**, which is the one way the assertions
	 * above could go on being green while the format quietly became the reader's. They would catch
	 * it on almost every machine — but `sv-SE`'s own CLDR output *is* `2026-08-31 16:02`, so on a
	 * reader whose browser is in that locale the coincidence the format was not chosen for would hide
	 * the change. So the locale-aware half of `Date` is taken away and the answer must be unchanged.
	 */
	it('renders through no locale-aware method at all', () => {
		const locale = () => {
			throw new Error("the format may not come from the reader's locale");
		};
		const spies = [
			vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(locale),
			vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(locale),
			vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(locale),
		];
		try {
			expect(formatInstant(GRANTED, 'Europe/Warsaw')).toBe('2026-08-31 16:02');
		} finally {
			for (const spy of spies) {
				spy.mockRestore();
			}
		}
	});

	// Minute precision drops the seconds rather than rounding by them, so the value on screen is
	// never a minute the instant had not reached.
	it('drops the seconds rather than rounding by them', () => {
		expect(formatInstant('2026-08-31T14:02:59.999Z', 'UTC')).toBe('2026-08-31 14:02');
	});

	/*
	 * `null` and never a guess, for the reason `UNKNOWN` exists on the Archive screen: the callers
	 * decide what to say about it, and neither may put an invented time on screen
	 * (`archive/run-identity.ts`, `components/devices/device-card.tsx`).
	 */
	it('answers null for a string that is not an instant', () => {
		expect(formatInstant('')).toBeNull();
		expect(formatInstant('unknown')).toBeNull();
		expect(formatInstant('20260830T170501Z')).toBeNull();
		expect(formatInstant('2026-08-31T25:02:41.219Z')).toBeNull();
	});
});
