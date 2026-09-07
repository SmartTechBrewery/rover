import { keyOf, MAX_ARCHIVE_PATH_DEPTH } from '@panel/archive/archive-path.js';
import { expandedIn, type OpenNodes, openedBy, toggled } from '@panel/archive/open-branches.js';
import { describe, expect, it } from 'vitest';

const PROJECT = ['checkout-app'];
const TEST = ['checkout-app', 'login-flow'];
const RUN = ['checkout-app', 'login-flow', '20260830T170501Z-issue-112-9f1c2ab4'];
const OTHER = ['payments-web'];

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
