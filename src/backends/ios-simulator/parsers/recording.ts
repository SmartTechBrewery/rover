/**
 * What a recording on this platform looks like — the three questions the recorder asks that are
 * about *text and bytes* rather than about a process.
 *
 * It lives beside the other parsers for `./png.js`'s reason: `../simctl.js` owns the process and
 * `../backend.ts` is the join between the two, so knowledge of what the tool's output *is*
 * belongs on this side and can be tested without a process and without a simulator.
 * `../android/parsers/screenrecord.ts` is the counterpart, and holds the same three shapes for
 * the same three callers.
 *
 * **The one thing that is genuinely different here is where the recorder lives.** `screenrecord`
 * runs on the device, so `pidof` on the device answers "is this device recording"; `simctl io
 * recordVideo` runs on the **host**, so this host's own process table is that answer
 * ({@link recorderPids}). Everything else — the start marker, the finished container — is the
 * same pair of questions with this tool's answers.
 *
 * Every predicate here is pinned against a capture taken from a real simulator on
 * macOS 26.6.2 (25G83) / Xcode 26.6 (17F113) / iOS 26.5 (23F77), 2026-09-08
 * (`tests/fixtures/ios-simulator/README.md`).
 */

/**
 * The line `simctl` writes to **stderr** once the first video frame has been processed — the
 * only thing that says a recording is running.
 *
 * Its own usage text names it: *"simctl writes 'Recording started' to stderr once the first video
 * frame has been processed. Look for this if you want to wait for the recording to start."*
 * Measured on the bench above: it arrived at **0.14–0.23 s** across the runs here.
 *
 * **Matching this line specifically is the whole point, and "anything on stderr" would be
 * wrong.** An ordinary *successful* run prints `Note: No display specified. Defaulting to
 * display: … (screenID: 1, name: LCD)` first, at ~0.12 s — before any frame exists
 * (`tests/fixtures/ios-simulator/recordvideo.stderr.xcode26.6-ios26.5.txt` is both lines in the
 * order they arrive). A wait that resolved on the first byte of stderr would return while the
 * recorder had not begun, which is the failure `startRecording`'s contract is written against.
 */
const RECORDING_STARTED = 'Recording started';

/** The four ASCII bytes of the box that must come first — the container's own header. */
const FTYP = 'ftyp';

/** The four ASCII bytes of the index box, without which no player will open the file. */
const MOOV = 'moov';

/** Every top-level box header is `size:uint32` then `type:4 chars` (ISO/IEC 14496-12 §4.2). */
const BOX_HEADER_BYTES = 8;

/** `size === 1` means the real length is a `uint64` in the eight bytes after the header. */
const EXTENDED_SIZE_MARKER = 1;

/** How long a header plus its 64-bit extended size is. */
const EXTENDED_HEADER_BYTES = 16;

/** The subcommand, the operation and the program, in the order a recorder's argv carries them. */
const IO_SUBCOMMAND = 'io';
const RECORD_VIDEO_OPERATION = 'recordVideo';
const SIMCTL_PROGRAM = 'simctl';

/**
 * Whether this stderr says the recorder has started.
 *
 * A `includes` on {@link RECORDING_STARTED} rather than a line-anchored match, because the
 * caller hands over whatever has arrived so far and a chunk boundary can fall anywhere: the
 * marker is checked against the *accumulated* stream, where it may sit at the end of a partial
 * line the next chunk completes. The string is distinctive enough that a substring rule costs
 * nothing — nothing else this tool writes contains it.
 */
export function saysRecordingStarted(stderr: string): boolean {
	return stderr.includes(RECORDING_STARTED);
}

/**
 * The pids of every `simctl io <udid> recordVideo` this host is running for **this** udid, empty
 * when there is none.
 *
 * This is the answer to "is this device recording", and it is asked of the machine at the moment
 * it matters rather than remembered (D6, `ai/RULES.md` §2). The recorder is a host process, so
 * the host's process table is the device's answer — which is what survives a daemon restart and
 * what sees a recorder some other program on this Mac started. It answers pids rather than a
 * boolean so a refusal and a wait's `found` can both name them, exactly as
 * `../../android/parsers/screenrecord.ts` does.
 *
 * `table` is `ps -A -o pid=,command=`: one process per line, the pid then the command line. **One
 * process really is one line** — `ps` escapes a newline inside an argv as `\012`, measured on the
 * bench above against a process deliberately given one — so splitting on newlines cannot merge or
 * split a process.
 *
 * **Two rules have to hold, and the second one is not belt and braces.**
 *
 * 1. The token sequence `io <udid> recordVideo` appears, as whole tokens. That is what makes the
 *    match *this* device's rather than any recorder's: the udid is the pin, and matching
 *    `recordVideo` alone would stop a recording somebody else's lease is holding open.
 * 2. The **program** is `simctl` — the basename of the command's first token. Without this the
 *    scan matches any process whose argv merely quotes the command, and that is not
 *    hypothetical: while this was being measured it matched the agent's own shell, whose
 *    arguments contained a script discussing exactly this command line, and it would then have
 *    had a `SIGINT` sent to it. The capture
 *    (`tests/fixtures/ios-simulator/recordvideo-ps.recording.xcode26.6.txt`) holds one real
 *    recorder and one deliberate near miss for that reason.
 *
 * **The program is compared by basename and never by path**, which is measured rather than
 * fastidious: `<developer-dir>/usr/bin/simctl` is a bash shim that `exec`s
 * `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/…/bin/simctl`, so the running
 * process reports the *CoreSimulator* path even though this backend spawned the Xcode one — and
 * `exec` keeps the pid, so the pid this host spawned is the pid in the table. A path comparison
 * against what was spawned would therefore match nothing at all.
 */
export function recorderPids(table: string, udid: string): string[] {
	const pids: string[] = [];

	for (const line of table.split('\n')) {
		const entry = splitEntry(line);
		if (entry === null) continue;
		if (!isSimctl(entry.command)) continue;
		if (!recordsFor(entry.command, udid)) continue;
		pids.push(entry.pid);
	}

	return pids;
}

/** `<pid> <command line>`, or `null` for a line that is not one — the header and the blank end. */
function splitEntry(line: string): { pid: string; command: string } | null {
	const trimmed = line.trim();
	const space = trimmed.indexOf(' ');
	if (space === -1) return null;

	const pid = trimmed.slice(0, space);
	if (!/^\d+$/.test(pid)) return null;

	return { pid, command: trimmed.slice(space + 1).trimStart() };
}

/** Whether the program this command line ran is `simctl` — see {@link recorderPids}. */
function isSimctl(command: string): boolean {
	const program = command.split(' ')[0] ?? '';
	return program === SIMCTL_PROGRAM || program.endsWith(`/${SIMCTL_PROGRAM}`);
}

/**
 * Whether these arguments record *this* udid: `io`, the udid and `recordVideo`, adjacent and in
 * that order.
 *
 * Compared as whole tokens rather than as a substring of the line, `../simctl.js`'s
 * `quoteArgv` rule and for its reason: an argv entry either *is* the udid or it is not, and a
 * substring rule would also match a path that happened to contain one.
 */
function recordsFor(command: string, udid: string): boolean {
	const tokens = command.split(' ').filter((token) => token.length > 0);

	return tokens.some(
		(token, index) =>
			token === IO_SUBCOMMAND &&
			tokens[index + 1] === udid &&
			tokens[index + 2] === RECORD_VIDEO_OPERATION,
	);
}

/**
 * Whether these bytes are a **finished** recording: the container header first, and the index box
 * present.
 *
 * `../../android/parsers/screenrecord.ts` holds the same walk over the same box format, and the
 * duplication is deliberate for the reason `src/verbs/recording-container.ts` states about its
 * own copy: what a container declares is a property of the file format rather than of any one
 * platform, and one backend reaching into another's folder is what `ai/RULES.md` §2 forbids. The
 * ~8 bytes of box header are cheaper duplicated than a shared module that couples two backends.
 *
 * **What this platform's two shapes actually are, measured on the bench above:**
 *
 * - a recorder given `SIGINT` writes `ftyp` (brand `qt  `) → `moov` → `wide` → `mdat` and exits
 *   0, i.e. `ftyp` first and `moov` **before** `mdat`
 *   (`tests/fixtures/ios-simulator/recordvideo.finished.xcode26.6-ios26.5.mov`, 100,782 bytes for
 *   ~2 s of an idle screen);
 * - a recording that did not finish is **zero bytes**, not a headerless container. `simctl`
 *   buffers and writes the whole file at the end — `Recording completed. Writing to disk.` on
 *   stdout is the moment it happens — so a recorder that was killed, or one that ran against a
 *   device that was not booted, leaves a file that is really there and holds nothing.
 *
 * So this check is not looking for the Android trap of an index written late; on this platform
 * the file is either whole or empty. It is the same check anyway, because it is the honest one:
 * what the caller may be handed is a file a player will open, and the presence of `moov` is what
 * says so whatever produced the bytes. A partial flush nobody has captured yet fails it too.
 *
 * It deliberately judges **nothing else**, `isPng`'s stance in `./png.ts`: a valid recording of a
 * still screen, of a black screen, or of a quarter of a second is a true answer about the device
 * and passes here. What a recording *holds* is `src/verbs/recording-container.ts`'s question, and
 * it reads this container — the committed capture parses as one sample declaring 2,042 ms.
 *
 * Every exit is bounded. A zero or negative advance, a length that runs past the end, and a box
 * header that does not fit all answer `false` rather than looping — a `size === 0` box means "to
 * the end of the file" in the format, and a file whose last box is that and is not `moov` has no
 * index either way.
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
 * How many bytes the box at `offset` occupies, or `null` when there is no next box to walk to.
 *
 * The 64-bit extended form is compared as a `bigint` rather than converted first: `Number` on a
 * value the size of a malformed length is imprecise, and the answer here is "stop" either way.
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
