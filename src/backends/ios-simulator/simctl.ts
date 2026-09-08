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
 */

import { type ExecFileException, execFile } from 'node:child_process';
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
	const udid = unwrap(serial);
	if (udid.toLowerCase() === BOOTED_SELECTOR) {
		throw new Error(
			`Refusing to run ${SIMCTL} ${subcommand} against '${udid}': that is not a ` +
				'device, it is simctl choosing one of the booted ones for itself — which is a command ' +
				'landing on hardware lent to somebody else, reported as success.',
		);
	}

	return runSimctl([subcommand, udid, ...args], options);
}
