import { describe, expect, it } from 'vitest';
import { decomposeRunName } from './run-identity.js';

describe('a run directory decomposed', () => {
	it('reads the timestamp and the owner out of a name Rover wrote', () => {
		expect(decomposeRunName('20260830T170501Z-issue-112-9f1c2ab4')).toEqual({
			name: '20260830T170501Z-issue-112-9f1c2ab4',
			owner: 'issue-112',
			grantedAt: '2026-08-30 17:05:01 UTC',
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
	 * The string is the **host's** own UTC instant and nothing may re-express it in this browser's
	 * zone (`docs/DESIGN.md` §6). The reformatting is textual for exactly that reason, so a reader
	 * in Warsaw and a reader in Los Angeles are shown the same run at the same time.
	 */
	it('does not shift with the reader time zone', () => {
		const before = process.env.TZ;
		try {
			process.env.TZ = 'Pacific/Kiritimati';
			const east = decomposeRunName('20260830T170501Z-issue-112-9f1c2ab4').grantedAt;
			process.env.TZ = 'Pacific/Niue';
			const west = decomposeRunName('20260830T170501Z-issue-112-9f1c2ab4').grantedAt;

			expect(east).toBe('2026-08-30 17:05:01 UTC');
			expect(west).toBe(east);
		} finally {
			process.env.TZ = before;
		}
	});

	// `OWNER` is the directory's own text: `pathSegment` ran on the way in and is not reversible,
	// so what a run row shows is what the directory is called, never the caller's `owner` string.
	it('reads a name that went through the archive writer verbatim', () => {
		expect(decomposeRunName('20260830T170501Z-feature_a-b-9f1c2ab4').owner).toBe('feature_a-b');
	});
});
