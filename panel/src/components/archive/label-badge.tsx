/**
 * One artifact's label badge — the small numbered pill beside its name in the groups view's tree
 * (#182, numbered by #206, `docs/DESIGN.md` §9).
 *
 * **The number carries the meaning, never the colour alone.** Every badge says which label it is in
 * text, at badge size, and the fill is a second channel for something already written — the rule
 * `StatusLed` keeps from the other side, where the colour is the only channel and the badge is
 * therefore `aria-hidden`. This one is not: a number is a code local to one group, so the **filed**
 * label travels with it in the accessible name and in `title`, and a reader who cannot see the
 * colour, or cannot see anything, still gets the thing that means something.
 *
 * **The numbers have no ceiling, and the palette does** (#206). `1`, `2`, `3`, … run as far as a
 * group files distinct labels, so nothing is ever left undistinguished and `@` is gone rather than
 * kept as a fallback. The colours cannot follow: there are four honest families across
 * {@link PALETTE_CYCLES} honest steps, and inventing a twenty-ninth would mean a hue nobody
 * commissioned (`ai/RULES.md` §8). So past the last cycle the fill **repeats** — two badges far
 * apart may share one, their digits differ, and the digit is the identity.
 *
 * **A badge is not the artifact's own sequence number**, which is the confusion numbering could
 * have bought. An archived artifact leads with a zero-padded ordinal inside its file name
 * (`002_remaining-deliveries_screenshot.png`), so a bare `2` beside a row named `007_…` would
 * invite exactly the wrong reading. Three things separate them and the first is the decisive one:
 * the badge carries a leading `#`, which a file's ordinal never does; it is a filled pill rather
 * than text in the row's name; and it is never zero-padded. `#` is the number sign — *this is
 * label number two* — and not an ordinal or a place: nothing here is compared, so no badge can be a
 * rank, a score or an order of merit (`docs/DESIGN.md` §2, `ai/RULES.md` §1).
 *
 * **No colour here may read as an outcome** (`docs/DESIGN.md` §5, §9). §5 already spends the
 * tertiary green on *a free device*, the primary-container blue on *held* and the
 * secondary-container orange on *warning*, and `error` is excluded outright — so every fill below is
 * a `-fixed` step, a neutral, or a step derived from one of those, and no two of them can pair into
 * the pass/fail verdict Rover does not have (`ai/RULES.md` §1). A green `#1` beside a red `#2` is
 * exactly the thing this palette is chosen to make unavailable. Since #200 that is a measurement
 * rather than an argument: `tests/unit/panel/label-badge-palette.test.ts` fails if any fill comes
 * within ΔE 10 of the free-device green, the held blue, the warning orange, the not-ready grey,
 * `error` or `error-container`.
 *
 * **It is not a control.** The tree row is a single `<Link>` and must stay one target (#175), so
 * this is a `<span>` with no handler, no focus and no press affordance — an element inside the link
 * rather than a second thing to click.
 */

/**
 * The four colours, **cycled by the number's position** (#197), as token classes and nothing else
 * (`ai/RULES.md` §8, `docs/DESIGN.md` §1). A hex written here fails
 * `tests/unit/panel/tokens-are-the-source-of-truth.test.ts` loudly, which is the point of it.
 *
 * | family | numbers | cycle 1's fill | reads as |
 * | --- | --- | --- | --- |
 * | primary | `1`, `5`, `9`, … | `bg-primary-fixed` | pale lavender |
 * | secondary | `2`, `6`, `10`, … | `bg-secondary-fixed` | pale peach |
 * | tertiary | `3`, `7`, `11`, … | `bg-tertiary-fixed` | mint |
 * | neutral | `4`, `8`, `12`, … | `bg-inverse-surface` | neutral |
 *
 * Only `#1`…`#4` draw those fills as written; every family's later numbers are the same hue a cycle
 * deeper, which is {@link CYCLE_FAMILIES} below.
 *
 * Each fill is paired with the `on-` step the design system pairs it with, so the number is legible
 * on every one of them: the four are light fills carrying dark text, which is what makes them read
 * at badge size against this screen's `surface-container`.
 *
 * **`bg-surface-container-highest` used to be here and is not** (#206). It was `@`'s inverted fill,
 * the quietest thing on the card, deliberately not asking to be looked at because it distinguished
 * nothing. There is nothing left that distinguishes nothing, so the token is unspent rather than
 * retained for a case that can no longer arise.
 *
 * **This is cycle 1 and only cycle 1** (#200). It is what `#1`…`#4` draw, verbatim and
 * byte-identical to what #182 shipped, and it is the light end of every ramp {@link cycleStep}
 * modulates — mixing at 100% is the identity, so the utility pair here and the ramp there cannot
 * disagree about what the first cycle is.
 */
const CYCLED_FILLS = [
	'bg-primary-fixed text-on-primary-fixed',
	'bg-secondary-fixed text-on-secondary-fixed',
	'bg-tertiary-fixed text-on-tertiary-fixed',
	'bg-inverse-surface text-inverse-on-surface',
] as const;

/**
 * Cycles 2…7 — the same four families, **each cycle a step deeper into the family's own dark
 * step** (#200, `docs/DESIGN.md` §9), which is what makes `#5` onwards a different step of the same
 * hue rather than a plain repeat of `#1`…`#4`.
 *
 * Not a colour: every step is `color-mix(in srgb, …)` over two tokens of one family, in
 * `panel/src/index.css` beside the panel's other derived colours, and
 * `tests/unit/panel/label-badge-palette.test.ts` recomputes all twenty-eight fills from the tokens
 * and asserts the contrast, the distance from every colour that already means something, and the
 * distance between the fills of consecutive numbers. What is written here is the family and the
 * cycle; the colour is not written anywhere but the token file.
 *
 * **Adjacency is satisfied by construction, at every boundary including the wrap.** Cycling
 * family-first already meant two consecutive numbers are always two different families, with two
 * steps of one family exactly four numbers apart. What #197 had to record as the one weak pair was
 * the cycle boundary — `D`'s neutral `#e2e2e6` beside `E`'s lavender `#dde1ff`, ΔE 13.6 apart,
 * because `E` was a plain repeat of `A`. Every fifth number is now a step off the first, so that
 * pair is ΔE 19.7; and because the sequence of fills is periodic in twenty-eight, the gate asserts
 * all twenty-eight consecutive pairs — the wrap from `#28` back to `#1`'s fill included.
 *
 * **The `-fixed-dim` tokens are not this cycle, though they look like a free one.**
 * `--color-tertiary-fixed-dim` is byte-identical to `--color-tertiary`, §5's *free device* green;
 * `--color-primary-fixed-dim` is byte-identical to `--color-primary`; and
 * `--color-secondary-fixed-dim` (`#ffb59a`) is ΔE 9.3 from `--color-error` (`#ffb4ab`). The test
 * below asserts the *class name* is not `bg-tertiary`, so `bg-tertiary-fixed-dim` would have
 * passed the gate while painting the free-device green onto a badge — considered, measured and
 * rejected, said here and in §9 so nobody reaches for it again.
 */
const CYCLE_FAMILIES = ['primary', 'secondary', 'tertiary', 'neutral'] as const;

/**
 * How many cycles the tokens define — `label-badge-cycle-2` … `label-badge-cycle-7` in
 * `panel/src/index.css`, plus cycle 1's utility pairs above.
 *
 * **This is the palette's ceiling, and it is named rather than left implicit in a modulo** (#206).
 * Each family reaches exactly as far as its own constraints allow and no further — the neutral
 * stops where it is still clear of §5's not-ready grey, the tertiary where it is still clear of the
 * free-device green — so a cycle 8 is not a number to raise here but four new steps somebody would
 * have to measure. Since the numbers are unbounded and the steps are not, `#29` draws `#1`'s fill:
 * the colour repeats and the digit is what distinguishes them.
 * `tests/unit/panel/label-badge-palette.test.ts` reads this constant back out of this file and
 * fails if `index.css` stops defining exactly that many.
 */
export const PALETTE_CYCLES = 7;

/** The class triple a number past `#4` is drawn with — the ramp, its family, and its cycle. */
function cycleStep(family: number, cycle: number): string {
	return `label-badge-step label-badge-${CYCLE_FAMILIES[family]} label-badge-cycle-${cycle}`;
}

/**
 * The fill of badge `n`, as arithmetic rather than as a map — because the domain is every positive
 * integer and a map over that is not a thing.
 *
 * The family and the cycle are **both** the number's own position: the position modulo four picks
 * the family, and the position over four picks how deep into that family the fill sits. Cycle 1
 * takes the utility pair; every later cycle takes the ramp. The one branch #206 adds is the wrap at
 * {@link PALETTE_CYCLES}, which is what makes the twenty-ninth badge honest — it repeats a fill
 * instead of naming a step no token defines.
 */
function fillOf(number: number): string {
	const position = number - 1;
	const family = position % CYCLE_FAMILIES.length;
	const cycle = (Math.floor(position / CYCLE_FAMILIES.length) % PALETTE_CYCLES) + 1;
	return cycle === 1 ? CYCLED_FILLS[family] : cycleStep(family, cycle);
}

/**
 * **The height is fixed and the width is not** (#206). `h-4.5` is 18px against the row's 14px
 * monospace line, so a badged row is the height of an unbadged one and a level does not jump where
 * a label starts — the property `size-4.5` was chosen for. What `size-4.5` also fixed was the
 * width, and `#12` does not fit an 18px circle; so the pill grows horizontally on the design's own
 * spacing step and `rounded-full` keeps it a pill at every width rather than becoming a rectangle.
 *
 * The type step is the design's own smallest — `label-caps`, 12px in the monospace face — rather
 * than a size invented at the keyboard, and `mt-0.5` is the alignment the row's glyph and triangle
 * already use.
 */
const BADGE =
	'mt-0.5 inline-flex h-4.5 shrink-0 items-center justify-center rounded-full px-1.5 font-label-caps text-label-caps';

/**
 * What a badge says out loud, and it is the **filed** label — never the caller's own string, which
 * `pathSegment` truncated and rewrote on the way into the file name and which is genuinely
 * unrecoverable (`archive-listing.ts`, the rule §9 already states for `OWNER`).
 *
 * The same sentence in both channels, so hovering and listening give the same answer. `role="img"`
 * is what makes `aria-label` reach a screen reader on a `<span>` — and it puts the label into the
 * row link's own accessible name, where the number alone would have been a stray "1". The number is
 * deliberately **not** in that sentence: it is a code with no meaning outside this group, and
 * reading it out beside the artifact's own ordinal is the one place the two could be confused by
 * ear.
 */
export function LabelBadge({
	number,
	label,
}: {
	/** Which distinct label of this group it is — `1` upwards, in the host's own answer order. */
	readonly number: number;
	/** The label as the archive filed it. A number is a code, so this is the whole of the meaning. */
	readonly label: string;
}) {
	const said = `Filed under the label ${label}`;
	return (
		<span
			aria-label={said}
			className={`${BADGE} ${fillOf(number)}`}
			role="img"
			title={said}
		>{`#${number}`}</span>
	);
}
