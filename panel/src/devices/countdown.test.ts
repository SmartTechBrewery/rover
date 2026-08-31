import { describe, expect, it } from 'vitest';
import { formatCountdown, remainingMs } from './countdown.js';

describe('remainingMs', () => {
	it('subtracts what has elapsed since the answer arrived', () => {
		expect(remainingMs(600_000, 1_000_000, 1_000_000)).toBe(600_000);
		expect(remainingMs(600_000, 1_000_000, 1_090_000)).toBe(510_000);
	});

	it('clamps at zero rather than counting past the expiry', () => {
		expect(remainingMs(5_000, 1_000_000, 1_010_000)).toBe(0);
	});

	// A clock that steps backwards must not report more time than the host granted.
	it('clamps elapsed at zero too', () => {
		expect(remainingMs(600_000, 1_000_000, 990_000)).toBe(600_000);
	});

	/*
	 * The renewal, as arithmetic (`PROJECT.md` D8). Activity pushed the expiry forward, so the next
	 * poll carries a larger `expiresInMs` with a later `receivedAtMs` — and the same function
	 * answers a larger number, at the same instant, with no mechanism of its own.
	 */
	it('answers a larger number after a poll that carried a renewed lease', () => {
		const before = remainingMs(600_000, 1_000_000, 1_090_000);
		const after = remainingMs(600_000, 1_090_000, 1_090_000);

		expect(after).toBeGreaterThan(before);
	});
});

describe('formatCountdown', () => {
	it('reads mm:ss under an hour', () => {
		expect(formatCountdown(0)).toBe('00:00');
		expect(formatCountdown(9_000)).toBe('00:09');
		expect(formatCountdown(69_000)).toBe('01:09');
		expect(formatCountdown(3_599_000)).toBe('59:59');
	});

	// A two-hour TTL rendered as `120:00` is read as two minutes by whoever is deciding whether a
	// lease is stuck, which is the one question this number answers.
	it('widens to h:mm:ss at an hour', () => {
		expect(formatCountdown(3_600_000)).toBe('1:00:00');
		expect(formatCountdown(7_384_000)).toBe('2:03:04');
	});

	it('floors rather than rounding, so it never shows time that has gone', () => {
		expect(formatCountdown(1_999)).toBe('00:01');
	});
});
