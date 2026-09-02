import { describe, expect, it } from 'vitest';
import {
	ListArchiveParamsSchema,
	SearchArchiveParamsSchema,
	SearchArchiveResultSchema,
} from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/search-archive.json' with { type: 'json' };

/**
 * The daemon's half of the archive search's drift gate (#146).
 *
 * `panel/src/archive/archive-listing.ts` re-declares `search_archive`'s answer instead of importing
 * these schemas, for the structural reason `list-archive-fixture.test.ts` sets out: the panel is a
 * separate tree with its own `tsconfig.json` and its own alias, and `src/ipc/methods.js` drags
 * `core/device.ts`, `core/capabilities.ts` and the verb schemas into a browser bundle behind it. So
 * one fixture is parsed twice, by two projects that cannot import each other — **here** by the
 * host's own schemas, and in `panel/src/archive/archive-listing.test.ts` by the panel's mirror.
 *
 * **It is a search list**, the shape `list-archive.json`'s level list already extended once:
 * `{ "searches": [ { "text": …, "result": … } ] }`. One answer per file would have been six files
 * pinning one schema, and the search field renders every one of these six differently.
 *
 * **Every search was captured and none was hand-edited.** Like `list_archive`, this method needs no
 * device — it reads the host's own disk — so the whole file is a daemon's own bytes off the panel's
 * HTTP surface (`ROVER_HTTP_PORT`) against a seeded `ROVER_ARTIFACTS_PATH`. The three outcomes came
 * from the filesystem rather than from a text editor, which is `list-archive.json`'s own trick: a
 * subdirectory with mode `000` is walked past and makes the answer `truncated`, the root with mode
 * `000` answers `unreadable`, and the root moved aside answers `missing`.
 *
 * **Every match's `path` is parsed by `ListArchiveParamsSchema`.** That is what makes *the archive
 * has one path vocabulary* assertable rather than merely claimed: a match is an address the listing
 * the panel navigates to would itself accept.
 */

const searches = fixture.searches;

describe("the panel's search_archive fixture", () => {
	it('is a set of answers the daemon could give', () => {
		for (const search of searches) {
			expect(SearchArchiveResultSchema.safeParse(search.result).success).toBe(true);
		}
	});

	it('was searched for with text the daemon would accept', () => {
		for (const search of searches) {
			expect(SearchArchiveParamsSchema.safeParse({ text: search.text }).success).toBe(true);
		}
	});

	// The load-bearing one. Every match is an address, so the row the panel draws for a hit links
	// somewhere the archive's other read would answer for.
	it('names matches the daemon would accept a listing request for', () => {
		const paths = searches.flatMap((search) => {
			const parsed = SearchArchiveResultSchema.parse(search.result);
			return parsed.outcome === 'searched' ? parsed.matches.map((match) => match.path) : [];
		});

		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) {
			expect(ListArchiveParamsSchema.safeParse({ path }).success).toBe(true);
		}
	});

	it('carries all three outcomes, because the field renders all three differently', () => {
		const outcomes = new Set(searches.map((search) => search.result.outcome));

		expect(outcomes).toEqual(new Set(['searched', 'missing', 'unreadable']));
	});

	// *Nothing matched* is a `searched` with an empty array and is not a failure — the distinction
	// the field's three states rest on.
	it('carries a search that matched nothing apart from one that could not be run', () => {
		const empty = searches.filter((search) => {
			const parsed = SearchArchiveResultSchema.parse(search.result);
			return parsed.outcome === 'searched' && parsed.matches.length === 0;
		});

		expect(empty).toHaveLength(1);
	});

	// A partial answer must never render like a complete one, so the flag has to be on the wire in
	// both of its states or the tree card's truncation line is unpinned.
	it('carries both a truncated answer and a complete one', () => {
		const flags = searches.flatMap((search) => {
			const parsed = SearchArchiveResultSchema.parse(search.result);
			return parsed.outcome === 'searched' ? [parsed.truncated] : [];
		});

		expect(new Set(flags)).toEqual(new Set([true, false]));
	});

	// The tree draws a different glyph for each, so a fixture missing one leaves it unpinned.
	it('carries at least one match of each kind', () => {
		const kinds = new Set(
			searches.flatMap((search) => {
				const parsed = SearchArchiveResultSchema.parse(search.result);
				return parsed.outcome === 'searched' ? parsed.matches.map((match) => match.kind) : [];
			}),
		);

		expect(kinds).toEqual(new Set(['directory', 'file', 'other']));
	});
});
