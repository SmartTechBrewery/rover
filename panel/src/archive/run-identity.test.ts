import { describe, expect, it } from 'vitest';
import { decomposeRunName } from './run-identity.js';

describe('a run directory decomposed', () => {
	it('reads the timestamp and the owner out of a name Rover wrote', () => {
		expect(decomposeRunName('20260830T170501Z-issue-112-9f1c2ab4', 'Europe/Warsaw')).toEqual({
			name: '20260830T170501Z-issue-112-9f1c2ab4',
			owner: 'issue-112',
			grantedAt: '2026-08-30 19:05',
		});
	});

	/*
	 * **The regression this function exists for.** An owner string is free text and hyphens are
	 * ordinary in one — `pr-127-review` is the example `ai/RULES.md` §1 itself uses — so the owner
	 * is everything between the *first* and the *last* hyphen. A `split('-')[1]` gives `pr`.
	 */
	it('keeps an owner that contains hyphens whole', () => {
		expect(decomposeRunName('20260828T091544Z-pr-127-review-c8d1a0f3').owner).toBe('pr-127-review');
	});

	it('says nothing about a name that does not have the shape, and keeps the name', () => {
		for (const name of ['unlabeled', 'no-timestamp-here', 'onehyphen-x', '-leading', 'trailing-']) {
			const identity = decomposeRunName(name);

			expect(identity.name).toBe(name);
			if (identity.owner !== null) {
				// A name may decompose into an owner without carrying a timestamp; what must never
				// happen is a timestamp being invented for one.
				expect(identity.grantedAt).toBeNull();
			}
		}
	});

	it('gives no timestamp for a prefix that only looks like one', () => {
		expect(decomposeRunName('20260830-issue-112-9f1c2ab4').grantedAt).toBeNull();
		expect(decomposeRunName('20260830T170501-issue-112-9f1c2ab4').grantedAt).toBeNull();
		expect(decomposeRunName('120260830T170501Z-issue-112-9f1c2ab4').grantedAt).toBeNull();
	});

	/*
	 * **Inverted, not deleted** (#223). This asserted that a reader in `Pacific/Kiritimati` and one
	 * in `Pacific/Niue` were shown the *same* string, which was the point of reformatting the name
	 * textually; the run's grant time is now read in the reader's own zone, so what has to hold is
	 * that the two are shown the correct *different* strings for the one instant the name carries.
	 * Nothing is differenced against either reader's clock, which is the half of §6's rule that
	 * stands (D17, R29).
	 *
	 * The zone is a parameter rather than an ambient `process.env.TZ` flip **because that flip does
	 * not work here**: under the `panel` project the tests run in a worker thread, whose own V8
	 * isolate never sees it, so a test written that way would pass whatever this module did
	 * (`time/instant.ts`, `ai/TESTING.md`).
	 */
	it("shifts with the reader's own time zone, and by the right amount", () => {
		const name = '20260830T170501Z-issue-112-9f1c2ab4';

		expect(decomposeRunName(name, 'Pacific/Kiritimati').grantedAt).toBe('2026-08-31 07:05');
		expect(decomposeRunName(name, 'Pacific/Niue').grantedAt).toBe('2026-08-30 06:05');
		expect(decomposeRunName(name, 'Europe/Warsaw').grantedAt).toBe('2026-08-30 19:05');
	});

	// `OWNER` is the directory's own text: `pathSegment` ran on the way in and is not reversible,
	// so what a run row shows is what the directory is called, never the caller's `owner` string.
	it('reads a name that went through the archive writer verbatim', () => {
		expect(decomposeRunName('20260830T170501Z-feature_a-b-9f1c2ab4').owner).toBe('feature_a-b');
	});
});
