/**
 * What a recording off this platform looks like — the two questions `record_video` asks
 * that are about *output* rather than about a process.
 *
 * It lives beside the text parsers for `./screencap.js`'s reason: `../adb.js` owns the
 * process and `../backend.ts` is the join between the two, so knowledge of what the
 * device's output *is* belongs on this side and can be tested without either a process or
 * a device.
 *
 * **There is no refusal predicate here, and that is a measurement rather than an
 * omission.** `screenrecord` on API 37 succeeds with zero bytes on both streams at exit 0
 * and refuses with a stderr line at exit **1** — `Unable to open '…': No such file or
 * directory` (`tests/fixtures/adb/screenrecord.unwritable-path.api37-….txt`), which
 * `../adb.js` already turns into an `AdbCommandError`. Nothing was found that fails while
 * exiting 0, which is the trap `./app-control.js` and `./network.js` exist for; a
 * predicate for a case no device produces would be one no test could pin. Capture one
 * beside that fixture if a device ever does.
 */

/** The four ASCII bytes of the box that must come first — the container's own header. */
const FTYP = 'ftyp';

/** The four ASCII bytes of the index box, which a recorder writes only as it exits. */
const MOOV = 'moov';

/** Every top-level box header is `size:uint32` then `type:4 chars` (ISO/IEC 14496-12 §4.2). */
const BOX_HEADER_BYTES = 8;

/** `size === 1` means the real length is a `uint64` in the eight bytes after the header. */
const EXTENDED_SIZE_MARKER = 1;

/** How long a header plus its 64-bit extended size is. */
const EXTENDED_HEADER_BYTES = 16;

/**
 * Whether `pidof` says a recorder is still running on the device.
 *
 * `pidof screenrecord` prints one bare pid and a newline while a recording is in flight
 * (`tests/fixtures/adb/screenrecord-pidof.running.api37-….txt`, `29633\n`) and **nothing at
 * all** once it has exited — where it also exits 1, which is why the backend runs it with a
 * `|| true` rather than letting a perfectly ordinary "no such process" reach `../adb.js` as
 * a command failure.
 *
 * So the predicate is on the *output*, not on the exit code: any non-blank text is a
 * recorder. It deliberately does not parse the pids — several would mean several recorders,
 * which is the same answer, and matching on a particular one would mean matching on a pid
 * this code never learned.
 */
export function isRecorderRunning(stdout: string): boolean {
	return stdout.trim().length > 0;
}

/**
 * The pids `pidof` named, for a wait's `found` — the half of a timeout that makes it
 * actionable (`src/core/wait.ts`, `Observation`).
 *
 * `pidof` separates several with spaces, so the whitespace split is the format rather than
 * a guess about it.
 */
export function recorderPids(stdout: string): string[] {
	return stdout.trim().split(/\s+/).filter(Boolean);
}

/**
 * Whether these bytes are a **finished** recording: the container header first, and the
 * index box present.
 *
 * This is the check the whole verb exists for. A recorder writes the index box last, so a
 * file copied while it is still running has the header, a reserved gap where the index will
 * go, and a payload box claiming a nonsense length — measured on API 37 and committed as
 * `tests/fixtures/adb/screenrecord.unfinished.api37-….mp4`: `ftyp`, `free`, then `mdat` with
 * a 64-bit size of 4557430888798830399 over a 3232-byte file. The finished capture beside it
 * is `ftyp`, `moov`, `free`, `mdat`. Neither the byte count nor the exit code separates
 * those two; the presence of `moov` does.
 *
 * The walk is over **top-level boxes only** — it never descends, because nothing here needs
 * to know what is inside one, and a walk that descended would be a parser for a format this
 * backend has no business decoding.
 *
 * It deliberately judges **nothing else**, the stance `./screencap.js`'s `isPng` takes: a
 * valid recording of a black screen, of a static screen, or of one second rather than five
 * is a true answer about the device and passes here.
 *
 * Every exit is bounded. A zero or negative advance, a length that runs past the end, and a
 * box header that does not fit all answer `false` rather than looping — a `size === 0` box
 * means "to the end of the file" in the format, and a file whose last box is that and is not
 * `moov` has no index either way.
 */
export function isFinishedRecording(bytes: Uint8Array): boolean {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 0;
	let first = true;

	while (offset + BOX_HEADER_BYTES <= bytes.byteLength) {
		const type = boxTypeAt(bytes, offset);

		// The container header has to be the first box. Bytes that start with anything else are
		// not a recording at all — a PNG, an error message, or a stream that came back mangled.
		if (first && type !== FTYP) return false;
		first = false;

		if (type === MOOV) return true;

		const size = boxLengthAt(view, offset);
		// `null` is a box this walk cannot step over: a length that is malformed, one that means
		// "to the end of the file", or one that runs past the bytes there are. There is no `moov`
		// still to come in any of the three.
		if (size === null) return false;

		offset += size;
	}

	return false;
}

/**
 * How many bytes the box at `offset` occupies, or `null` when there is no next box to walk
 * to.
 *
 * The 64-bit extended form is compared as a `bigint` rather than converted first: `Number`
 * on a value the size of the garbage length an unfinished recording carries is imprecise,
 * and the answer here is "stop" either way.
 */
function boxLengthAt(view: DataView, offset: number): number | null {
	const declared = view.getUint32(offset);
	if (declared !== EXTENDED_SIZE_MARKER) {
		// `size === 0` is "to the end of the file", so nothing follows it; anything else below a
		// header's length is malformed.
		return declared < BOX_HEADER_BYTES ? null : declared;
	}

	if (offset + EXTENDED_HEADER_BYTES > view.byteLength) return null;
	const extended = view.getBigUint64(offset + BOX_HEADER_BYTES);
	if (extended < BigInt(EXTENDED_HEADER_BYTES) || extended > BigInt(view.byteLength)) return null;
	return Number(extended);
}

/** The four ASCII characters of the box type at `offset`. */
function boxTypeAt(bytes: Uint8Array, offset: number): string {
	return String.fromCharCode(
		bytes[offset + 4] ?? 0,
		bytes[offset + 5] ?? 0,
		bytes[offset + 6] ?? 0,
		bytes[offset + 7] ?? 0,
	);
}
