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
 * argv entries, and `execFile` protects this host's.
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
 */
export class SimctlCommandError extends Error {
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
		// `killed` is also set when `maxBuffer` overflows, and that is not a timeout: reporting it
		// as one sends the next reader looking for a slow simulator instead of a large answer.
		const timedOut = error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
		const signal = error.signal ?? null;

		super(
			[
				`${SIMCTL} ${argv.join(' ')} ${outcome({ error, exitCode, signal, timedOut, timeoutMs })}`,
				`stdout: ${quoteStream(stdout)}`,
				`stderr: ${quoteStream(stderr)}`,
			].join('\n'),
		);

		this.name = 'SimctlCommandError';
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
	// Nothing ran at all — the file the search settled on having moved since is the case here,
	// and its own message is the only thing that says so.
	return `failed to run: ${failure.error.message}`;
}

/**
 * One captured stream, ready to be read inside an error message.
 *
 * Exported because {@link SimctlCommandError} will not be the only failure worth quoting: this
 * tool reports plenty while exiting 0, and those are caught a layer out. One definition so no
 * two messages disagree about what an empty stream looks like.
 */
export function quoteStream(stream: string): string {
	const text = stream.trimEnd();
	return text.length === 0 ? '(empty)' : text;
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
			{ timeout: timeoutMs, maxBuffer: SIMCTL_MAX_BUFFER_BYTES, encoding: 'utf8' },
			(error, stdout, stderr) => {
				if (error === null) {
					resolve({ stdout, stderr });
					return;
				}
				reject(new SimctlCommandError(args, timeoutMs, error, stdout, stderr));
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
