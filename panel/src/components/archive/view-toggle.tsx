/**
 * Which arrangement of the archive the screen is drawing (#165).
 *
 * `all` is the file explorer `docs/DESIGN.md` §9 settles — the tree beside one card, at every
 * depth. `groups` is the archive arranged by the testing group a lease named (`PROJECT.md` R41),
 * and it is a placeholder for now: the toggle and the *state* land here, the arrangement itself is
 * separate work.
 */
export type ArchiveView = 'all' | 'groups';

/** The two segments, in the order they are drawn. `all` is first because it is the default. */
const VIEWS: readonly { readonly view: ArchiveView; readonly label: string }[] = [
	{ view: 'all', label: 'All' },
	{ view: 'groups', label: 'Testing groups' },
];

/**
 * The frame is the header badge's own — `rounded-sm border-2 border-outline-variant
 * bg-surface-container`, minus the padding, which belongs to each segment so the two of them
 * divide one block rather than sitting as two chips in a row.
 *
 * **No approved Stitch screen shows this control** (`ai/RULES.md` §8), so nothing about it is
 * invented: every value here is already on this screen or in §3. That is what keeps the deviation
 * small enough to reconcile in one edit once a design for it exists.
 */
const FRAME =
	'm-0 inline-flex shrink-0 rounded-sm border-2 border-outline-variant bg-surface-container p-0';

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
 * Both segments are buttons rather than links: this changes what the screen *draws*, never where
 * you are, so there is no address for either of them to point at. `aria-pressed` is what says which
 * one you are on, since the colour cannot.
 *
 * A `<fieldset>` rather than a `div` with `role="group"` — the element the role exists for, named by
 * `aria-label` because a `<legend>` would be a visible heading over a control that needs none. Its
 * two UA measures are reset in {@link FRAME}, since the frame here is the badge's and not the
 * browser's.
 */
export function ArchiveViewToggle({
	view,
	onSelect,
}: {
	readonly view: ArchiveView;
	readonly onSelect: (view: ArchiveView) => void;
}) {
	return (
		<fieldset aria-label="Archive view" className={FRAME}>
			{VIEWS.map((segment) => {
				const isCurrent = segment.view === view;
				return (
					<button
						aria-pressed={isCurrent}
						className={`${SEGMENT} ${isCurrent ? SEGMENT_CURRENT : SEGMENT_OTHER}`}
						key={segment.view}
						onClick={() => onSelect(segment.view)}
						type="button"
					>
						{segment.label}
					</button>
				);
			})}
		</fieldset>
	);
}
