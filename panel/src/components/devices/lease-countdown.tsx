import { formatCountdown, remainingMs } from '@panel/devices/countdown.js';
import { useEffect, useState } from 'react';

/**
 * The digits in the lease panel's header, falling once a second — and rising when the lease is
 * renewed.
 *
 * **The renewal needs no mechanism of its own** (`PROJECT.md` D8). The next poll carries a larger
 * `expiresInMs` with a later `receivedAtMs`, and this component recomputes from its props: the
 * number goes back up without a reload, and nothing has to notice a renewal happened.
 *
 * Three things it deliberately does not do:
 *
 * - **No colour that changes with time left.** The design's demo script turns the timer orange
 *   under a minute. Expiry here is normal and renewable, orange is this palette's warning colour,
 *   and `docs/DESIGN.md` §7 already says this number is "not dressed as urgent".
 * - **No `aria-live`.** A region announcing once a second is a screen-reader firehose. The digits
 *   are ordinary text, and what a lease is and who holds it is written beside them in text that
 *   does not move.
 * - **Nothing to suppress under `prefers-reduced-motion`.** It changes text, with no transition and
 *   no animation on it, so the global block in `index.css` has nothing to reach — there is no
 *   missing branch here to go looking for.
 */
export function LeaseCountdown({
	expiresInMs,
	receivedAtMs,
}: {
	readonly expiresInMs: number;
	readonly receivedAtMs: number;
}) {
	const [nowMs, setNowMs] = useState(() => Date.now());

	useEffect(() => {
		const ticking = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(ticking);
	}, []);

	return (
		<span className="font-code-md text-code-md text-on-surface">
			{formatCountdown(remainingMs(expiresInMs, receivedAtMs, nowMs))}
		</span>
	);
}
