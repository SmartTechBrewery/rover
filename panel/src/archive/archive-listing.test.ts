import { describe, expect, it } from 'vitest';
import listings from '../../../tests/fixtures/panel/list-archive.json';
import searches from '../../../tests/fixtures/panel/search-archive.json';
import { ListArchiveResultSchema, SearchArchiveResultSchema } from './archive-listing.js';

/**
 * The panel's half of the drift gate `tests/unit/panel/list-archive-fixture.test.ts` opens.
 *
 * The same seven captured levels, parsed here by the mirror and there by the daemon's own schemas.
 * What this half proves is that every field the screen renders survives the parse; what the other
 * half proves is that the file is a set of answers the daemon could really give.
 */
describe("the panel's mirror of list_archive", () => {
	it('reads every level of a real capture', () => {
		for (const level of listings.levels) {
			expect(ListArchiveResultSchema.safeParse(level.result).success).toBe(true);
		}
	});

	it('reads the three kinds, down to the fields the screen renders', () => {
		const entries = listings.levels.flatMap((level) => {
			const parsed = ListArchiveResultSchema.parse(level.result);
			return parsed.outcome === 'listed' ? parsed.entries : [];
		});

		const directory = entries.find((entry) => entry.name === 'recordings');
		expect(directory).toEqual({
			kind: 'directory',
			name: 'recordings',
			childCount: 1,
			onlyChild: '001.mp4',
		});
		expect(entries.find((entry) => entry.name === 'device_info.json')).toEqual({
			kind: 'file',
			name: 'device_info.json',
			sizeBytes: 80,
		});
		expect(entries.find((entry) => entry.kind === 'other')).toEqual({
			kind: 'other',
			name: 'latest_recording',
		});
	});

	it('keeps `null` distinguishable from a number, which is the whole of `unknown`', () => {
		const opaque = listings.levels.find((level) => level.path.at(-1) === 'opaque-test');
		const parsed = ListArchiveResultSchema.parse(opaque?.result);

		expect(parsed.outcome).toBe('listed');
		if (parsed.outcome !== 'listed') {
			return;
		}
		const [child, file] = parsed.entries;
		expect(child).toMatchObject({ kind: 'directory', childCount: null, onlyChild: null });
		expect(file).toMatchObject({ kind: 'file', sizeBytes: null });
	});

	it('reads all three outcomes and keeps empty apart from unreadable', () => {
		expect(ListArchiveResultSchema.parse({ outcome: 'listed', entries: [] })).toEqual({
			outcome: 'listed',
			entries: [],
		});
		expect(ListArchiveResultSchema.parse({ outcome: 'missing' }).outcome).toBe('missing');
		expect(ListArchiveResultSchema.parse({ outcome: 'unreadable' }).outcome).toBe('unreadable');
	});

	/*
	 * The one deliberate difference from the host's copy: nothing here is `.strict()`. A browser
	 * that blanked a working screen because a newer daemon added a column would be worse than one
	 * that ignored it, so an unknown field is stripped rather than refused.
	 */
	it('strips a field it does not know rather than refusing the answer', () => {
		const parsed = ListArchiveResultSchema.parse({
			outcome: 'listed',
			entries: [{ kind: 'file', name: 'device_info.json', sizeBytes: 80, modifiedAt: 'later' }],
			totalBytes: 4096,
		});

		expect(parsed).toEqual({
			outcome: 'listed',
			entries: [{ kind: 'file', name: 'device_info.json', sizeBytes: 80 }],
		});
	});

	// A name is the on-disk name and nothing validates it further here: the host already bounded it,
	// and a panel that refused one would make a level the host answered with unreachable.
	it('accepts a name a filesystem allows and a reader would not expect', () => {
		const parsed = ListArchiveResultSchema.parse({
			outcome: 'listed',
			entries: [{ kind: 'directory', name: 'a b%c#d', childCount: 0, onlyChild: null }],
		});

		expect(parsed.outcome === 'listed' && parsed.entries[0]?.name).toBe('a b%c#d');
	});
});

/**
 * The panel's half of the drift gate `tests/unit/panel/search-archive-fixture.test.ts` opens (#146).
 *
 * The same six captured searches, parsed here by the mirror and there by the daemon's own schemas.
 * The other half proves the file is a set of answers the daemon could really give, and that every
 * match is an address a listing would accept; this half proves every field the tree card draws a
 * hit from survives the parse.
 */
describe("the panel's mirror of search_archive", () => {
	it('reads every search of a real capture', () => {
		for (const search of searches.searches) {
			expect(SearchArchiveResultSchema.safeParse(search.result).success).toBe(true);
		}
	});

	it('reads a match down to the two fields a hit row is drawn from', () => {
		const matches = searches.searches.flatMap((search) => {
			const parsed = SearchArchiveResultSchema.parse(search.result);
			return parsed.outcome === 'searched' ? parsed.matches : [];
		});

		expect(matches).toContainEqual({ path: ['checkout-app', 'login-flow'], kind: 'directory' });
		// A file deep under a run, which is the hit the URL's own tree would never draw: a run is a
		// leaf there, and the searched tree draws exactly the paths the host answered.
		expect(matches.find((match) => match.path.at(-1) === 'login-screen.png')).toEqual({
			path: [
				'checkout-app',
				'login-flow',
				'20260830T170501Z-issue-112-9f1c2ab4',
				'R5CT30ABCDE',
				'screenshots',
				'login-screen.png',
			],
			kind: 'file',
		});
		expect(matches.find((match) => match.kind === 'other')?.path.at(-1)).toBe('latest_recording');
	});

	// The three states the field renders come off these three outcomes, and *nothing matched* is a
	// `searched` with an empty array rather than any kind of failure.
	it('keeps nothing matched apart from a search that could not be run', () => {
		const outcomes = searches.searches.map((search) => {
			const parsed = SearchArchiveResultSchema.parse(search.result);
			return parsed.outcome === 'searched' ? `searched:${parsed.matches.length}` : parsed.outcome;
		});

		expect(outcomes).toContain('searched:0');
		expect(outcomes).toContain('missing');
		expect(outcomes).toContain('unreadable');
	});

	// The flag the truncation line is drawn from, in both of its states.
	it('reads a truncated answer as truncated and a complete one as complete', () => {
		const flags = searches.searches.flatMap((search) => {
			const parsed = SearchArchiveResultSchema.parse(search.result);
			return parsed.outcome === 'searched' ? [parsed.truncated] : [];
		});

		expect(new Set(flags)).toEqual(new Set([true, false]));
	});

	/*
	 * The one deliberate difference from the host's copy, again: nothing here is `.strict()`, so a
	 * field a newer daemon adds is stripped rather than blanking a working screen.
	 */
	it('strips a field it does not know rather than refusing the answer', () => {
		const parsed = SearchArchiveResultSchema.parse({
			outcome: 'searched',
			matches: [{ path: ['checkout-app'], kind: 'directory', childCount: 5 }],
			truncated: false,
			directoriesRead: 12,
		});

		expect(parsed).toEqual({
			outcome: 'searched',
			matches: [{ path: ['checkout-app'], kind: 'directory' }],
			truncated: false,
		});
	});
});
