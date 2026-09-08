/**
 * How this panel renders an instant — `2026-08-31 16:02`, and **the one place that decides it**
 * (#223, `docs/DESIGN.md` §6).
 *
 * Every timestamp on a screen a person reads comes through here: the device card's `GRANTED`
 * (`components/devices/device-card.tsx`) and the archive's, decomposed out of a run directory name
 * (`archive/run-identity.ts`). Those two disagreed about the zone, the precision and the zone
 * marker all at once — `2026-08-31T14:02:41.219Z` on one screen beside `2026-08-30 17:05:01 UTC`
 * on the next — which is two formats for one kind of fact, and machine output on either.
 *
 * **Re-expressing an instant is not differencing one, and only the second is forbidden** (D17,
 * R29). `grantedAt` is an unambiguous UTC instant (`z.string().datetime()`), so putting it in
 * another zone is exact and needs no agreement between the host's clock and this one — skew only
 * costs something when you *subtract*. Nothing relative is derived from a host instant anywhere in
 * this panel: no "5 minutes ago", no elapsed figure. The countdown is the only relative number on a
 * card and it comes from `expiresInMs`, a duration, plus the moment the answer arrived
 * (`devices/countdown.ts`, whose header is the other half of this one).
 *
 * **The zone comes from the reader; the format does not.** `Intl.DateTimeFormat` is asked for the
 * fields and the string is assembled here, in a fixed order with fixed separators — the locale is
 * never the reader's, because a browser's own locale decides the order of the fields, their
 * separators, the hour cycle and even which digits are used. `toLocaleString()` on an `en-US`
 * machine renders `8/31/2026, 4:02 PM`, which is a second format wearing the first one's name. That
 * is the rule §9 already keeps for sorting and for `toUpperCase`, applied to a time. **The pinned
 * locale is not the format either** — `en-US`'s own pattern is `08/31/2026, 16:02`; what is taken
 * from it is the Gregorian calendar and Latin digits, and the shape below is this module's.
 *
 * **Nothing is held at module scope, and that is deliberate.** A formatter built once and reused
 * would freeze the zone at first use, so a reader who changes their system zone mid-session would
 * keep the old one for the life of the tab. One formatter per call, and nothing to invalidate.
 *
 * **Minute precision costs two things and both are accepted** (`docs/DESIGN.md` §6). What is on
 * screen no longer round-trips to the host's exact instant, so a value read off a card cannot be
 * pasted into a host-side UTC log search; and two instants a second apart render alike — which the
 * Archive screen answers by always drawing the run's own directory name, `…T170501Z` and all,
 * beside the field (§9). The CLI is not on this rule and keeps printing the host's exact instant
 * (`src/cli/_shared/output.ts`): its output gets piped, diffed and pasted into a log.
 */

/**
 * The one locale this module reads fields out of, and it is **never the reader's**.
 *
 * `en-US` rather than a tag whose CLDR pattern happens to look like the format wanted: the pattern
 * is not used at all, so what this pins is the calendar and the numbering system. It is also the
 * one locale a small-ICU build is guaranteed to carry.
 */
const FIELD_LOCALE = 'en-US';

/**
 * `2026-08-31 16:02` in the reader's own zone, or `null` for a string that is not an instant.
 *
 * **`zone` is a parameter for the same reason `remainingMs` takes `nowMs`** (`devices/countdown.ts`):
 * it keeps this a pure function of its inputs, and it is the only way the one property worth
 * asserting about this module — that two readers in two zones are shown *different, correct*
 * strings — can be asserted at all. Nothing in the panel passes it, and the default is what a
 * browser is in. See `ai/TESTING.md` for why the alternative does not work: under the `panel`
 * project a `process.env.TZ` flip never reaches the worker thread's own V8 isolate, so a test
 * written that way passes whatever the implementation does.
 *
 * `null` rather than a guess or a throw, and its two callers read it differently on purpose. On the
 * Archive screen it is what makes a directory name whose prefix is not a timestamp read `unknown`
 * (`archive/run-identity.ts`, `docs/DESIGN.md` §9). On a device card it is a host that broke its
 * own `z.string().datetime()` contract (`src/ipc/methods.ts`), and the card shows what it was sent
 * rather than hiding the one piece of evidence that it did.
 */
export function formatInstant(instant: string, zone?: string): string | null {
	const at = new Date(instant);
	if (Number.isNaN(at.getTime())) {
		return null;
	}
	const parts = new Intl.DateTimeFormat(FIELD_LOCALE, {
		timeZone: zone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		// A 24-hour clock, so no field carries a `PM` and midnight is `00` rather than `24`.
		hourCycle: 'h23',
	}).formatToParts(at);
	const field = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? '';

	return `${field('year')}-${field('month')}-${field('day')} ${field('hour')}:${field('minute')}`;
}
