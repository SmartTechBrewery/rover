/**
 * Parsers for the output of the app-lifecycle commands — `simctl install`, `launch`,
 * `terminate` and `uninstall`.
 *
 * Here rather than in `../backend.ts` for the reason `ai/CODING_STANDARDS.md` gives: output gets
 * "a parser module with its own tests and its own fixture files captured from a real device".
 * The one predicate below is pinned in
 * `tests/unit/backends/ios-simulator/parsers/app-control.test.ts` against captures under
 * `tests/fixtures/ios-simulator/`, so re-capturing on a newer Xcode is adding a file beside the
 * old one rather than hand-editing a string literal.
 *
 * **This module reads a failure's wording, never its exit code**, which is the opposite of the
 * split on the Android side and follows from `../simctl.ts`'s own finding: three subcommands
 * made to fail on the same bench answered three different numbers, so nothing here maps one
 * (`docs/IOS.md` §2). The exit code is what makes `../simctl.ts` throw; whether a particular
 * throw is really a failure is this module's question.
 *
 * **Only one command needs a predicate**, and the absence of the others is deliberate rather
 * than unfinished. Measured on macOS 26.6.2 (25G83) / Xcode 26.4.1 (17E202), 2026-09-08, each
 * command run directly out of the developer directory:
 *
 * | Command | Exit | Output |
 * |---|---|---|
 * | `install <booted> /tmp/nope.app` | 2 | `lstat of /tmp/nope.app failed: No such file or directory` |
 * | `launch <booted> com.rover.nope` | 4 | `Simulator device failed to launch com.rover.nope.` |
 * | `uninstall <booted> com.rover.nope` | **0** | *both streams empty* |
 * | any of them, on a `Shutdown` device | 149 | `Unable to lookup in current state: Shutdown` |
 *
 * Every one of those is either a non-zero exit `../simctl.ts` already throws on, or — for the
 * uninstall — a silence that is the right answer anyway. No failure that this tool reports
 * *while exiting 0* has been captured from any of them, and a wording asserted from memory is
 * exactly what this folder's fixtures exist to prevent (ai/RULES.md §6). When one is captured,
 * its predicate belongs here beside {@link saysNothingToTerminate}.
 */

/**
 * The line `simctl terminate` prints when the app it was asked to stop was not running.
 *
 * Measured on the bench above: `terminate <booted> com.rover.nope` exits **3** and writes six
 * lines to stderr, of which this one appears three times — bare on its own line, and again
 * inside the sentence of each nested error
 * (`tests/fixtures/ios-simulator/simctl-terminate-not-running.xcode26.4.1-ios26.4.1.txt`). It is
 * matched as a substring for that reason: which of the three lines carries it is the tool's
 * business and has already changed shape once between the two benches this repository has
 * measured.
 *
 * **It is one of the strings this tool does *not* localize**, which is what makes matching it
 * safe and is worth recording because the counter-example is one command away. On this bench —
 * a host whose UI language is Polish — a failed `install` of a bundle came back as *"App
 * installation failed: Nie można zainstalować „Rover”"* from `IXUserPresentableErrorDomain`,
 * while every line of the terminate capture, taken minutes later on the same host, is English.
 * A predicate over a user-presentable message would pass on the machine it was written on and
 * fail on the next one; this is not one (`docs/IOS.md` §8, trap 9).
 */
const NOTHING_TO_TERMINATE = 'found nothing to terminate';

/**
 * Whether a `simctl terminate` failure means the app simply was not running.
 *
 * **That is a success, and the reasoning is the contract's rather than the tool's.** `stopApp`
 * asks for an app not to be running, and an app that was never running is already in the state
 * the caller asked for; Android's `am force-stop` is silent for a package that does not exist
 * at all and cannot tell the two apart either (`../../android/backend.ts`). What answers "is it
 * really gone" is the verb's post-state (#11), read off the device rather than off the tool's
 * opinion of it, so a refusal here would buy nothing and would make the ordinary
 * stop-then-stop-again sequence fail on the second call.
 *
 * Decided from the wording and never from the exit code: that code was **3** on this bench and
 * is one of the three unrelated numbers `docs/IOS.md` §2 records for three failures, so the
 * number carries no meaning to read.
 *
 * Every other terminate failure stays a failure — a device that is not booted answers 149 and
 * `Unable to lookup in current state: Shutdown`, which is a real refusal and is pinned as this
 * predicate's negative case.
 */
export function saysNothingToTerminate(stderr: string): boolean {
	return stderr.includes(NOTHING_TO_TERMINATE);
}
