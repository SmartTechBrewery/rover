import { formatInstant } from '@panel/time/instant.js';

/**
 * A run directory's name, decomposed — **the one place in the panel that parses a component**, and
 * the reason it is allowed to is that this is a name Rover itself wrote
 * (`src/daemon/archive-path.ts`: `<timestamp>-<owner>-<hash>`).
 *
 * Two rules from `docs/DESIGN.md` §9 live here, and neither is a detail:
 *
 * - **The first and the last hyphen, never `split('-')`.** An owner string is free text —
 *   `pr-127-review` is one owner (`ai/RULES.md` §1 names it), and a naive split makes it `pr`.
 * - **`OWNER` is the directory's own text.** It went through `pathSegment` on the way in, so it is
 *   not reversibly the caller's `owner` string and nothing in the panel may present it as one. It
 *   is what the directory is called, which is all this screen can honestly say.
 *
 * Nothing here is inferred when the name does not have the shape: both fields come back `null`,
 * the screen says `unknown`, and the name itself is shown verbatim either way. Nothing is invented
 * — no duration, no trigger, no author (`docs/DESIGN.md` §9).
 */

export interface RunIdentity {
	/** The directory name, verbatim and always. */
	readonly name: string;
	/** Between the first and the last hyphen, or `null`. */
	readonly owner: string | null;
	/** `2026-08-30 19:05` for a reader in Warsaw, or `null` — {@link formatArchiveTimestamp}. */
	readonly grantedAt: string | null;
}

/**
 * The host's own timestamp, in UTC basic format, as `src/daemon/archive-path.ts` writes it.
 * Anchored at both ends: a name that merely starts with digits is not a timestamp.
 */
const TIMESTAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * `zone` is handed straight to `formatInstant` and **nothing in the panel passes it** — it is there
 * for the reason that module's own parameter is there, so that a test can put two readers in two
 * zones (`time/instant.ts`, `ai/TESTING.md`).
 */
export function decomposeRunName(name: string, zone?: string): RunIdentity {
	const first = name.indexOf('-');
	const last = name.lastIndexOf('-');
	// `first > 0` because a leading hyphen leaves no timestamp before it, and `last > first`
	// because one hyphen leaves no owner between them. Either way there is nothing to read.
	if (first <= 0 || last <= first) {
		return { name, owner: null, grantedAt: null };
	}
	return {
		name,
		owner: name.slice(first + 1, last),
		grantedAt: formatArchiveTimestamp(name.slice(0, first), zone),
	};
}

/**
 * `20260830T170501Z` as `2026-08-30 19:05` for a reader in Warsaw — the archive's own basic format
 * reshaped into an ISO instant and handed to the panel's one formatter (`time/instant.ts`), which
 * is what every timestamp on every screen goes through (`docs/DESIGN.md` §6).
 *
 * **It was textual until #223, and the rule it followed is reversed rather than dropped.** *No
 * `Date` and no `Intl`* was §9's rule, resting on §6's older claim that nothing may re-express a
 * host instant in the reader's zone — which collapsed *do not difference an instant against this
 * clock* and *do not localise one* into a single prohibition. The first half stands, here and
 * everywhere: nothing in this module differences anything, and the panel's one relative number
 * still comes from a duration (`devices/countdown.ts`). The second half was wrong, because this
 * string is an unambiguous UTC instant and putting it in another zone is exact. What it cost while
 * it stood was `2026-08-30 17:05:01 UTC` on this screen beside a raw ISO instant on the device card
 * — two formats for one kind of fact, neither of them in the reader's own zone.
 *
 * **The parse is unchanged and is still what decides `unknown`.** The regex is what says a prefix
 * is a timestamp at all, so a name that merely starts with digits still comes back `null` and still
 * reads `unknown`, with the directory's own name shown in full either way (§9). The reshaping
 * inserts separators and changes no value.
 */
function formatArchiveTimestamp(timestamp: string, zone?: string): string | null {
	const parts = TIMESTAMP.exec(timestamp);
	if (parts === null) {
		return null;
	}
	const [, year, month, day, hour, minute, second] = parts;
	return formatInstant(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`, zone);
}
