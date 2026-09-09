import type { ReactNode } from 'react';

/**
 * The panel's header badge pill — **one component, and three badges draw it** (#261, #260,
 * `docs/DESIGN.md` §9 and §13).
 *
 * Two of them are the Archive header's, the count and the size; the third is on the **System**
 * screen, in the `ARCHIVE SETTINGS` card's own strip, saying what the archive weighs (#260). It
 * lives under `components/archive/` because that is where it was extracted and where two of its
 * three callers are, and the third reads `archive/size-sentence.ts` for its words in any case — the
 * System card is one more reader of the Archive's answer rather than a second owner of it.
 *
 * It was `badgeFor`'s inline class string while there was one badge to draw. The size badge is the
 * second, and a second copy of that string is how two pills in one row drift apart by a border
 * width; so it is extracted rather than repeated, and neither badge owns the treatment any more.
 *
 * **No new colour and no new measure.** Every value here is the one already on this screen —
 * `border-2 border-outline-variant` is the card frame's, `bg-surface-container` the card's own
 * surface, and the 12px face is the view toggle's segment (`view-toggle.tsx`). Nothing about the
 * pill is invented, because no approved Stitch screen shows a second badge in this row
 * (`ai/RULES.md` §8) and that is what keeps the deviation small enough to reconcile in one edit.
 *
 * **What a badge says is not this component's business.** The count badge's wording, its
 * absent-rather-than-`0` rule and the size badge's sentence live where each is decided —
 * `routes/archive.tsx` and `size-sentence.ts`. This is the frame and the type, so a badge that
 * should not be drawn is not drawn by its own caller returning nothing — which is how all three
 * come and go, including the System card's.
 */

/**
 * The frame alone, for the one thing in this row that needs it without the padding: the view
 * toggle, whose two segments divide one block and so carry their own `px-3 py-1` and need `p-0`
 * and `inline-flex` of their own.
 *
 * That control's header already claimed the frame was the badge's own; exporting it is what makes
 * that true rather than duplicated.
 */
export const BADGE_FRAME = 'rounded-sm border-2 border-outline-variant bg-surface-container';

/**
 * The padding and the type all three share — 12px from Tailwind's own `--text-xs` rather than
 * from `text-label-caps`, for the reason `Breadcrumb` records: the caps step would drag 700 weight
 * and 0.1em tracking along with the size. The toggle's segments beside it are the same 12px in the
 * same face.
 */
const TYPE = 'px-3 py-1 font-code-md text-[12px] text-on-surface';

/** One badge — the Archive header's count and size, and the System card's archive total (#260). */
export function HeaderBadge({ children }: { readonly children: ReactNode }) {
	return <div className={`${BADGE_FRAME} ${TYPE}`}>{children}</div>;
}
