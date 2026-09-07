import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The host, scripted **per address** — `artifact.test.tsx`'s shape, one answer per file, because
 * the whole of this card is N panes each reading their own artifact.
 *
 * `URL.createObjectURL` and `URL.revokeObjectURL` are installed for the whole `panel` project by
 * `tests/panel-setup.ts` (jsdom implements neither), so a test that wants to observe one `vi.spyOn`s
 * it and `clearMocks` restores it.
 */
const { host } = vi.hoisted(() => ({
	host: {
		/** What the byte route answers for one file name; anything unnamed is `missing`. */
		byName: {} as Record<string, unknown>,
		/** Every address the byte route was asked for, in order. */
		asked: [] as readonly (readonly string[])[],
	},
}));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({
		readArtifactBytes: async (path: readonly string[]) => {
			host.asked = [...host.asked, path];
			return {
				ok: true,
				value: host.byName[path.at(-1) ?? ''] ?? { outcome: 'missing' },
			};
		},
	}),
}));

import type { ComparisonPane, LabelComparison } from '@panel/archive/label-comparison.js';
import { ComparisonCard } from './comparison-card.js';

const PROJECT = 'c-ai';
const SERIAL = 'R5CT30ABCDE';
const ARM_A = 'statistics-deliveries_variantA';
const ARM_B = 'statistics-deliveries_variantB';
const FIRST = '20260901T090000Z-issue-199-1111aaaa';
const SECOND = '20260902T090000Z-pr-127-review-2222bbbb';
const LABEL = 'deliveries-list';

function pane(testName: string, run: string, name: string): ComparisonPane {
	const address = [PROJECT, testName, run, SERIAL];
	return { run: address, path: [...address, 'screenshots', name] };
}

function comparison(...panes: readonly ComparisonPane[]): LabelComparison {
	return { label: LABEL, panes };
}

const TWO = comparison(pane(ARM_A, FIRST, 'before.png'), pane(ARM_B, SECOND, 'after.png'));

function bytes(mediaType: string, body: string) {
	return { outcome: 'read', mediaType, bytes: new Blob([body], { type: mediaType }) };
}

/** Renders the card and lets each pane's own read settle — one answer and one decode per pane. */
async function showing(drawn: LabelComparison = TWO) {
	const rendered = render(<ComparisonCard comparison={drawn} />);
	for (let turn = 0; turn < 4; turn += 1) {
		await act(async () => undefined);
	}
	return rendered;
}

/** The panes, in the order they are drawn — left to right is the whole claim of this card. */
function panes(container: HTMLElement): readonly HTMLElement[] {
	return [...container.querySelectorAll('article')] as HTMLElement[];
}

/** One pane's `Field`s as `[label, value]` pairs, in the order the pane states them. */
function fieldsOf(drawn: HTMLElement | undefined): readonly (readonly string[])[] {
	return [...(drawn?.querySelectorAll('div.flex-col > div.flex-col') ?? [])].map((field) =>
		[...field.querySelectorAll('span')].map((part) => part.textContent ?? ''),
	);
}

beforeEach(() => {
	host.byName = {
		'before.png': bytes('image/png', 'before'),
		'after.png': bytes('image/png', 'after'),
	};
	host.asked = [];
});

describe('a label’s artifacts side by side', () => {
	// The label names the card, and it is the label **as the archive filed it**.
	it('is headed by the filed label, and by nothing else in that strip', async () => {
		const { container } = await showing();

		expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(LABEL);
		const strip = container.querySelector('section > div:first-child');
		expect(strip?.textContent).toBe(`LABEL${LABEL}`);
		// No count, no chip, no glyph and no control in the strip.
		expect(strip?.querySelectorAll('button')).toHaveLength(0);
		expect(strip?.querySelectorAll('a')).toHaveLength(0);
		expect(strip?.textContent).not.toContain('2');
	});

	// One pane per artifact, **in the given DOM order** — oldest run on the left is decided upstream
	// and drawn here, so what is asserted is that the order is preserved rather than re-sorted.
	it('draws one pane per artifact, in the order it was given', async () => {
		const { container } = await showing();

		const drawn = panes(container);
		expect(drawn).toHaveLength(2);
		expect(drawn[0]?.textContent).toContain(FIRST);
		expect(drawn[1]?.textContent).toContain(SECOND);
	});

	// A group may hold seven runs (R41) and nothing caps N.
	it('draws seven panes for seven artifacts', async () => {
		const seven = comparison(
			...Array.from({ length: 7 }, (_unused, index) => pane(ARM_A, FIRST, `run-${index}.png`)),
		);

		const { container } = await showing(seven);

		expect(panes(container)).toHaveLength(7);
	});

	/*
	 * **Wide content scrolls inside the card**, which is the other half of the row beside the tree
	 * being two fractions that shrink into the gutter (#172): the page body must not scroll
	 * horizontally, so the row of panes owns the overflow and the card keeps `min-w-0`.
	 */
	it('scrolls the row inside the card rather than widening it', async () => {
		const { container } = await showing();

		const row = container.querySelector('section > div:last-child > div');
		expect(row?.className).toContain('overflow-x-auto');
		expect(row?.className).toContain('flex');
		const card = container.querySelector('section');
		expect(card?.className).toContain('min-w-0');
		expect(card?.className).toContain('overflow-hidden');
		// A floor on the pane, never on the card — a card with a width puts the split on the window.
		expect(panes(container)[0]?.className).toContain('min-w-[240px]');
		expect(card?.className).not.toMatch(/\bw-\[/);
	});

	/*
	 * Which run a pane is, in the vocabulary the screen already has: the directory's own name, its
	 * test name off the run's address, and `OWNER` / `GRANTED` decomposed at the first and the last
	 * hyphen — never `split('-')`, because `pr-127-review` is **one** owner (D20, D22).
	 */
	it('says which run each pane is, without parsing a component to death', async () => {
		const { container } = await showing();

		const later = panes(container)[1];
		expect(later?.querySelector('h3')?.textContent).toBe(SECOND);
		expect(fieldsOf(later)).toEqual([
			['TEST NAME', ARM_B],
			// The whole owner, not `pr` — which is what `split('-')` would have made of it.
			['OWNER', 'pr-127-review'],
			// Reformatted textually, and it is what lets a reader check *oldest on the left*.
			['GRANTED', '2026-09-02 09:00:00 UTC'],
		]);
		expect(fieldsOf(panes(container)[0])).toEqual([
			['TEST NAME', ARM_A],
			['OWNER', 'issue-199'],
			['GRANTED', '2026-09-01 09:00:00 UTC'],
		]);
	});

	it('says `unknown` for a run name that does not decompose, with the name still in full', async () => {
		const odd = comparison(
			pane(ARM_A, 'norunshape', 'before.png'),
			pane(ARM_B, SECOND, 'after.png'),
		);

		const { container } = await showing(odd);

		const first = panes(container)[0];
		expect(first?.querySelector('h3')?.textContent).toBe('norunshape');
		expect(first?.textContent).toContain('unknown');
	});

	it('names each pane’s own file, and asks the byte route for each address', async () => {
		const { container } = await showing();

		expect(host.asked).toEqual([
			[PROJECT, ARM_A, FIRST, SERIAL, 'screenshots', 'before.png'],
			[PROJECT, ARM_B, SECOND, SERIAL, 'screenshots', 'after.png'],
		]);
		expect(panes(container)[0]?.textContent).toContain('before.png');
		expect(screen.getByAltText('before.png')).toBeDefined();
		expect(screen.getByAltText('after.png')).toBeDefined();
	});
});

describe('each pane draws the body its content type says', () => {
	it('draws a recording with the browser’s own controls, and no autoplay or loop', async () => {
		host.byName = {
			'before.mp4': bytes('video/mp4', 'a'),
			'after.mp4': bytes('video/mp4', 'b'),
		};

		const { container } = await showing(
			comparison(pane(ARM_A, FIRST, 'before.mp4'), pane(ARM_B, SECOND, 'after.mp4')),
		);

		const videos = container.querySelectorAll('video');
		expect(videos).toHaveLength(2);
		for (const video of videos) {
			expect(video.hasAttribute('controls')).toBe(true);
			expect(video.hasAttribute('autoplay')).toBe(false);
			expect(video.hasAttribute('loop')).toBe(false);
		}
	});

	it('draws a text artifact with a line gutter, scrolling inside its own pane', async () => {
		host.byName = {
			'before.txt': bytes('text/plain', 'one\ntwo'),
			'after.txt': bytes('text/plain', 'one\ntwo\nthree'),
		};

		const { container } = await showing(
			comparison(pane(ARM_A, FIRST, 'before.txt'), pane(ARM_B, SECOND, 'after.txt')),
		);

		const lists = container.querySelectorAll('ol');
		expect(lists).toHaveLength(2);
		expect(lists[0]?.querySelectorAll('li')).toHaveLength(2);
		expect(lists[1]?.querySelectorAll('li')).toHaveLength(3);
		expect(lists[0]?.parentElement?.className).toContain('overflow-y-auto');
	});

	/*
	 * **`opaque` creates no object URL and says so in one sentence** — an address for something a
	 * browser will not display is only ever an offer to download (§10).
	 */
	it('says it cannot draw bytes it cannot name, with no object URL and no control', async () => {
		const created = vi.spyOn(URL, 'createObjectURL');
		host.byName = {
			'before.bin': bytes('application/octet-stream', 'a'),
			'after.bin': bytes('application/octet-stream', 'b'),
		};

		const { container } = await showing(
			comparison(pane(ARM_A, FIRST, 'before.bin'), pane(ARM_B, SECOND, 'after.bin')),
		);

		expect(screen.getAllByText(/no way to show this file/)).toHaveLength(2);
		expect(created).not.toHaveBeenCalled();
		expect(container.querySelectorAll('a')).toHaveLength(0);
	});

	// The three answers that are not an artifact, and no two of them render alike (D6).
	it('tells a missing artifact from one the host will not serve', async () => {
		host.byName = { 'after.png': { outcome: 'unreadable' } };

		const { container } = await showing();

		expect(screen.getByText(/Nothing is filed at this address/)).toBeDefined();
		expect(screen.getByText(/Rover cannot read this artifact/)).toBeDefined();
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
	});

	it('says a pane is still reading, in one line and with no spinner', async () => {
		const { container } = render(<ComparisonCard comparison={TWO} />);

		expect(screen.getAllByText('Reading this artifact.')).toHaveLength(2);
		expect(container.innerHTML).not.toContain('animate');
		// And the reads settle inside the test rather than after it, so React has nothing to warn
		// about a state update landing outside `act`.
		for (let turn = 0; turn < 4; turn += 1) {
			await act(async () => undefined);
		}
	});

	// The one control on a pane, and it is the existing one: a view rather than a transfer (§10).
	it('offers `Open in a new window` per pane, and no download', async () => {
		const { container } = await showing();

		const controls = screen.getAllByRole('link', { name: /Open in a new window/ });
		expect(controls).toHaveLength(2);
		for (const control of controls) {
			expect(control.getAttribute('target')).toBe('_blank');
			expect(control.getAttribute('rel')).toBe('noopener noreferrer');
			expect(control.hasAttribute('download')).toBe(false);
		}
		expect(container.innerHTML).not.toContain('download');
	});
});

/**
 * **What this card must not do** — the issue's binding rules, and most of them are §11's list of
 * what the reference screen got wrong. The comparison is visual and human-judged: Rover computes no
 * diff and reports no verdict (`docs/DESIGN_INITIAL_PROMPT.md` §4, `ai/RULES.md` §1).
 */
describe('nothing on this card is a verdict, and nothing is invented', () => {
	it('carries no outcome vocabulary, no baseline framing and no fact Rover does not have', async () => {
		const { container } = await showing();
		const text = container.textContent ?? '';

		for (const absent of [
			'PASS',
			'FAIL',
			'SUCCESS',
			'COMPLETE',
			'BASELINE',
			'CURRENT',
			'Visual Regression',
			'HASH',
			'BRANCH',
			'SWAP',
			'SYNC SCROLL',
			'RESYNC',
			'RUN A',
			'RUN B',
			'✓',
			'✗',
			'×',
		]) {
			expect(text).not.toContain(absent);
		}
	});

	// No diff, no score, no highlight, and no second explorer: the tree is how another artifact is
	// chosen (#160). No zoom, pan, rotate, filmstrip or next/previous either.
	it('offers no control of its own at all', async () => {
		const { container } = await showing();

		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.querySelectorAll('input')).toHaveLength(0);
		const text = (container.textContent ?? '').toLowerCase();
		for (const absent of [
			'diff',
			'score',
			'zoom',
			'rotate',
			'next',
			'previous',
			'filmstrip',
			'swap',
			'sync',
			'annotate',
			'measure',
			'verdict',
			'force_release',
			'profile',
		]) {
			expect(text).not.toContain(absent);
		}
	});

	/*
	 * **The region around each artifact is clean** — the rule that is not traded away (§5, §9), and
	 * it holds for every pane. The reference screen's own coloured pane borders, its simulated phone
	 * status bar and its `object-cover` crop are all in this list.
	 */
	it('lays nothing over or around any pane’s artifact', async () => {
		const { container } = await showing();
		const markup = container.innerHTML;

		for (const forbidden of [
			'scanline',
			'mix-blend',
			'bg-gradient',
			'bg-linear',
			'shadow-',
			'drop-shadow',
			'opacity-',
			'backdrop-',
			'vignette',
			'watermark',
			'bezel',
			'object-cover',
			'animate',
			'cursor-',
		]) {
			expect(markup).not.toContain(forbidden);
		}
		/*
		 * **No red/green pairing by another name**: the panes are one treatment, so no arm is framed
		 * in a colour the other is not. Scoped to the panes' own class lists — the recessive control
		 * inside one carries the tree's hover accent, which is a control's and not an arm's.
		 */
		const classes = new Set(panes(container).map((drawn) => drawn.className));
		expect(classes.size).toBe(1);
		for (const colour of ['border-error', 'border-tertiary', 'border-secondary-container']) {
			expect([...classes][0]).not.toContain(colour);
		}
	});
});
