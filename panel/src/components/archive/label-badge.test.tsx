import { LABEL_LETTERS, type LabelLetter } from '@panel/archive/group-labels.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LabelBadge } from './label-badge.js';

const LABEL = 'home-baseline';

/** Every letter a badge can be drawn as, the overflow included — it is a case, not a corner. */
const EVERY_LETTER: readonly LabelLetter[] = [...LABEL_LETTERS, '@'];

/** The classes one badge is drawn with, rendered and torn down so the next letter starts clean. */
function classesOf(letter: LabelLetter): readonly string[] {
	const { container, unmount } = render(<LabelBadge label={LABEL} letter={letter} />);
	const className = container.querySelector('span')?.className ?? '';
	unmount();
	return className.split(' ');
}

/**
 * Just the fill, which is the one thing the letter's position decides — and it is spelled two ways
 * on purpose (#200). Cycle 1 and `@` name a token directly in a `bg-` utility; every later cycle
 * names its family and its cycle, and the colour those two compose is derived in
 * `panel/src/index.css` and judged by `tests/unit/panel/label-badge-palette.test.ts`. Both are
 * class-level identities, so everything below compares them the same way.
 */
function fillOf(letter: LabelLetter): string {
	const classes = classesOf(letter);
	const utility = classes.find((name) => name.startsWith('bg-'));
	if (utility !== undefined) {
		return utility;
	}
	return classes.filter((name) => /^label-badge-(?!step$)/.test(name)).join(' ');
}

describe('the label badge', () => {
	/*
	 * **The letter carries the meaning, never the colour alone.** It is drawn as text, at badge
	 * size, so a reader who cannot tell two fills apart still has two badges that differ.
	 */
	it('draws the letter as text', () => {
		render(<LabelBadge label={LABEL} letter="B" />);

		expect(screen.getByRole('img').textContent).toBe('B');
	});

	/*
	 * **The filed label stays reachable, by hover and by screen reader** — because a letter is a code
	 * local to one group and `@` names nothing at all. Both channels say the same sentence, so
	 * hovering and listening give one answer rather than two.
	 */
	it('names the filed label in its accessible name and in `title`', () => {
		render(<LabelBadge label={LABEL} letter="A" />);

		const badge = screen.getByRole('img', { name: `Filed under the label ${LABEL}` });
		expect(badge.getAttribute('title')).toBe(`Filed under the label ${LABEL}`);
		// Verbatim, as the archive filed it: nothing here trims it, shortens it or lower-cases it.
		expect(badge.getAttribute('title')).toContain(LABEL);
	});

	// The overflow is drawn like any other badge and says its label like any other: what stops
	// distinguishing them is the letter, and the row does not.
	it('draws `@` as a badge, still naming the label it stands for', () => {
		render(<LabelBadge label="a-fifth-label" letter="@" />);

		const badge = screen.getByRole('img', { name: 'Filed under the label a-fifth-label' });
		expect(badge.textContent).toBe('@');
	});

	/*
	 * **Cycle 1 is byte-identical to what #182 shipped**, which is the whole of why cycling the four
	 * colours costs nothing: the first four letters draw on the same four fills, in the same order,
	 * and `@` is untouched. Pinned exactly, so the cycle cannot drift under a later edit.
	 */
	it('draws `A`…`D` on the four colours it draws them on today', () => {
		expect(classesOf('A')).toContain('bg-primary-fixed');
		expect(classesOf('A')).toContain('text-on-primary-fixed');
		expect(classesOf('B')).toContain('bg-secondary-fixed');
		expect(classesOf('B')).toContain('text-on-secondary-fixed');
		expect(classesOf('C')).toContain('bg-tertiary-fixed');
		expect(classesOf('C')).toContain('text-on-tertiary-fixed');
		expect(classesOf('D')).toContain('bg-inverse-surface');
		expect(classesOf('D')).toContain('text-inverse-on-surface');
		expect(classesOf('@')).toContain('bg-surface-container-highest');
		expect(classesOf('@')).toContain('text-on-surface-variant');
	});

	/*
	 * **Two letters next to each other in the alphabet never carry one colour** (#197). Cycling
	 * family-first is what makes that true by construction rather than by inspection, and this is
	 * that criterion in executable form at the level a class name can honestly reach. Since #200 the
	 * perceptual half is executable too, and it is not here: the twenty-five adjacent pairs are
	 * measured in `tests/unit/panel/label-badge-palette.test.ts`, which recomputes the fills from
	 * the tokens — including the cycle boundaries, which is the pair §9 used to have to record as
	 * the weak one.
	 */
	it('gives no two letters adjacent in the alphabet one fill', () => {
		const fills = LABEL_LETTERS.map(fillOf);

		for (const [index, fill] of fills.entries()) {
			if (index > 0) {
				expect(fill).not.toBe(fills[index - 1]);
			}
			// `@` distinguishes nothing and must never be mistaken for a letter that does.
			expect(fill).not.toBe(fillOf('@'));
		}
	});

	/*
	 * **Every colour comes from `panel/src/tokens.css`** (`ai/RULES.md` §8, `docs/DESIGN.md` §1).
	 * `tests/unit/panel/tokens-are-the-source-of-truth.test.ts` is the gate that fails on a hex
	 * anywhere under `panel/src`; what is asserted here is that a fill is never drawn without the
	 * text step that makes the letter legible on it. Cycle 1 and `@` carry both as `bg-`/`on-`
	 * utilities; a later cycle carries `label-badge-step`, whose one rule sets the background *and*
	 * the colour from the family's own two tokens, so the pair cannot come apart there either.
	 */
	it('pairs every fill with a text step, and writes no colour of its own', () => {
		for (const letter of EVERY_LETTER) {
			const classes = classesOf(letter);

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
	 * **Every letter of a later cycle is a family and a step of it** (#200), which is the whole of
	 * what the component decides: the family is the position modulo four and the cycle is the
	 * position over four, so two letters of one family never draw the same step and `E` is `A`'s
	 * family one step deeper rather than a repeat of `A`.
	 *
	 * The colours those two classes compose are `panel/src/index.css`'s, and
	 * `tests/unit/panel/label-badge-palette.test.ts` recomputes every one of them from the tokens.
	 * What is checked here is the assignment; what is checked there is the arithmetic.
	 */
	it('draws `E`…`Z` as a step of the family the position picks', () => {
		const families = ['primary', 'secondary', 'tertiary', 'neutral'];
		const drawn = new Map<string, string[]>(families.map((family) => [family, []]));

		for (const [index, letter] of LABEL_LETTERS.entries()) {
			const family = families[index % families.length];
			const cycle = Math.floor(index / families.length) + 1;
			if (cycle === 1) continue;

			const classes = classesOf(letter);
			expect(classes, letter).toContain('label-badge-step');
			expect(classes, letter).toContain(`label-badge-${family}`);
			expect(classes, letter).toContain(`label-badge-cycle-${cycle}`);
			drawn.get(family)?.push(`cycle-${cycle}`);
		}

		// `Y` and `Z` reach cycle 7, so the primary and secondary families run the full seven and
		// the other two stop at six — the alphabet ends mid-cycle, and it ends there rather than
		// being padded out to a round number of cycles.
		expect(drawn.get('primary')).toEqual([
			'cycle-2',
			'cycle-3',
			'cycle-4',
			'cycle-5',
			'cycle-6',
			'cycle-7',
		]);
		expect(drawn.get('tertiary')).toEqual(['cycle-2', 'cycle-3', 'cycle-4', 'cycle-5', 'cycle-6']);
		for (const [family, cycles] of drawn) {
			expect(new Set(cycles).size, `${family} draws each cycle once`).toBe(cycles.length);
		}
	});

	/*
	 * **The five token fills are still the whole of what is named in a class**, and `@` is still
	 * outside the cycle. The cycle adds letters and derived steps of those same five, never a fifth
	 * hue and never a token that means something else.
	 */
	it('names no token but the five the palette is made of', () => {
		expect(new Set(EVERY_LETTER.map(fillOf).filter((fill) => fill.startsWith('bg-')))).toEqual(
			new Set([
				'bg-primary-fixed',
				'bg-secondary-fixed',
				'bg-tertiary-fixed',
				'bg-inverse-surface',
				'bg-surface-container-highest',
			]),
		);
		expect(fillOf('@')).toBe('bg-surface-container-highest');
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
		for (const letter of EVERY_LETTER) {
			const classes = classesOf(letter);

			expect(classes.some((name) => name.includes('error'))).toBe(false);
			expect(classes.some((name) => name.includes('fixed-dim'))).toBe(false);
			// The free-device green, the held blue and the warning orange, each in the exact spelling
			// §5's table gives it — matched as whole class names, since `bg-tertiary-fixed` is a
			// different step from `bg-tertiary` and is one of the five this palette is made of.
			expect(classes).not.toContain('bg-tertiary');
			expect(classes).not.toContain('bg-primary-container');
			expect(classes).not.toContain('bg-secondary-container');
		}
	});

	// The tree row is one `<Link>` and must stay one target (#175): this is an element inside it,
	// never a second control.
	it('is not a control', () => {
		const { container } = render(<LabelBadge label={LABEL} letter="C" />);

		expect(container.querySelector('button')).toBeNull();
		expect(container.querySelector('a')).toBeNull();
		expect(container.querySelector('[tabindex]')).toBeNull();
	});
});
