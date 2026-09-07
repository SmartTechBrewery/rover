import type { ArchiveGroups } from '@panel/archive/archive-groups.js';
import type { ArchiveGroup, ArchiveSearchMatch } from '@panel/archive/archive-listing.js';
import type { ArchiveSearchState } from '@panel/archive/archive-search.js';
import { describe, expect, it } from 'vitest';
import {
	componentsFromSplat,
	MAX_ARCHIVE_PATH_DEPTH,
	splatFromComponents,
} from './archive-path.js';
import { groupedSearch } from './group-search.js';

const SERIAL = 'R5CT30ABCDE';
const GROUP = 'app-bar-top-space';
const OTHER_GROUP = 'basket-total';
const OLDER = '20260829T142201Z-issue-112-4b0e7c15';
const RUN = '20260830T170501Z-issue-112-9f1c2ab4';

/** How many components a groups splat carries in front of the archive's own path (`OFFSET`). */
const GROUPS_OFFSET = 1;

function run(project: string, testName: string, name: string, serial = SERIAL) {
	return { path: [project, testName, name, serial], artifacts: [] };
}

/**
 * The grouping the cases below restrict against — over the same archive the matches address, so
 * what falls out is a fact about one host rather than about two fixtures. `login-flow` is grouped
 * twice over; `unlabeled` names no group and `payments-web` holds no grouped run at all.
 */
function groups(): readonly ArchiveGroup[] {
	return [
		{
			project: 'checkout-app',
			groupId: GROUP,
			runs: [
				run('checkout-app', 'login-flow', OLDER, 'emulator-5554'),
				run('checkout-app', 'login-flow', RUN),
			],
		},
		{
			project: 'checkout-app',
			groupId: OTHER_GROUP,
			runs: [run('checkout-app', 'basket', RUN)],
		},
	];
}

function listed(truncated = false): ArchiveGroups {
	return { status: 'listed', groups: groups(), truncated };
}

function match(
	path: readonly string[],
	kind: ArchiveSearchMatch['kind'] = 'file',
): ArchiveSearchMatch {
	return { path: [...path], kind };
}

function found(matches: readonly ArchiveSearchMatch[], truncated = false): ArchiveSearchState {
	return { status: 'searched', matches, truncated };
}

/** The addresses a restricted answer drew, which is the whole of what the tree is built from. */
function addresses(state: ArchiveSearchState): readonly (readonly string[])[] {
	if (state.status !== 'searched') {
		throw new Error(`the answer is ${state.status}, not searched`);
	}
	return state.matches.map((one) => one.path);
}

describe('what a search of the grouped runs draws', () => {
	/*
	 * The composition: the group id in front of the archive address, which is exactly what
	 * `archiveAddressOf` takes back out. A match at the run, at its `<serial>` and below both is one
	 * rule rather than three cases.
	 */
	it('puts the group id in front of every address at or below a grouped run', () => {
		const state = groupedSearch(
			found([
				match(['checkout-app', 'login-flow', RUN], 'directory'),
				match(['checkout-app', 'login-flow', RUN, SERIAL], 'directory'),
				match(['checkout-app', 'login-flow', RUN, SERIAL, 'screenshots', 'login.png']),
			]),
			listed(),
		);

		expect(addresses(state)).toEqual([
			['checkout-app', GROUP, 'login-flow', RUN],
			['checkout-app', GROUP, 'login-flow', RUN, SERIAL],
			['checkout-app', GROUP, 'login-flow', RUN, SERIAL, 'screenshots', 'login.png'],
		]);
	});

	// Each run takes its own group, so two arms of one investigation and a second group under the
	// same project land on the addresses they are actually filed under.
	it('addresses each run under the group that run named', () => {
		const state = groupedSearch(
			found([
				match(['checkout-app', 'login-flow', OLDER, 'emulator-5554', 'a.png']),
				match(['checkout-app', 'basket', RUN, SERIAL, 'a.png']),
			]),
			listed(),
		);

		expect(addresses(state)).toEqual([
			['checkout-app', GROUP, 'login-flow', OLDER, 'emulator-5554', 'a.png'],
			['checkout-app', OTHER_GROUP, 'basket', RUN, SERIAL, 'a.png'],
		]);
	});

	// A run that named no group is not a hit, and a project with no grouped run is drawn nowhere —
	// which is what this view already does when browsing.
	it('drops a match under a run that named no group, and one under an ungrouped project', () => {
		const state = groupedSearch(
			found([
				match(['checkout-app', 'unlabeled', RUN, SERIAL, 'login.png']),
				match(['payments-web', 'refund-flow', RUN, SERIAL, 'login.png']),
				match(['checkout-app', 'login-flow', RUN, SERIAL, 'login.png']),
			]),
			listed(),
		);

		expect(addresses(state)).toEqual([
			['checkout-app', GROUP, 'login-flow', RUN, SERIAL, 'login.png'],
		]);
	});

	/*
	 * A project or a test name is not addressable in this arrangement: a test name lives under any
	 * number of groups, so *which group* has no honest answer for it. The levels above a hit come out
	 * of the tree the surviving matches build, not out of a match of their own.
	 */
	it('drops a match shallower than a run', () => {
		const state = groupedSearch(
			found([
				match(['checkout-app'], 'directory'),
				match(['checkout-app', 'login-flow'], 'directory'),
			]),
			listed(),
		);

		expect(addresses(state)).toEqual([]);
	});

	// The answer's own order, unchanged — nothing here re-sorts, which is `search-tree.ts`'s rule
	// one step earlier.
	it('keeps the answer’s own order and the host’s own `kind`', () => {
		const state = groupedSearch(
			found([
				match(['checkout-app', 'basket', RUN, SERIAL, 'z.png'], 'other'),
				match(['checkout-app', 'login-flow', RUN, SERIAL], 'directory'),
			]),
			listed(),
		);

		expect(addresses(state).map((path) => path.at(-1))).toEqual(['z.png', SERIAL]);
		expect(state.status === 'searched' && state.matches.map((one) => one.kind)).toEqual([
			'other',
			'directory',
		]);
	});

	/*
	 * The deepest match the host can answer is eight components, which becomes nine here — and nine
	 * is exactly what a groups splat carries. A hit row that the router cut back to its parent would
	 * select the level above the one that was clicked (#189 review).
	 */
	it('composes an address the groups splat can still carry at the host’s deepest match', () => {
		const deepest = [
			'checkout-app',
			'login-flow',
			RUN,
			SERIAL,
			'screenshots',
			'a',
			'b',
			'login.png',
		];
		expect(deepest).toHaveLength(MAX_ARCHIVE_PATH_DEPTH);

		const state = groupedSearch(found([match(deepest)]), listed());
		const composed = addresses(state)[0] ?? [];

		expect(composed).toHaveLength(MAX_ARCHIVE_PATH_DEPTH + GROUPS_OFFSET);
		expect(componentsFromSplat(splatFromComponents(composed), GROUPS_OFFSET)).toEqual(composed);
	});
});

/**
 * **The truncation criterion**, which is the one that must be got right: the answer is assembled
 * from two bounded walks, so either being short means the panel may not claim that nothing in this
 * arrangement contains that text.
 */
describe('an answer either walk cut short', () => {
	it('is truncated when the search was short, when the grouping walk was, and when both', () => {
		const hit = [match(['checkout-app', 'login-flow', RUN, SERIAL, 'a.png'])];

		for (const [search, grouping, expected] of [
			[false, false, false],
			[true, false, true],
			[false, true, true],
			[true, true, true],
		] as const) {
			const state = groupedSearch(found(hit, search), listed(grouping));

			expect(state.status === 'searched' && state.truncated).toBe(expected);
			// And the hit itself is drawn either way: a short answer narrows the claim beside the
			// rows rather than dropping any of them.
			expect(addresses(state)).toHaveLength(1);
		}
	});

	// A hit whose run fell out of a truncated grouping answer does not vanish silently: the flag is
	// what says so, and it rides on an empty answer exactly as it rides on a full one.
	it('sets the flag on an answer that matched nothing at all', () => {
		const state = groupedSearch(found([], false), listed(true));

		expect(state).toEqual({ status: 'searched', matches: [], truncated: true });
	});
});

describe('the four states, folded', () => {
	// The search's own three non-`searched` states are about the search itself and say the same
	// thing in both views, so nothing folds them.
	it('passes idle, searching and failed through unchanged', () => {
		for (const state of [
			{ status: 'idle' },
			{ status: 'searching' },
			{ status: 'failed' },
		] as const) {
			for (const grouping of [listed(), { status: 'loading' } as const]) {
				expect(groupedSearch(state, grouping)).toEqual(state);
			}
		}
	});

	// The panel has not got the answer it needs to restrict — one quiet line, and not a claim that
	// nothing matched. Reachable: a deep group address draws the tree while the walk is still out.
	it('is searching while the grouping walk is still out', () => {
		const state = groupedSearch(found([match(['checkout-app', 'login-flow', RUN, SERIAL])]), {
			status: 'loading',
		});

		expect(state).toEqual({ status: 'searching' });
	});

	// The state that already folds everything unusable, and one of the two answers this needs is.
	it('fails when the grouping walk is unreadable', () => {
		const state = groupedSearch(found([match(['checkout-app', 'login-flow', RUN, SERIAL])]), {
			status: 'unreadable',
		});

		expect(state).toEqual({ status: 'failed' });
	});

	// Nothing on this host named a group, so nothing in this arrangement contains that text — and
	// `matches: []` is *nothing matched*, not a failure.
	it('matches nothing when no run named a group, carrying that walk’s own truncation', () => {
		expect(
			groupedSearch(found([match(['checkout-app', 'login-flow', RUN, SERIAL])]), {
				status: 'empty',
				truncated: false,
			}),
		).toEqual({ status: 'searched', matches: [], truncated: false });
		expect(groupedSearch(found([]), { status: 'empty', truncated: true })).toEqual({
			status: 'searched',
			matches: [],
			truncated: true,
		});
	});
});
