/**
 * The two host settings that bound what the archive keeps (§9.4, #238).
 *
 * Two claims, and the second is the one that cannot be made anywhere else. The first is
 * ordinary: what a value means, and that a value which is not a whole count above zero is a
 * **loud startup failure naming the variable** rather than a silent default — an operator who
 * typed `1gb` must not quietly get 1024 MB and discover the difference as deleted runs.
 *
 * The second is the **divergence gate**. The System screen already carries these two defaults
 * (`panel/src/system/retention-settings.ts`, #237), the two trees deliberately cannot import each
 * other, and nothing but an assertion can hold them equal. So this suite reaches across that
 * boundary the way `tests/unit/panel/artifact-bodies.test.ts` does — a direct relative import of
 * one panel module — and asserts the pair. Without it, *the screen and the host must not disagree
 * about the defaults* is a comment; with it, a change to either side is a red suite.
 */

import { describe, expect, it } from 'vitest';
import {
	ARTIFACTS_BUDGET_MB_ENV_VAR,
	ARTIFACTS_MAX_AGE_DAYS_ENV_VAR,
	ageCutoffMs,
	budgetBytesOf,
	DEFAULT_ARTIFACTS_BUDGET_MB,
	DEFAULT_ARTIFACTS_MAX_AGE_DAYS,
	resolveRetentionPolicy,
} from '@/daemon/archive-retention.js';
import {
	DEFAULT_DISK_BUDGET_MB,
	DEFAULT_MAX_AGE_DAYS,
} from '../../../panel/src/system/retention-settings.js';

describe('resolveRetentionPolicy', () => {
	it('answers the defaults when nothing names either', () => {
		expect(resolveRetentionPolicy({})).toEqual({
			budgetMb: DEFAULT_ARTIFACTS_BUDGET_MB,
			maxAgeDays: DEFAULT_ARTIFACTS_MAX_AGE_DAYS,
		});
	});

	it('counts an empty value as unset, as every other row does', () => {
		expect(
			resolveRetentionPolicy({
				[ARTIFACTS_BUDGET_MB_ENV_VAR]: '',
				[ARTIFACTS_MAX_AGE_DAYS_ENV_VAR]: '',
			}),
		).toEqual({
			budgetMb: DEFAULT_ARTIFACTS_BUDGET_MB,
			maxAgeDays: DEFAULT_ARTIFACTS_MAX_AGE_DAYS,
		});
	});

	it('reads what an operator set', () => {
		expect(
			resolveRetentionPolicy({
				[ARTIFACTS_BUDGET_MB_ENV_VAR]: '4096',
				[ARTIFACTS_MAX_AGE_DAYS_ENV_VAR]: '7',
			}),
		).toEqual({ budgetMb: 4096, maxAgeDays: 7 });
	});

	// Four ways to be wrong, and every one of them names the variable to edit rather than
	// falling back to a number nobody chose.
	it.each([
		['a value that is not a number', '1gb'],
		['zero, which is keep nothing', '0'],
		['a negative count', '-1'],
		['a fraction of a megabyte', '1.5'],
	])('refuses %s, naming the variable', (_what, value) => {
		expect(() => resolveRetentionPolicy({ [ARTIFACTS_BUDGET_MB_ENV_VAR]: value })).toThrow(
			ARTIFACTS_BUDGET_MB_ENV_VAR,
		);
	});

	it('names the age variable when that is the one that is wrong', () => {
		expect(() => resolveRetentionPolicy({ [ARTIFACTS_MAX_AGE_DAYS_ENV_VAR]: 'thirty' })).toThrow(
			ARTIFACTS_MAX_AGE_DAYS_ENV_VAR,
		);
	});

	it('names both when both are wrong, so one restart fixes the setup', () => {
		let message = '';
		try {
			resolveRetentionPolicy({
				[ARTIFACTS_BUDGET_MB_ENV_VAR]: 'lots',
				[ARTIFACTS_MAX_AGE_DAYS_ENV_VAR]: 'ages',
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain(ARTIFACTS_BUDGET_MB_ENV_VAR);
		expect(message).toContain(ARTIFACTS_MAX_AGE_DAYS_ENV_VAR);
	});
});

describe('the two derived quantities', () => {
	it('measures the budget in MiB, which is what a walk of the tree counts', () => {
		expect(budgetBytesOf({ budgetMb: 1, maxAgeDays: 30 })).toBe(1024 * 1024);
	});

	it('puts the age cutoff a whole number of days behind now', () => {
		const now = Date.UTC(2026, 8, 8, 12, 0, 0);
		expect(ageCutoffMs({ budgetMb: 1024, maxAgeDays: 30 }, now)).toBe(
			now - 30 * 24 * 60 * 60 * 1_000,
		);
	});
});

/**
 * **The promise that the screen and the host cannot disagree.** See the module header for why
 * this is an assertion rather than a comment, and why it imports across the tree boundary.
 */
describe('the defaults the System screen shows', () => {
	it('is the budget this host actually enforces', () => {
		expect(DEFAULT_ARTIFACTS_BUDGET_MB).toBe(DEFAULT_DISK_BUDGET_MB);
	});

	it('is the age limit this host actually enforces', () => {
		expect(DEFAULT_ARTIFACTS_MAX_AGE_DAYS).toBe(DEFAULT_MAX_AGE_DAYS);
	});
});
