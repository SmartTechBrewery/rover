import { LABEL_LETTERS, type LabelLetter } from '@panel/archive/group-labels.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LabelBadge } from './label-badge.js';

const LABEL = 'home-baseline';

/** Every letter a badge can be drawn as, the overflow included — it is a case, not a corner. */
const EVERY_LETTER: readonly LabelLetter[] = [...LABEL_LETTERS, '@'];

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
	 * **Every colour comes from `panel/src/tokens.css`** (`ai/RULES.md` §8, `docs/DESIGN.md` §1).
	 * `tests/unit/panel/tokens-are-the-source-of-truth.test.ts` is the gate that fails on a hex
	 * anywhere under `panel/src`; what is asserted here is that each letter is a *different* fill, so
	 * the palette cannot quietly collapse into one colour with five letters on it.
	 */
	it('gives every letter a distinct token fill, and writes no colour of its own', () => {
		const fills = EVERY_LETTER.map((letter) => {
			const { container, unmount } = render(<LabelBadge label={LABEL} letter={letter} />);
			const className = container.querySelector('span')?.className ?? '';
			unmount();
			return className.split(' ').find((name) => name.startsWith('bg-')) ?? '';
		});

		expect(new Set(fills).size).toBe(EVERY_LETTER.length);
		expect(fills.every((fill) => fill.length > 0)).toBe(true);
	});

	/*
	 * **No colour that reads as an outcome** (`docs/DESIGN.md` §5, §9). `error` is excluded outright,
	 * and the three steps §5 gives a device state to are spent — so a badge can never pair with
	 * another into the pass/fail verdict Rover does not have.
	 */
	it('uses none of the tokens that already mean something', () => {
		for (const letter of EVERY_LETTER) {
			const { container, unmount } = render(<LabelBadge label={LABEL} letter={letter} />);
			const classes = (container.querySelector('span')?.className ?? '').split(' ');

			expect(classes.some((name) => name.includes('error'))).toBe(false);
			// The free-device green, the held blue and the warning orange, each in the exact spelling
			// §5's table gives it — matched as whole class names, since `bg-tertiary-fixed` is a
			// different step from `bg-tertiary` and is one of the five this palette is made of.
			expect(classes).not.toContain('bg-tertiary');
			expect(classes).not.toContain('bg-primary-container');
			expect(classes).not.toContain('bg-secondary-container');
			unmount();
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
