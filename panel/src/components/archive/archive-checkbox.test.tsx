import type { PinState } from '@panel/archive/pinned-tests.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ArchiveCheckbox } from './archive-checkbox.js';

/**
 * The `Keep` tick and the sentence that explains it (`docs/DESIGN.md` §9).
 *
 * That the tick is one flag shared by a test's card and a run's is asserted where both are on one
 * screen (`routes/archive.test.tsx`); what this file pins is the control itself — its accessible
 * shape, which three earlier attempts got wrong in three different ways, and the two rules its
 * sentence has to keep.
 *
 * **The popover's *visibility* is not asserted here, and cannot be.** It is shown by
 * `group-hover:block` over a `hidden` utility, and jsdom applies no Tailwind stylesheet — a test
 * that read `display` back would be asserting against an empty cascade and would pass with the
 * class removed. What is testable is that the sentence is in the DOM, addressable, and the input's
 * description; the hover itself is a CSS claim, and `pointer-on-what-can-be-pressed.test.ts` is the
 * pattern for asserting one of those if it ever earns a gate of its own.
 */

const UNPINNED: PinState = { checked: false, toggle: () => {} };

function showing(pin: PinState = UNPINNED) {
	return render(<ArchiveCheckbox pin={pin} />);
}

const tick = () => screen.getByRole('checkbox', { name: 'Keep' }) as HTMLInputElement;
const sentenceOf = (box: HTMLElement) =>
	document.getElementById(box.getAttribute('aria-describedby') ?? '');

describe('the Keep tick', () => {
	/*
	 * **The name is `Keep` and nothing else.** Two earlier attempts put the sentence inside the
	 * `<label>`, and an accessible name is computed from the label's own text — so the control
	 * announced itself as *Keep Traces of this test will be removed…*. This is the query a screen
	 * reader performs, so it is the query that has to hold.
	 */
	it('is named `Keep`, and described by the sentence rather than named by it', () => {
		showing();

		expect(tick().getAttribute('aria-describedby')).not.toBeNull();
		expect(sentenceOf(tick())?.textContent).toContain('will be removed');
	});

	/*
	 * **`Archive` was the name until the sentence made it impossible** — on a screen called Archive,
	 * *unless you archive it* used the word for two different things eight words apart. Asserted so
	 * that a rename back has to be a decision rather than an edit.
	 */
	it('does not call itself `Archive`, and says `archive` once, for the place', () => {
		const { container } = showing();

		expect(screen.queryByRole('checkbox', { name: 'Archive' })).toBeNull();
		expect((container.textContent ?? '').match(/archive/gi)).toHaveLength(1);
	});

	it('reports the state it was handed, and toggling is the caller’s', () => {
		const toggles: number[] = [];
		showing({ checked: true, toggle: () => toggles.push(1) });

		expect(tick().checked).toBe(true);
		fireEvent.click(tick());
		expect(toggles).toEqual([1]);
	});

	/*
	 * **The sentence is in the DOM whether or not anybody hovers**, because it is the tick's
	 * `aria-describedby` target: a reference resolves to hidden content, so the description holds for
	 * a reader who never brings a pointer near it. Mounting it on hover would leave the input
	 * pointing at an element that is not there for most of its life.
	 */
	it('keeps the sentence addressable with nothing hovered', () => {
		showing();

		expect(sentenceOf(tick())).not.toBeNull();
	});

	/*
	 * **No number of days, and this is the assertion that guards it.** The sentence a reader
	 * eventually wants is *…in 14 days…*; the panel does not have the 14, no host answer carries a
	 * retention window, and a figure written in here would be the invention this screen refuses
	 * (`docs/DESIGN.md` §9). A later edit filling in a plausible one fails here.
	 */
	it('names the condition and never a deadline', () => {
		showing();

		const said = sentenceOf(tick())?.textContent ?? '';
		expect(said).toContain('unless you keep it');
		expect(said).not.toMatch(/\d/);
	});

	/*
	 * **It says where the decision is held** (#237). The tick was React state and forgot on reload,
	 * so the sentence could only promise what the reader was about to lose; the host remembers it
	 * now (D33), and a reader who ticks a box on one machine is told that it holds. Asserted with
	 * the no-digit rule beside it, because the host answering the *window* is a different landing
	 * from the host answering the *set* — and only the second has happened.
	 */
	it('says the host holds the decision, and still names no window', () => {
		showing();

		const said = sentenceOf(tick())?.textContent ?? '';
		expect(said).toContain('The host remembers this tick, not the browser.');
		expect(said).not.toMatch(/\d/);
	});

	/*
	 * **`mixed` is a third state and is drawn as one.** It belongs to a group's tick, where some of
	 * its tests are kept and some are not, and the box shows a dash rather than a tick or nothing —
	 * `indeterminate` is a property and not an attribute, so a ref is the only way React reaches it,
	 * which is exactly the wiring worth pinning.
	 */
	it('draws part-kept as neither on nor off', () => {
		const { container } = render(
			<ArchiveCheckbox pin={{ checked: false, mixed: true, toggle: () => {} }} scope="group" />,
		);

		expect(tick().checked).toBe(false);
		expect(tick().indeterminate).toBe(true);
		// Filled like a kept box, so *some* reads as closer to on than to off, and the glyph is what
		// tells them apart.
		expect(tick().className).toContain('bg-tertiary');
		expect(container.querySelector('svg')).not.toBeNull();
	});

	it('takes the group’s wording from the scope, and nothing else from it', () => {
		render(<ArchiveCheckbox pin={UNPINNED} scope="group" />);

		const said = sentenceOf(tick())?.textContent ?? '';
		expect(said).toContain('every test in this group');
		expect(said).toContain('keep them all');
		// Plural, for the same reason the first half is the group's own wording rather than the
		// test's: the press stands over several flags.
		expect(said).toContain('The host remembers these ticks, not the browser.');
		expect(said).not.toMatch(/\d/);
	});

	/*
	 * **Nothing on this control is a link or a button.** The `?` that opened the sentence on a press
	 * was the third shape tried and is not kept: it gave one sentence its own control, and it put a
	 * `<button>` on a card whose whole claim is that it moves nobody anywhere (#161).
	 */
	it('carries no link and no button', () => {
		const { container } = showing();

		expect(container.querySelectorAll('a')).toHaveLength(0);
		expect(container.querySelectorAll('button')).toHaveLength(0);
	});
});
