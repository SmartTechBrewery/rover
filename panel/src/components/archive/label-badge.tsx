import { LABEL_LETTERS, type LabelLetter } from '@panel/archive/group-labels.js';

/**
 * One artifact's label badge — the round letter beside its name in the groups view's tree (#182,
 * `docs/DESIGN.md` §9).
 *
 * **The letter carries the meaning, never the colour alone.** Every badge says which label it is in
 * text, at badge size, and the fill is a second channel for something already written — the rule
 * `StatusLed` keeps from the other side, where the colour is the only channel and the badge is
 * therefore `aria-hidden`. This one is not: a letter is a code local to one group and `@` names
 * nothing at all, so the **filed** label travels with it in the accessible name and in `title`, and
 * a reader who cannot see the colour, or cannot see anything, still gets the thing that means
 * something.
 *
 * **No colour here may read as an outcome** (`docs/DESIGN.md` §5, §9). §5 already spends the
 * tertiary green on *a free device*, the primary-container blue on *held* and the
 * secondary-container orange on *warning*, and `error` is excluded outright — so every fill below is
 * a `-fixed` step, a neutral, or a step derived from one of those, and no two of them can pair into
 * the pass/fail verdict Rover does not have (`ai/RULES.md` §1). A green `A` beside a red `B` is
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
 * The four colours, **cycled by the letter's position** (#197), as token classes and nothing else
 * (`ai/RULES.md` §8, `docs/DESIGN.md` §1). A hex written here fails
 * `tests/unit/panel/tokens-are-the-source-of-truth.test.ts` loudly, which is the point of it.
 *
 * | family | letters | cycle 1's fill | reads as |
 * | --- | --- | --- | --- |
 * | primary | `A`, `E`, `I`, `M`, `Q`, `U`, `Y` | `bg-primary-fixed` | pale lavender |
 * | secondary | `B`, `F`, `J`, `N`, `R`, `V`, `Z` | `bg-secondary-fixed` | pale peach |
 * | tertiary | `C`, `G`, `K`, `O`, `S`, `W` | `bg-tertiary-fixed` | mint |
 * | neutral | `D`, `H`, `L`, `P`, `T`, `X` | `bg-inverse-surface` | neutral |
 * | — | `@` | `bg-surface-container-highest` | the quietest thing on the card |
 *
 * Only the first letter of each row draws that fill as written; the rest are the same hue a cycle
 * deeper, which is {@link CYCLE_FAMILIES} below.
 *
 * Each fill is paired with the `on-` step the design system pairs it with, so the letter is legible
 * on every one of them: the four are light fills carrying dark text, which is what makes them read
 * at 18px against this screen's `surface-container`. **`@` is the one that inverts** — a dark fill
 * a shade off the card, carrying the same light text the tree's quiet lines use — and that is
 * deliberate rather than an oversight in the set: it distinguishes nothing, so it does not ask to
 * be looked at.
 *
 * **This is cycle 1 and only cycle 1** (#200). It is what `A`…`D` draw, verbatim and
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
 * step** (#200, `docs/DESIGN.md` §9), which is what makes `E` onwards a different step of the same
 * hue rather than a plain repeat of `A`…`D`.
 *
 * Not a colour: every step is `color-mix(in srgb, …)` over two tokens of one family, in
 * `panel/src/index.css` beside the panel's other derived colours, and
 * `tests/unit/panel/label-badge-palette.test.ts` recomputes all twenty-eight fills from the tokens
 * and asserts the contrast, the distance from every colour that already means something, and the
 * distance between the fills of letters adjacent in the alphabet. What is written here is the
 * family and the cycle; the colour is not written anywhere but the token file.
 *
 * **Adjacency is satisfied by construction, and the cycle boundary is no longer the exception.**
 * Cycling family-first already meant two letters next to each other are always two different
 * families, with two steps of one family exactly four letters apart. What #197 had to record as
 * the one weak pair was the boundary — `D`'s neutral `#e2e2e6` beside `E`'s lavender `#dde1ff`,
 * ΔE 13.6 apart, because `E` was a plain repeat of `A`. `E` is now a step off `A`, so that pair
 * is ΔE 19.7 and it is no longer the closest thing in the set to a collision; the gate asserts
 * every one of the twenty-five adjacent pairs, boundaries included.
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

/** The class triple a letter past `D` is drawn with — the ramp, its family, and its cycle. */
function cycleStep(family: number, cycle: number): string {
	return `label-badge-step label-badge-${CYCLE_FAMILIES[family]} label-badge-cycle-${cycle}`;
}

/** `@` is outside the cycle: it distinguishes nothing, so it stays the quietest thing here. */
const OVERFLOW_FILL = 'bg-surface-container-highest text-on-surface-variant';

/**
 * The map holds exactly `A`…`Z`, so `@` falls through it to {@link OVERFLOW_FILL} the same way
 * `lettersOfGroup`'s own `?? OVERFLOW_LETTER` does — one idiom, read in both directions. The `??`
 * below is therefore a live branch rather than a cast around an exhaustive record.
 *
 * The family and the cycle are **both** the letter's own position, which is why there is one
 * mapping here and not two: the position modulo four picks the family, and the position over four
 * picks how deep into that family the fill sits. Cycle 1 takes the utility pair; every later cycle
 * takes the ramp.
 */
const FILL_OF: ReadonlyMap<LabelLetter, string> = new Map(
	LABEL_LETTERS.map((letter, index) => {
		const family = index % CYCLED_FILLS.length;
		const cycle = Math.floor(index / CYCLED_FILLS.length) + 1;
		return [letter, cycle === 1 ? CYCLED_FILLS[family] : cycleStep(family, cycle)];
	}),
);

/**
 * `size-4.5` is 18px against the row's 14px monospace line, so a badged row is the height of an
 * unbadged one and a level does not jump where a label starts. The type step is the design's own
 * smallest — `label-caps`, 12px in the monospace face — rather than a size invented at the
 * keyboard, and `mt-0.5` is the alignment the row's glyph and triangle already use.
 */
const BADGE =
	'mt-0.5 inline-flex size-4.5 shrink-0 items-center justify-center rounded-full font-label-caps text-label-caps';

/**
 * What a badge says out loud, and it is the **filed** label — never the caller's own string, which
 * `pathSegment` truncated and rewrote on the way into the file name and which is genuinely
 * unrecoverable (`archive-listing.ts`, the rule §9 already states for `OWNER`).
 *
 * The same sentence in both channels, so hovering and listening give the same answer. `role="img"`
 * is what makes `aria-label` reach a screen reader on a `<span>` — and it puts the label into the
 * row link's own accessible name, where the letter alone would have been a stray "A".
 */
export function LabelBadge({
	letter,
	label,
}: {
	readonly letter: LabelLetter;
	/** The label as the archive filed it. `@` names nothing, so this is the whole of the meaning. */
	readonly label: string;
}) {
	const said = `Filed under the label ${label}`;
	return (
		<span
			aria-label={said}
			className={`${BADGE} ${FILL_OF.get(letter) ?? OVERFLOW_FILL}`}
			role="img"
			title={said}
		>
			{letter}
		</span>
	);
}
