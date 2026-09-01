/**
 * A file's size, as the `CONTENTS` card says it — and `unknown` when the host could not `stat` it.
 *
 * **`null` is named, never closed up.** A size the host could not read is a real gap, and the
 * screen says so rather than printing `0 B`, which is a claim about an empty file. That is the same
 * rule `childCount: null` follows one level up, and `docs/DESIGN.md` §6's precedent for a fact the
 * host does not have.
 *
 * 1024, and no decimals below MB: a screenshot is `412 KB` rather than `412.31 KB`, and nothing on
 * this screen is a measurement anybody computes with.
 */

/**
 * What the screen says when the host does not have a fact — a size it could not `stat`, a count it
 * could not read, a name that does not decompose. **Never a `0` and never a guess.** One constant
 * because it is one word and the whole screen has to use the same one.
 */
export const UNKNOWN = 'unknown';

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export function formatBytes(bytes: number | null): string {
	if (bytes === null) {
		return UNKNOWN;
	}
	let size = bytes;
	let unit = 0;
	while (size >= 1024 && unit < UNITS.length - 1) {
		size /= 1024;
		unit += 1;
	}
	// Whole bytes and whole kilobytes; one decimal from megabytes up, where the fraction is the
	// difference between "a recording" and "a long recording".
	const rendered = unit <= 1 ? Math.round(size).toString() : size.toFixed(1);
	return `${rendered} ${UNITS[unit]}`;
}

/**
 * `3 files`, `1 file`, or `unknown` for a directory the host could not read into.
 *
 * The singular is not cosmetic here: a run directory holding one recording is the common case, and
 * `1 files` is the kind of thing that makes a reader wonder what else the page is guessing at.
 */
export function formatChildCount(childCount: number | null): string {
	if (childCount === null) {
		return UNKNOWN;
	}
	return childCount === 1 ? '1 file' : `${childCount} files`;
}
