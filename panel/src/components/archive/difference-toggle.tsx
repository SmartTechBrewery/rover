import { BADGE_SHAPE, BADGE_TYPE } from '@panel/components/archive/header-badge.js';
import { SquareDashed } from 'lucide-react';

/**
 * `Differences` — draw boxes where the second artifact of a pair differs from the first
 * (`docs/DESIGN.md` §9).
 *
 * **It is the comparison card's only control and it sits at the right end of the header strip**,
 * opposite the label — the position and the shape `Keep` and `Remove` already hold on this screen
 * (`archive-checkbox.tsx`, §10), because `ContentsCard`'s header is a slot precisely so a card can
 * put a second thing in that strip.
 *
 * **Drawn as the two-cell pill, not invented**: {@link BADGE_SHAPE} and {@link BADGE_TYPE} divided
 * by the frame's own border into a **lamp** and a word, so this control is the same object as the
 * tick beside it in every measure that is not its colour. No approved Stitch screen shows one
 * (`ai/RULES.md` §8), and reusing the pill is what keeps that deviation to a single reconcilable
 * edit rather than a third control language on one screen.
 *
 * **The lamp is `secondary` and deliberately not `tertiary`.** Green means *kept* and *you are
 * here* everywhere in this panel, and a green lamp over an artifact would read as a judgement about
 * it — which is the one thing the marks are not. `secondary` is the palette's other accent, it is
 * the colour the boxes themselves are drawn in, and lighting the control in the colour of what it
 * draws is the whole of what the lamp has to say. **Nothing here is red or green**, for §9's
 * reason: a red box would make one arm the wrong one, and neither arm is (`ai/RULES.md` §1).
 *
 * **A `<button aria-pressed>` rather than a checkbox**, which is `view-toggle.tsx`'s distinction:
 * this changes what the card *draws* and never where the reader is, there is no address for it to
 * point at, and nothing about it is filed anywhere. `Keep` is a checkbox because it writes a flag
 * to the host; this is a lamp on a view.
 */
export function DifferenceToggle({
	on,
	onPress,
}: {
	readonly on: boolean;
	readonly onPress: () => void;
}) {
	return (
		<button
			aria-pressed={on}
			className={`${BADGE_SHAPE} flex shrink-0 items-stretch overflow-hidden border-outline-variant bg-surface-container transition-colors select-none hover:border-secondary focus-visible:border-secondary`}
			onClick={onPress}
			type="button"
		>
			{/*
			 * The lamp — `bg-surface` sunk below the pill at rest with the glyph at the frame's weight,
			 * and `secondary` over `on-secondary` when it is on, which is the pairing the panel uses
			 * wherever something is lit (§3). The divider is the frame continued inwards rather than a
			 * rule of its own, so it stays the frame's colour in both states.
			 *
			 * The glyph is drawn in both states, `archive-checkbox.tsx`'s rule: an unlit lamp says
			 * *there is a light here and it is off*, where an empty cell says only that something is
			 * missing.
			 */}
			<span
				className={`flex items-center justify-center border-outline-variant border-r-2 px-2 transition-colors ${
					on ? 'bg-secondary text-on-secondary' : 'bg-surface text-outline-variant'
				}`}
			>
				<SquareDashed aria-hidden="true" size={14} strokeWidth={3} />
			</span>
			{/* One colour in every state — the lamp carries the state, and a word that also changed
			 * would be the state said twice (`archive-checkbox.tsx`). */}
			<span className={`${BADGE_TYPE} text-on-surface`}>Differences</span>
		</button>
	);
}
