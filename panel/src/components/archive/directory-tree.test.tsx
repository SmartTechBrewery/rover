import type { ArchiveLevel, ArchiveLevels } from '@panel/archive/archive-levels.js';
import type { ArchiveEntry, ArchiveSearchMatch } from '@panel/archive/archive-listing.js';
import { keyOf } from '@panel/archive/archive-path.js';
import type { ArchiveSearch, ArchiveSearchState } from '@panel/archive/archive-search.js';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `breadcrumb.test.tsx`'s shape: a `Link` is a plain anchor, so the tree renders with no router
// instance. The splat's own encoding is asserted against a real router in `archive-path.test.tsx`.
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		params,
		children,
		...rest
	}: {
		to: string;
		params?: { _splat?: string };
		children: ReactNode;
	} & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={`${to.replace('$', '')}${params?._splat ?? ''}`} {...rest}>
			{children}
		</a>
	),
}));

import { DirectoryTree } from './directory-tree.js';

function directory(name: string, childCount: number | null = 3): ArchiveEntry {
	return { kind: 'directory', name, childCount, onlyChild: null };
}

function listed(...entries: readonly ArchiveEntry[]): ArchiveLevel {
	return { status: 'listed', entries };
}

const RUN = '20260830T170501Z-issue-112-9f1c2ab4';
/** The run filed the day before — the one the host's own ascending order puts first. */
const OLDER = '20260829T142201Z-issue-112-4b0e7c15';

/**
 * The archive the tests below browse: two projects, two test names, two runs.
 *
 * **The run level is seeded in the host's own order**, which is ascending code-unit over names that
 * lead with a UTC basic-format timestamp, so oldest first (`src/daemon/list-archive.ts`). Seeding it
 * already-descending is what let the tree and the contents card disagree unseen.
 */
function archive(overrides: Record<string, ArchiveLevel> = {}): ArchiveLevels {
	const levels = new Map<string, ArchiveLevel>([
		[keyOf([]), listed(directory('checkout-app'), directory('payments-web'))],
		[keyOf(['checkout-app']), listed(directory('login-flow', 42), directory('unlabeled', 1))],
		[keyOf(['checkout-app', 'login-flow']), listed(directory(OLDER, 1), directory(RUN, 1))],
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

function showing(
	selected: readonly string[],
	levels: ArchiveLevels = archive(),
	search: ArchiveSearch = searching(NOT_SEARCHING),
) {
	return render(<DirectoryTree levels={levels} search={search} selected={selected} />);
}

function rows(container: HTMLElement): readonly HTMLElement[] {
	return [...container.querySelectorAll('a')];
}

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
	 * The lazy-expansion assertion, in DOM terms. A node is expanded exactly when it is a prefix of
	 * the selection, so `payments-web` has no children drawn — nothing was read for it, and nothing
	 * ever will be until it is selected.
	 */
	it('expands only the selected path', () => {
		const { container } = showing(['checkout-app', 'login-flow']);

		const names = rows(container).map((row) => row.textContent);
		expect(names).toContain(RUN);
		expect(names.filter((name) => name === 'payments-web')).toHaveLength(1);
		expect(names.indexOf('payments-web')).toBe(names.length - 1);
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

	it('links every row to its own level', () => {
		const { container } = showing(['checkout-app']);

		const login = rows(container).find((row) => row.textContent === 'login-flow');
		expect(login?.getAttribute('href')).toBe('/archive/checkout-app/login-flow');
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
	 */
	it('carries a folder on every row and a triangle only on an expandable one', () => {
		const { container } = showing(['checkout-app', 'login-flow']);

		for (const row of rows(container)) {
			const icons = row.querySelectorAll('svg');
			const isRun = row.textContent?.startsWith('2026') === true;
			expect(icons).toHaveLength(isRun ? 1 : 2);
		}
	});

	it('gives a run no triangle, because a run is a leaf', () => {
		const { container } = showing(['checkout-app', 'login-flow', RUN]);

		const run = rows(container).find((row) => row.textContent === RUN);
		expect(run?.querySelectorAll('svg')).toHaveLength(1);
		// And nothing is drawn under it: the `<serial>` is a fact about the run, not a level.
		expect(container.textContent).not.toContain('R5CT30ABCDE');
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

	// `lucide-react`'s glyph, not the design's Material Symbols one — and decoration, not a control.
	it('carries one leading glyph, hidden from assistive technology', () => {
		showing([]);

		const glyph = screen.getByRole('textbox').parentElement?.querySelector('svg');
		expect(glyph?.getAttribute('aria-hidden')).toBe('true');
		expect(glyph?.getAttribute('width')).toBe('18');
		expect(glyph?.className.baseVal).toContain('absolute');
		expect(screen.queryByRole('button')).toBeNull();
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
	 * The criterion: a hit under a run is drawn, ancestors expanded — which the URL's own tree
	 * cannot do, because a run is a leaf there and its `<serial>` is not a level at all.
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

	// A truncated answer must never render like a complete one.
	it('says a truncated answer is truncated, and says nothing when it is not', () => {
		const { unmount } = showing(['checkout-app'], archive(), hits(true));
		expect(screen.getByText('More names match than are shown. Narrow the text.')).toBeDefined();
		unmount();

		const { container } = showing(['checkout-app'], archive(), hits());
		expect(container.textContent).not.toContain('More names match');
	});

	it('marks a hit that is where you already are', () => {
		const { container } = showing(['checkout-app', 'login-flow'], archive(), hits());

		const marked = rows(container).filter((row) => row.className.includes('border-tertiary'));
		expect(marked.map((row) => row.textContent)).toEqual(['login-flow']);
	});
});
