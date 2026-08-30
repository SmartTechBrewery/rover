/**
 * Parser for `stat -L -c '%s %F' <path>` — what the device says a path *is*, and how big.
 *
 * One command answering both questions because both transfers need an answer before they
 * move any bytes, and asking twice would be two round trips for one fact about one inode.
 * `push_file` needs the kind: `adb push` to a path that is already a directory silently
 * lands the file *inside* it, under the host-side basename, and answers `1 file pushed`
 * (PROJECT.md §6). `pull_file` needs **both**: the size, because without it the whole file
 * is on this host's disk and in the daemon's heap before anything can refuse it — and the
 * kind before that, because for anything that is not a regular file `%s` does not predict
 * what a pull would fetch. A directory reports its own 4096 bytes while `adb pull` copies
 * the tree recursively; a character device reports **0** while `adb pull /dev/urandom`
 * writes until something stops it — 769,196,032 bytes onto this host in the five seconds
 * before it was killed (API 37, PROJECT.md §6). So a size read without a kind beside it is
 * a bound that passes on a
 * transfer of any size at all, which is why `kind` names a regular file rather than merely
 * ruling out a directory.
 *
 * **`-L` follows symlinks, and that is the question both callers are asking.** Without it
 * a link to a directory reads as `symbolic link` with the length of the link text as its
 * size — measured at 33 bytes for a link whose target was 11 (API 37, adb 37.0.0) — which
 * is the wrong answer to "will a push land inside this" and to "how much will a pull
 * fetch". `adb push` and `adb pull` both resolve the link, so this resolves it too.
 *
 * **The size is `%s`, the kind is `%F`, and the order is deliberate.** `%F` is a phrase
 * with spaces in it, so it goes last and the split is on the *first* space only; putting
 * it first would make the field boundary depend on which phrase the device chose.
 *
 * Pinned to captures like every predicate in this folder — `tests/fixtures/adb/stat.*` —
 * because `%F`'s vocabulary is the thing that would otherwise be written from memory: an
 * empty file is **`regular empty file`**, not `regular file`, so a check for the latter
 * calls a zero-byte file something it is not.
 */

/**
 * What a device path turned out to be — enough for a transfer to decide, and nothing more.
 *
 * Three values rather than the whole of `%F`'s vocabulary, because three is what the two
 * callers act on. `'directory'` is what a push must not land inside and what a pull must not
 * copy recursively. `'regular-file'` is the only shape whose `%s` *predicts* what a pull
 * would fetch, which makes it the only shape `pull_file` can bound — so it has to be a value
 * of its own rather than something inferred from "not a directory". Everything else is
 * `'other'`: a character device, a fifo, a socket, a block device. Enumerating those would
 * be a list this repository has no captures for (`tests/fixtures/adb/README.md`, "Shapes
 * with no fixture yet"), and no caller needs to tell them apart — `description` keeps the
 * device's own word for whoever reads a failure, so a refusal can still say *which* it was.
 */
export interface DeviceStat {
	readonly byteLength: number;
	readonly kind: 'directory' | 'regular-file' | 'other';
	readonly description: string;
}

/** `%F`'s word for a directory. */
const DIRECTORY_DESCRIPTION = 'directory';

/**
 * `%F`'s two words for a regular file, both captured.
 *
 * A set rather than a prefix test, because the second member is the whole reason this is
 * pinned to fixtures: an empty file is **`regular empty file`**, so `'regular file'` alone
 * calls a zero-byte file something it is not, and `startsWith('regular')` would be a guess
 * about a vocabulary nothing here has measured the rest of.
 */
const REGULAR_FILE_DESCRIPTIONS: ReadonlySet<string> = new Set([
	'regular file',
	'regular empty file',
]);

/** The device's `%F` phrase, mapped to the distinction a transfer acts on. */
function kindOf(description: string): DeviceStat['kind'] {
	if (description === DIRECTORY_DESCRIPTION) return 'directory';
	if (REGULAR_FILE_DESCRIPTIONS.has(description)) return 'regular-file';
	return 'other';
}

/**
 * The one line `stat` printed, or `null` when it printed something this does not recognise.
 *
 * `null` rather than a throw, because every caller here has a sound fallback: a probe that
 * could not answer leaves the transfer exactly where it was before the probe existed. An
 * exception would turn "this device's toybox words it differently" into a failed verb.
 */
export function parseDeviceStat(stdout: string): DeviceStat | null {
	const line = stdout.trim();
	if (line.length === 0) return null;

	const separator = line.indexOf(' ');
	if (separator === -1) return null;

	const size = line.slice(0, separator);
	const description = line.slice(separator + 1).trim();
	if (!/^\d+$/.test(size) || description.length === 0) return null;

	return {
		byteLength: Number(size),
		kind: kindOf(description),
		description,
	};
}
