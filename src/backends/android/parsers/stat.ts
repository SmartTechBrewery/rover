/**
 * Parser for `stat -L -c '%s %F' <path>` — what the device says a path *is*, and how big.
 *
 * One command answering both questions because both transfers need one of them before
 * they move any bytes, and asking twice would be two round trips for one fact about one
 * inode. `push_file` needs the kind: `adb push` to a path that is already a directory
 * silently lands the file *inside* it, under the host-side basename, and answers `1 file
 * pushed` (PROJECT.md §6). `pull_file` needs the size: without it the whole file is on
 * this host's disk and in the daemon's heap before anything can refuse it.
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
 * `kind` is `'directory'` or `'other'` rather than the whole of `%F`'s vocabulary, because
 * a directory is the only distinction either caller acts on and enumerating the rest would
 * be a list this repository has no captures for (`tests/fixtures/adb/README.md`, "Shapes
 * with no fixture yet"). `description` keeps the device's own word for whoever reads a
 * failure.
 */
export interface DeviceStat {
	readonly byteLength: number;
	readonly kind: 'directory' | 'other';
	readonly description: string;
}

/** `%F`'s word for a directory. The only value in that vocabulary anything here branches on. */
const DIRECTORY_DESCRIPTION = 'directory';

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
		kind: description === DIRECTORY_DESCRIPTION ? 'directory' : 'other',
		description,
	};
}
