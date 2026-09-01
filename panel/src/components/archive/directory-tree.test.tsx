import type { ArchiveLevel, ArchiveLevels } from '@panel/archive/archive-levels.js';
import type { ArchiveEntry } from '@panel/archive/archive-listing.js';
import { keyOf } from '@panel/archive/archive-path.js';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

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

function showing(selected: readonly string[], levels: ArchiveLevels = archive()) {
	return render(<DirectoryTree levels={levels} selected={selected} />);
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
