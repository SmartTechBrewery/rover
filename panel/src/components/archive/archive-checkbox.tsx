import type { PinState } from '@panel/archive/pinned-tests.js';
import { BADGE_SHAPE, BADGE_TYPE } from '@panel/components/archive/header-badge.js';
import { Check, Minus } from 'lucide-react';
import { useId } from 'react';

/**
 * `Keep` — mark this test to survive the sweep (D35, #238).
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
 * **It is drawn as a two-cell pill, not as a checkbox** — `Remove`'s frame from the same
 * `BADGE_SHAPE` and `BADGE_TYPE` (`header-badge.tsx`, §10), divided by that frame's own border into
 * a **lamp** on the left and the word on the right. Two attempts stand behind that: a bare box and
 * a word, which read as a stray tick loose in a strip beside a bordered control; and the same box
 * put inside the pill, which is what a checkbox dropped into a button looks like — a control inside
 * a control, with two frames and two radii nested a pixel apart. The lamp is the one that is not
 * either: a square well at the pill's left edge that fills `tertiary` when the test is kept, so the
 * whole control reads as one pressable thing whose left end is lit or unlit.
 *
 * **The constants are shared and not copied**, which is the half that keeps this from drifting: the
 * radius, the border width, the padding and the 12px face are the declarations `Remove` and the
 * header badges read, so an edit to one moves all of them. Only the padding sits somewhere else
 * than on `Remove` — the lamp has to reach the frame, so `BADGE_TYPE` goes on the word's cell,
 * exactly as `view-toggle.tsx` puts it on a segment rather than on its own frame.
 *
 * **The word is one colour in every state, and that is a reversal.** It used to be
 * `on-surface-variant` warming on hover and going `tertiary` when on — the whole of the state, back
 * when there was nothing else to carry it. The lamp carries it now, and a word that also changed
 * was the state said twice: it made a settled control look like it was still reacting, and it put
 * green in two places when green means *kept* in one. `Remove`'s word does not move either.
 *
 * **Still a native `<input type="checkbox">`**, not a `<button role="checkbox">`: the element
 * already carries the role, the tick state, the space bar and the label association, and
 * re-implementing those is how a control ends up almost accessible. It is no longer *drawn*,
 * though — `opacity-0` across the whole pill instead of `appearance-none` at the size of a box,
 * because the lamp is what a reader sees and no native box can be made into one. Spanning the pill
 * rather than the lamp is deliberate: the input is the hit area, so the entire control presses and
 * there is no dead strip between the lamp and the word.
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
	// `on` covers both states the control is drawn lit in — a tick, and a group's dash — and it is
	// one name because the frame, the box, the glyph and the word must never disagree about it.
	const on = pin.checked || pin.mixed === true;

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
			{/*
			 * **The pill is the `<label>`, and it is two cells rather than a box beside a word** — the
			 * lamp on the left, the word on the right, divided by the frame's own border. So the
			 * padding cannot be on the label the way `BADGE_TYPE` writes it (the lamp has to reach
			 * the frame on three sides), and it is on the word's cell instead — the arrangement
			 * `view-toggle.tsx` already uses with `BADGE_FRAME` and `p-0`, for the same reason.
			 *
			 * `overflow-hidden` so the lamp's fill is clipped by the pill's own radius, and
			 * `items-stretch` so it is the word's line height that sets how tall both cells are —
			 * neither cell states a height, so the control cannot end up a pixel off `Remove`.
			 *
			 * `has-[:focus-visible]` puts the keyboard's ring on the *frame*, because the input it
			 * belongs to is invisible: `:focus-visible` rather than `:focus` for the reason it always
			 * was — the click that toggles a checkbox also focuses it, and a ring drawn then reads as
			 * an error.
			 *
			 * **The frame itself does not light with the state**, and that is the point of the lamp:
			 * `outline-variant` at rest warming to `tertiary` under the pointer, the mirror of
			 * `Remove` warming to `error`, so hover means *this can be pressed* on both controls and
			 * green on this one means *kept* in exactly one place.
			 */}
			<label
				className={`${BADGE_SHAPE} relative flex items-stretch overflow-hidden border-outline-variant bg-surface-container transition-colors select-none hover:border-tertiary has-[:focus-visible]:border-tertiary`}
			>
				{/*
				 * The lamp. `border-r-2 border-outline-variant` is the frame continued inwards rather
				 * than a rule of its own, so it stays the frame's colour in both states — a green
				 * divider would draw the eye to the join rather than to the fill. At rest the cell is
				 * `bg-surface` — a well sunk below the pill's own `surface-container` — with the glyph
				 * at the frame's weight, and on it fills `tertiary` with `on-tertiary` over it, the
				 * pairing the panel uses everywhere something is lit (§3).
				 *
				 * **The glyph is drawn in both states**, unlike the box this replaced: an empty well
				 * says *there is a light here and it is off*, where an empty box said only that
				 * something was unticked. The dash still stands for a group that is part-kept.
				 */}
				<span
					className={`flex items-center justify-center border-outline-variant border-r-2 px-2 transition-colors ${
						on ? 'bg-tertiary text-on-tertiary' : 'bg-surface text-outline-variant'
					}`}
				>
					{/*
					 * **Still a native `<input type="checkbox">`**, and still the only thing that holds
					 * the state: the element carries the role, the tick, the space bar and the label
					 * association, and re-implementing those is how a control ends up almost
					 * accessible. What changed is that it is no longer *drawn* — `opacity-0` over the
					 * whole pill rather than `appearance-none` at the size of a box, because the lamp
					 * is now what a reader sees and no native checkbox can be made to look like one.
					 *
					 * `absolute inset-0` is deliberate on top of that: the input is the hit area, so
					 * the whole pill presses like the button it now resembles, and there is no dead
					 * strip between the lamp and the word.
					 */}
					<input
						aria-describedby={describedBy}
						checked={pin.checked}
						className="absolute inset-0 m-0 appearance-none opacity-0"
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
						onChange={pin.toggle}
						type="checkbox"
					/>
					{(() => {
						const Glyph = pin.mixed === true ? Minus : Check;
						return <Glyph aria-hidden="true" size={14} strokeWidth={3} />;
					})()}
				</span>
				{/*
				 * The word, in `BADGE_TYPE` — the padding and the 12px code face `Remove` and the
				 * header badges read from the same constant.
				 *
				 * **It does not change colour any more, in any state.** It was `on-surface-variant`
				 * warming on hover and going `tertiary` when on, which was the whole of the state
				 * before the lamp existed; with a lamp beside it that is the state said twice, and the
				 * second saying was the one that made a settled control look like it was still
				 * reacting. `Remove`'s word is one colour whatever the pointer is doing, and this is
				 * now the same.
				 */}
				<span className={`${BADGE_TYPE} text-on-surface`}>Keep</span>
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
 * **The sentence names the two bounds as a condition, and it used to name a trigger that had not
 * landed** — *once Rover starts sweeping the archive* (corrected in place, 2026-09-08, #246). That
 * clause was a promise about the future and it has stopped being one: the host enforces the disk
 * budget after every lease ends (D37, #245) and the **whole** policy at local midnight and at
 * daemon start (D38, #246), so *once Rover starts sweeping* would now be telling a reader the
 * opposite of what happens to their runs. What replaces it is the pair of bounds themselves —
 * *when the archive runs out of room, or this test gets old enough* — which is the condition the
 * reader is actually being offered an exemption from.
 *
 * **Still with no number of days in it**, and that half is unchanged along with its reason:
 * `sweep_archive` deliberately carries neither of the host's two settings, so no answer this panel
 * can make carries a retention figure and one written here would be the panel inventing data the
 * host never sent (`ai/RULES.md` §2, and this screen's own *nothing is invented* rule).
 * `archive-checkbox.test.tsx` asserts against a fabricated one. What makes the digits writable is a
 * host answer carrying the window, not a trigger — so the substitution that landing enables is
 * still the same one: *…will be removed in 14 days, unless…*.
 *
 * **The second half says where the decision is held, and it is there because the answer changed**
 * (D33, #237). The tick was React state and forgot on reload, so the sentence could only promise
 * what the reader was about to lose; the host remembers it now — in a document of its own, read and
 * written over the panel's transport — so a reader who ticks a box on one machine can be told that
 * it holds. Where the file is is deliberately not in it: a host path on a screen is the disclosure
 * D19 refuses, and *the host* is the whole of what a reader has to know.
 *
 * **The group's wording is not the test's with a word swapped.** Its tick stands over several tests
 * at once, so the sentence says *every test in this group* and *keep them all* — a reader who read
 * the test's sentence over a group's tick would take it for a control over the group as a thing,
 * and press it expecting one flag rather than several. Its second half is plural for that same
 * reason.
 */
const REMOVAL_NOTICE: Readonly<Record<'test' | 'group', string>> = {
	test: 'Traces of this test will be removed when the archive runs out of room, or when the test gets old enough, unless you keep it. The host remembers this tick, not the browser.',
	group:
		'Traces of every test in this group will be removed when the archive runs out of room, or when a test gets old enough, unless you keep them all. The host remembers these ticks, not the browser.',
};
