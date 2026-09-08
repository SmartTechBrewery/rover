/**
 * The `simctl` process runner every method of this backend goes through.
 *
 * The split with `./parsers/` is the one `../android/adb.ts` describes and both halves depend
 * on it: the parsers own the text and are pinned against output captured from a real
 * simulator, this owns the process — argv, the timeout, the exit code and the two streams.
 * That is what lets the parsers be tested without a process and this be tested without a
 * simulator.
 *
 * **`simctl` is executed directly, never through `xcrun`.** Measured on macOS 26.6.2 (25G83)
 * / Xcode 26.4.1 (17E202), 2026-09-08: `env -u DEVELOPER_DIR
 * /Applications/Xcode.app/Contents/Developer/usr/bin/simctl list -j devices runtimes` answered
 * the full JSON at exit 0, so the shim buys nothing. What it would cost is the point —
 * `xcrun` performs **its own** search for the utility, and that search can disagree with the
 * one `./developer-dir.ts` has already made and verified. `docs/IOS.md` §1 is that
 * disagreement written down: on a machine whose `xcode-select` points at
 * `/Library/Developer/CommandLineTools`, `xcrun simctl` fails outright with *"unable to find
 * utility simctl"* while the Xcode beside it holds a perfectly good one. Which `simctl` runs
 * is `./developer-dir.ts`'s answer and nothing else's.
 *
 * **Resolved per call and unmemoised**, which is `./developer-dir.ts`'s own documented stance:
 * that search is `stat`/`access`/`readlink` and **no process**, so re-running it costs a
 * handful of syscalls. Should a caller ever need the answer held, the shape is
 * `../android/adb-path.ts`'s `adbExecutable()` — a **success-only** memo, because memoising
 * the failure makes the first attempt of a daemon's life the only one.
 *
 * **The exit code carries no meaning here**, so nothing maps it. Three subcommands produced
 * three different numbers on the bench above: `launch <bogus-udid> com.example.nope` exited
 * **148** with `Invalid device: …` on stderr, `nonsense` exited **1** with `Unrecognized
 * subcommand: nonsense` on stderr **and its whole usage text on stdout**, and `terminate
 * <booted> com.rover.nope` exited **3** with six lines of `NSPOSIXErrorDomain … found nothing
 * to terminate`. A table built from three samples is a table that lies, so
 * {@link SimctlCommandError} surfaces the number and both streams together and attaches no
 * interpretation — and it carries both streams because the second of those failures puts the
 * useful half on stdout ("a non-zero exit is data", ai/CODING_STANDARDS.md).
 *
 * **`stderr` is not silence, and no rule here may assume it is.** An ordinary *successful*
 * `simctl io <device> screenshot <path>` prefixes its run with `Detected file type from
 * extension: PNG` and `Note: No display specified. Defaulting to display: … (screenID: 1,
 * name: LCD)` on stderr (same bench). Anything downstream that reads "wrote to stderr" as
 * "failed" would be wrong on this platform on the happy path.
 *
 * There is deliberately **no argument quoter** here, which is the other thing that does not
 * transfer from `../android/adb.ts`: `adb shell` joins its arguments and hands the string to a
 * shell *on the device*, so `shellArg`/`shellText` exist to protect that shell. `simctl` takes
 * argv entries, and `execFile` protects this host's. What *does* transfer is the **masking** of
 * a host path on its way into a failure message, which is a different question with a different
 * answer — {@link RunSimctlOptions.redactArgv}.
 *
 * **There are two runners here now, and the second one has no timeout on purpose**
 * ({@link streamSimctlOnDevice}): a recording is *supposed* to stay open, so the bound that
 * stops a hung query from wedging a lease would guarantee the failure instead. Same split as
 * `../android/adb.ts`'s `execFile`-and-`spawn` pair, and for the same reason — a query is a
 * buffer and an exit code, a recorder is a process whose output only means anything while it is
 * arriving.
 *
 * **And one thing this module runs that is not `simctl` at all**: `ps`
 * ({@link readProcessTable}). It belongs here rather than beside the parsers because this module
 * is the one that owns *processes* for this backend, and on this platform the recorder **is** a
 * host process — so "start one" and "is one still running" are two questions about the same
 * subject, and separating them would put half of it in a module named after the tool it does not
 * run. Reading the answer out of what `ps` printed is `./parsers/recording.ts`'s, exactly as
 * every other line this tool writes is a parser's.
 */

import { type ChildProcess, type ExecFileException, execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { type DeviceSerial, unwrap } from '../../core/ids.js';
import { resolveDeveloperDir, SIMCTL_RELATIVE_PATH } from './developer-dir.js';

/** The program, named the way a failure message should name it — never by the path it ran from. */
const SIMCTL = 'simctl';

/**
 * Every external invocation has a timeout (ai/CODING_STANDARDS.md) — a hung `simctl` with no
 * timeout wedges a lease until it expires. Callers that know they are slower say so.
 *
 * `simctl list -j devices runtimes` took **0.11–0.20 s** across the runs on this module's bench
 * (0.10–0.76 s on `docs/IOS.md`'s), so this is deliberately generous rather than tuned, for
 * `DEFAULT_ADB_TIMEOUT_MS`'s stated reason: it exists to stop a wedged process holding a lease
 * forever, not to bound a slow but healthy query. The calls that are *not* queries — the
 * install, the capture, the transfers, the recorder — bring their own budget with the
 * measurement it was set from, beside the call that needs it.
 */
export const DEFAULT_SIMCTL_TIMEOUT_MS = 10_000;

/**
 * The all-listings capture came back as **115 KB** for 22 devices and 124 device types
 * (`tests/fixtures/ios-simulator/simctl-list.xcode26.4.1-ios26.4.1.json`) and Node's default
 * `maxBuffer` is 1 MB — nine times that, so not alarming, and close enough on a host carrying
 * several runtimes that the headroom should be a decision rather than a default nobody chose.
 * An overflow is not a graceful truncation either: the child is killed and the answer is lost.
 */
export const SIMCTL_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * The one call here that is nothing like a query: `simctl install` copies a whole bundle into
 * the device's container and then has the runtime register it.
 *
 * Measured on macOS 26.6.2 (25G83) / Xcode 26.4.1 (17E202), 2026-09-08: **5.2 s** for the
 * first install of a freshly built `.app`, and **0.3 s** for the reinstall half of an
 * uninstall-and-install round trip on the same bundle; `docs/IOS.md` §2 has 2.7–3.8 s first
 * and 0.3 s on a reinstall from a different bench. Every one of those is already at or past
 * {@link DEFAULT_SIMCTL_TIMEOUT_MS}'s half, on a small bundle and an idle host — a real
 * application's is orders of magnitude larger.
 *
 * So this is deliberately generous rather than tuned, for `INSTALL_ADB_TIMEOUT_MS`'s stated
 * reason and matching its number: it exists to stop a wedged `simctl` holding a lease forever,
 * not to bound a slow but healthy install. Named and passed at the call site rather than
 * raised as the default, because every other call this backend makes is a query.
 */
export const INSTALL_SIMCTL_TIMEOUT_MS = 5 * 60_000;

/**
 * The budget for one capture, and the one number in this module whose *upper* bound is worth as
 * much as its size.
 *
 * Measured on macOS 26.6.2 (25G83) / Xcode 26.4.1 (17E202), 2026-09-08, against a booted
 * iPhone 17: `simctl io <device> screenshot --type png --mask ignored <path>` wrote its 2.8 MB
 * PNG in **0.22–0.29 s**. So this is generous rather than tuned, for
 * {@link INSTALL_SIMCTL_TIMEOUT_MS}'s stated reason — it exists to stop a wedged capture
 * holding a lease forever, not to bound a slow but healthy one on a screen bigger than that
 * device's.
 *
 * **It also sits below the tool's own wait**, which is the half a tighter number would not buy.
 * Against a `Shutdown` device the same command blocked for **60.68 s** before failing with
 * *"Timeout waiting for screen surfaces"* (same bench, `docs/IOS.md` §8 trap 1). The device's
 * state is checked before the capture (`./backend.ts`), so that wait is only reachable when the
 * device went down between the two calls — and when it is, this is what makes it cost half a
 * minute rather than a whole one.
 */
export const SCREENSHOT_SIMCTL_TIMEOUT_MS = 30_000;

/**
 * The headroom for the one read whose answer is a payload rather than a listing: the device's
 * own system log, serialised as NDJSON.
 *
 * Measured on the bench above against the same booted iPhone 17, with nothing on it but the
 * operator's own session: `simctl spawn <device> log show --style ndjson --info --debug --last
 * 60s` came back as **5.0 MB** (3,998 entries) across a quiet minute and **11.3–11.9 MB**
 * (9,166–9,669 entries) across a minute in which this bench was itself reading logs in a loop.
 * The second of those is already past {@link SIMCTL_MAX_BUFFER_BYTES}, on an *idle* simulator,
 * which is the whole argument for a number of its own: what `./backend.ts` pushes down is a
 * window, which bounds a duration and not a size, and an application under test says several
 * times more per second than a SpringBoard does.
 *
 * `maxBuffer` is a ceiling rather than an allocation, so a generous one costs nothing until the
 * bytes arrive — while an overflow is not a graceful truncation: the child is killed and the
 * answer is lost. Set well clear of the largest plausible read rather than close to the measured
 * one, which is `../android/adb.ts`'s `ADB_BINARY_MAX_BUFFER_BYTES`' reasoning and its number.
 */
export const READ_LOGS_SIMCTL_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * How long a recorder is given to say it has started, before the wait on that marker gives up.
 *
 * Measured on macOS 26.6.2 (25G83) / Xcode 26.6 (17F113) against a booted iPhone 17, 2026-09-08:
 * `Recording started` reached stderr at **0.14–0.23 s** across the runs here, behind a
 * `Note: No display specified…` line at ~0.12 s. `docs/IOS.md` §2 measured 0.21 s on its own
 * bench. So this is generous rather than tuned, for {@link INSTALL_SIMCTL_TIMEOUT_MS}'s stated
 * reason: it exists to stop a recorder that will never start holding a lease, not to bound a
 * slow but healthy one on a busy host.
 *
 * **It is also the only bound on the one failure the marker cannot rule out.** A recorder given a
 * device that is not `Booted` prints the marker anyway and then runs forever writing nothing
 * (`./backend.ts`, `recordVideo`), so the state check in front of the recording is what catches
 * that — and this is what catches a device that went down in the gap between the two.
 *
 * The same number as `../android/adb.ts`'s `RECORDING_START_TIMEOUT_MS`, deliberately: the two
 * platforms answer the same question with different evidence, and a caller that has to reason
 * about how long "start a recording" may take should not have to learn two numbers.
 */
export const RECORDING_START_TIMEOUT_MS = 10_000;

/**
 * How long a signalled recorder is given to be gone, before the wait on the process table gives
 * up.
 *
 * Measured on the bench above: after `SIGINT` the recorder wrote `Recording completed. Writing to
 * disk.` and `Wrote video to: …` to stdout and exited **0 within 20–30 ms**, with `ps` no longer
 * naming it on the **first** probe 39 ms later. That is unlike the Android side, where `pidof`
 * went on naming `screenrecord` for another 0.265 s — here the file is written *before* the
 * process goes, so the process being gone is the file being whole.
 *
 * Generous against those numbers, and for the same reason as everything else here: a recorder
 * finalising a long capture of a busy screen has megabytes to flush, and this exists to stop one
 * that will not go away at all.
 */
export const RECORDING_FINISH_TIMEOUT_MS = 10_000;

/**
 * The program this module asks about the recorders it started, and the arguments that make its
 * answer parseable.
 *
 * By absolute path rather than by name, because this is the one place a `PATH` a caller controls
 * would change *which* program answers a question this host acts on — and what it acts on is a
 * `SIGINT` to a pid. `-A` for every process rather than this session's, because a recorder
 * started by an earlier daemon is exactly the one the lease-end teardown has to find; `pid=`
 * and `command=` with the trailing `=` so there is no header row to skip, and `command=` last
 * because it is the field that contains spaces.
 */
const PROCESS_TABLE = '/bin/ps';
const PROCESS_TABLE_ARGV = ['-A', '-o', 'pid=,command='] as const;

/**
 * What bounds one {@link readProcessTable}.
 *
 * Tighter than {@link DEFAULT_SIMCTL_TIMEOUT_MS} because this is not a query against a
 * simulator: `ps -A -o pid=,command=` is a walk of the kernel's own process list and took
 * **0.03–0.04 s** on this bench with ~700 processes on the host. It is asked before every
 * recording and after every signal, so a bound in the same order as the calls it guards is what
 * keeps a wedged `ps` from being indistinguishable from a recorder that will not stop.
 */
const PROCESS_TABLE_TIMEOUT_MS = 5_000;

/**
 * The one device selector `simctl` accepts that is not a device, **lowercased**.
 *
 * Refused by {@link runSimctlOnDevice} — see its own note. `simctl help`, quoted verbatim: *"or
 * the special "booted" string which will cause simctl to pick a booted device. If multiple
 * devices are booted when the "booted" device is selected, simctl will choose one of them."*
 *
 * **The tool's own match is case-insensitive, so the comparison against this constant is too.**
 * Measured on Xcode 26.4.1 with one device booted: `terminate BOOTED com.rover.nope` and
 * `terminate Booted com.rover.nope` both resolved that device and answered exit **3**, `found
 * nothing to terminate` — the same answer as lowercase `booted` — while the near-miss
 * `terminate bootedx com.rover.nope` answered exit **148**, `Invalid device: bootedx`. With no
 * device booted the three casings answer exit 148, `No devices are booted.`, which is again a
 * different message from `Invalid device:`. Either way the casing is not what decides it: every
 * spelling of the word is the selector (`docs/IOS.md` §2).
 */
const BOOTED_SELECTOR = 'booted';

/** The two streams of a successful run, kept separate — see {@link SimctlCommandError}. */
export interface SimctlResult {
	readonly stdout: string;
	readonly stderr: string;
}

export interface RunSimctlOptions {
	/** Overrides {@link DEFAULT_SIMCTL_TIMEOUT_MS} for one call. */
	readonly timeoutMs?: number;

	/**
	 * Overrides {@link SIMCTL_MAX_BUFFER_BYTES} for one call — for a call whose answer is a
	 * payload rather than a listing, which today is the log read alone
	 * ({@link READ_LOGS_SIMCTL_MAX_BUFFER_BYTES}).
	 *
	 * A knob of its own rather than one raised default, because every other call this backend
	 * makes is a listing measured in kilobytes, and because the failure it prevents reads as a
	 * different one: an overflow sets `killed` exactly as a timeout does, and
	 * {@link SimctlCommandError} tells the two apart by the code rather than by the budget that
	 * was exceeded.
	 */
	readonly maxBufferBytes?: number;

	/**
	 * argv entries that must not appear in {@link SimctlCommandError}'s **message**.
	 *
	 * For the one class of argument that is a path on *this host*: the package a caller sent,
	 * which the daemon wrote to a temporary file of its own (`src/daemon/verb-handlers.ts`) and
	 * deletes moments later. A `SimctlCommandError` becomes the text of an `internal_error`
	 * response (`src/ipc/server.ts`) read on the agent's machine — possibly another machine
	 * entirely — where a `/var/folders/…` path this host already removed names nothing anyone
	 * can act on (D19, PROJECT.md §4).
	 *
	 * **Masked in the argv *and* in the captured streams**, because `simctl` writes the path it
	 * was given back out itself: measured on Xcode 26.4.1, 2026-09-08, `install <device>
	 * /tmp/nope.app` exits 2 with `lstat of /tmp/nope.app failed: No such file or directory` on
	 * stderr. Masking only the argv would leave the same string in the message two lines
	 * further down.
	 *
	 * The argv is matched as whole entries and the streams as substrings, which is
	 * `../android/adb.ts`'s split and for its reasons — see {@link quoteStream}.
	 *
	 * {@link SimctlCommandError.argv}, {@link SimctlCommandError.stdout} and
	 * {@link SimctlCommandError.stderr} all keep the real values: they never cross the
	 * boundary, and this host's own log is exactly where the staged path is worth having.
	 */
	readonly redactArgv?: readonly string[];
}

/**
 * A run that did not exit 0.
 *
 * Carries stdout, stderr, the argv and the exit code together, because "a non-zero exit is
 * data" (ai/CODING_STANDARDS.md) and because on this tool the useful half is as often on stdout
 * as on stderr — an unrecognised subcommand prints its usage text there and nothing but the one
 * line of complaint on stderr (module header). The streams stay separate rather than being
 * merged for the same reason: a successful `simctl io` writes an informational note to stderr,
 * so merging would corrupt one stream with the other's chatter.
 *
 * **The program is named by its bare name**, never by the path it was resolved to. This message
 * becomes the text of an `internal_error` response read on the caller's machine — possibly
 * another machine entirely (D19) — where this host's Xcode layout names nothing anyone can act
 * on. The failure that *is* about the search says so in full, and that one is
 * `SimctlNotFoundError` in `./developer-dir.ts`.
 *
 * For the same reason the message masks whatever {@link RunSimctlOptions.redactArgv} named,
 * while {@link argv}, {@link stdout} and {@link stderr} keep the real values for this host's
 * own log.
 */
export class SimctlCommandError extends Error {
	readonly argv: readonly string[];
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	/**
	 * The answer outgrew {@link RunSimctlOptions.maxBufferBytes} and the child was killed for it.
	 *
	 * A field rather than something a caller matches out of {@link message}, because it is the one
	 * failure here a caller can *act* on rather than only report: it says the command was fine and
	 * the answer was too large, so a caller reading in widening windows can keep the narrower
	 * answer it already has instead of failing the verb (`readLogs` in `./backend.ts` is that
	 * caller). Matching on the message would tie that decision to Node's wording, and the
	 * message is also the one thing here that crosses the boundary and gets masked.
	 *
	 * Told apart from {@link timedOut} by the same `code` the constructor already reads: both
	 * arrive as `killed`, and they call for opposite responses — a narrower window fixes this one
	 * and does nothing for a wedged simulator.
	 */
	readonly overflowedBuffer: boolean;

	constructor(
		argv: readonly string[],
		timeoutMs: number,
		error: ExecFileException,
		stdout: string,
		stderr: string,
		redactArgv: readonly string[] = [],
	) {
		const exitCode = typeof error.code === 'number' ? error.code : null;
		const overflowedBuffer = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
		// `killed` is also set when `maxBuffer` overflows, and that is not a timeout: reporting it
		// as one sends the next reader looking for a slow simulator instead of a large answer.
		const timedOut = error.killed === true && !overflowedBuffer;
		const signal = error.signal ?? null;

		super(
			[
				`${SIMCTL} ${quoteArgv(argv, redactArgv)} ${outcome({ error, exitCode, overflowedBuffer, signal, timedOut, timeoutMs })}`,
				`stdout: ${quoteStream(stdout, redactArgv)}`,
				`stderr: ${quoteStream(stderr, redactArgv)}`,
			].join('\n'),
		);

		this.name = 'SimctlCommandError';
		this.argv = argv;
		this.exitCode = exitCode;
		this.signal = signal;
		this.stdout = stdout;
		this.stderr = stderr;
		this.timedOut = timedOut;
		this.overflowedBuffer = overflowedBuffer;
	}
}

function outcome(failure: {
	error: ExecFileException;
	exitCode: number | null;
	overflowedBuffer: boolean;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	timeoutMs: number;
}): string {
	if (failure.timedOut) return `timed out after ${failure.timeoutMs}ms`;
	// Ahead of the exit code and the signal, because both are misleading here: the child was
	// killed, so it reports one or the other, and neither is what went wrong. Node's own message
	// ("stdout maxBuffer length exceeded") would otherwise arrive through the branch below, which
	// says `failed to run` — the one thing that did not happen.
	if (failure.overflowedBuffer) return 'said more than its buffer holds and was killed for it';
	if (failure.exitCode !== null) return `exited ${failure.exitCode}`;
	if (failure.signal !== null) return `was killed by ${failure.signal}`;
	// Nothing ran at all — the file the search settled on having moved since is the case here,
	// and its own message is the only thing that says so.
	return `failed to run: ${failure.error.message}`;
}

/**
 * The command as it may be read on the caller's machine.
 *
 * Everything `simctl` was given, in order, with the host-local paths in `redact` replaced by
 * {@link REDACTED_ARGV}. Whole entries are compared rather than substrings of the joined line:
 * an argv entry either *is* the path this host made up or it is the caller's own value, and a
 * substring rule would also mask a device path that happened to share a prefix with it.
 */
function quoteArgv(argv: readonly string[], redact: readonly string[]): string {
	return argv.map((entry) => (redact.includes(entry) ? REDACTED_ARGV : entry)).join(' ');
}

/**
 * What a host path reads as once it has crossed the boundary, in an argv or in a stream.
 *
 * Says what was there rather than eliding it, so a failure message stays a sentence: the caller
 * sent bytes and this host wrote them somewhere of its own choosing, which is the whole fact the
 * path was carrying.
 */
const REDACTED_ARGV = '<the file you sent>';

/**
 * One captured stream, ready to be read inside an error message.
 *
 * Exported because {@link SimctlCommandError} will not be the only failure worth quoting: this
 * tool reports plenty while exiting 0, and those are caught a layer out. One definition so no
 * two messages disagree about what an empty stream looks like — or about how a host path reads
 * once it has crossed the boundary, which is what `redact` is for.
 *
 * **`redact` is a substring rule here where {@link quoteArgv}'s is a whole-entry rule**, and the
 * asymmetry is the difference between the two subjects, exactly as in `../android/adb.ts`. An
 * argv entry either *is* the path this host made up or it is the caller's own value. A stream is
 * a sentence `simctl` wrote with the path embedded in it — `lstat of <host path> failed: No such
 * file or directory` (measured on Xcode 26.4.1, 2026-09-08) — so nothing but a substring rule
 * reaches it. That is safe because the tool echoes the path byte for byte as it was given, and
 * because the only values ever passed here are paths this host invented moments earlier.
 *
 * **Bounded at {@link QUOTED_STREAM_MAX_CHARS}, and it says what it dropped.** One of these
 * streams is a log read's own payload, and quoting a killed one whole is tens of megabytes of
 * `Error.message` — that constant carries the measurement.
 */
export function quoteStream(stream: string, redact: readonly string[] = []): string {
	const kept = quotable(stream);
	const masked = redact.reduce(
		(text, path) => (path.length === 0 ? text : text.replaceAll(path, REDACTED_ARGV)),
		kept,
	);
	const text = masked.trimEnd();
	const dropped = stream.length - kept.length;

	if (dropped === 0) return text.length === 0 ? '(empty)' : text;
	const note = `(${dropped} more characters, dropped)`;
	return text.length === 0 ? `(${dropped} characters, not quoted)` : `${text}\n${note}`;
}

/**
 * How much of a captured stream ends up inside a message.
 *
 * Bounded because one of these streams is a payload rather than a complaint: the log read is
 * given {@link READ_LOGS_SIMCTL_MAX_BUFFER_BYTES} to fill, and a read that overflows it hands
 * the runner back everything it had managed to buffer. Quoting that unbounded put ~64 MB into an
 * `Error.message` that then travels the daemon's error path to another machine (D19) — measured
 * at 67,108,185 characters, which was itself enough to take a test worker down serialising it.
 * What a reader needs is the first few lines and the size, and this is the first half of that.
 *
 * The head rather than `../android/adb.ts`'s tail, because these two streams end differently: a
 * long-lived `adb` is quoted for *why it stopped*, while a stream this long got here by being
 * killed mid-sentence, so its last bytes explain nothing and its first ones say what it was.
 */
export const QUOTED_STREAM_MAX_CHARS = 4_096;

/**
 * The part of a long stream that is safe to quote: whole lines, up to the bound.
 *
 * Cut back to the last line break rather than at the character, because the bound falls wherever
 * it falls and a host path is masked by a substring rule ({@link quoteStream}) that no partial
 * copy of it would match. Dropping the incomplete line keeps the one guarantee that matters here
 * — nothing crosses the boundary that was not looked at whole — and a stream with no line break
 * inside the bound is quoted as its size alone for the same reason.
 *
 * The slice comes before the masking so that neither cost is paid on the whole stream.
 */
function quotable(stream: string): string {
	if (stream.length <= QUOTED_STREAM_MAX_CHARS) return stream;
	const head = stream.slice(0, QUOTED_STREAM_MAX_CHARS);
	return head.slice(0, head.lastIndexOf('\n') + 1);
}

/**
 * A binary payload, rendered for a message a human will read — {@link quoteStream}'s
 * counterpart, and `../android/adb.ts`'s `describeBytes` for the same reasons.
 *
 * Nothing in this module produces bytes, and it lives here anyway. What this platform's capture
 * comes back as is a file `simctl` wrote at a path of this backend's choosing, which
 * `./backend.ts` reads and then refuses if it is not an image — a failure one layer out, like
 * the exit-0 failures {@link quoteStream} is exported for, and one that gets read beside them.
 * One definition, so no two messages disagree about how a payload reads.
 *
 * Quoting the payload itself is not an option: it is megabytes and it is not text. What is
 * quoted is the two facts that identify it — how much came back, and what it starts with. The
 * leading bytes are the useful half, because a capture that arrived as an error message, as text
 * or not at all is told apart by exactly those.
 */
export function describeBytes(bytes: Uint8Array): string {
	if (bytes.length === 0) return '(empty)';
	const head = [...bytes.subarray(0, 8)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join(' ');
	return `(${bytes.length} bytes, starting ${head})`;
}

/**
 * Run `simctl <args>` and hand back both streams.
 *
 * Throws {@link SimctlCommandError} on a non-zero exit, a timeout, or a failure to start, and
 * `SimctlNotFoundError` when there was no `simctl` to run in the first place
 * (`./developer-dir.ts`). Note that plenty of `simctl` failures exit 0 and say so in their
 * output — those are the parsers' to catch, not this function's.
 *
 * The executable is resolved before the timeout starts running, so the budget below is the
 * command's own and not the command's plus whatever the search cost.
 */
export async function runSimctl(
	args: readonly string[],
	options: RunSimctlOptions = {},
): Promise<SimctlResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_SIMCTL_TIMEOUT_MS;
	const simctl = join(resolveDeveloperDir(), SIMCTL_RELATIVE_PATH);

	return new Promise<SimctlResult>((resolve, reject) => {
		execFile(
			simctl,
			[...args],
			{
				timeout: timeoutMs,
				maxBuffer: options.maxBufferBytes ?? SIMCTL_MAX_BUFFER_BYTES,
				encoding: 'utf8',
			},
			(error, stdout, stderr) => {
				if (error === null) {
					resolve({ stdout, stderr });
					return;
				}
				reject(new SimctlCommandError(args, timeoutMs, error, stdout, stderr, options.redactArgv));
			},
		);
	});
}

/**
 * The same, pinned to one device — the udid goes **immediately after the subcommand**.
 *
 * It exists so that no caller can forget the pin: an unpinned install landing on another
 * agent's device is the worst failure mode this tool has (PROJECT.md §2), and it looks like
 * success from both sides. Every method that acts on a device goes through here rather than
 * through {@link runSimctl}.
 *
 * The position is structural because the tool is regular about it: `install`, `launch`,
 * `terminate`, `uninstall`, `io`, `spawn`, `get_app_container`, `bootstatus`, `boot`,
 * `shutdown` and `erase` all take the device as their first non-option argument (`simctl help
 * <subcommand>`, Xcode 26.4.1). `launch` and `spawn` are the two that accept flags of their own
 * ahead of it, so a call needing one of those flags cannot use this function's shape — and
 * none of the calls this backend makes passes one.
 *
 * **The literal `booted` is refused in any casing**, which is two lines against the worst thing
 * this platform can do quietly: `simctl` answers a pinned-*looking* command on whichever booted
 * device it feels like, and reports success. The casing matters because the tool's match is
 * case-insensitive and measurably so, `BOOTED` and `Booted` being the selector every bit as
 * much as `booted` is (see {@link BOOTED_SELECTOR}) — a `===` here would have let exactly the
 * value it was written to catch through. No serial can be that string in any casing
 * today — every one comes out of the enumeration through `DeviceSerialSchema` — so this is a
 * tripwire rather than a live path, and it is worth its two lines exactly because it is the one
 * value that silently turns a pinned call into an unpinned one.
 */
export async function runSimctlOnDevice(
	serial: DeviceSerial,
	subcommand: string,
	args: readonly string[] = [],
	options: RunSimctlOptions = {},
): Promise<SimctlResult> {
	return runSimctl(pinnedArgv(serial, subcommand, args), options);
}

/**
 * `<subcommand> <udid> <args…>`, with the `booted` refusal — {@link runSimctlOnDevice}'s whole
 * body, extracted because {@link streamSimctlOnDevice} needs exactly the same guarantee.
 *
 * One place assembles a pinned argv, so the two runners cannot come to disagree about where the
 * udid goes or about which selector is refused. A recorder is the one long-lived call this
 * backend makes, and it is also the one where an unpinned command would be least visible: it
 * records somebody else's screen and hands the bytes over as though they were this device's.
 */
function pinnedArgv(
	serial: DeviceSerial,
	subcommand: string,
	args: readonly string[],
): readonly string[] {
	const udid = unwrap(serial);
	if (udid.toLowerCase() === BOOTED_SELECTOR) {
		throw new Error(
			`Refusing to run ${SIMCTL} ${subcommand} against '${udid}': that is not a ` +
				'device, it is simctl choosing one of the booted ones for itself — which is a command ' +
				'landing on hardware lent to somebody else, reported as success.',
		);
	}

	return [subcommand, udid, ...args];
}

/** Handlers of a long-lived run. Each is called as documented on it, and never after `onEnd`. */
export interface SimctlStreamHandlers {
	/**
	 * Decoded stdout text, in order. Decoded by the stream so a chunk boundary inside a
	 * multi-byte character cannot become a replacement character — unlike
	 * `../android/adb.ts`'s `streamAdb`, whose output is a length-framed protocol and must stay
	 * bytes. Nothing this runner streams is binary: the recording goes to a file.
	 */
	onStdout(chunk: string): void;

	/** Decoded stderr text, in order. This is the stream a recording's start marker arrives on. */
	onStderr(chunk: string): void;

	/**
	 * The run ended, for any reason at all, or never started. Called **exactly once**.
	 *
	 * `reason` is a message ready to be shown to a caller: the argv — masked by
	 * {@link StreamSimctlOptions.redactArgv} — and how it ended. It deliberately does **not**
	 * carry the streams — the caller has been handed every byte of both already, and a runner
	 * that quoted them again would decide for the caller which half of a failure matters. On this tool that decision cannot be made here: an unrecognised subcommand
	 * puts its usage text on stdout and one line of complaint on stderr (module header).
	 */
	onEnd(reason: string): void;
}

export interface StreamSimctlOptions {
	/**
	 * argv entries that must not appear in the `reason` {@link SimctlStreamHandlers.onEnd} is
	 * given — {@link RunSimctlOptions.redactArgv}'s counterpart on the streaming runner, matched
	 * as whole entries by the same {@link quoteArgv} rule and for the same reason.
	 *
	 * The one caller that needs it is the recorder, whose last argv entry is the file *this host*
	 * chose to write the recording to (`./backend.ts`, `launchRecorder`). That `reason` is what a
	 * recorder that ended before it said it had started is reported with, and that report becomes
	 * the text of an `internal_error` read on the agent's machine — possibly another machine
	 * entirely — where a `/var/folders/…` path this host has already removed names nothing anyone
	 * can act on (D19, PROJECT.md §4).
	 *
	 * Only the argv is masked here, because unlike {@link RunSimctlOptions.redactArgv} this runner
	 * never quotes a stream: every byte of both goes to the handlers as it arrives, and whoever
	 * puts a stream into a message masks it there ({@link quoteStream}) — which is what
	 * `recorderNeverStarted` does.
	 */
	readonly redactArgv?: readonly string[];
}

/** The handle {@link streamSimctlOnDevice} answers with. */
export interface SimctlStream {
	/**
	 * The pid, or `null` when the spawn itself failed.
	 *
	 * Held as a way to *act* and never as the answer to whether anything is running — that
	 * question is asked of the machine at the moment it matters (D6, {@link readProcessTable}).
	 */
	readonly pid: number | null;

	/**
	 * Send `signal` to the run. A no-op once it has ended, and once after {@link release}.
	 *
	 * **The only signal anything here sends is `SIGINT`, and that is measured rather than
	 * fastidious.** `simctl io recordVideo` finalises its file on `SIGINT` — its own usage text
	 * says so — and a `SIGKILL` does something much worse than lose the recording: on macOS
	 * 26.6.2 / Xcode 26.6, 2026-09-08, a killed recorder left CoreSimulator holding **that
	 * device's** host-recording lock, and every later recording on it failed with exit 16
	 * *"Host recording is already in progress"* until the device was shut down and booted again,
	 * while the encoder went on writing the file with no process left to stop it (4.6 MB
	 * afterwards). So there is no `stop()` here that kills: stopping a recording *is* a `SIGINT`,
	 * and what follows it is a wait on the process table, which is the backend's
	 * (`./backend.ts`).
	 */
	signal(signal: NodeJS.Signals): void;

	/**
	 * Let this process exit while the run continues — for a recording held open past the call
	 * that started it (`./backend.ts`, `startRecording`).
	 *
	 * Both pipes are **unreferenced rather than destroyed**, and that distinction is the whole
	 * of this method: destroying the read end would give the recorder `EPIPE` on the two lines it
	 * writes as it finalises the file, so the tidier-looking version of this risks the recording.
	 * Unreferenced, the data still flows into the handlers and the event loop simply stops
	 * counting it as work owed.
	 */
	release(): void;
}

/**
 * Run `simctl <subcommand> <udid> <args…>` and hand both streams back for as long as it lives.
 *
 * `spawn`, not `execFile`, and it shares nothing with {@link runSimctl}: a query is a buffer and
 * an exit code, this is a process whose output only means anything while it is arriving.
 *
 * **Deliberately without a timeout**, which every other invocation here has
 * (ai/CODING_STANDARDS.md). A timeout exists so a hung `simctl` cannot wedge a lease; the one
 * call that uses this is *supposed* to stay open, so a timeout would guarantee the failure
 * instead of preventing it. What bounds it instead is `./backend.ts`: a recorder that never says
 * it started is given {@link RECORDING_START_TIMEOUT_MS}, one that will not go away is given
 * {@link RECORDING_FINISH_TIMEOUT_MS}, and the lease-end teardown stops whatever is left (D9).
 *
 * **Pinned to one device through {@link pinnedArgv}**, for that function's reason.
 *
 * **Synchronous, unlike `streamAdb`** — the resolution behind it is
 * (`./developer-dir.ts` is `stat`/`access`/`readlink` and no process), so the pid is available
 * the moment this returns and `SimctlNotFoundError` is thrown from the call rather than reported
 * as an end. A caller that has no `simctl` gets the failure that names every place it looked,
 * which is the one thing a person can act on (#168).
 *
 * `stdin` is `ignore`d: nothing here has anything to say to a recorder, and inheriting it would
 * let a recording consume the daemon's own input.
 *
 * **The argv in the end reason is masked**, {@link StreamSimctlOptions.redactArgv}, because that
 * reason crosses the boundary the same way {@link SimctlCommandError}'s message does.
 */
export function streamSimctlOnDevice(
	serial: DeviceSerial,
	subcommand: string,
	args: readonly string[],
	handlers: SimctlStreamHandlers,
	options: StreamSimctlOptions = {},
): SimctlStream {
	const argv = [...pinnedArgv(serial, subcommand, args)];
	/** The command as the end reason may name it — a host path in it is masked (D19). */
	const quoted = quoteArgv(argv, options.redactArgv ?? []);
	const simctl = join(resolveDeveloperDir(), SIMCTL_RELATIVE_PATH);
	const child: ChildProcess = spawn(simctl, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

	/** Set by the first of `close`/`error`; suppresses every later handler call and the signal. */
	let ended = false;
	const finish = (reason: string): void => {
		if (ended) return;
		ended = true;
		handlers.onEnd(reason);
	};

	child.stdout?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => {
		if (!ended) handlers.onStdout(chunk);
	});
	child.stderr?.setEncoding('utf8');
	child.stderr?.on('data', (chunk: string) => {
		if (!ended) handlers.onStderr(chunk);
	});
	child.on('error', (error: Error) => {
		// Nothing ran at all: the file the search settled on has moved since it was verified.
		finish(`${SIMCTL} ${quoted} failed to run: ${error.message}`);
	});
	// `close` rather than `exit`, because `exit` can fire while stdout still holds bytes — and on
	// this tool the last thing a finished recording says (`Wrote video to: …`) is on stdout.
	child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
		finish(`${SIMCTL} ${quoted} ${streamOutcome(code, signal)}`);
	});

	return {
		pid: child.pid ?? null,
		signal(signal: NodeJS.Signals): void {
			if (ended) return;
			child.kill(signal);
		},
		release(): void {
			child.unref();
			unreference(child.stdout);
			unreference(child.stderr);
		},
	};
}

/**
 * Stop the event loop counting one of a child's pipes as work owed, if it can be told to.
 *
 * `ChildProcess.stdout` and `.stderr` are typed `Readable | null`, and `Readable` has no `unref`
 * — but a pipe from `spawn`'s `'pipe'` stdio is a `net.Socket`, which does. Asked optionally
 * rather than cast to `Socket`, because the type is the one making the weaker claim: a stream
 * that turns out not to be unreferenceable is a run this process keeps waiting on, which is what
 * it would do anyway without {@link SimctlStream.release}.
 *
 * **Unreferenced, never destroyed** — {@link SimctlStream.release} carries why that distinction
 * is the whole of this: the data has to keep flowing so the recorder can finish writing.
 */
function unreference(stream: NodeJS.ReadableStream | null): void {
	(stream as (NodeJS.ReadableStream & { unref?: () => void }) | null)?.unref?.();
}

/**
 * How a long-lived run ended, in the words a caller can be shown.
 *
 * **Exit 0 is an end like any other**, which is not a formality on this tool: a recording that
 * was asked to stop exits 0, and so does one that was given a device with no screen to record
 * and produced nothing (`./backend.ts`). Whatever the code, the run is over and the bytes are
 * what decide the answer.
 */
function streamOutcome(code: number | null, signal: NodeJS.Signals | null): string {
	if (code !== null) return `ended with exit ${code}`;
	if (signal !== null) return `was killed by ${signal}`;
	return 'ended';
}

/**
 * This host's process table, as `ps` printed it: one process per line, the pid then the command.
 *
 * The device's answer to "am I recording", because the recorder is a **host** process
 * (`./parsers/recording.ts`, which reads this). Asked fresh every time it matters and never
 * remembered (D6): a flag on this host would go on believing itself across a daemon restart,
 * across a recorder that somebody else's program started, and across one that stopped on its own.
 *
 * **One process is one line even when an argv contains a newline** — `ps` escapes it as `\012`,
 * measured on macOS 26.6.2, 2026-09-08 against a process deliberately given one — which is what
 * makes a line-oriented parse safe here.
 *
 * A failure is a throw rather than an empty table, and the distinction is the whole reason this
 * is not `.catch(() => '')`: an empty table reads as *this device is not recording*, which is the
 * answer that starts a second recorder and stops the teardown from cleaning up. So a `ps` that
 * would not run says so.
 */
export async function readProcessTable(): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		execFile(
			PROCESS_TABLE,
			[...PROCESS_TABLE_ARGV],
			{
				timeout: PROCESS_TABLE_TIMEOUT_MS,
				maxBuffer: SIMCTL_MAX_BUFFER_BYTES,
				encoding: 'utf8',
			},
			(error, stdout, stderr) => {
				if (error === null) {
					resolve(stdout);
					return;
				}
				reject(
					new Error(
						`${PROCESS_TABLE} ${PROCESS_TABLE_ARGV.join(' ')} would not answer, so whether ` +
							'this host is running a recorder for this device is unknown — and an unknown ' +
							'answer is not "no", which is why this is a failure rather than an empty ' +
							`table: ${error.message}\nstderr: ${quoteStream(stderr)}`,
						{ cause: error },
					),
				);
			},
		);
	});
}
