import type { PinState } from '@panel/archive/pinned-tests.js';
import { Check, Minus } from 'lucide-react';
import { useId } from 'react';

/**
 * `Keep` — mark this test to survive the sweep, once Rover has one.
 *
 * **The panel's first checkbox**, and **no approved Stitch screen shows one** (`ai/RULES.md` §8),
 * so nothing about it is invented: every value below is already on this screen or in
 * `docs/DESIGN.md` §3, exactly as `view-toggle.tsx` was built and for the same reason — a deviation
 * small enough to reconcile in one edit once a design exists.
 *
 * **It is `Keep` and not `Archive`, and the rename is the sentence's fault.** The control read
 * `Archive`, on a screen called Archive, whose one job is to browse the archive — and the sentence
 * explaining it then had to say *…sweeping the archive, unless you archive it*, with the word
 * carrying two different meanings eight words apart. `Keep` is the verb a reader would use for what
 * this does, and it leaves *archive* meaning the place.
 *
 * **It sits at the right end of the card's header strip**, opposite the name — on the test-name
 * card and on a run's `Run Details`, and nowhere else. `ContentsCard`'s header is a slot rather
 * than a title precisely so a caller can put a second thing in that strip, which is what makes
 * this an argument to that slot instead of a fourth card component.
 *
 * **A popover on hover says what ticking it is for.** A checkbox alone does not say what happens if
 * you leave it alone, and three shapes were tried before this one: a `title` (a tooltip nobody
 * reads, in the browser's own styling), the sentence printed in the strip (it **did not fit** — a
 * 40-character run name lost its header to it), and a green `?` that opened it on a press (a
 * control earning its own affordance, for one sentence). What is left is the panel's own panel, on
 * the control's own hover.
 *
 * **`group-hover` and `group-has-[:focus-visible]`, and no state at all** — no `useState`, no
 * listener, no Escape key, nothing to get out of step. The second half is not decoration: hover is
 * unreachable from a keyboard, so a keyboard reader would otherwise never see the sentence at all.
 *
 * **It is `:focus-visible` and deliberately not `:focus-within`**, which was the first attempt and
 * was wrong in a way only using it shows: a mouse click on a checkbox *focuses* it, so the popover
 * stayed up after the tick until the reader clicked somewhere else — a panel that would not go away
 * on its own. `:focus-visible` is the browser's own answer to *was this focus from the keyboard*,
 * so the pointer no longer holds it open and the keyboard still does. `:has()` rather than a
 * `group-focus-visible` variant, because the thing that takes focus is the input *inside* the
 * group, not the group.
 *
 * **A native `<input type="checkbox">`**, not a `<button role="checkbox">`: the element already
 * carries the role, the tick state, the space bar and the label association, and re-implementing
 * those is how a control ends up almost accessible. `appearance-none` takes the browser's own box
 * away so the frame can be the panel's, and the glyph is drawn over it — a checked native box
 * cannot be recoloured to `tertiary` on every platform, which is the one thing this control has to
 * agree with the rest of the screen about.
 */
export function ArchiveCheckbox({
	pin,
	scope = 'test',
}: {
	readonly pin: PinState;
	/**
	 * What this tick stands over, which is the only thing that differs between the three cards that
	 * carry one: a **test** on a test name's card and on a run's, and a whole **group** on a group's
	 * card in the groups view.
	 *
	 * It chooses the sentence and nothing else — the box, the word and the behaviour are the same
	 * control, because it is the same flag (`pinned-tests.ts`). A sentence about one test shown over
	 * a group's tick would be wrong about what pressing it does, which is the whole reason this
	 * argument exists rather than one wording for both.
	 */
	readonly scope?: 'test' | 'group';
}) {
	const describedBy = useId();

	return (
		/*
		 * `group relative`: the popover is anchored here and **not in a portal**. It opens downward
		 * out of the header strip and over the card's own body, which it may do — the
		 * `overflow-hidden` on this screen's cards is on the `<section>` (`ContentsCard`), and this
		 * stays inside it. So there is nothing to measure and nothing to keep in step with a scroll.
		 *
		 * **The sentence sits outside the `<label>`, and that is not cosmetic.** An accessible name is
		 * computed from the label's own text, so a sentence inside it became part of the name — the
		 * control announced itself as *Keep Traces of this test will be removed…* instead of being
		 * called `Keep` and described by that sentence. Caught by
		 * `getByRole('checkbox', { name: 'Keep' })`, which is the query a screen reader performs.
		 */
		<span className="group relative flex shrink-0 items-center gap-2">
			<label className="flex items-center gap-2 select-none">
				<span className="relative inline-flex size-4 shrink-0">
					{/*
					 * The search field's own frame, at checkbox size — `rounded-sm border-2
					 * border-outline-variant bg-surface`, warming to `tertiary` when it is on, which is
					 * the green that means *active* everywhere else in the panel (§3: the breadcrumb's
					 * last segment, the current nav item, this screen's view toggle).
					 *
					 * `focus-visible` rather than `focus`: the field beside it takes a caret and shows
					 * its ring on any focus, while a checkbox is also focused by the click that just
					 * toggled it, and a ring drawn then reads as an error.
					 */}
					<input
						aria-describedby={describedBy}
						checked={pin.checked}
						/*
						 * **`indeterminate` is a property and not an attribute**, so React cannot set it
						 * from JSX — this ref is the only way to reach it. It is what a group's tick says
						 * when some of its tests are kept and some are not (`pinned-tests.ts`), and the
						 * platform's own third state is used rather than a third visual invented here.
						 */
						ref={(box) => {
							if (box !== null) {
								box.indeterminate = pin.mixed ?? false;
							}
						}}
						className={`size-4 appearance-none rounded-sm border-2 bg-surface transition-colors focus-visible:border-tertiary ${
							pin.checked || pin.mixed === true
								? 'border-tertiary bg-tertiary'
								: 'border-outline-variant'
						}`}
						onChange={pin.toggle}
						type="checkbox"
					/>
					{pin.checked || pin.mixed === true
						? /*
							 * `lucide-react`'s glyph over the box, not the design's Material Symbols one (§9),
							 * and `on-tertiary` because that is the token paired with the fill underneath it.
							 * `pointer-events-none` so the glyph never eats the click meant for the input.
							 *
							 * **A dash for `mixed`**, which is the glyph a half-ticked box has carried since
							 * long before this panel: *some of what this stands over*, drawn as neither a tick
							 * nor an empty box, so the three states are three things a reader can see.
							 */
							(() => {
								const Glyph = pin.checked ? Check : Minus;
								return (
									<Glyph
										aria-hidden="true"
										className="pointer-events-none absolute inset-0 text-on-tertiary"
										size={16}
										strokeWidth={3}
									/>
								);
							})()
						: null}
				</span>
				{/*
				 * 12px in the code face, which is the view toggle's `SEGMENT` — and for the reason
				 * recorded there, from Tailwind's own `--text-xs` rather than the caps step, whose 700
				 * weight and 0.1em tracking would come along with the size. The label warms on hover the
				 * way an inactive toggle segment does, and goes green when it is on, so the state is
				 * legible without the box.
				 */}
				<span
					className={`font-code-md text-xs transition-colors ${
						pin.checked || pin.mixed === true
							? 'text-tertiary'
							: 'text-on-surface-variant group-hover:text-on-surface'
					}`}
				>
					Keep
				</span>
			</label>
			{/*
			 * **Always in the DOM, shown by CSS rather than mounted**, because it is the checkbox's
			 * `aria-describedby` target: a reference resolves to hidden content, so the tick keeps its
			 * description whether or not a pointer ever goes near it. Mounting it on hover would leave
			 * the input describing an element that is not there for most of its life.
			 *
			 * It is the `hidden` **utility** and not the attribute, so `group-hover:block` can override
			 * it — the attribute's user-agent rule cannot be beaten by a class.
			 *
			 * `right-0` so it grows leftwards from the card's right edge and never past it, `w-72` so
			 * the sentence wraps at a readable measure, and `z-10` because it is drawn over the card's
			 * body rather than inside the strip's own height.
			 */}
			<span
				className="absolute top-full right-0 z-10 mt-2 hidden w-72 rounded-lg border-2 border-outline-variant bg-surface p-3 font-code-md text-on-surface-variant text-xs group-hover:block group-has-[:focus-visible]:block"
				id={describedBy}
			>
				{REMOVAL_NOTICE[scope]}
			</span>
		</span>
	);
}

/**
 * The sentence this control makes about itself, one per {@link ArchiveCheckbox} scope.
 *
 * **`once Rover starts sweeping the archive` is standing in for a number**, and the substitution is
 * the only thing that changes when the host half lands: *…will be removed in 14 days, unless…*.
 * Until a host answer carries that window there is no honest way to write the digits — nothing
 * sweeps the archive, no answer carries a retention figure, and one written here would be the panel
 * inventing data the host never sent (`ai/RULES.md` §2, and this screen's own *nothing is invented*
 * rule). Naming the condition still tells a reader why the box is there, which is what the sentence
 * is for.
 *
 * **The group's wording is not the test's with a word swapped.** Its tick stands over several tests
 * at once, so the sentence says *every test in this group* and *keep them all* — a reader who read
 * the test's sentence over a group's tick would take it for a control over the group as a thing,
 * and press it expecting one flag rather than several.
 */
const REMOVAL_NOTICE: Readonly<Record<'test' | 'group', string>> = {
	test: 'Traces of this test will be removed once Rover starts sweeping the archive, unless you keep it.',
	group:
		'Traces of every test in this group will be removed once Rover starts sweeping the archive, unless you keep them all.',
};
