/**
 * The panel's one empty-ish state: a destination that has nothing on it.
 *
 * `Archive`, `System` and `Profile` lead nowhere so far, and an unknown address leads nowhere
 * at all; both must say so rather than 404. It is written in the language of the empty states
 * (`docs/DESIGN.md` §7): a state with nothing in it is normal and *finished*, not a fault. So
 * no error or warning colour, no icon of alarm, no spinner, no progress-shaped ornament, no
 * `role="alert"` — and no control, because there is nothing here to do and a button would be
 * the first thing to lie about that.
 *
 * `closing` is a separate line rather than part of `detail` because the two cases genuinely
 * differ: a screen that is not built yet *will* be, and an address that does not exist will
 * not. One reassurance for both would be false in one of them.
 */
export function CalmNotice({
	heading,
	detail,
	closing,
}: {
	readonly heading: string;
	readonly detail: string;
	readonly closing: string;
}) {
	return (
		<section className="mt-8 rounded-lg border-2 border-outline-variant bg-surface-container-low p-8">
			<h2 className="font-label-caps text-label-caps text-on-surface-variant uppercase">
				{heading}
			</h2>
			<p className="mt-4 max-w-prose font-body-md text-body-md text-on-surface">{detail}</p>
			<p className="mt-2 max-w-prose font-body-md text-body-md text-on-surface-variant">
				{closing}
			</p>
		</section>
	);
}

/** The wording every route that is not built yet shares, so it cannot drift between them. */
export const NOT_BUILT_YET = {
	heading: 'Not built yet',
	closing: 'It will be. Nothing is wrong here.',
} as const;
