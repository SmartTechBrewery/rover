/**
 * How long a lease has left, and how that reads on a card.
 *
 * Pure arithmetic, in its own module, because the interesting property is not the digits: **the
 * number goes back up.** A TTL is renewed by activity rather than by a heartbeat (`PROJECT.md` D8),
 * so the next poll carries a larger `expiresInMs` with a later `receivedAtMs` and the same function
 * answers a larger number. Nothing has to notice a renewal happened, and there is no reload.
 *
 * `receivedAtMs` is this browser's clock read at the moment the answer was parsed, and it is the
 * only place local time touches host data. That is sound where differencing `grantedAt` would not
 * be: `expiresInMs` is a duration the host measured, so subtracting locally elapsed time from it
 * costs drift between two readings of one clock, while `grantedAt` is an instant on *another* clock
 * and differencing it would cost the skew as well.
 */

/**
 * What is left of `expiresInMs`, given when the answer arrived and what time it is now.
 *
 * Clamped at both ends. Zero, because a lease cannot have negative time left — and it shows `00:00`
 * for at most one poll, since `list_devices` drops a record whose instant has passed and the next
 * answer reports the device free. Elapsed at zero too, because a clock that steps backwards would
 * otherwise report *more* time than the host granted.
 */
export function remainingMs(expiresInMs: number, receivedAtMs: number, nowMs: number): number {
	const elapsed = Math.max(0, nowMs - receivedAtMs);
	return Math.max(0, expiresInMs - elapsed);
}

/**
 * `mm:ss`, widening to `h:mm:ss` past an hour.
 *
 * The widening is not cosmetic: a two-hour TTL rendered as `120:00` is read as two minutes by
 * whoever is deciding whether a lease is stuck, which is the one question this number exists to
 * answer.
 */
export function formatCountdown(ms: number): string {
	const total = Math.floor(Math.max(0, ms) / 1000);
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	const mmss = `${pad(minutes)}:${pad(seconds)}`;
	return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}
