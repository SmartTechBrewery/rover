/**
 * Parsers for the output of the app-lifecycle commands — `adb install`, `am start`,
 * `am force-stop`, `pm clear` and `cmd package resolve-activity`.
 *
 * Lives here rather than in `../backend.ts` for the reason `ai/CODING_STANDARDS.md`
 * gives: output gets "a parser module with its own tests and its own fixture files
 * captured from a real device". Every predicate below is pinned in
 * `tests/unit/backends/android/parsers/app-control.test.ts` against captures under
 * `tests/fixtures/adb/`, so re-capturing on a newer API level is adding a file beside the
 * old one rather than hand-editing a string literal.
 *
 * The subject of all of it is the same: **every one of these commands reports at least one
 * failure in a way its exit code does not** (PROJECT.md §6). The exit code is
 * `../adb.js`'s to enforce; the wording is this module's.
 */

import type { AdbResult } from '../adb.js';

/**
 * The word `adb install` and `pm clear` both print, on a line of their own, when the work
 * was actually done.
 */
const SUCCESS_LINE = 'Success';

/** `am start` names the intent it dispatched before anything can have gone wrong with it. */
const START_DISPATCHED = 'Starting: Intent';

/**
 * How `am` announces a refusal — with a line, never with an exit code it can be trusted on.
 *
 * `Warning: Activity not started, …` is deliberately absent: it means the app was already
 * the top-most instance, which is a launch that succeeded. `Error type 3` and `Error: …`
 * are the two `am` prints for a component it will not start, and a shell command that
 * threw prints `Exception occurred while executing 'start':` above a Java stack trace
 * whose head line is the exception class (PROJECT.md §6).
 */
const AM_REFUSAL = /^(?:Error\b|Exception occurred\b|java\.[\w.]+(?:Exception|Error)\b)/;

/**
 * A `<package>/<class>` component name, the only shape `am start -n` accepts.
 *
 * Narrow on purpose. This value is device output on its way back into a device-side
 * command line, so the character set is the guarantee that it stays one word there — it is
 * passed through `shellArg()` in `../adb.js`, which quotes it and refuses a value carrying
 * a `'`.
 * `$` is allowed because an inner-class activity is the common case on Android
 * (`com.android.settings/.Settings$MyDeviceInfoActivity`), and quoting is what keeps the
 * device's shell from expanding it.
 */
const COMPONENT = /^[A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+$/;

/**
 * adb's own client-level chatter, which arrives on stderr *before* the subcommand it was
 * asked to run has produced anything.
 *
 * It is not device output and it is not evidence of anything going wrong: `adb` writes it
 * whenever the client has to start a server first — after `adb kill-server`, after a
 * server crash, or when a second adb of a different version killed the running one. It is
 * filtered once, here, rather than per verb, because the next assertion that "this stream
 * should be empty" would be defeated by it in exactly the same way {@link isSilent} was.
 * Captured on API 37 / adb 37.0.1 in
 * `tests/fixtures/adb/am-force-stop.daemon-start.stderr.api37-sdk-gphone16k-arm64.txt`,
 * on a force-stop that worked and exited 0.
 */
const CLIENT_PREAMBLE =
	/^(?:\* daemon (?:not running|started successfully)\b|adb server version \(\d+\) doesn't match this client\b)/;

/**
 * The meaningful lines of one captured stream, with adb's own preamble dropped.
 *
 * The `\r` is why this trims rather than splits alone: nothing on an API 37 emulator over
 * the v2 shell protocol carries one, but a device that falls back to a pty-backed shell
 * ends every line `\r\n`, and an equality test against `Success` is exactly the assertion
 * that would then silently stop matching.
 */
export function outputLines(stream: string): string[] {
	return stream
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !CLIENT_PREAMBLE.test(line));
}

/**
 * Did the command say the word it says when the work was done?
 *
 * A `Success` **line**, not the trimmed stream — a successful `adb install` wraps the word
 * in one to three other lines depending on which install path adb took (`Performing
 * Streamed Install` above it on one capture, `Serving…` / `Performing Incremental Install`
 * / `Install command complete in 49 ms` around it on another), and `stdout.trim() ===
 * 'Success'` rejects both (PROJECT.md §6).
 */
export function saysSuccess(stdout: string): boolean {
	return outputLines(stdout).includes(SUCCESS_LINE);
}

/**
 * Did the command print nothing of its own?
 *
 * `am force-stop` is the one verb with no success wording, so silence is the assertion —
 * and silence has to mean "nothing the *device* said", not "zero bytes on stderr". A
 * force-stop that worked while adb had to start its server first exits 0 with
 * `* daemon started successfully` on stderr, and reading that as a failure makes the verb
 * intermittently reject work it had already done.
 */
export function isSilent(result: AdbResult): boolean {
	return outputLines(result.stdout).length === 0 && outputLines(result.stderr).length === 0;
}

/**
 * Did `am start` dispatch the intent, and say nothing to take it back?
 *
 * Both halves are needed. `Starting: Intent {…}` is printed before anything can have gone
 * wrong, so on its own it is not evidence of a launch; and `am` prints its refusal on
 * whichever stream it feels like — `Error: Activity class {…} does not exist.` came back
 * on stderr on API 37 while every guide of the era shows it on stdout — so both are read.
 */
export function startedActivity(result: AdbResult): boolean {
	const dispatched = outputLines(result.stdout).some((line) => line.startsWith(START_DISPATCHED));
	const refused = [...outputLines(result.stdout), ...outputLines(result.stderr)].some((line) =>
		AM_REFUSAL.test(line),
	);
	return dispatched && !refused;
}

/**
 * The `<package>/<class>` component `cmd package resolve-activity --brief` answered with,
 * or `null` when it did not answer with one.
 *
 * `--brief` is not brief: it prints a `priority=… isDefault=true` header line above its
 * answer, so the answer is the **last** line. `No activity found` on stdout with exit 0 is
 * what a package that is not installed *and* a package with nothing launchable both come
 * back with — neither is a component, which is why the shape is checked rather than the
 * wording: the day that sentence changes, an unlaunchable app must still fail here rather
 * than be handed to `am start -n` as a component name.
 *
 * `null` rather than a throw — this is a lookup with no answer (ai/CODING_STANDARDS.md
 * "Error handling"), and only the caller knows the app id and the device to name in the
 * failure.
 */
export function parseResolvedActivity(stdout: string): string | null {
	const answer = outputLines(stdout).at(-1) ?? '';
	return COMPONENT.test(answer) ? answer : null;
}
