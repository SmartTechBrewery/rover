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

import { type ExecFileException, execFile } from 'node:child_process';
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
 * `adb shell getprop` returned ~23 KB on an API 37 emulator, and Node's default
 * `maxBuffer` is 1 MB — close enough that a chattier device would truncate the answer
 * into an `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` failure that reads like the device is
 * broken. Set explicitly so the headroom is a decision rather than a default nobody chose.
 */
export const ADB_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** The two streams of a successful run, kept separate — see {@link AdbCommandError}. */
export interface AdbResult {
	readonly stdout: string;
	readonly stderr: string;
}

export interface RunAdbOptions {
	/** Overrides {@link DEFAULT_ADB_TIMEOUT_MS} for one call. */
	readonly timeoutMs?: number;
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
	) {
		const exitCode = typeof error.code === 'number' ? error.code : null;
		// `killed` is also set when `maxBuffer` overflows, and that is not a timeout.
		const timedOut = error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
		const signal = error.signal ?? null;

		super(
			[
				`${ADB} ${argv.join(' ')} ${outcome({ error, exitCode, signal, timedOut, timeoutMs })}`,
				`stdout: ${quoteStream(stdout)}`,
				`stderr: ${quoteStream(stderr)}`,
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
 * One captured stream, ready to be read inside an error message.
 *
 * Exported because {@link AdbCommandError} is not the only failure worth quoting: the
 * failures adb reports *while exiting 0* are caught a layer up in `./backend.ts`, and the
 * two messages get read side by side. One definition so they never disagree about what an
 * empty stream looks like.
 */
export function quoteStream(stream: string): string {
	const text = stream.trimEnd();
	return text.length === 0 ? '(empty)' : text;
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
				reject(new AdbCommandError(args, timeoutMs, error, stdout, stderr));
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
