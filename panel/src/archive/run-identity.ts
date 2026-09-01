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
	/** `2026-08-30 17:05:01 UTC`, or `null`. */
	readonly grantedAt: string | null;
}

/**
 * The host's own timestamp, in UTC basic format, as `src/daemon/archive-path.ts` writes it.
 * Anchored at both ends: a name that merely starts with digits is not a timestamp.
 */
const TIMESTAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

export function decomposeRunName(name: string): RunIdentity {
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
		grantedAt: formatArchiveTimestamp(name.slice(0, first)),
	};
}

/**
 * `20260830T170501Z` as `2026-08-30 17:05:01 UTC`, **textually**.
 *
 * No `Date` and no `Intl`, deliberately: the string is the host's own UTC instant, and anything
 * that parsed it would re-express it in this browser's zone — which `docs/DESIGN.md` §6 already
 * forbids for `grantedAt` on a device card, for the same reason. The reformatting inserts
 * separators and adds the unit; it changes no value and shifts no clock.
 */
function formatArchiveTimestamp(timestamp: string): string | null {
	const parts = TIMESTAMP.exec(timestamp);
	if (parts === null) {
		return null;
	}
	const [, year, month, day, hour, minute, second] = parts;
	return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC`;
}
