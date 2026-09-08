import { describe, expect, it } from 'vitest';
import {
	DEFAULT_DISK_BUDGET_MB,
	DEFAULT_MAX_AGE_DAYS,
	digitsOnly,
	retentionValueOf,
} from './retention-settings.js';

/**
 * The two retention numbers as the System screen edits them (`docs/DESIGN.md` §13).
 *
 * Nothing here is about React. What it pins is the arithmetic the screen leans on: that a field
 * cannot hold a value the setting could not take, and that *not finished* is told apart from *zero*
 * — which is the distinction a coercion to `number` would have quietly lost.
 */
describe('what a retention field may hold', () => {
	/*
	 * **Enforced on the way in rather than validated on the way out.** A field that accepted `1.5`
	 * and complained afterwards is a field that held a value the setting has no meaning for; this
	 * way the invalid state is unrepresentable, which is also why the inputs are `type="text"`.
	 */
	it('keeps digits and drops everything else', () => {
		expect(digitsOnly('10240')).toBe('10240');
		expect(digitsOnly('1.5')).toBe('15');
		expect(digitsOnly('-30')).toBe('30');
		expect(digitsOnly('1e6')).toBe('16');
		expect(digitsOnly('12 MB')).toBe('12');
		expect(digitsOnly('abc')).toBe('');
	});

	/** Halfway through typing is not something to rewrite: a leading zero survives the keystroke. */
	it('leaves a half-typed number alone', () => {
		expect(digitsOnly('0')).toBe('0');
		expect(digitsOnly('01')).toBe('01');
	});
});

describe('what a retention field means', () => {
	it('reads a whole number of megabytes or days', () => {
		expect(retentionValueOf('10240')).toBe(10240);
		expect(retentionValueOf('30')).toBe(30);
		expect(retentionValueOf('01')).toBe(1);
	});

	/*
	 * **Empty and zero are both *not a setting*, and neither is an error.** A cleared field is
	 * ordinary — it is how you replace a number — and `0` would be *keep nothing*, which no operator
	 * sets on purpose and which this screen must not be the accidental way to ask for.
	 */
	it('is nothing yet when the field is empty or zero', () => {
		expect(retentionValueOf('')).toBeNull();
		expect(retentionValueOf('0')).toBeNull();
		expect(retentionValueOf('000')).toBeNull();
	});

	/** Beyond a safe integer it is not a count any more, so it is not a setting either. */
	it('refuses a number no longer exactly representable', () => {
		expect(retentionValueOf('9'.repeat(20))).toBeNull();
	});
});

describe('the defaults', () => {
	/*
	 * A default is a claim about somebody else's disk, so both are round figures rather than a
	 * fraction of a size this panel cannot see (D19), and the budget is deliberately small — of the
	 * two ways to be wrong, deleting too eagerly is the recoverable one. They are asserted because
	 * they are the two numbers a reader will see first, and a silent change to either is a change to
	 * what Rover appears to promise about their disk.
	 */
	it('are one GiB and thirty days, as whole counts', () => {
		expect(DEFAULT_DISK_BUDGET_MB).toBe(1024);
		expect(DEFAULT_MAX_AGE_DAYS).toBe(30);
		for (const value of [DEFAULT_DISK_BUDGET_MB, DEFAULT_MAX_AGE_DAYS]) {
			expect(Number.isSafeInteger(value)).toBe(true);
			expect(value).toBeGreaterThan(0);
		}
	});

	/** And each is a value its own field would accept, which is the only coupling worth pinning. */
	it('are values the fields accept', () => {
		expect(retentionValueOf(String(DEFAULT_DISK_BUDGET_MB))).toBe(DEFAULT_DISK_BUDGET_MB);
		expect(retentionValueOf(String(DEFAULT_MAX_AGE_DAYS))).toBe(DEFAULT_MAX_AGE_DAYS);
	});
});
