/**
 * The one status LED (`docs/DESIGN.md` §5): same fill and same border wherever it appears, and
 * only the size changes with context — 3 on a card header, 2.5 in the counter badge.
 *
 * One component rather than three class lists, for the reason `Wordmark` is one: the rule is that
 * they are identical, and identical-by-construction is the only kind that survives a second screen.
 *
 * **There is no red or orange device state and there will not be one.** A device that disappears
 * from the host is simply not listed, and orange in this palette is the warning colour. Held is
 * neutral blue, free is green, and neither glows.
 *
 * `not-ready` is the third tone and it is **grey, deliberately** (#123): a device adb reports as
 * `unauthorized` or `offline` is listed, is not held, and cannot be leased — so it may not carry
 * the free green, and the rule above says it may not carry a warning colour either. Grey is what
 * is left, and it is the honest one: nothing has failed, there is simply nothing here to take.
 *
 * `aria-hidden`, everywhere it is used: on a card the body already says `ACTIVE LEASE`, `free` or
 * what adb reports, and in the counter the text beside it reads "2 held". It is a second channel
 * for something already written, which is what makes it decoration to a screen reader rather than
 * information withheld from one.
 */
export function StatusLed({
	tone,
	size = 'card',
}: {
	readonly tone: 'held' | 'free' | 'not-ready';
	readonly size?: 'card' | 'counter';
}) {
	const colour = {
		held: 'border-primary bg-primary-container',
		free: 'border-tertiary bg-tertiary',
		'not-ready': 'border-outline bg-outline',
	}[tone];
	return (
		<span
			aria-hidden="true"
			className={`inline-block shrink-0 rounded-full border ${size === 'card' ? 'size-3' : 'size-2.5'} ${colour}`}
		/>
	);
}
