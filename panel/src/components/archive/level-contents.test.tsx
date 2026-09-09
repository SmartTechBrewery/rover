import type { ArchiveLevel } from '@panel/archive/archive-levels.js';
import type { ArchiveEntry } from '@panel/archive/archive-listing.js';
import type { TestRemoval } from '@panel/archive/delete-archived-test.js';
import type { PinState } from '@panel/archive/pinned-tests.js';
import { formatInstant } from '@panel/time/instant.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/*
 * The session the strip's second control reads — it attributes its call with the signed-in identity
 * and asks nothing at all until somebody presses it (`remove-control.tsx`). Everything this file
 * asserts about that control is about the *strip*; what the control does with an answer is
 * `remove-control.test.tsx`'s.
 */
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({
		state: { status: 'signed-in', identity: { identifier: 'karolina', displayName: 'Karolina' } },
		call: async () => await new Promise(() => undefined),
	}),
}));

import { LevelContents } from './level-contents.js';

function directory(name: string, childCount: number | null = 3): ArchiveEntry {
	return { kind: 'directory', name, childCount, onlyChild: null };
}

function listed(...entries: readonly ArchiveEntry[]): ArchiveLevel {
	return { status: 'listed', entries };
}

const RUNS = [
	directory('20260826T101155Z-issue-104-2fd913c7', 1),
	directory('20260828T091544Z-pr-127-review-c8d1a0f3', 1),
	directory('20260830T170501Z-issue-112-9f1c2ab4', 1),
] as const;

/*
 * The newest run's `GRANTED` as the panel draws every instant since #223 — the reader's own
 * zone, to the minute (`docs/DESIGN.md` §6, §9). Composed rather than written out because the
 * zone is whatever machine runs the suite; the format itself is `time/instant.test.ts`'s to
 * assert.
 */
const GRANTED = String(formatInstant('2026-08-30T17:05:01Z'));

function showing(path: readonly string[], level: ArchiveLevel) {
	return render(<LevelContents level={level} path={path} />);
}

/**
 * The rows, and **queried as the `<li>`'s own content rather than as anchors** (#161). They stopped
 * being links when the tree reached every address: what a row carries is unchanged, and that it is
 * no longer followable is what {@link readOnly} asserts per level.
 */
function rows(container: HTMLElement): readonly HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>('li > div')];
}

/** The card holds no clickable element at all while it is showing a level (#161). */
function readOnly(container: HTMLElement): void {
	expect(container.querySelectorAll('a')).toHaveLength(0);
	expect(container.querySelectorAll('button')).toHaveLength(0);
}

/**
 * The header strip — **a name at one end and the two controls at the other** (`docs/DESIGN.md` §9,
 * #276).
 *
 * `readOnly` above still holds for every level drawn without them, which is the arrangement the
 * screen relies on: this card draws six different levels and only a test name's is about one test,
 * so it is handed a control there and at no other depth (`routes/archive.tsx`, `levelRemoval`).
 */
describe('the header strip', () => {
	const UNPINNED: PinState = { checked: false, toggle: () => undefined };
	const REMOVAL: TestRemoval = {
		kind: 'test',
		project: 'checkout-app',
		testName: 'login-flow',
		runs: 42,
		kept: false,
		card: 'test',
	};

	function withControls(path: readonly string[] = ['checkout-app', 'login-flow']) {
		return render(
			<LevelContents
				level={listed(...RUNS)}
				onRemoveSettled={() => undefined}
				path={path}
				pin={UNPINNED}
				removal={REMOVAL}
			/>,
		);
	}

	/** The strip is the card's first child — the bordered row above the body. */
	function strip(container: HTMLElement): HTMLElement {
		return container.querySelector('section > div:first-child') as HTMLElement;
	}

	it('carries the name, then the tick, then Remove — in that order', () => {
		const { container } = withControls();
		const row = strip(container);

		expect(row.querySelector('h2')?.textContent).toBe('login-flow');
		expect(row.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
		expect(
			[...row.querySelectorAll('input[type="checkbox"], button')].map((node) => node.tagName),
		).toEqual(['INPUT', 'BUTTON']);
		expect(screen.getByRole('button', { name: 'Remove test login-flow' }).textContent).toBe(
			'Remove',
		);
	});

	/*
	 * **One `shrink-0` box around the pair**, which is what keeps the heading's own wrap: two children
	 * of the outer row would each negotiate their width against a 40-character name, and the tick
	 * would be the one that lost it (§9's *the sentence did not fit* finding, in the other direction).
	 */
	it('keeps the pair together and leaves the heading the wrap', () => {
		const { container } = withControls();
		const row = strip(container);

		const pair = row.querySelector('div:has(> button)');
		expect(pair?.className).toContain('shrink-0');
		expect(pair?.querySelectorAll('input[type="checkbox"], button')).toHaveLength(2);
		expect(row.querySelector('div.min-w-0')?.querySelector('h2')).not.toBeNull();
	});

	// A 40-character name is the length that forced §9's popover, and the strip has to survive it
	// with two controls in it: the name wraps and neither control is pushed out of the card.
	it('survives a 40-character name in the heading', () => {
		const { container } = withControls([
			'checkout-app',
			'20260830T170501Z-issue-112-9f1c2ab4-long',
		]);

		expect(container.querySelector('h2')?.className).toContain('break-words');
		expect(screen.getByRole('button', { name: 'Remove test login-flow' }).className).toContain(
			'shrink-0',
		);
	});

	/*
	 * **No control at a depth that is not about a test**, and this card draws four such depths. The
	 * decision is the screen's (`levelRemoval`), so what is asserted here is that a card handed
	 * nothing draws nothing — the rule `force-release-control.tsx` records: no branch for a control
	 * that cannot exist.
	 */
	it('draws neither control at a depth it was handed nothing for', () => {
		const { container } = showing([], listed(directory('checkout-app')));

		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.querySelectorAll('input')).toHaveLength(0);
	});

	// And the tick without the control is a real arrangement: it is a group's card in the groups
	// view, where the tick writes an array and `Remove` is phase 3's (§9's phase boundary).
	it('draws the tick without Remove when it is handed only the tick', () => {
		const { container } = render(
			<LevelContents
				level={listed(...RUNS)}
				path={['checkout-app', 'a-group']}
				pin={UNPINNED}
				pinScope="group"
			/>,
		);

		expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
		expect(container.querySelectorAll('button')).toHaveLength(0);
	});
});

describe('the root', () => {
	it('names itself `Archive` and lists one row per project', () => {
		const { container } = showing([], listed(directory('checkout-app'), directory('payments-web')));

		expect(screen.getByRole('heading', { name: 'Archive' })).toBeDefined();
		expect(rows(container).map((row) => row.textContent)).toEqual(['checkout-app', 'payments-web']);
	});

	/*
	 * **No link affordance, and no hover treatment that promises one** (#161). The tree beside this
	 * card reaches every address in the archive (#159), so the approved markup's `cursor-default` is
	 * right after all and these rows are read rather than followed.
	 */
	it('lists its projects as read-only rows, with nothing to click and nothing to hover', () => {
		const { container } = showing([], listed(directory('checkout-app')));

		readOnly(container);
		expect(container.innerHTML).not.toContain('hover:');
		expect(container.innerHTML).not.toContain('cursor-pointer');
	});
});

describe('a project', () => {
	it('lists its test names with the number of runs under each', () => {
		showing(['checkout-app'], listed(directory('login-flow', 42), directory('unlabeled', 1)));

		expect(screen.getByRole('heading', { name: 'checkout-app' })).toBeDefined();
		expect(screen.getByText('42')).toBeDefined();
		expect(screen.getAllByText('RUNS')).toHaveLength(2);
	});

	/*
	 * `null` is not `0`. A `0` would say *no runs* about a directory the host could not read into,
	 * which is the whole reason the wire carries `childCount: null` rather than a number.
	 */
	it('says `unknown` for a test name it could not read into, never `0`', () => {
		const { container } = showing(['checkout-app'], listed(directory('sealed', null)));

		expect(screen.getByText('unknown')).toBeDefined();
		expect(container.textContent).not.toContain('0');
	});

	it('lists its test names as read-only rows, keeping every field they carried as links', () => {
		const { container } = showing(['checkout-app'], listed(directory('login-flow', 42)));

		expect(rows(container).map((row) => row.textContent)).toEqual(['login-flowRUNS42']);
		readOnly(container);
		expect(container.innerHTML).not.toContain('hover:');
	});

	// A legacy directory from before `test_name` was required is an ordinary row (D22, #129).
	it('lists a legacy unlabeled directory like any other test name', () => {
		const { container } = showing(['checkout-app'], listed(directory('unlabeled', 4)));

		const [row] = rows(container);
		expect(row?.textContent).toBe('unlabeled' + 'RUNS' + '4');
		readOnly(container);
	});
});

describe('a test name', () => {
	/*
	 * Most recent first. The host's order is chronological by construction — a lease directory leads
	 * with a UTC basic-format timestamp so that it sorts chronologically as text — so this is that
	 * order reversed, and reversing is not parsing.
	 */
	it('lists its runs most recent first', () => {
		const { container } = showing(['checkout-app', 'login-flow'], listed(...RUNS));

		expect(rows(container).map((row) => row.textContent?.split('OWNER')[0])).toEqual([
			'20260830T170501Z-issue-112-9f1c2ab4',
			'20260828T091544Z-pr-127-review-c8d1a0f3',
			'20260826T101155Z-issue-104-2fd913c7',
		]);
	});

	it('reads `OWNER` and `GRANTED` out of the directory name', () => {
		showing(['checkout-app', 'login-flow'], listed(...RUNS));

		expect(screen.getByText('issue-112')).toBeDefined();
		expect(screen.getByText(GRANTED)).toBeDefined();
		// The owner is everything between the first and the last hyphen, hyphens included.
		expect(screen.getByText('pr-127-review')).toBeDefined();
	});

	it('says `unknown` for a name that does not decompose, and shows the name in full', () => {
		showing(['checkout-app', 'login-flow'], listed(directory('handwritten', 1)));

		expect(screen.getByText('handwritten')).toBeDefined();
		expect(screen.getAllByText('unknown')).toHaveLength(2);
	});

	it('lists its runs as read-only rows, keeping `OWNER` and `GRANTED`', () => {
		const { container } = showing(['checkout-app', 'login-flow'], listed(...RUNS));

		readOnly(container);
		expect(container.innerHTML).not.toContain('hover:');
		expect(screen.getAllByText('OWNER')).toHaveLength(3);
	});
});

describe('an entry the archive is not supposed to have here', () => {
	// Dropping it would make a short listing look exactly like a complete one, which is the reason
	// the host reports `other` at all rather than omitting it.
	it('lists a file and a `kind: other` entry by name, with no size and no count', () => {
		const { container } = showing(
			['checkout-app'],
			listed(
				{ kind: 'file', name: 'stray.txt', sizeBytes: 12 },
				{ kind: 'other', name: 'a-socket' },
			),
		);

		expect(rows(container).map((row) => row.textContent)).toEqual(['stray.txt', 'a-socket']);
		expect(container.textContent).not.toContain('12');
		// It is named rather than reachable: the tree beside the card is what takes a reader into an
		// address, and it draws no row for a stray file above a run either.
		readOnly(container);
	});
});

describe('a level with nothing in it', () => {
	it('says so plainly, with no panel and no alarm', () => {
		const { container } = showing(['checkout-app', 'login-flow'], { status: 'empty' });

		expect(screen.getByText(/Nothing is filed under this directory/)).toBeDefined();
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	it('says the host cannot see into an unreadable one, with no retry and no code', () => {
		const { container } = showing(['checkout-app', 'login-flow'], { status: 'unreadable' });

		expect(screen.getByText('ARCHIVE NOT READABLE')).toBeDefined();
		expect(screen.getByText(/runs may well be filed here/)).toBeDefined();
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	it('says it is reading, with no spinner', () => {
		const { container } = showing(['checkout-app'], { status: 'loading' });

		expect(screen.getByText('Reading this level of the archive.')).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
	});
});
