import { BADGE_FRAME } from '@panel/components/archive/header-badge.js';
import { Link } from '@tanstack/react-router';

/**
 * Which arrangement of the archive the screen is drawing (#165, given addresses of its own by
 * #181).
 *
 * `all` is the file explorer `docs/DESIGN.md` §9 settles — the tree beside one card, at every
 * depth. `groups` is the same archive arranged by the testing group a lease named (`PROJECT.md`
 * R41): project, then `groupId`, then the standard arrangement under it.
 *
 * **Each view is a route family of its own**, `/archive` and `/archive/$` against `/groups` and
 * `/groups/$`, served by one screen component. So this type says which route is matched rather than
 * which button was last pressed.
 */
export type ArchiveView = 'all' | 'groups';

/**
 * The two segments, in the order they are drawn. `all` is first because it is the default.
 *
 * `as const` so each `to` stays the literal the router type-checks a link against, rather than
 * widening to `string` and taking the address out of the type system in the one place it matters.
 */
const VIEWS = [
	{ view: 'all', label: 'All', to: '/archive' },
	{ view: 'groups', label: 'Testing groups', to: '/groups' },
] as const satisfies readonly {
	readonly view: ArchiveView;
	readonly label: string;
	readonly to: string;
}[];

/**
 * The frame is the header badge's own — **and it is now that badge's own constant** rather than the
 * same classes written twice (#261, amended in place). {@link BADGE_FRAME} is the frame; the
 * padding is deliberately not taken with it, because it belongs to each segment so the two of them
 * divide one block rather than sitting as two chips in a row. `p-0` and `m-0` reset the
 * `<fieldset>`'s two UA measures, since the frame here is the badge's and not the browser's.
 *
 * **No approved Stitch screen shows this control** (`ai/RULES.md` §8), so nothing about it is
 * invented: every value here is already on this screen or in §3. That is what keeps the deviation
 * small enough to reconcile in one edit once a design for it exists.
 */
const FRAME = `m-0 inline-flex shrink-0 ${BADGE_FRAME} p-0`;

/**
 * 12px from Tailwind's own `--text-xs` rather than from `text-label-caps`, for the reason
 * `Breadcrumb` records: the caps step would drag 700 weight and 0.1em tracking along with the size.
 * The badge beside it is the same 12px in the same face.
 */
const SEGMENT = 'px-3 py-1 font-code-md text-xs';

/**
 * The green that means *you are here* everywhere else in the panel — the breadcrumb's last segment
 * and the active nav item (§3) — over the card header strip's surface. Deliberately not the nav
 * item's filled `bg-tertiary-container`: this is chrome in a header row, and §5 keeps emphasis on
 * the data rather than on the furniture.
 */
const SEGMENT_CURRENT = 'bg-surface-container-high text-tertiary';

/** The breadcrumb's inactive link treatment, which is the same question asked of the same reader. */
const SEGMENT_OTHER = 'text-on-surface-variant transition-colors hover:text-on-surface';

/**
 * The Archive screen's one view switch, and **it is text and nothing else** — no glyph, because
 * neither arrangement has a symbol that would say more than its name does.
 *
 * **Both segments are links, and that is a reversal of #165's own reasoning, made in place**
 * (#181, `docs/DESIGN.md` §9). They were buttons because the toggle changed what the screen *drew*
 * and never where you were, and there was no address for the second one to point at: the groups
 * arrangement had none. It has them now — `/groups` and `/groups/$` — so the view is where you are,
 * a reload and a shared link land on it, and `aria-current` says which one you are on the way it
 * says it everywhere else in the panel. The `viewChosenAt` reset machinery an address was standing
 * in for is gone with it.
 *
 * Each segment links to its view's **root**, never to the address you are standing on translated
 * into the other view: the two arrangements do not share a vocabulary below the project — one has a
 * group id where the other has a test name — so *the same place in the other view* is a claim
 * neither of them can make honestly.
 *
 * A `<fieldset>` rather than a `div` with `role="group"` — the element the role exists for, named by
 * `aria-label` because a `<legend>` would be a visible heading over a control that needs none. Its
 * two UA measures are reset in {@link FRAME}.
 */
export function ArchiveViewToggle({ view }: { readonly view: ArchiveView }) {
	return (
		<fieldset aria-label="Archive view" className={FRAME}>
			{VIEWS.map((segment) => {
				const isCurrent = segment.view === view;
				return (
					<Link
						aria-current={isCurrent ? 'page' : undefined}
						className={`${SEGMENT} ${isCurrent ? SEGMENT_CURRENT : SEGMENT_OTHER}`}
						key={segment.view}
						to={segment.to}
					>
						{segment.label}
					</Link>
				);
			})}
		</fieldset>
	);
}
