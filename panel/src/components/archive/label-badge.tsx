import type { LabelLetter } from '@panel/archive/group-labels.js';

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
 * a `-fixed` step or a neutral, and no two of them can pair into the pass/fail verdict Rover does
 * not have (`ai/RULES.md` §1). A green `A` beside a red `B` is exactly the thing this palette is
 * chosen to make unavailable.
 *
 * **It is not a control.** The tree row is a single `<Link>` and must stay one target (#175), so
 * this is a `<span>` with no handler, no focus and no press affordance — an element inside the link
 * rather than a second thing to click.
 */

/**
 * The four letters and the overflow, as **token classes and nothing else** (`ai/RULES.md` §8,
 * `docs/DESIGN.md` §1). A hex written here fails
 * `tests/unit/panel/tokens-are-the-source-of-truth.test.ts` loudly, which is the point of it.
 *
 * | letter | fill | reads as |
 * | --- | --- | --- |
 * | `A` | `bg-primary-fixed` | pale lavender |
 * | `B` | `bg-secondary-fixed` | pale peach |
 * | `C` | `bg-tertiary-fixed` | mint |
 * | `D` | `bg-inverse-surface` | neutral |
 * | `@` | `bg-surface-container-highest` | the quietest thing on the card |
 *
 * Each fill is paired with the `on-` step the design system pairs it with, so the letter is legible
 * on every one of them: `A`…`D` are four light fills carrying dark text, which is what makes them
 * read at 18px against this screen's `surface-container`. **`@` is the one that inverts** — a dark
 * fill a shade off the card, carrying the same light text the tree's quiet lines use — and that is
 * deliberate rather than an oversight in the set: it distinguishes nothing, so it does not ask to
 * be looked at.
 */
const PALETTE: Readonly<Record<LabelLetter, string>> = {
	A: 'bg-primary-fixed text-on-primary-fixed',
	B: 'bg-secondary-fixed text-on-secondary-fixed',
	C: 'bg-tertiary-fixed text-on-tertiary-fixed',
	D: 'bg-inverse-surface text-inverse-on-surface',
	'@': 'bg-surface-container-highest text-on-surface-variant',
};

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
		<span aria-label={said} className={`${BADGE} ${PALETTE[letter]}`} role="img" title={said}>
			{letter}
		</span>
	);
}
