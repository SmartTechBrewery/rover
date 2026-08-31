/**
 * The `adb` process runner every verb of this backend goes through.
 *
 * The split with `./parsers/` is deliberate and both halves depend on it: the parsers own
 * the text and are pinned against output captured from a real device, this owns the
 * process — argv, the timeout, the exit code and the two streams. That is what lets the
 * parsers be tested without a process and this be tested without a device.
 *
 * `adb` is resolved from `PATH` rather than from configuration, exactly as
 * `tests/device/setup.ts` already does. A configurable path is a real request, but it is
 * a configuration option (ai/RULES.md §7) and nothing needs one yet.
 */

import { type ExecFileException, execFile, spawn } from 'node:child_process';
import { type DeviceSerial, unwrap } from '../../core/ids.js';

/** The program name, looked up on `PATH`. */
const ADB = 'adb';

/**
 * Every external invocation has a timeout (ai/CODING_STANDARDS.md) — a hung `adb` with no
 * timeout wedges a lease until it expires. Callers that know they are slower say so.
 */
export const DEFAULT_ADB_TIMEOUT_MS = 10_000;

/**
 * The one call that is nothing like a query: `install` streams the whole package across
 * the link and then waits for the platform to verify and optimise it, and neither half is
 * bounded by anything this side controls. The 45 MB APK used to check the recipe crossed
 * an emulator's loopback in 0.16 s; the same file over USB to a physical phone is two
 * orders of magnitude slower before dexopt has started. So this is deliberately generous
 * rather than tuned — it exists to stop a wedged `adb` holding a lease forever, not to
 * bound a slow but healthy install.
 *
 * Named and passed at the call site rather than raised as the default: every other verb
 * here is a query, and ten seconds is the right answer for those.
 */
export const INSTALL_ADB_TIMEOUT_MS = 5 * 60_000;

/**
 * A file transfer in either direction, which is the install above without the platform's
 * half: the bytes cross the link and nothing else happens.
 *
 * The payload is bounded — `MAX_TRANSFER_BYTES` in `src/ipc/verb-methods.ts` caps it at 4
 * MiB — but the *link* is not: the same 4 MiB is a moment over an emulator's loopback and a
 * different order of magnitude over USB to a phone that is busy, which is the case this
 * number exists for. So it mirrors {@link INSTALL_ADB_TIMEOUT_MS} rather than being tuned
 * against a measurement, and it is a separate constant because the two bound different
 * things: raising the transfer cap (R24) moves this one and leaves the install alone.
 */
export const TRANSFER_ADB_TIMEOUT_MS = 5 * 60_000;

/**
 * The other call that is not a query. A capture is an encode of the whole framebuffer on
 * the device and a transfer of the result: three runs against an API 37 emulator on a
 * fast host each took **2.4 s** for a 1080×2424 screen (PROJECT.md §6), which is two
 * orders of magnitude above every other verb here and already a quarter of the default
 * budget. A physical device with a taller panel, over USB, under load, is the case that
 * would spend the rest of it — and a capture that times out reads to the caller as a
 * broken device rather than as a budget set too low.
 *
 * Generous rather than tuned, for the same reason as the install above: it exists to stop
 * a wedged `adb` holding a lease forever, not to bound a slow but healthy capture.
 */
export const SCREENSHOT_ADB_TIMEOUT_MS = 30_000;

/**
 * How long the encoder gets to close the file after the capture window ends — the budget
 * for the last thing a recorder does, and the timeout of the wait that watches for it.
 *
 * It is a *finish* budget, not a recording budget: the recording command's own timeout is
 * the requested duration plus this, because `screenrecord --time-limit N` runs for N
 * seconds and then writes its index. On an API 37 emulator the recorder was already gone
 * by the time its adb client returned (PROJECT.md §6), so the wait ordinarily costs one
 * round trip and nothing else; ten seconds is the room a loaded device or a physical panel
 * needs to finish the same work, well clear of the measurement rather than tuned to it.
 *
 * It also bounds the case this exists for: a recorder somebody *else* started on the same
 * device never goes away, and the wait must end with a timeout naming the pids rather than
 * holding the lease until it expires.
 */
export const RECORDING_FINISH_TIMEOUT_MS = 10_000;

/**
 * The third call here that is not a query: pulling a whole recording off the device.
 *
 * A recording is bounded by `MAX_ARTIFACT_BYTES` (4 MiB, `src/verbs/result.ts`) — up to
 * three times the largest capture measured on a device — and it crosses the same link a
 * capture does, which took 2.4 s. Generous rather than tuned, for
 * {@link SCREENSHOT_ADB_TIMEOUT_MS}'s reason: it exists to stop a wedged `adb` holding a
 * lease forever, not to bound a slow but healthy transfer over USB to a physical device.
 */
export const RECORDING_PULL_TIMEOUT_MS = 60_000;

/**
 * The one call that goes the *other* way: a query so small it deserves **less** than the
 * default, because something is waiting on it that the default was never sized for.
 *
 * The per-device OS-version read is two `getprop` calls on one command line, and it is the
 * only query issued from the enumeration path — which `DeviceInventory.verifyForGrant` runs
 * on every lease grant, in parallel across every attached device. So the slowest device on
 * the host sets how long a grant for a *healthy* one takes, and a wedged handset that adb
 * still reports as `device` would spend the full ten seconds of every grant on a fact that
 * is nice to have.
 *
 * Tuned against a measurement rather than generous, which is the opposite of the three
 * budgets above: five runs against an API 35 emulator each took **0.07–0.11 s**
 * (PROJECT.md §6), so three seconds is more than an order of magnitude of headroom for the
 * same read over USB to a busy physical device, and a thirtieth of the wait a wedged one
 * used to cost. Timing out is cheap here in a way it is not for a capture or an install:
 * the device is listed without a version and asked again at the next enumeration.
 */
export const OS_VERSION_ADB_TIMEOUT_MS = 3_000;

/**
 * How much of a long-lived run's stderr is kept for its end reason.
 *
 * Bounded because {@link streamAdb} runs for as long as the host does, and an adb that
 * chats on stderr for a week would otherwise be a slow leak. The tail rather than the head:
 * whatever adb said last is what explains the end, while the first thing it said is the
 * `* daemon started successfully` banner it prints on the success path (PROJECT.md §6).
 */
export const ADB_STREAM_STDERR_TAIL_CHARS = 4096;

/**
 * `adb shell getprop` returned ~23 KB on an API 37 emulator, and Node's default
 * `maxBuffer` is 1 MB — close enough that a chattier device would truncate the answer
 * into an `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` failure that reads like the device is
 * broken. Set explicitly so the headroom is a decision rather than a default nobody chose.
 */
export const ADB_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * The same headroom for a capture, which is not text and is an order of magnitude
 * larger. A 1080×2424 screen came back as 1.3 MB of PNG from an API 37 emulator
 * (PROJECT.md §6) — already past Node's 1 MB default, and a busier screen on a taller
 * panel is several times that, because a PNG of real content compresses nothing like a
 * PNG of a flat one. An overflow is not a graceful truncation either: the child is killed
 * and the answer is lost, so the number is set well clear of the largest plausible frame
 * rather than close to the measured one.
 */
export const ADB_BINARY_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** The two streams of a successful run, kept separate — see {@link AdbCommandError}. */
export interface AdbResult {
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * The two streams of a successful **binary** run.
 *
 * `stdout` stays bytes all the way to the caller; `stderr` is decoded, because adb's own
 * half of the conversation — the daemon banner, `device '…' not found` — is text on every
 * call regardless of what the device sent back.
 */
export interface AdbBinaryResult {
	readonly stdout: Buffer;
	readonly stderr: string;
}

export interface RunAdbOptions {
	/** Overrides {@link DEFAULT_ADB_TIMEOUT_MS} for one call. */
	readonly timeoutMs?: number;

	/**
	 * argv entries that must not appear in {@link AdbCommandError}'s **message**.
	 *
	 * For the one class of argument that is a path on *this host*: the file a transfer
	 * reads or writes here on the caller's behalf. An `AdbCommandError` becomes the text of
	 * an `internal_error` response (`src/ipc/server.ts`), and that response is read on the
	 * agent's machine — possibly another machine entirely — where a `/var/folders/…` path
	 * this host already deleted names nothing anyone can act on (D19, PROJECT.md §4).
	 *
	 * **Masked in the argv *and* in the captured streams**, because adb writes the path it
	 * was given back out itself: measured on adb 37.0.0, a failed push says `adb: error:
	 * failed to copy '<host path>' to '<device path>'`, a failed install says `adb: filename
	 * doesn't end .apk or .apex: <host path>`, and a pull that cannot write its destination
	 * says `adb: error: cannot create '<host path>'` (PROJECT.md §6). Masking only the argv
	 * would leave the same string in the message one line further down, which is exactly the
	 * hole a first pass at this left open.
	 *
	 * The argv is matched as whole entries so the masking cannot depend on how the message
	 * happens to be assembled; the streams are matched as substrings, because adb embeds
	 * the path inside a sentence of its own — byte for byte as it was given, which is what
	 * makes the substitution safe to do that way ({@link quoteStream}).
	 *
	 * {@link AdbCommandError.argv}, {@link AdbCommandError.stdout} and {@link
	 * AdbCommandError.stderr} all keep the real values: they never cross the boundary, and
	 * the host's own log is exactly where the staged path is worth having.
	 */
	readonly redactArgv?: readonly string[];
}

/**
 * A run that did not exit 0.
 *
 * Carries stdout, stderr, the argv and the exit code together, because "a non-zero exit
 * is data" (ai/CODING_STANDARDS.md): the useful half of an `adb` failure is as often on
 * stdout as on stderr, and neither is worth anything without the command that produced it.
 *
 * The streams stay separate rather than being merged. The `* daemon not running …` banner
 * goes to stderr on `adb` 37.0.0 while the device list goes to stdout (PROJECT.md §6), so
 * merging them would corrupt the one and lose the ability to quote the other.
 *
 * **The message is not what this carries, and the difference is the boundary.** {@link
 * argv}, {@link stdout} and {@link stderr} are whole, for this host's own log; the message
 * masks whatever {@link RunAdbOptions.redactArgv} named — in the argv *and* in both
 * streams, since adb quotes the path it was given back into its own output — because this
 * message is what an `internal_error` response carries to a client that may be on another
 * machine (D19).
 */
export class AdbCommandError extends Error {
	readonly argv: readonly string[];
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;

	constructor(
		argv: readonly string[],
		timeoutMs: number,
		error: ExecFileException,
		stdout: string,
		stderr: string,
		redactArgv: readonly string[] = [],
	) {
		const exitCode = typeof error.code === 'number' ? error.code : null;
		// `killed` is also set when `maxBuffer` overflows, and that is not a timeout.
		const timedOut = error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
		const signal = error.signal ?? null;

		super(
			[
				`${ADB} ${quoteArgv(argv, redactArgv)} ${outcome({ error, exitCode, signal, timedOut, timeoutMs })}`,
				`stdout: ${quoteStream(stdout, redactArgv)}`,
				`stderr: ${quoteStream(stderr, redactArgv)}`,
			].join('\n'),
		);

		this.name = 'AdbCommandError';
		this.argv = argv;
		this.exitCode = exitCode;
		this.signal = signal;
		this.stdout = stdout;
		this.stderr = stderr;
		this.timedOut = timedOut;
	}
}

function outcome(failure: {
	error: ExecFileException;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	timeoutMs: number;
}): string {
	if (failure.timedOut) return `timed out after ${failure.timeoutMs}ms`;
	if (failure.exitCode !== null) return `exited ${failure.exitCode}`;
	if (failure.signal !== null) return `was killed by ${failure.signal}`;
	// Nothing ran at all — `adb` absent from PATH is the common one, and its own message
	// is the only thing that says so.
	return `failed to run: ${failure.error.message}`;
}

/**
 * The command as it may be read on the caller's machine.
 *
 * Everything `adb` was given, in order, with the host-local paths in `redact` replaced by
 * {@link REDACTED_ARGV}. Whole entries are compared rather than substrings of the joined
 * line: an argv entry either *is* the path this host made up or it is the caller's own
 * value, and a substring rule would also mask a device path that happened to share a
 * prefix with it.
 */
function quoteArgv(argv: readonly string[], redact: readonly string[]): string {
	return argv.map((entry) => (redact.includes(entry) ? REDACTED_ARGV : entry)).join(' ');
}

/**
 * What a host path reads as once it has crossed the boundary, in an argv or in a stream.
 *
 * Says what was there rather than eliding it, so a failure message stays a sentence: the
 * caller sent bytes and this host wrote them somewhere of its own choosing, which is the
 * whole fact the path was carrying.
 */
const REDACTED_ARGV = '<the file you sent>';

/**
 * One captured stream, ready to be read inside an error message.
 *
 * Exported because {@link AdbCommandError} is not the only failure worth quoting: the
 * failures adb reports *while exiting 0* are caught a layer up in `./backend.ts`, and the
 * two messages get read side by side. One definition so they never disagree about what an
 * empty stream looks like — or about how a host path reads once it has crossed the
 * boundary, which is what `redact` is for.
 *
 * **`redact` is a substring rule here where {@link quoteArgv}'s is a whole-entry rule**,
 * and the asymmetry is the difference between the two subjects. An argv entry either *is*
 * the path this host made up or it is the caller's own value, so comparing whole entries
 * is both sufficient and the only rule that cannot mask a device path sharing a prefix
 * with it. A stream is a sentence adb wrote, with the path embedded in it — `adb: error:
 * failed to copy '<host path>' to '<device path>'` — so nothing but a substring rule
 * reaches it. That is safe because adb echoes the path byte for byte as it was given
 * (measured on adb 37.0.0, PROJECT.md §6), and because the only values ever passed here
 * are `mkdtemp` paths this host invented moments earlier: they cannot collide with a
 * caller's device path, and the empty-string case cannot arise from one.
 */
export function quoteStream(stream: string, redact: readonly string[] = []): string {
	const masked = redact.reduce(
		(text, path) => (path.length === 0 ? text : text.replaceAll(path, REDACTED_ARGV)),
		stream,
	);
	const text = masked.trimEnd();
	return text.length === 0 ? '(empty)' : text;
}

/**
 * A binary stream, rendered for a message a human will read.
 *
 * The counterpart of {@link quoteStream} for the runner below, and exported for the same
 * reason: the failures adb reports *while exiting 0* are caught a layer up in
 * `./backend.ts`, and the two messages get read side by side. Quoting the payload itself
 * is not an option — it is megabytes and it is not text — so what is quoted is the two
 * facts that identify it: how much came back, and what it starts with. The leading bytes
 * are the useful half, because a capture that arrived as a text stream, an error page or
 * nothing at all is told apart by exactly those.
 */
export function describeBytes(bytes: Buffer): string {
	if (bytes.length === 0) return '(empty)';
	const head = bytes
		.subarray(0, 8)
		.toString('hex')
		.replace(/(..)(?=.)/g, '$1 ');
	return `(${bytes.length} bytes, starting ${head})`;
}

/**
 * One argument of a device-side `adb shell` command, quoted for the shell **on the
 * device**.
 *
 * `adb shell am start -n <component>` does not reach the device as an argv: adb joins its
 * arguments with single spaces and hands the resulting string to the device's `sh`, so
 * every metacharacter in them is that shell's to interpret. `execFile` protects the
 * *host* shell and nothing else. Two things measured on API 37 / adb 37.0.1 (PROJECT.md
 * §6) are what this exists for:
 *
 * - `am start -n com.android.settings/.Settings$MyDeviceInfoActivity` launched plain
 *   `.Settings` and reported success — `$MyDeviceInfoActivity` expanded to nothing on the
 *   device, and inner-class activities are the common case on Android, not an edge one.
 * - `am force-stop 'com.rover.nope;echo INJECTED'` printed `INJECTED`: a second command,
 *   run on the device, under the lease that authorised the first.
 *
 * Single quotes, and a value carrying one is refused rather than escaped — everything
 * quoted here is a shape that has already been checked (`parseAppId`, the component
 * pattern in `./parsers/app-control.js`), so a `'` reaching this point is a bug in that
 * check and not something to paper over.
 */
export function shellArg(value: string): string {
	if (value.includes("'")) {
		throw new Error(`Cannot pass '${value}' to a device shell: it contains a single quote`);
	}
	return `'${value}'`;
}

/**
 * The same, for a value whose **content** is the point rather than its shape — the text a
 * caller wants typed on the device.
 *
 * {@link shellArg} refuses a value carrying a `'`, and that refusal is correct where it
 * lives: everything it quotes has already been through a shape check, so an apostrophe
 * arriving there is a bug in that check. Screen content is the opposite kind of value.
 * `don't` is ordinary text, and a primitive that refused it would be refusing the caller's
 * data rather than catching anyone's mistake — so this one escapes instead of refusing,
 * and the two live side by side so nobody has to decide which behaviour `shellArg` has
 * today.
 *
 * The escape is the standard single-quote splice: close the quote, hand the shell a
 * backslashed `'`, reopen it. That is the only form that works, because a single-quoted
 * string in `sh` has no escapes inside it at all. It is what the device runs, and it is
 * measured rather than assumed — `input text 'don'\''t'` typed `don't` on API 37 with adb
 * 37.0.0, and one word carrying every shell metacharacter — ampersand, pipe, semicolon,
 * dollar, backtick, double quote, parentheses, glob characters — arrived verbatim
 * (PROJECT.md §6).
 *
 * Quoting is needed at all for the reason {@link shellArg} states: adb joins its arguments
 * with single spaces and hands the string to the device's own `sh`, so an unquoted
 * `input text hello world` reaches `input` as two arguments and an unquoted `;` starts a
 * second command on hardware lent out for something else.
 */
export function shellText(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Run `adb <args>` and hand back both streams.
 *
 * Throws {@link AdbCommandError} on a non-zero exit, a timeout, or a failure to start.
 * Note that plenty of `adb` failures exit 0 and say so in their output — those are the
 * parsers' to catch, not this function's.
 */
export async function runAdb(
	args: readonly string[],
	options: RunAdbOptions = {},
): Promise<AdbResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_ADB_TIMEOUT_MS;

	return new Promise<AdbResult>((resolve, reject) => {
		execFile(
			ADB,
			[...args],
			{ timeout: timeoutMs, maxBuffer: ADB_MAX_BUFFER_BYTES, encoding: 'utf8' },
			(error, stdout, stderr) => {
				if (error === null) {
					resolve({ stdout, stderr });
					return;
				}
				reject(new AdbCommandError(args, timeoutMs, error, stdout, stderr, options.redactArgv));
			},
		);
	});
}

/**
 * The same, pinned to one device with a leading `-s <serial>`.
 *
 * It exists so that no caller can forget the pin: an unpinned install landing on another
 * agent's device is the worst failure mode this tool has (PROJECT.md §2), and it looks
 * like success from both sides. Every method that acts on a device goes through here
 * rather than through {@link runAdb}.
 */
export async function runAdbOnDevice(
	serial: DeviceSerial,
	args: readonly string[],
	options: RunAdbOptions = {},
): Promise<AdbResult> {
	return runAdb(['-s', unwrap(serial), ...args], options);
}

/**
 * The binary counterpart of {@link runAdbOnDevice}: bytes out, never decoded.
 *
 * A separate function rather than an option on the text runner, so that no caller can
 * decode a capture as UTF-8 by forgetting to pass a flag. That failure is silent — the
 * replacement characters look like a corrupt device rather than a corrupt read — and it
 * is unrecoverable, because the bytes are gone by the time anyone notices.
 *
 * Only pinned to a device: everything that produces bytes is a capture off one screen,
 * and an unpinned one is a screenshot of somebody else's device (PROJECT.md §2).
 */
export async function runAdbBinaryOnDevice(
	serial: DeviceSerial,
	args: readonly string[],
	options: RunAdbOptions = {},
): Promise<AdbBinaryResult> {
	const argv = ['-s', unwrap(serial), ...args];
	const timeoutMs = options.timeoutMs ?? DEFAULT_ADB_TIMEOUT_MS;

	return new Promise<AdbBinaryResult>((resolve, reject) => {
		execFile(
			ADB,
			argv,
			{ timeout: timeoutMs, maxBuffer: ADB_BINARY_MAX_BUFFER_BYTES, encoding: 'buffer' },
			(error, stdout, stderr) => {
				const message = stderr.toString('utf8');
				if (error === null) {
					resolve({ stdout, stderr: message });
					return;
				}
				// The error carries a *description* of stdout rather than stdout: there is no
				// text to quote, and pasting a megabyte of PNG into a message corrupts the
				// terminal reading it.
				reject(
					new AdbCommandError(
						argv,
						timeoutMs,
						error,
						describeBytes(stdout),
						message,
						options.redactArgv,
					),
				);
			},
		);
	});
}

/** Handlers of a long-lived run. Both are called at most as documented on each. */
export interface AdbStreamHandlers {
	/** Raw stdout bytes, in order. Never decoded here — the framing may not be text. */
	onStdout(chunk: Buffer): void;
	/**
	 * The run ended, for any reason at all, or never started. Called **exactly once**, and
	 * never after {@link AdbStream.stop}. `reason` is a message ready to be shown to a
	 * caller: the argv, how it ended, and the stderr tail.
	 */
	onEnd(reason: string): void;
}

/** The handle {@link streamAdb} answers with. */
export interface AdbStream {
	/**
	 * Kill the run and resolve once it is gone. No handler is called after `stop()` is
	 * called, and calling it twice is a no-op.
	 */
	stop(): Promise<void>;
}

/**
 * Run `adb <args>` and hand its stdout back in chunks for as long as it lives.
 *
 * `spawn`, not `execFile`, and it shares nothing with {@link runAdb}: a query is a buffer
 * and an exit code, this is a process whose output only means anything while it is
 * arriving.
 *
 * **Deliberately without a timeout**, which every other invocation here has
 * (ai/CODING_STANDARDS.md). A timeout exists so a hung `adb` cannot wedge a lease; this
 * invocation is *supposed* to stay open, so a timeout would guarantee the failure instead
 * of preventing it. What bounds it instead is that nothing downstream may treat its output
 * as authoritative — every grant re-verifies with a bounded call (D6).
 *
 * **`exit 0` is an end like any other.** On adb 37.0.1 a tracker whose server is killed
 * exits 0 with an empty stderr (PROJECT.md §6), so there is no "clean end" worth reporting
 * differently: whatever the code, the view is gone.
 *
 * Ends on `close` rather than on `exit`, because `exit` can fire while stdout still holds
 * bytes: a caller that restarts on the end reason would then take delivery of the old
 * run's last chunk after the new one began.
 */
export function streamAdb(args: readonly string[], handlers: AdbStreamHandlers): AdbStream {
	const argv = [...args];
	const child = spawn(ADB, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

	let stderrTail = '';
	let ended = false;
	/** Set by the first of `close`/`error`, and by `stop()`; suppresses every handler call. */
	let finished = false;

	const finish = (reason: string): void => {
		if (finished) return;
		finished = true;
		handlers.onEnd(reason);
	};

	child.stdout?.on('data', (chunk: Buffer) => {
		if (!finished) handlers.onStdout(chunk);
	});
	// Decoded by the stream itself, so a chunk boundary inside a multi-byte character
	// cannot become a replacement character in the message a human reads.
	child.stderr?.setEncoding('utf8');
	child.stderr?.on('data', (chunk: string) => {
		stderrTail = `${stderrTail}${chunk}`.slice(-ADB_STREAM_STDERR_TAIL_CHARS);
	});
	child.on('error', (error: Error) => {
		ended = true;
		// Nothing ran at all — `adb` absent from PATH is the common one.
		finish(`${ADB} ${argv.join(' ')} failed to run: ${error.message}`);
	});
	child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
		ended = true;
		finish(
			`${ADB} ${argv.join(' ')} ${streamOutcome(code, signal)}\nstderr: ${quoteStream(stderrTail)}`,
		);
	});

	return {
		async stop(): Promise<void> {
			finished = true;
			if (ended) return;

			await new Promise<void>((resolve) => {
				child.once('close', () => resolve());
				child.once('error', () => resolve());
				child.kill();
			});
		},
	};
}

function streamOutcome(code: number | null, signal: NodeJS.Signals | null): string {
	if (code !== null) return `ended with exit ${code}`;
	if (signal !== null) return `was killed by ${signal}`;
	return 'ended';
}
