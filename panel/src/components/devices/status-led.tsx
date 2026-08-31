/**
 * The one status LED (`docs/DESIGN.md` §5): same fill and same border wherever it appears, and
 * only the size changes with context — 3 on a card header, 2.5 in the counter badge.
 *
 * One component rather than two class lists, for the reason `Wordmark` is one: the rule is that
 * they are identical, and identical-by-construction is the only kind that survives a second screen.
 *
 * **There is no red or orange device state and there will not be one.** A device that disappears
 * from the host is simply not listed, and orange in this palette is the warning colour. Held is
 * neutral blue, free is green, and neither glows.
 *
 * `aria-hidden`, everywhere it is used: on a card the body already says `ACTIVE LEASE` or `free`,
 * and in the counter the text beside it reads "2 held". It is a second channel for something
 * already written, which is what makes it decoration to a screen reader rather than information
 * withheld from one.
 */
export function StatusLed({
	held,
	size = 'card',
}: {
	readonly held: boolean;
	readonly size?: 'card' | 'counter';
}) {
	return (
		<span
			aria-hidden="true"
			className={`inline-block shrink-0 rounded-full border ${size === 'card' ? 'size-3' : 'size-2.5'} ${
				held ? 'border-primary bg-primary-container' : 'border-tertiary bg-tertiary'
			}`}
		/>
	);
}
