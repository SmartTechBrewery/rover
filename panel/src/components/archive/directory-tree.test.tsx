import type { ArchiveGroups } from '@panel/archive/archive-groups.js';
import type { ArchiveLevel, ArchiveLevels } from '@panel/archive/archive-levels.js';
import type {
	ArchiveEntry,
	ArchiveGroup,
	ArchiveGroupRun,
	ArchiveSearchMatch,
} from '@panel/archive/archive-listing.js';
import { keyOf, MAX_ARCHIVE_SEARCH_TEXT_LENGTH } from '@panel/archive/archive-path.js';
import type { ArchiveSearch, ArchiveSearchState } from '@panel/archive/archive-search.js';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * `breadcrumb.test.tsx`'s shape: a `Link` is a plain anchor, so the tree renders with no router
 * instance. The splat's own encoding is asserted against a real router in `archive-path.test.tsx`.
 *
 * **It keeps the one half of the real `Link` a row's own click depends on** (#198): the real one
 * calls `preventDefault` and routes instead, so the anchor's `onClick` — which is the open set's
 * toggle — runs without jsdom being asked to navigate. A row is still one target and there is still
 * nothing nested in it.
 */
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		params,
		children,
		onClick,
		...rest
	}: {
		to: string;
		params?: { _splat?: string };
		children: ReactNode;
	} & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		// The trailing slash an **empty** splat leaves is dropped, because the real router drops it —
		// pinned against a real router in `archive-path.test.tsx` rather than believed of this mock.
		<a
			href={`${to.replace('$', '')}${params?._splat ?? ''}`.replace(/\/$/, '')}
			onClick={(event) => {
				event.preventDefault();
				onClick?.(event);
			}}
			{...rest}
		>
			{children}
		</a>
	),
}));

import {
	absorbing,
	expandedIn,
	type OpenBranches,
	type OpenNodes,
	openedBy,
} from '@panel/archive/open-branches.js';
import { allRowSource, groupRowSource } from '@panel/archive/tree-source.js';
import { DirectoryTree } from './directory-tree.js';

function directory(
	name: string,
	childCount: number | null = 3,
	onlyChild: string | null = null,
): ArchiveEntry {
	return { kind: 'directory', name, childCount, onlyChild };
}

function file(name: string, sizeBytes: number | null = 80): ArchiveEntry {
	return { kind: 'file', name, sizeBytes };
}

/** Neither a directory nor a regular file — what the host could not classify. */
function other(name: string): ArchiveEntry {
	return { kind: 'other', name };
}

function listed(...entries: readonly ArchiveEntry[]): ArchiveLevel {
	return { status: 'listed', entries };
}

const RUN = '20260830T170501Z-issue-112-9f1c2ab4';
/** The run filed the day before — the one the host's own ascending order puts first. */
const OLDER = '20260829T142201Z-issue-112-4b0e7c15';
/** The one child a run directory holds, which is a fact about the run and not a level (§9). */
const SERIAL = 'R5CT30ABCDE';
const RUN_PATH = ['checkout-app', 'login-flow', RUN];
/** Where the run's own contents are listed — hopped to at the run's depth, never descended into. */
const SERIAL_LEVEL = [...RUN_PATH, SERIAL];
const FRAMES = [...SERIAL_LEVEL, 'recordings', '001_frames'];

/**
 * The archive the tests below browse: two projects, two test names, two runs — and, under the run,
 * the levels a selected run already reads (#159), so the deep tree is drawn out of exactly what the
 * screen fetches today rather than out of a listing invented for the test.
 *
 * **The run level is seeded in the host's own order**, which is ascending code-unit over names that
 * lead with a UTC basic-format timestamp, so oldest first (`src/daemon/list-archive.ts`). Seeding it
 * already-descending is what let the tree and the contents card disagree unseen.
 */
function archive(overrides: Record<string, ArchiveLevel> = {}): ArchiveLevels {
	const levels = new Map<string, ArchiveLevel>([
		[keyOf([]), listed(directory('checkout-app'), directory('payments-web'))],
		[keyOf(['checkout-app']), listed(directory('login-flow', 42), directory('unlabeled', 1))],
		[
			keyOf(['checkout-app', 'login-flow']),
			listed(directory(OLDER, 1, 'emulator-5554'), directory(RUN, 1, SERIAL)),
		],
		[
			keyOf(SERIAL_LEVEL),
			listed(
				file('device_info.json'),
				other('latest_recording'),
				directory('recordings', 1),
				directory('screenshots', 3),
			),
		],
		[keyOf([...SERIAL_LEVEL, 'recordings']), listed(directory('001_frames', 1))],
		[keyOf(FRAMES), listed(file('0001.png', 1024))],
	]);
	for (const [path, level] of Object.entries(overrides)) {
		levels.set(path, level);
	}
	return levels;
}

/** No text in the field, which is every browsing case below: the tree is the URL's own. */
const NOT_SEARCHING: ArchiveSearchState = { status: 'idle' };

const typed: string[] = [];

/** The search as the screen holds it — the state is scripted and `setText` is recorded. */
function searching(
	state: ArchiveSearchState,
	text = state.status === 'idle' ? '' : 'login',
): ArchiveSearch {
	return { text, setText: (next) => typed.push(next), state };
}

function match(path: readonly string[], kind: ArchiveSearchMatch['kind']): ArchiveSearchMatch {
	return { path: [...path], kind };
}

/** A `searched` state with the matches given, in the host's own order. */
function found(matches: readonly ArchiveSearchMatch[], truncated = false): ArchiveSearchState {
	return { status: 'searched', matches, truncated };
}

/** Every address a row's click reported as toggled, in order — the open set's own gesture (#198). */
const toggled: string[] = [];

/**
 * The open set as the screen holds it, scripted the way {@link searching} scripts the search: the
 * state is given and the setter is recorded.
 *
 * **It defaults to what a fresh mount seeds** — every prefix of the address, which is the tree the
 * derived rule drew — so every case that predates #198 renders the tree it always did. A case about
 * *two* open branches passes its own set.
 */
function branchesFor(
	selected: readonly string[],
	open: OpenNodes = openedBy(selected),
): OpenBranches {
	return {
		isOpen: (address) => expandedIn(open, selected, address),
		toggle: (address) => toggled.push(keyOf(address)),
	};
}

function showing(
	selected: readonly string[],
	levels: ArchiveLevels = archive(),
	search: ArchiveSearch = searching(NOT_SEARCHING),
	branches: OpenBranches = branchesFor(selected),
) {
	// The `All` view's source, which is what every case below browses (#181). The groups view's is
	// the same component over a second source, and is asserted through the screen in
	// `routes/archive.test.tsx`.
	return render(
		<DirectoryTree
			branches={branches}
			search={search}
			selected={selected}
			source={allRowSource(levels)}
		/>,
	);
}

function rows(container: HTMLElement): readonly HTMLElement[] {
	return [...container.querySelectorAll('a')];
}

/** One row by the name it draws — and a failure rather than `undefined` when there is no such row. */
function rowNamed(container: HTMLElement, name: string): HTMLElement {
	const row = rows(container).find((candidate) => candidate.textContent === name);
	if (row === undefined) {
		throw new Error(`no row named ${name}`);
	}
	return row;
}

function href(container: HTMLElement, name: string): string | null {
	return rowNamed(container, name).getAttribute('href');
}

// One test's clicks must never be another's, the way the search field's recorded text is not.
beforeEach(() => {
	toggled.length = 0;
});

describe('the tree', () => {
	it('draws the root level, and nothing under a sibling off the selected path', () => {
		const { container } = showing(['checkout-app']);

		expect(rows(container).map((row) => row.textContent)).toEqual([
			'checkout-app',
			'login-flow',
			'unlabeled',
			'payments-web',
		]);
	});

	/*
	 * The lazy-expansion assertion, in DOM terms — over the set a fresh mount seeds, which is the
	 * address's own branch and nothing else (#198). So `payments-web` has no children drawn: nothing
	 * was read for it, and nothing will be until somebody opens it.
	 *
	 * **And every row that opens something says which it is** (#175), reporting the state it is drawn
	 * in. The tree told assistive technology nothing about openness while the triangle was the only
	 * thing that carried it, and the row is a toggle.
	 */
	it('expands the address’s own branch, and says so on every row that opens something', () => {
		const { container } = showing(['checkout-app', 'login-flow']);

		const names = rows(container).map((row) => row.textContent);
		expect(names).toContain(RUN);
		expect(names.filter((name) => name === 'payments-web')).toHaveLength(1);
		expect(names.indexOf('payments-web')).toBe(names.length - 1);
		const openness = Object.fromEntries(
			rows(container).map((row) => [row.textContent, row.getAttribute('aria-expanded')]),
		);
		expect(openness).toEqual({
			'checkout-app': 'true',
			'login-flow': 'true',
			[RUN]: 'false',
			[OLDER]: 'false',
			unlabeled: 'false',
			'payments-web': 'false',
		});
	});

	it('marks the selected row, and only that row', () => {
		const { container } = showing(['checkout-app', 'login-flow']);

		const selected = rows(container).filter((row) => row.className.includes('border-tertiary'));
		expect(selected).toHaveLength(1);
		expect(selected[0]?.textContent).toBe('login-flow');
		expect(selected[0]?.getAttribute('aria-current')).toBe('page');
	});

	// Most recent first, out of the host's oldest-first order — and it is the contents card's order
	// too, decided once in `level-order.ts` for both panes rather than by each of them.
	it('lists the runs most recent first, as the contents card does', () => {
		const { container } = showing(['checkout-app', 'login-flow']);

		const runs = rows(container)
			.map((row) => row.textContent ?? '')
			.filter((name) => name.startsWith('2026'));
		expect(runs).toEqual([RUN, OLDER]);
	});

	/*
	 * **Every row goes to its own address, open or shut** (#198, reversing #175's one-level-up
	 * destination in place). One selection reaching a file six components deep draws an open row at
	 * every depth that has a level under it — a project, a test name, a run, a directory inside the
	 * run and a directory inside that — and not one of them links anywhere but at itself.
	 */
	it('links every row to its own address, at every depth and whether it is open or shut', () => {
		const { container } = showing([...FRAMES, '0001.png']);

		const address = (components: readonly string[]) => `/archive/${components.join('/')}`;
		expect(href(container, 'checkout-app')).toBe(address(['checkout-app']));
		expect(href(container, 'login-flow')).toBe(address(['checkout-app', 'login-flow']));
		expect(href(container, RUN)).toBe(address(RUN_PATH));
		expect(href(container, 'recordings')).toBe(address([...SERIAL_LEVEL, 'recordings']));
		expect(href(container, '001_frames')).toBe(address(FRAMES));
		// And the shut rows at those same depths, which is the address they always had.
		expect(href(container, 'payments-web')).toBe(address(['payments-web']));
		expect(href(container, OLDER)).toBe(address(['checkout-app', 'login-flow', OLDER]));
		expect(href(container, 'screenshots')).toBe(address([...SERIAL_LEVEL, 'screenshots']));
	});

	/**
	 * **The collapse is the same at every depth that has a level under it** (#175's gesture, #198's
	 * shape — AC 3). What a click reports is *that row's own branch*, at every one of the five depths
	 * above, and the run's contents are no exception: the open set is keyed by the row's address, so
	 * the `<serial>` the tree hops on the way down needs no matching hop on the way up.
	 */
	it('reports a click on an open row as that row’s own branch, at every depth', () => {
		const { container } = showing([...FRAMES, '0001.png']);

		for (const name of ['checkout-app', 'login-flow', RUN, 'recordings', '001_frames']) {
			fireEvent.click(rowNamed(container, name));
		}

		expect(toggled).toEqual([
			keyOf(['checkout-app']),
			keyOf(['checkout-app', 'login-flow']),
			keyOf(RUN_PATH),
			keyOf([...SERIAL_LEVEL, 'recordings']),
			keyOf(FRAMES),
		]);
	});

	// A shut row's click is the same one gesture: it opens that branch and selects it, which is the
	// single click a folder has always taken.
	it('reports a click on a shut row as that row’s own branch too', () => {
		const { container } = showing(['checkout-app']);

		fireEvent.click(rowNamed(container, 'payments-web'));

		expect(toggled).toEqual([keyOf(['payments-web'])]);
	});

	/*
	 * **And a modifier-click toggles nothing**, because the router declines it too and lets the
	 * browser take the address to a new tab. Reading a second file beside the one already open must
	 * not collapse the branch in the tab being left behind — the two halves of one gesture ride on
	 * one click.
	 */
	it('toggles nothing on a click the router leaves to the browser', () => {
		const { container } = showing(['checkout-app']);

		fireEvent.click(rowNamed(container, 'payments-web'), { metaKey: true });
		fireEvent.click(rowNamed(container, 'payments-web'), { ctrlKey: true });
		fireEvent.click(rowNamed(container, 'payments-web'), { shiftKey: true });
		fireEvent.click(rowNamed(container, 'payments-web'), { button: 1 });

		expect(toggled).toEqual([]);
	});

	/**
	 * **Opening a node leaves every already-open branch open** (AC 1), which is the whole of #198 —
	 * and it is true at any depth, so this set has a second *top-level* row open and a directory
	 * open inside the first one's run.
	 */
	it('draws two branches open at once, at every depth', () => {
		const { container } = showing(
			['checkout-app', 'login-flow'],
			archive({
				[keyOf(['payments-web'])]: listed(directory('refund-flow', 2)),
			}),
			searching(NOT_SEARCHING),
			branchesFor(
				['checkout-app', 'login-flow'],
				new Set(
					[
						[],
						['checkout-app'],
						['checkout-app', 'login-flow'],
						RUN_PATH,
						[...SERIAL_LEVEL, 'screenshots'],
						['payments-web'],
					].map(keyOf),
				),
			),
		);

		const names = rows(container).map((row) => row.textContent);
		// The first branch, all the way down into the run's own contents.
		expect(names).toContain('device_info.json');
		expect(names).toContain('recordings');
		// And the second top-level row's, which the old rule could not have drawn at the same time.
		expect(names).toContain('refund-flow');
		expect(href(container, 'refund-flow')).toBe('/archive/payments-web/refund-flow');
		expect(rowNamed(container, 'payments-web').getAttribute('aria-expanded')).toBe('true');
	});

	/**
	 * **The one thing that must not regress** (AC 4, #160): the selection is drawn in the tree
	 * whatever the open set holds. An address arrived at by a deep link, a breadcrumb, the back
	 * button or a search hit is a selection nobody clicked their way down to — so the set holds none
	 * of its ancestors, and every one of them is drawn expanded all the same.
	 */
	it('draws every ancestor of the selection expanded with an empty open set', () => {
		const selected = [...FRAMES, '0001.png'];
		const { container } = showing(
			selected,
			archive(),
			searching(NOT_SEARCHING),
			branchesFor(selected, new Set()),
		);

		const selectedRows = rows(container).filter((row) => row.className.includes('border-tertiary'));
		expect(selectedRows).toHaveLength(1);
		expect(selectedRows[0]?.textContent).toBe('0001.png');
		for (const name of ['checkout-app', 'login-flow', RUN, 'recordings', '001_frames']) {
			expect(rowNamed(container, name).getAttribute('aria-expanded')).toBe('true');
		}
	});

	/**
	 * **And closing the selected node leaves the row drawn** — it is its children that go, not it.
	 * That is what makes closing a node the reader is standing on a legitimate state rather than the
	 * one the floor above forbids: the card beside the tree draws that node, and the tree draws the
	 * row it is drawing the card for.
	 */
	it('draws the selected row shut, and still draws it, once the reader has closed it', () => {
		const selected = ['checkout-app', 'login-flow'];
		const { container } = showing(
			selected,
			archive(),
			searching(NOT_SEARCHING),
			branchesFor(selected, new Set([[], ['checkout-app']].map(keyOf))),
		);

		const row = rowNamed(container, 'login-flow');
		expect(row.getAttribute('aria-expanded')).toBe('false');
		expect(row.className).toContain('border-tertiary');
		expect(rows(container).map((candidate) => candidate.textContent)).not.toContain(RUN);
	});

	/**
	 * **And a branch the floor was holding open stays drawn once the selection leaves it** (#202
	 * review). This is the two-render case the single-render ones above cannot see: the first render
	 * is a deep selection with nothing in the set, so every row of that branch is drawn by the floor
	 * alone; the second has the selection on a different top-level row, where the floor holds none of
	 * it. What keeps it drawn is `absorbing`, which the screen runs at every move of the selection.
	 */
	it('keeps a branch the floor drew open drawn once the selection moves to another one', () => {
		const deep = [...FRAMES, '0001.png'];
		const { container, rerender } = showing(
			deep,
			archive(),
			searching(NOT_SEARCHING),
			branchesFor(deep, new Set()),
		);
		expect(rowNamed(container, '0001.png')).toBeDefined();

		// The click on `payments-web` opens it and lands on it, and the fold has already taken the
		// branch the reader was in into the set.
		const moved = ['payments-web'];
		const open: OpenNodes = new Set([...absorbing(new Set(), deep), keyOf(moved)]);
		rerender(
			<DirectoryTree
				branches={branchesFor(moved, open)}
				search={searching(NOT_SEARCHING)}
				selected={moved}
				source={allRowSource(archive())}
			/>,
		);

		for (const name of ['checkout-app', 'login-flow', RUN, 'recordings', '001_frames']) {
			expect(rowNamed(container, name).getAttribute('aria-expanded')).toBe('true');
		}
		expect(rowNamed(container, '0001.png')).toBeDefined();
		// And the row just opened is the selected one, so nothing about the old branch is still marked.
		const selectedRows = rows(container).filter((row) => row.className.includes('border-tertiary'));
		expect(selectedRows.map((row) => row.textContent)).toEqual(['payments-web']);
	});

	// A row that opens nothing gains nothing: the selected file is still a link to itself, so
	// clicking it a second time is the no-op it has always been — and it toggles nothing, because
	// there is no branch under it to be in either state.
	it('leaves a row that opens nothing linking to itself', () => {
		const { container } = showing([...FRAMES, '0001.png']);

		const leaf = rowNamed(container, '0001.png');
		expect(leaf.getAttribute('href')).toBe(`/archive/${[...FRAMES, '0001.png'].join('/')}`);
		expect(leaf.getAttribute('aria-expanded')).toBeNull();
		fireEvent.click(leaf);
		expect(toggled).toEqual([]);
	});
});

describe('what a row may carry', () => {
	// The header badge carries the one number for whatever is selected; a count in the tree is what
	// turns a tree into a report (`docs/DESIGN.md` §9).
	it('shows no count anywhere, for a listing whose counts are all non-zero', () => {
		const { container } = showing(['checkout-app', 'login-flow']);

		// The card's heading and the names, and **nothing else at all** — asserted as the exact text
		// rather than by searching for a digit, because a run's hash is full of digits.
		expect(container.textContent).toBe(
			['DIRECTORY', 'checkout-app', 'login-flow', RUN, OLDER, 'unlabeled', 'payments-web'].join(''),
		);
	});

	/*
	 * **No status icon of any kind** — Rover has no verdicts to report (`docs/DESIGN.md` §2), and
	 * green ticks and red crosses beside runs in the tree are exactly what the superseded design got
	 * wrong. The two icons a row may carry are a folder and, if it opens, a triangle.
	 *
	 * **And a row that opens nothing claims no state either** (#175, rewritten in place): the
	 * triangle and `aria-expanded` come and go together, so the two never disagree about whether
	 * there is anything to open.
	 */
	it('carries a glyph and an expanded state only where there is a level under it', () => {
		const { container } = showing(RUN_PATH);

		for (const row of rows(container)) {
			const icons = row.querySelectorAll('svg');
			// Every row here is a directory with a level under it — including the run, whose level is
			// its `<serial>`'s — except the two entries inside the run that open nothing.
			const opens = !['device_info.json', 'latest_recording'].includes(row.textContent ?? '');
			expect(icons).toHaveLength(opens ? 2 : 1);
			expect(row.hasAttribute('aria-expanded')).toBe(opens);
		}
	});

	/*
	 * **A run is no longer a leaf** (#159). Its children are the entries of its `<serial>` directory,
	 * which stays out of the tree as a level and stays in every address below the run — so the tree
	 * reaches a file by clicking, which is what the card beside it used to be for.
	 */
	it('expands a selected run into its own contents, and the `<serial>` is not a row', () => {
		const { container } = showing(RUN_PATH);

		const run = rows(container).find((row) => row.textContent === RUN);
		expect(run?.querySelectorAll('svg')).toHaveLength(2);
		const names = rows(container).map((row) => row.textContent);
		expect(names).toContain('screenshots');
		expect(names).toContain('device_info.json');
		// The serial names no row of its own...
		expect(names).not.toContain(SERIAL);
		// ...and is in every address under the run all the same.
		expect(
			rows(container)
				.find((row) => row.textContent === 'screenshots')
				?.getAttribute('href'),
		).toBe(`/archive/${[...SERIAL_LEVEL, 'screenshots'].join('/')}`);
	});

	/*
	 * Below a run every entry is a row, and what it *is* comes from the host's own `kind` and never
	 * from its name (D22) — the rule the searched tree already keeps, now kept by both of them.
	 */
	it('draws a file below a run as a row, with the host’s own glyph and no measure', () => {
		const { container } = showing(RUN_PATH);

		const glyphOf = (name: string) => {
			const row = rows(container).find((candidate) => candidate.textContent === name);
			expect(row?.querySelectorAll('svg')).toHaveLength(1);
			return row?.querySelector('svg')?.className.baseVal ?? '';
		};
		expect(glyphOf('device_info.json')).toContain('lucide-file-text');
		// The host's own *unclassified*, and it is not an alarm.
		expect(glyphOf('latest_recording')).toContain('lucide-file-question-mark');
		// No size and no count: a row's text is exactly its name, as it is above a run — and both of
		// these entries are seeded with one the row could have drawn.
		expect(rows(container).map((row) => row.textContent)).toContain('device_info.json');
	});

	it('recurses below a run to any depth', () => {
		const { container } = showing([...FRAMES, '0001.png']);

		const leaf = rows(container).find((row) => row.textContent === '0001.png');
		expect(leaf?.getAttribute('href')).toBe(`/archive/${[...FRAMES, '0001.png'].join('/')}`);
		expect(leaf?.getAttribute('aria-current')).toBe('page');
		// Every ancestor is drawn expanded, and the serial is a row at none of those depths.
		expect(rows(container).map((row) => row.textContent)).toEqual([
			'checkout-app',
			'login-flow',
			RUN,
			'device_info.json',
			'latest_recording',
			'recordings',
			'001_frames',
			'0001.png',
			'screenshots',
			OLDER,
			'unlabeled',
			'payments-web',
		]);
	});

	// The serial is not a level here, so `/…/<run>` and `/…/<run>/<serial>` are the same place in
	// this tree — an address typed, or followed from a search hit, marks the run's own row.
	it('marks the run’s row when the selection is its `<serial>` level', () => {
		const { container } = showing(SERIAL_LEVEL);

		const marked = rows(container).filter((row) => row.getAttribute('aria-current') === 'page');
		expect(marked.map((row) => row.textContent)).toEqual([RUN]);
	});

	// No level to open, so no triangle and nothing under it — the same refusal to invent a `0` the
	// rest of this screen makes about a run that is not one-device shaped.
	it('draws nothing under a run whose parent named no single child', () => {
		const levels = archive({
			[keyOf(['checkout-app', 'login-flow'])]: listed(
				directory(OLDER, 1, 'emulator-5554'),
				directory(RUN, 1, null),
			),
		});
		const { container } = showing(RUN_PATH, levels);

		const run = rows(container).find((row) => row.textContent === RUN);
		expect(run?.querySelectorAll('svg')).toHaveLength(1);
		expect(container.textContent).not.toContain(SERIAL);
		expect(container.textContent).not.toContain('device_info.json');
		expect(container.textContent).not.toContain('0 ');
		// It gains nothing from #175 or #198 either: no state to claim, no branch to toggle, and
		// clicking it is the selection it has always been rather than a collapse of a level that is
		// not there.
		expect(run?.getAttribute('aria-expanded')).toBeNull();
		expect(run?.getAttribute('href')).toBe(`/archive/${RUN_PATH.join('/')}`);
		fireEvent.click(rowNamed(container, RUN));
		expect(toggled).toEqual([]);
	});

	// The tree's own quiet line, one level deeper: the run is expanded, and what is under it has not
	// answered yet. Not a spinner, and not an empty run.
	it('says it is reading under an expanded run whose `<serial>` level has not answered', () => {
		const levels = archive({ [keyOf(SERIAL_LEVEL)]: { status: 'loading' } });
		const { container } = showing(RUN_PATH, levels);

		expect(screen.getByText('Reading this level.')).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
	});

	it('wraps a name at its own separators — `break-words`, never `break-all`', () => {
		const { container } = showing(['checkout-app', 'login-flow']);

		expect(container.innerHTML).toContain('break-words');
		expect(container.innerHTML).not.toContain('break-all');
	});

	// Verbatim: a 40-character run directory is shown in full and is not shortened or ellipsised.
	it('shows a name in full', () => {
		showing(['checkout-app', 'login-flow']);

		expect(screen.getByText(RUN)).toBeDefined();
		expect(screen.queryByText(/…|\.\.\./)).toBeNull();
	});

	// A legacy directory from before `test_name` was required lists like any other folder.
	it('gives a legacy unlabeled directory no special treatment', () => {
		const { container } = showing(['checkout-app']);

		const unlabeled = rows(container).find((row) => row.textContent === 'unlabeled');
		expect(unlabeled?.className).toBe(
			rows(container).find((row) => row.textContent === 'login-flow')?.className,
		);
	});
});

describe('a level with nothing to draw', () => {
	it('says it is reading, with no spinner', () => {
		const levels = archive({ [keyOf(['checkout-app'])]: { status: 'loading' } });
		const { container } = showing(['checkout-app'], levels);

		expect(screen.getByText('Reading this level.')).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
	});

	// No `0`, no placeholder row, no icon: a directory that does not exist is not listed, and one
	// the host cannot see into is said in the contents card, where there is room to say it.
	it('draws nothing under an empty or unreadable node', () => {
		for (const status of ['empty', 'unreadable'] as const) {
			const levels = archive({ [keyOf(['checkout-app'])]: { status } });
			const { container, unmount } = showing(['checkout-app'], levels);

			expect(rows(container).map((row) => row.textContent)).toEqual([
				'checkout-app',
				'payments-web',
			]);
			expect(container.textContent).not.toContain('0');
			unmount();
		}
	});
});

/**
 * **What the run's own `<serial>` level says when it holds nothing** (#161) — the one level in this
 * tree that says it here rather than in the card beside it.
 *
 * `CONTENTS` drew *empty* and *unreadable* apart until this phase, and the pair may never render
 * alike (D6). Every other node's card **is** that level's listing and says both itself; a run's card
 * is its identity and its device and lists nothing at all, so the tree is the only place left.
 */
describe('a run that wrote nothing, and one nobody can read', () => {
	const SENTENCES = {
		empty: 'This run wrote nothing.',
		unreadable: "This run's contents are not readable.",
	} as const;

	function withSerialLevel(status: 'empty' | 'unreadable') {
		return archive({ [keyOf(SERIAL_LEVEL)]: { status } });
	}

	it('says which of the two it is, under the expanded run', () => {
		for (const status of ['empty', 'unreadable'] as const) {
			const { unmount } = showing(RUN_PATH, withSerialLevel(status));

			expect(screen.getByText(SENTENCES[status])).toBeDefined();
			unmount();
		}
	});

	// The pair that must never render alike, and neither may borrow a sentence from the card one
	// level up — which still says *Nothing is filed under this directory* and `ARCHIVE NOT READABLE`
	// about a level of its own.
	it('shares no sentence with the other, or with the card', () => {
		for (const status of ['empty', 'unreadable'] as const) {
			const { container, unmount } = showing(RUN_PATH, withSerialLevel(status));
			const text = container.textContent ?? '';

			expect(text).toContain(SENTENCES[status]);
			expect(text).not.toContain(SENTENCES[status === 'empty' ? 'unreadable' : 'empty']);
			expect(text).not.toContain('Nothing is filed under this directory');
			expect(text).not.toContain('ARCHIVE NOT READABLE');
			expect(text).not.toContain('runs may well be filed here');
			expect(text).not.toContain('Reading this level.');
			unmount();
		}
	});

	/*
	 * **One quiet line, and nothing that is a row** (AC 9): no `<a>`, no glyph, no triangle, no `0`
	 * — the same refusal to draw something over nothing the rest of this tree makes.
	 */
	it('draws it as a line rather than as a row, with no spinner', () => {
		const { container } = showing(RUN_PATH, withSerialLevel('empty'));

		const line = [...container.querySelectorAll('p')].find(
			(paragraph) => paragraph.textContent === SENTENCES.empty,
		);
		expect(line?.querySelectorAll('svg')).toHaveLength(0);
		expect(line?.closest('a')).toBeNull();
		expect(rows(container).map((row) => row.textContent)).toEqual([
			'checkout-app',
			'login-flow',
			RUN,
			OLDER,
			'unlabeled',
			'payments-web',
		]);
		expect(container.innerHTML).not.toContain('animate');
	});

	// Every other level still draws nothing under its node, because the card beside it **is** that
	// level's own listing — the line is this one level's, keyed on its depth and on nothing else.
	it('says neither about a level above a run', () => {
		for (const status of ['empty', 'unreadable'] as const) {
			const levels = archive({ [keyOf(['checkout-app'])]: { status } });
			const { container, unmount } = showing(['checkout-app'], levels);

			expect(container.textContent).not.toContain('This run');
			unmount();
		}
	});
});

describe('the search field', () => {
	beforeEach(() => {
		typed.length = 0;
	});

	// The design's own field, between the header strip and the tree (screen `8dcd4330…`).
	it("sits between the header strip and the tree, in the design's own markup", () => {
		const { container } = showing([]);

		const field = screen.getByRole('textbox');
		const heading = screen.getByText('DIRECTORY');
		expect(heading.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(
			field.compareDocumentPosition(rows(container)[0] as HTMLElement) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(field.className).toBe(
			'w-full rounded-sm border-2 border-outline-variant bg-surface px-3 py-2 pl-9 font-code-md text-code-md text-on-surface transition-colors placeholder:text-outline focus:border-tertiary focus:ring-0',
		);
		expect(field.parentElement?.className).toBe('relative');
	});

	/*
	 * The deviation from the approved markup, recorded in `docs/DESIGN.md` §9: the design's *Filter
	 * this tree...* describes a client-side filter over rows already drawn, and this searches the
	 * whole archive on the host.
	 */
	it('says what it does rather than the design’s *Filter this tree...*', () => {
		showing([]);

		const field = screen.getByRole('textbox');
		expect(field.getAttribute('placeholder')).toBe('Search the whole archive...');
		expect(field.getAttribute('placeholder')).not.toContain('Filter');
	});

	/*
	 * `lucide-react`'s glyph, not the design's Material Symbols one — and decoration, not a control.
	 * It is also the empty half of #154's swap: with nothing in the field this is the approved glyph
	 * and nothing else, so the clear action cannot be reached before there is a query to clear.
	 */
	it('carries one leading glyph, hidden from assistive technology', () => {
		showing([]);

		const glyph = screen.getByRole('textbox').parentElement?.querySelector('svg');
		expect(glyph?.getAttribute('aria-hidden')).toBe('true');
		expect(glyph?.getAttribute('width')).toBe('18');
		expect(glyph?.className.baseVal).toContain('absolute');
		expect(screen.queryByRole('button')).toBeNull();
	});

	/*
	 * The other half (#154), a further deliberate deviation recorded in `docs/DESIGN.md` §9 — the
	 * approved screens only ever draw this field empty, so what the glyph position does with a query
	 * in it was never designed. It replaces the glyph rather than standing beside it, in the same
	 * corner at the same size, so nothing in the approved markup moves.
	 */
	it('replaces the glyph with a named clear control once there is text', () => {
		showing(['checkout-app'], archive(), searching(found([]), 'checkout'));

		const clear = screen.getByRole('button', { name: 'Clear the search text' });
		// A real `button`, so Enter and Space work it without a key handler of this card's own.
		expect(clear.getAttribute('type')).toBe('button');
		expect(clear.className).toContain('absolute top-2.5 left-2.5');
		const glyph = clear.querySelector('svg');
		expect(glyph?.getAttribute('aria-hidden')).toBe('true');
		expect(glyph?.getAttribute('width')).toBe('18');
		// One thing in that corner, not two.
		expect(screen.getByRole('textbox').parentElement?.querySelectorAll('svg')).toHaveLength(1);
	});

	// Through the setter a keystroke already uses, so an emptied field is `idle` by the one path
	// `archive-search.ts` has for it rather than a second one this control invents.
	it('empties the field through the screen’s own setter', () => {
		showing(['checkout-app'], archive(), searching(found([]), 'checkout'));

		fireEvent.click(screen.getByRole('button', { name: 'Clear the search text' }));

		expect(typed).toEqual(['']);
	});

	// The control stops existing the instant the text is empty, so leaving focus on it would drop a
	// keyboard reader onto the document body mid-search.
	it('takes the caret back to the field after clearing', () => {
		showing(['checkout-app'], archive(), searching(found([]), 'checkout'));

		fireEvent.click(screen.getByRole('button', { name: 'Clear the search text' }));

		expect(document.activeElement).toBe(screen.getByRole('textbox'));
	});

	it('reports what was typed and holds nothing itself', () => {
		showing([]);

		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'login' } });

		expect(typed).toEqual(['login']);
		// The field's content is the screen's, so the card renders it back rather than storing it.
		expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
	});

	it('shows the text the screen holds', () => {
		showing(['checkout-app'], archive(), searching(found([]), 'checkout'));

		expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('checkout');
	});

	// The host refuses text past its own bound, so the field stops there rather than spending a
	// request to be refused and reporting it as a host that could not search.
	it('stops at the host’s own text bound rather than sending a paste to be refused', () => {
		showing([]);

		expect((screen.getByRole('textbox') as HTMLInputElement).maxLength).toBe(
			MAX_ARCHIVE_SEARCH_TEXT_LENGTH,
		);
	});
});

/**
 * The three states, and the criterion that none of them borrows another's sentence — nor one from
 * *Nothing in the archive*, `ARCHIVE NOT READABLE` or the tree's own *Reading this level.*
 */
describe('a search with nothing to draw', () => {
	const SENTENCES = {
		searching: "Searching this host's archive.",
		'nothing matched': 'No name in the archive contains that text.',
		failed: 'The host could not search the archive.',
	} as const;

	const STATES: Record<keyof typeof SENTENCES, ArchiveSearchState> = {
		searching: { status: 'searching' },
		'nothing matched': found([]),
		failed: { status: 'failed' },
	};

	it('says its own sentence in each state', () => {
		for (const [name, state] of Object.entries(STATES)) {
			const { unmount } = showing(['checkout-app'], archive(), searching(state));

			expect(screen.getByText(SENTENCES[name as keyof typeof SENTENCES])).toBeDefined();
			unmount();
		}
	});

	it('shares no sentence with another state, or with the browsing tree', () => {
		const drawn: string[] = [];
		for (const state of Object.values(STATES)) {
			const { container, unmount } = showing(['checkout-app'], archive(), searching(state));
			drawn.push(container.textContent ?? '');
			unmount();
		}

		for (const [index, text] of drawn.entries()) {
			for (const [other, sentence] of Object.values(SENTENCES).entries()) {
				expect(text.includes(sentence)).toBe(index === other);
			}
			// Nor any of the screen's other empty answers, which say different things.
			expect(text).not.toContain('Nothing in the archive');
			expect(text).not.toContain('ARCHIVE NOT READABLE');
			expect(text).not.toContain('runs may well be filed here');
			expect(text).not.toContain('Nothing is filed under this directory');
			expect(text).not.toContain('Reading this level.');
		}
	});

	it('draws one quiet line in flight, with no spinner', () => {
		const { container } = showing(['checkout-app'], archive(), searching({ status: 'searching' }));

		expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(SENTENCES.searching);
		expect(container.innerHTML).not.toContain('animate');
		expect(rows(container)).toHaveLength(0);
	});

	// While there is text in the field the tree is the search's answer, not the URL's levels.
	it('draws none of the URL’s own levels', () => {
		const { container } = showing(['checkout-app'], archive(), searching(found([])));

		expect(container.textContent).not.toContain('payments-web');
	});
});

describe('the hits a search draws', () => {
	const DEEP = ['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE', 'screenshots', 'login.png'];

	function hits(truncated = false) {
		return searching(
			found(
				[
					match(['checkout-app', 'login-flow'], 'directory'),
					match(DEEP, 'file'),
					match([...DEEP.slice(0, 4), 'latest_recording'], 'other'),
				],
				truncated,
			),
		);
	}

	/*
	 * The criterion: a hit under a run is drawn, ancestors expanded — out of the one answer, and
	 * with the `<serial>` a row of its own here, because the searched tree draws exactly the
	 * addresses the host answered rather than the levels the URL describes.
	 */
	it('draws every hit with its ancestors expanded, below a run’s `<serial>` included', () => {
		const { container } = showing(['checkout-app'], archive(), hits());

		expect(rows(container).map((row) => row.textContent)).toEqual([
			'checkout-app',
			'login-flow',
			RUN,
			'R5CT30ABCDE',
			'screenshots',
			'login.png',
			'latest_recording',
		]);
	});

	it('draws no branch that holds no match', () => {
		const { container } = showing(['checkout-app'], archive(), hits());

		expect(container.textContent).not.toContain('payments-web');
		expect(container.textContent).not.toContain('unlabeled');
		expect(container.textContent).not.toContain(OLDER);
	});

	it('links a hit to its own address', () => {
		const { container } = showing(['checkout-app'], archive(), hits());

		const hit = rows(container).find((row) => row.textContent === 'login.png');
		expect(hit?.getAttribute('href')).toBe(`/archive/${DEEP.join('/')}`);
	});

	/*
	 * **The searched tree does not collapse** (#175, and #198 left it alone). Every node in it is an
	 * address the host answered with and is drawn expanded by construction, so there is nothing under
	 * it to open and nothing to close: a hit goes to its own address whatever it is drawing beneath
	 * it, and it is **not in the open set** — clicking it toggles nothing. It still says it is open,
	 * because it is.
	 */
	it('links an expanded hit to its own address all the same, and says it is open', () => {
		const { container } = showing(['checkout-app'], archive(), hits());

		const parent = rows(container).find((row) => row.textContent === 'screenshots');
		expect(parent?.getAttribute('href')).toBe(`/archive/${DEEP.slice(0, 5).join('/')}`);
		expect(parent?.getAttribute('aria-expanded')).toBe('true');
		fireEvent.click(rowNamed(container, 'screenshots'));
		expect(toggled).toEqual([]);
		// And a hit with nothing under it claims no state, exactly as a browsing leaf does.
		expect(
			rows(container)
				.find((row) => row.textContent === 'login.png')
				?.getAttribute('aria-expanded'),
		).toBeNull();
	});

	// A hit row is the browsing row, so it carries nothing §9 forbids: the card's heading, the
	// names, and nothing else at all.
	it('carries no count, no status glyph and no outcome colour', () => {
		const { container } = showing(['checkout-app'], archive(), hits());

		expect(container.textContent).toBe(
			[
				'DIRECTORY',
				'checkout-app',
				'login-flow',
				RUN,
				'R5CT30ABCDE',
				'screenshots',
				'login.png',
				'latest_recording',
			].join(''),
		);
		for (const row of rows(container)) {
			// A folder or a file glyph, plus a triangle only where something is drawn under it.
			expect(row.querySelectorAll('svg').length).toBeLessThanOrEqual(2);
			expect(row.className).not.toContain('error');
			expect(row.className).not.toContain('primary');
		}
	});

	it('wraps a hit’s name at its own separators, never `break-all`', () => {
		const { container } = showing(['checkout-app'], archive(), hits());

		expect(container.innerHTML).toContain('break-words');
		expect(container.innerHTML).not.toContain('break-all');
	});

	// A truncated answer must never render like a complete one — in either of its hit counts, since
	// the host sets the flag without recording a match whenever a bound or an unreadable subtree
	// stops a descent, and an empty hit list is the one a reader acts on by giving up.
	it('says a truncated answer is truncated, and says nothing when it is not', () => {
		const { unmount } = showing(['checkout-app'], archive(), hits(true));
		expect(screen.getByText('More names match than are shown. Narrow the text.')).toBeDefined();
		unmount();

		const complete = showing(['checkout-app'], archive(), hits());
		expect(complete.container.textContent).not.toContain('More names match');
		complete.unmount();

		const empty = showing(['checkout-app'], archive(), searching(found([], true)));
		expect(empty.container.textContent).toContain('the part of the archive that could be examined');
		empty.unmount();

		const { container } = showing(['checkout-app'], archive(), searching(found([])));
		expect(container.textContent).not.toContain('the part of the archive that could be examined');
	});

	// The failure this replaced: a search the host cut short, matching nothing, read as a complete
	// and definitive *it is not in the archive*.
	it('never says nothing matched definitively about a search that was cut short', () => {
		const { container } = showing(['checkout-app'], archive(), searching(found([], true)));

		expect(
			screen.getByText(
				'Nothing in the part of the archive that could be examined contains that text.',
			),
		).toBeDefined();
		expect(container.textContent).not.toContain('No name in the archive contains that text.');
		expect(rows(container)).toHaveLength(0);
	});

	it('marks a hit that is where you already are', () => {
		const { container } = showing(['checkout-app', 'login-flow'], archive(), hits());

		const marked = rows(container).filter((row) => row.className.includes('border-tertiary'));
		expect(marked.map((row) => row.textContent)).toEqual(['login-flow']);
	});
});

/**
 * **The lettered label badges, and the groups view is the only place one is drawn** (#182,
 * `docs/DESIGN.md` §9).
 *
 * A letter is defined only inside a group, so the source is what answers it: these cases go through
 * `groupRowSource`, and the `All` view's own tree above — whose exact text is asserted several times
 * over — is the assertion that nothing outside this view gained one.
 */
describe('the label badges', () => {
	const GROUP_ID = 'app-bar-top-space';
	const A_VARIANT = 'home_a_variant';
	const B_VARIANT = 'home_b_variant';
	const BASELINE = 'home-baseline';
	const AFTER = 'home-after';
	const SHOTS = 'screenshots';

	/** One run's archive address — the four levels the archive is always deep (#129). */
	function runPath(testName: string, name: string): readonly string[] {
		return ['checkout-app', testName, name, SERIAL];
	}

	/** One run of a group, filing one artifact per label in the order the host answers them. */
	function grouped(testName: string, name: string, labels: readonly string[]): ArchiveGroupRun {
		return {
			path: [...runPath(testName, name)],
			artifacts: labels.map((label, index) => ({
				path: [...runPath(testName, name), SHOTS, `00${index + 1}_${label}.png`],
				label,
			})),
		};
	}

	/** One group holding those runs, answered as the whole of `list_archive_groups`. */
	function answer(runs: readonly ArchiveGroupRun[]): ArchiveGroups {
		const group: ArchiveGroup = { project: 'checkout-app', groupId: GROUP_ID, runs: [...runs] };
		return { status: 'listed', groups: [group], truncated: false };
	}

	/**
	 * The `list_archive` levels the tree browses inside those runs, **built from the answer itself**
	 * — so the artifacts the grouping walk named and the entries the tree lists cannot drift apart in
	 * this fixture the way they could if both were written out by hand.
	 */
	function levelsFor(runs: readonly ArchiveGroupRun[]): ArchiveLevels {
		const under = new Map<string, ArchiveEntry[]>();
		for (const run of runs) {
			under.set(keyOf(run.path), [file('device_info.json'), directory(SHOTS, 1)]);
			for (const artifact of run.artifacts) {
				const parent = keyOf(artifact.path.slice(0, -1));
				under.set(parent, [...(under.get(parent) ?? []), file(artifact.path.at(-1) ?? '')]);
			}
		}
		return new Map([...under].map(([path, entries]) => [path, listed(...entries)]));
	}

	/** The address of one run's `screenshots` level, in the **tree's** own space — group id and all. */
	function shotsIn(testName: string, name: string): readonly string[] {
		return ['checkout-app', GROUP_ID, testName, name, SERIAL, SHOTS];
	}

	function showingGroups(selected: readonly string[], runs: readonly ArchiveGroupRun[]) {
		return render(
			<DirectoryTree
				branches={branchesFor(selected)}
				selected={selected}
				source={groupRowSource(answer(runs), levelsFor(runs))}
			/>,
		);
	}

	/** The badge on one row of the tree, as the letter it draws — or `null` where there is none. */
	function badgeOn(container: HTMLElement, name: string): string | null {
		const row = rows(container).find((candidate) => candidate.textContent?.endsWith(name));
		const badge = row === undefined ? null : within(row).queryByRole('img');
		return badge?.textContent ?? null;
	}

	// A badge where there is a label, and nowhere else: not on the directory holding the artifacts,
	// not on the run's own files, and not on any level of the arrangement above them.
	it('draws a badge on a labelled artifact and on no other row', () => {
		const { container } = showingGroups(shotsIn(A_VARIANT, RUN), [
			grouped(A_VARIANT, RUN, [BASELINE, AFTER]),
		]);

		expect(badgeOn(container, `001_${BASELINE}.png`)).toBe('A');
		expect(badgeOn(container, `002_${AFTER}.png`)).toBe('B');
		expect(badgeOn(container, 'device_info.json')).toBeNull();
		expect(badgeOn(container, SHOTS)).toBeNull();
		expect(badgeOn(container, RUN)).toBeNull();
		expect(badgeOn(container, 'checkout-app')).toBeNull();
	});

	/*
	 * **The same label is the same letter everywhere in one group**, which is what the badge is for:
	 * two runs filed `home-baseline` and a reader has to see one letter on both. Only one path is
	 * ever expanded, so it is asserted as two loads of the same group — which is also the case that
	 * would catch a letter drifting between two visits to the same address.
	 */
	it('gives one label one letter across two runs of a group', () => {
		const runs = [
			grouped(A_VARIANT, OLDER, [BASELINE, AFTER]),
			grouped(B_VARIANT, RUN, [AFTER, BASELINE]),
		];

		const first = showingGroups(shotsIn(A_VARIANT, OLDER), runs);
		expect(badgeOn(first.container, `001_${BASELINE}.png`)).toBe('A');
		expect(badgeOn(first.container, `002_${AFTER}.png`)).toBe('B');
		first.unmount();

		const second = showingGroups(shotsIn(B_VARIANT, RUN), runs);
		expect(badgeOn(second.container, `002_${BASELINE}.png`)).toBe('A');
		expect(badgeOn(second.container, `001_${AFTER}.png`)).toBe('B');
	});

	// Four letters, then `@` — a case rather than a corner (`docs/DESIGN.md` §9). The badge stops
	// distinguishing them there and the row does not.
	it('gives every label past the fourth `@`, and still says which artifact it is', () => {
		const labels = ['one', 'two', 'three', 'four', 'five', 'six'];
		const { container } = showingGroups(shotsIn(A_VARIANT, RUN), [grouped(A_VARIANT, RUN, labels)]);

		expect(labels.map((label, index) => badgeOn(container, `00${index + 1}_${label}.png`))).toEqual(
			['A', 'B', 'C', 'D', '@', '@'],
		);
		expect(screen.getByText('001_one.png')).toBeDefined();
		expect(screen.getByText('006_six.png')).toBeDefined();
	});

	/*
	 * **The filed label is reachable, and the letter is never the only thing a screen reader gets.**
	 * A letter is a code local to one group and `@` names nothing, so the label the archive filed
	 * travels into the row's own accessible name — and into a `title`, for a reader who hovers.
	 */
	it('puts the filed label in the row’s accessible name and in a `title`', () => {
		const { container } = showingGroups(shotsIn(A_VARIANT, RUN), [
			grouped(A_VARIANT, RUN, [BASELINE]),
		]);

		// Matched as a predicate rather than as one string: whether the accname algorithm separates
		// the badge from the name with a space depends on the badge's computed display, and jsdom
		// applies no stylesheet. What is asserted is what the criterion asks — the filed label and the
		// artifact's own name are both in the row's accessible name.
		const row = screen.getByRole('link', {
			name: (name: string) =>
				name.includes(`Filed under the label ${BASELINE}`) && name.includes(`001_${BASELINE}.png`),
		});
		expect(row.getAttribute('href')).toBe(
			`/groups/${[...shotsIn(A_VARIANT, RUN), `001_${BASELINE}.png`].join('/')}`,
		);
		expect(within(row).getByRole('img').getAttribute('title')).toBe(
			`Filed under the label ${BASELINE}`,
		);
		// And the run's own unlabelled file is untouched by any of it.
		expect(container.textContent).toContain('device_info.json');
	});

	// An artifact with no label carries no badge, so the tree of an archive that never used labels
	// looks exactly as it does today — asserted as the tree's exact text, the way the `All` view's is.
	it('draws nothing at all for a group whose runs carry no label', () => {
		const { container } = showingGroups(shotsIn(A_VARIANT, RUN), [grouped(A_VARIANT, RUN, [])]);

		expect(within(container).queryAllByRole('img')).toHaveLength(0);
		expect(rows(container).map((row) => row.textContent)).toEqual([
			'checkout-app',
			GROUP_ID,
			A_VARIANT,
			RUN,
			'device_info.json',
			SHOTS,
		]);
	});

	/*
	 * **No row outside the groups view gains one**, and it is structural rather than a rule the
	 * component keeps: the `All` source answers no label at any depth, so the same tree over the same
	 * directories draws no badge even for an archive whose group is full of them.
	 */
	it('draws none in the `All` view, over the same directories', () => {
		const runs = [grouped(A_VARIANT, RUN, [BASELINE, AFTER])];
		// The `All` view walks from the root, so it needs the three levels above the run that the
		// groups view reads off its one answer instead.
		const levels: ArchiveLevels = new Map([
			[keyOf([]), listed(directory('checkout-app'))],
			[keyOf(['checkout-app']), listed(directory(A_VARIANT))],
			[keyOf(['checkout-app', A_VARIANT]), listed(directory(RUN, 1, SERIAL))],
			...levelsFor(runs),
		]);
		const selected = ['checkout-app', A_VARIANT, RUN, SERIAL, SHOTS];
		const { container } = render(
			<DirectoryTree
				branches={branchesFor(selected)}
				search={searching(NOT_SEARCHING)}
				selected={selected}
				source={allRowSource(levels)}
			/>,
		);

		expect(screen.getByText(`001_${BASELINE}.png`)).toBeDefined();
		expect(within(container).queryAllByRole('img')).toHaveLength(0);
	});
});
