import { keyOf, MAX_ARCHIVE_PATH_DEPTH } from '@panel/archive/archive-path.js';
import {
	absorbing,
	expandedIn,
	type OpenNodes,
	openedBy,
	toggled,
} from '@panel/archive/open-branches.js';
import { describe, expect, it } from 'vitest';

const PROJECT = ['checkout-app'];
const TEST = ['checkout-app', 'login-flow'];
const RUN = ['checkout-app', 'login-flow', '20260830T170501Z-issue-112-9f1c2ab4'];
const OTHER = ['payments-web'];
/** A search hit's address, deep inside the *other* project — the shape #202's review reported on. */
const HIT = [
	'payments-web',
	'refund-flow',
	'20260901T090000Z-issue-9-1a2b3c4d',
	'R5CT',
	'shot.png',
];

/** The open set the tests below start from, in the tree's own address space. */
function open(...addresses: readonly (readonly string[])[]): OpenNodes {
	return new Set(addresses.map(keyOf));
}

/** The whole of what the URL can address in the `All` view — no view offset in front of it. */
const DEEPEST = MAX_ARCHIVE_PATH_DEPTH;

describe('the set an address arrives with', () => {
	// The derived rule written down as state: a reload draws the branch the address is in, open all
	// the way down, and nothing else. That is what makes #198 additive to the reader's gestures
	// rather than a different tree at every load.
	it('opens every prefix of the selection, and the selection itself', () => {
		const seeded = openedBy(RUN);

		expect(seeded.has(keyOf([]))).toBe(true);
		expect(seeded.has(keyOf(PROJECT))).toBe(true);
		expect(seeded.has(keyOf(TEST))).toBe(true);
		expect(seeded.has(keyOf(RUN))).toBe(true);
		expect(seeded.has(keyOf(OTHER))).toBe(false);
	});

	it('is the root alone at the root', () => {
		expect([...openedBy([])]).toEqual([keyOf([])]);
	});
});

describe('what is drawn expanded', () => {
	it('draws a node the set holds, wherever the selection is', () => {
		expect(expandedIn(open(OTHER), RUN, OTHER)).toBe(true);
	});

	it('draws nothing the set does not hold off the selected path', () => {
		expect(expandedIn(open(PROJECT), RUN, OTHER)).toBe(false);
	});

	/*
	 * **The floor, and it is the one thing that must not regress** (AC 4, #160). An ancestor of the
	 * selection is expanded whatever the set holds, so the selected node can never be hidden beneath
	 * a collapsed ancestor while the card beside the tree draws its contents.
	 */
	it('draws every ancestor of the selection expanded with nothing in the set at all', () => {
		const nothing = open();

		expect(expandedIn(nothing, RUN, PROJECT)).toBe(true);
		expect(expandedIn(nothing, RUN, TEST)).toBe(true);
	});

	// And *strict* is what lets the selected node be shut: closing it is a state a reader can reach,
	// and the row is still drawn — it is its own children that are not.
	it('leaves the selected node itself to the set', () => {
		expect(expandedIn(open(), RUN, RUN)).toBe(false);
		expect(expandedIn(open(RUN), RUN, RUN)).toBe(true);
	});
});

describe('one click on a row', () => {
	it('opens a shut row and leaves every other open branch alone', () => {
		const before = open(PROJECT, TEST);

		const after = toggled(before, PROJECT, OTHER, DEEPEST);

		expect(expandedIn(after, PROJECT, OTHER)).toBe(true);
		expect(expandedIn(after, PROJECT, PROJECT)).toBe(true);
		expect(expandedIn(after, PROJECT, TEST)).toBe(true);
	});

	it('closes a row the set holds open', () => {
		const after = toggled(open(PROJECT, OTHER), PROJECT, OTHER, DEEPEST);

		expect(expandedIn(after, PROJECT, OTHER)).toBe(false);
		expect(expandedIn(after, PROJECT, PROJECT)).toBe(true);
	});

	/*
	 * **The toggle turns on the *drawn* state, not on membership** — the two differ on exactly the
	 * rows a reader is most likely to close. An ancestor of a selection that arrived by a deep link
	 * or a search hit is drawn open by the floor with nothing in the set to remove, and keying the
	 * toggle on membership would *add* it and draw it open twice over.
	 *
	 * The click lands on that row, so the selection is the row itself afterwards — which is when the
	 * floor stops applying and the closed state is what the tree draws.
	 */
	it('closes an ancestor of the selection the set never held', () => {
		const after = toggled(open(), RUN, TEST, DEEPEST);

		expect(after.has(keyOf(TEST))).toBe(false);
		// The selection is `TEST` itself after the click, which is what lifts the floor off it.
		expect(expandedIn(after, TEST, TEST)).toBe(false);
	});

	// Nothing else moves with it: closing an ancestor closes that node and not the branch beside it.
	it('leaves a branch off the selected path open when an ancestor of the selection closes', () => {
		const after = toggled(open(OTHER), RUN, TEST, DEEPEST);

		expect(expandedIn(after, TEST, OTHER)).toBe(true);
	});

	/*
	 * A row deeper than the URL can carry cannot be selected — `componentsFromSplat` truncates the
	 * address it links to — and the level under it is one `list_archive` refuses. So it is not
	 * opened, and no triangle claims a level nobody can reach.
	 */
	it('does not open a row deeper than the address can carry', () => {
		const tooDeep = Array.from({ length: DEEPEST + 1 }, (_unused, index) => `d${index}`);

		expect(toggled(open(), [], tooDeep, DEEPEST)).toEqual(open());
		// The last row that *can* be addressed still opens, so the bound is the URL's own and not one
		// level short of it.
		const deepest = tooDeep.slice(0, DEEPEST);
		expect(expandedIn(toggled(open(), [], deepest, DEEPEST), [], deepest)).toBe(true);
	});

	// Closing is never capped: a set that could not be emptied of a key would be worse than one that
	// never took it.
	it('closes a row past the bound if something did open it', () => {
		const tooDeep = Array.from({ length: DEEPEST + 1 }, (_unused, index) => `d${index}`);

		expect(toggled(open(tooDeep), [], tooDeep, DEEPEST).has(keyOf(tooDeep))).toBe(false);
	});

	it('holds no opinion about the set it was given', () => {
		const before = open(PROJECT);

		toggled(before, PROJECT, OTHER, DEEPEST);

		expect([...before]).toEqual([keyOf(PROJECT)]);
	});
});

/*
 * **The floor is absorbed, and it is what makes an unclicked branch survive** (#202 review). The
 * floor is evaluated against whatever the selection is *now*, so a branch the reader reached without
 * clicking a row — a search hit, a breadcrumb, the back button — stands on nothing the set holds.
 * `useOpenBranches` runs this at every move of the selection, so what the floor was drawing is in
 * the set before the floor moves off it.
 */
describe('absorbing the floor', () => {
	it('writes every strict ancestor of the selection into the set', () => {
		const after = absorbing(open(), RUN);

		expect(after.has(keyOf([]))).toBe(true);
		expect(after.has(keyOf(PROJECT))).toBe(true);
		expect(after.has(keyOf(TEST))).toBe(true);
	});

	// And *strict*, for the second reason: this runs on the selection a closing click just landed on,
	// so adding the selected node itself would put back the one key that click removed.
	it('leaves the selected node itself out', () => {
		expect(absorbing(open(), RUN).has(keyOf(RUN))).toBe(false);
	});

	it('gives back the set it was handed when there is nothing to add', () => {
		const before = open([], PROJECT);

		expect(absorbing(before, TEST)).toBe(before);
		expect(absorbing(before, [])).toBe(before);
	});

	it('holds no opinion about the set it was given', () => {
		const before = open();

		absorbing(before, RUN);

		expect([...before]).toEqual([]);
	});
});

/*
 * The two-step scenarios, which is where #202's blocker lived: one selection change at a time can
 * never see it, because the branch that collapses is one an *earlier* change left standing on the
 * floor. Each of these is the hook's own sequence — absorb on every move of the selection, toggle on
 * a click — run against the pure functions it is made of.
 */
describe('a selection that moves twice', () => {
	/** The hook's fold, as a step these tests can sequence by hand. */
	function arriveAt(at: OpenNodes, selected: readonly string[]): OpenNodes {
		return absorbing(at, selected);
	}

	it('keeps a branch reached by a search hit open when another project is opened', () => {
		// Mounted at the root, so the set is the root alone; the hit moves the address with no toggle.
		const arrived = arriveAt(openedBy([]), HIT);
		expect(expandedIn(arrived, HIT, OTHER)).toBe(true);

		// Clearing the field and clicking a shut top-level row: the click opens it and selects it.
		const clicked = arriveAt(toggled(arrived, HIT, PROJECT, DEEPEST), PROJECT);

		expect(expandedIn(clicked, PROJECT, PROJECT)).toBe(true);
		// The whole branch the reader was looking at is still drawn, at every depth of it.
		expect(expandedIn(clicked, PROJECT, OTHER)).toBe(true);
		expect(expandedIn(clicked, PROJECT, HIT.slice(0, 2))).toBe(true);
		expect(expandedIn(clicked, PROJECT, HIT.slice(0, 4))).toBe(true);
	});

	it('keeps a branch reached by a breadcrumb or the back button open the same way', () => {
		// A deep link mounts seeded, the reader goes back up to the project, then opens a second one.
		const back = arriveAt(openedBy(RUN), PROJECT);
		const clicked = arriveAt(toggled(back, PROJECT, OTHER, DEEPEST), OTHER);

		expect(expandedIn(clicked, OTHER, OTHER)).toBe(true);
		expect(expandedIn(clicked, OTHER, PROJECT)).toBe(true);
		expect(expandedIn(clicked, OTHER, TEST)).toBe(true);
	});

	// The counterpart that must keep failing: absorbing may not resurrect what a click closed.
	it('still draws a closed ancestor of the selection shut once the selection lands on it', () => {
		const seeded = openedBy(RUN);

		// The click on `TEST` closes it and lands on it — which is the move the fold then sees.
		const closed = arriveAt(toggled(seeded, RUN, TEST, DEEPEST), TEST);

		expect(expandedIn(closed, TEST, TEST)).toBe(false);
		expect(expandedIn(closed, TEST, PROJECT)).toBe(true);
	});

	// The same for a node closed at the top: moving on afterwards must not reopen it either.
	it('leaves a closed branch closed when the selection moves on', () => {
		const closed = arriveAt(toggled(openedBy(RUN), RUN, PROJECT, DEEPEST), PROJECT);
		const elsewhere = arriveAt(toggled(closed, PROJECT, OTHER, DEEPEST), OTHER);

		expect(expandedIn(elsewhere, OTHER, PROJECT)).toBe(false);
		expect(expandedIn(elsewhere, OTHER, OTHER)).toBe(true);
	});
});
