import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LabelBadge, PALETTE_CYCLES } from './label-badge.js';

const LABEL = 'home-baseline';

/** The four families cycle 1 names directly, in the order the component declares them. */
const FAMILIES = ['primary', 'secondary', 'tertiary', 'neutral'] as const;

/**
 * How many badges draw a distinct fill before the palette repeats — four families across
 * {@link PALETTE_CYCLES} steps. Read off the component's own constant rather than written as 28,
 * so raising the ramp raises this with it.
 */
const DISTINCT_FILLS = FAMILIES.length * PALETTE_CYCLES;

/** `1`, `2`, … `n`, which is the only vocabulary a badge has now — there is no overflow value. */
function upTo(last: number): readonly number[] {
	return Array.from({ length: last }, (_, index) => index + 1);
}

/** The classes one badge is drawn with, rendered and torn down so the next number starts clean. */
function classesOf(number: number): readonly string[] {
	const { container, unmount } = render(<LabelBadge label={LABEL} number={number} />);
	const className = container.querySelector('span')?.className ?? '';
	unmount();
	return className.split(' ');
}

/**
 * Just the fill, which is the one thing the number's position decides — and it is spelled two ways
 * on purpose (#200). Cycle 1 names a token directly in a `bg-` utility; every later cycle names its
 * family and its cycle, and the colour those two compose is derived in `panel/src/index.css` and
 * judged by `tests/unit/panel/label-badge-palette.test.ts`. Both are class-level identities, so
 * everything below compares them the same way.
 */
function fillOf(number: number): string {
	const classes = classesOf(number);
	const utility = classes.find((name) => name.startsWith('bg-'));
	if (utility !== undefined) {
		return utility;
	}
	return classes.filter((name) => /^label-badge-(?!step$)/.test(name)).join(' ');
}

describe('the label badge', () => {
	/*
	 * **The number carries the meaning, never the colour alone.** It is drawn as text, at badge
	 * size, so a reader who cannot tell two fills apart still has two badges that differ — and it is
	 * drawn for every number a group can reach, because the numbers have no ceiling (#206).
	 */
	it('draws the number as text, at one, two and three digits', () => {
		for (const number of [2, 12, 123]) {
			const { unmount } = render(<LabelBadge label={LABEL} number={number} />);
			expect(screen.getByRole('img').textContent).toBe(`#${number}`);
			unmount();
		}
	});

	/*
	 * **A badge must not read as the artifact's own sequence number** (#206). An archived artifact
	 * leads with a zero-padded ordinal inside its file name, so `2` beside a row named `007_…` is
	 * exactly the wrong reading. The badge's own separations are asserted here at the level markup
	 * can reach: a leading `#`, which a file's ordinal never carries, and no zero-padding.
	 */
	it('leads with `#` and never pads the number', () => {
		for (const number of upTo(12)) {
			const { unmount } = render(<LabelBadge label={LABEL} number={number} />);
			const drawn = screen.getByRole('img').textContent ?? '';
			expect(drawn).toBe(`#${number}`);
			expect(drawn).not.toMatch(/^#0/);
			unmount();
		}
	});

	/*
	 * **The filed label stays reachable, by hover and by screen reader** — because a number is a code
	 * local to one group. Both channels say the same sentence, so hovering and listening give one
	 * answer rather than two, and the number is deliberately *not* in it: read out beside the
	 * artifact's own ordinal it is the one place the two could be confused by ear.
	 */
	it('names the filed label in its accessible name and in `title`, and not the number', () => {
		render(<LabelBadge label={LABEL} number={1} />);

		const badge = screen.getByRole('img', { name: `Filed under the label ${LABEL}` });
		expect(badge.getAttribute('title')).toBe(`Filed under the label ${LABEL}`);
		// Verbatim, as the archive filed it: nothing here trims it, shortens it or lower-cases it.
		expect(badge.getAttribute('title')).toContain(LABEL);
		expect(badge.getAttribute('aria-label')).not.toContain('1');
	});

	/*
	 * **Cycle 1 is byte-identical to what #182 shipped**, which is the whole of why cycling the four
	 * colours costs nothing: the first four badges draw on the same four fills, in the same order.
	 * Pinned exactly, so the cycle cannot drift under a later edit.
	 */
	it('draws `#1`…`#4` on the four colours it draws them on today', () => {
		expect(classesOf(1)).toContain('bg-primary-fixed');
		expect(classesOf(1)).toContain('text-on-primary-fixed');
		expect(classesOf(2)).toContain('bg-secondary-fixed');
		expect(classesOf(2)).toContain('text-on-secondary-fixed');
		expect(classesOf(3)).toContain('bg-tertiary-fixed');
		expect(classesOf(3)).toContain('text-on-tertiary-fixed');
		expect(classesOf(4)).toContain('bg-inverse-surface');
		expect(classesOf(4)).toContain('text-inverse-on-surface');
	});

	/*
	 * **Two consecutive numbers never carry one colour** (#197). Cycling family-first is what makes
	 * that true by construction rather than by inspection, and this is that criterion in executable
	 * form at the level a class name can honestly reach. The fills repeat with a period of
	 * {@link DISTINCT_FILLS}, so checking one period plus one covers **every** consecutive pair an
	 * unbounded sequence of numbers can produce — the wrap included, which is the one boundary #206
	 * adds. The perceptual half is `tests/unit/panel/label-badge-palette.test.ts`, which recomputes
	 * the fills from the tokens.
	 */
	it('gives no two consecutive numbers one fill, the wrap included', () => {
		const fills = upTo(DISTINCT_FILLS + 1).map(fillOf);

		for (const [index, fill] of fills.entries()) {
			if (index > 0) {
				expect(fill, `#${index + 1}`).not.toBe(fills[index - 1]);
			}
		}
	});

	/*
	 * **The colour ramp keeps its own ceiling, and the number is what disambiguates past it**
	 * (#206). Four families across {@link PALETTE_CYCLES} honest steps is twenty-eight fills and no
	 * more; a twenty-ninth step would be a colour nobody commissioned, so the fill **repeats** and
	 * the digits are the identity. That is a wrap rather than a fallback: `#29` is a badge like any
	 * other and says its own label, where `@` said nothing at all.
	 */
	it('wraps the fill at the last cycle instead of inventing a step', () => {
		expect(fillOf(DISTINCT_FILLS + 1)).toBe(fillOf(1));
		expect(fillOf(DISTINCT_FILLS + 2)).toBe(fillOf(2));
		expect(fillOf(2 * DISTINCT_FILLS)).toBe(fillOf(DISTINCT_FILLS));
		// Exactly one period of distinct fills, over three periods of numbers.
		expect(new Set(upTo(3 * DISTINCT_FILLS).map(fillOf)).size).toBe(DISTINCT_FILLS);
		// And no fill names a cycle the stylesheet does not define.
		for (const number of upTo(3 * DISTINCT_FILLS)) {
			for (const name of classesOf(number)) {
				const cycle = /^label-badge-cycle-(\d+)$/.exec(name);
				if (cycle !== null) {
					expect(Number(cycle[1]), `#${number}`).toBeLessThanOrEqual(PALETTE_CYCLES);
				}
			}
		}
	});

	/*
	 * **Every colour comes from `panel/src/tokens.css`** (`ai/RULES.md` §8, `docs/DESIGN.md` §1).
	 * `tests/unit/panel/tokens-are-the-source-of-truth.test.ts` is the gate that fails on a hex
	 * anywhere under `panel/src`; what is asserted here is that a fill is never drawn without the
	 * text step that makes the number legible on it. Cycle 1 carries both as `bg-`/`on-` utilities;
	 * a later cycle carries `label-badge-step`, whose one rule sets the background *and* the colour
	 * from the family's own two tokens, so the pair cannot come apart there either.
	 */
	it('pairs every fill with a text step, and writes no colour of its own', () => {
		for (const number of upTo(DISTINCT_FILLS + 1)) {
			const classes = classesOf(number);

			if (classes.includes('label-badge-step')) {
				// A family and a cycle, and nothing else: the colour is `index.css`'s to derive.
				expect(classes.some((name) => /^label-badge-cycle-\d$/.test(name))).toBe(true);
				expect(classes.some((name) => name.startsWith('bg-'))).toBe(false);
				continue;
			}
			expect(classes.some((name) => name.startsWith('bg-'))).toBe(true);
			// `text-inverse-on-surface` is the design system's own pairing for `bg-inverse-surface`, so
			// the `on-` step is not always spelled with the `text-on-` prefix.
			expect(classes.some((name) => name.includes('on-'))).toBe(true);
		}
	});

	/*
	 * **Every number past `#4` is a family and a step of it** (#200), which is the whole of what the
	 * component decides: the family is the position modulo four and the cycle is the position over
	 * four wrapped at the last one, so two numbers of one family never draw the same step inside a
	 * period and `#5` is `#1`'s family one step deeper rather than a repeat of `#1`.
	 *
	 * The colours those two classes compose are `panel/src/index.css`'s, and
	 * `tests/unit/panel/label-badge-palette.test.ts` recomputes every one of them from the tokens.
	 * What is checked here is the assignment; what is checked there is the arithmetic.
	 */
	it('draws every number past the fourth as a step of the family its position picks', () => {
		const drawn = new Map<string, string[]>(FAMILIES.map((family) => [family, []]));

		for (const number of upTo(DISTINCT_FILLS)) {
			const position = number - 1;
			const family = FAMILIES[position % FAMILIES.length];
			const cycle = Math.floor(position / FAMILIES.length) + 1;
			if (cycle === 1) continue;

			const classes = classesOf(number);
			expect(classes, `#${number}`).toContain('label-badge-step');
			expect(classes, `#${number}`).toContain(`label-badge-${family}`);
			expect(classes, `#${number}`).toContain(`label-badge-cycle-${cycle}`);
			drawn.get(family)?.push(`cycle-${cycle}`);
		}

		// One period is every family at every cycle past the first, each exactly once — the ramps no
		// longer stop mid-cycle the way the alphabet made them (`Y` and `Z` reached cycle 7 alone).
		for (const [family, cycles] of drawn) {
			expect(cycles, family).toEqual(upTo(PALETTE_CYCLES - 1).map((step) => `cycle-${step + 1}`));
		}
	});

	/*
	 * **The four token fills are the whole of what is named in a class.** The cycle adds numbers and
	 * derived steps of those same four, never a fifth hue and never a token that means something
	 * else. **`bg-surface-container-highest` is gone with `@`** (#206): it was the overflow's
	 * inverted fill, and there is no longer anything that distinguishes nothing.
	 */
	it('names no token but the four the palette is made of', () => {
		expect(
			new Set(
				upTo(3 * DISTINCT_FILLS)
					.map(fillOf)
					.filter((fill) => fill.startsWith('bg-')),
			),
		).toEqual(
			new Set([
				'bg-primary-fixed',
				'bg-secondary-fixed',
				'bg-tertiary-fixed',
				'bg-inverse-surface',
			]),
		);
		for (const number of upTo(DISTINCT_FILLS + 1)) {
			expect(classesOf(number), `#${number}`).not.toContain('bg-surface-container-highest');
		}
	});

	/*
	 * **No colour that reads as an outcome** (`docs/DESIGN.md` §5, §9). `error` is excluded outright,
	 * and the three steps §5 gives a device state to are spent — so a badge can never pair with
	 * another into the pass/fail verdict Rover does not have.
	 *
	 * A class name is as far as this can reach, and #200 is why that is no longer enough on its own:
	 * `bg-tertiary-fixed-dim` would pass every line below while painting the free-device green onto
	 * a badge, since that token is byte-identical to `--color-tertiary`. The distances are measured
	 * in `tests/unit/panel/label-badge-palette.test.ts`; what is kept here is that no token which
	 * already means something is *named*, `-fixed-dim` included.
	 */
	it('uses none of the tokens that already mean something', () => {
		for (const number of upTo(DISTINCT_FILLS + 1)) {
			const classes = classesOf(number);

			expect(classes.some((name) => name.includes('error'))).toBe(false);
			expect(classes.some((name) => name.includes('fixed-dim'))).toBe(false);
			// The free-device green, the held blue and the warning orange, each in the exact spelling
			// §5's table gives it — matched as whole class names, since `bg-tertiary-fixed` is a
			// different step from `bg-tertiary` and is one of the four this palette is made of.
			expect(classes).not.toContain('bg-tertiary');
			expect(classes).not.toContain('bg-primary-container');
			expect(classes).not.toContain('bg-secondary-container');
		}
	});

	/*
	 * **A badged row stays the height of an unbadged one** — the property `size-4.5` was chosen for,
	 * and the half of it #206 keeps. Two- and three-digit numbers do not fit an 18px circle, so the
	 * width is the half that had to go: the pill grows on the design's own spacing step and
	 * `rounded-full` keeps it a pill at every width. The height and the design's smallest type step
	 * are what hold, and they are pinned here because a badge that changed either would push a level
	 * of the tree wherever a label starts.
	 */
	it('keeps one height at every width, on the smallest type step', () => {
		const wide = classesOf(123);

		expect(wide).toContain('h-4.5');
		expect(wide).toContain('px-1.5');
		expect(wide).toContain('rounded-full');
		expect(wide).toContain('font-label-caps');
		expect(wide).toContain('text-label-caps');
		// Nothing that would fix the width, so `#123` is not clipped and not squeezed.
		expect(wide.some((name) => /^(?:size|w)-/.test(name))).toBe(false);
		// One height for every number, one digit or three.
		expect(classesOf(1).filter((name) => name.startsWith('h-'))).toEqual(['h-4.5']);
	});

	// The tree row is one `<Link>` and must stay one target (#175): this is an element inside it,
	// never a second control.
	it('is not a control', () => {
		const { container } = render(<LabelBadge label={LABEL} number={3} />);

		expect(container.querySelector('button')).toBeNull();
		expect(container.querySelector('a')).toBeNull();
		expect(container.querySelector('[tabindex]')).toBeNull();
	});
});
