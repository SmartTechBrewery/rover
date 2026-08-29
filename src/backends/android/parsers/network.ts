/**
 * The predicate for the environment commands — `cmd connectivity airplane-mode` and
 * `cmd wifi set-wifi-enabled`.
 *
 * Its own module rather than a line in `../backend.ts`, for the reason
 * `ai/CODING_STANDARDS.md` gives: output gets "a parser module with its own tests and its
 * own fixture files captured from a real device". It is pinned in
 * `tests/unit/backends/android/parsers/network.test.ts` against captures under
 * `tests/fixtures/adb/`.
 *
 * The subject here is the opposite of `./app-control.js`'s. Those commands report at least
 * one failure in a way their exit code does not; these two, on API 37 with adb 37.0.1,
 * exit 255 on every refusal that was captured and 0 on every success — so `../adb.js`
 * rejects a bad argument before anything below is consulted (PROJECT.md §6). What is left
 * for this module is the standing rule that an exit code which agrees today is not a
 * reason to stop reading what the device said.
 */

import type { AdbResult } from '../adb.js';
import { isSilent } from './app-control.js';

/**
 * Did the device accept the change without comment?
 *
 * **Silence is the whole assertion**, and it delegates to {@link isSilent} rather than
 * re-deriving one: both commands print zero bytes on both streams and exit 0 on success —
 * including when asked for the state the device is already in — which is the shape
 * `am force-stop` has, and "silence" has to mean "nothing the *device* said" rather than
 * "zero bytes on stderr" for the same reason it does there. adb's own
 * `* daemon started successfully` banner lands on the stderr of whatever ran first after a
 * server restart, on a call that worked, and one definition of what it means to say
 * nothing is one place to get that wrong.
 *
 * A refusal is not read for its wording, deliberately: `cmd connectivity airplane-mode`
 * answers a bad argument with the connectivity service's **entire help text** on stdout —
 * 943 bytes containing no `Error`, no `Exception` and no `Failed` — so a predicate hunting
 * for error-shaped lines the way {@link isSilent}'s neighbours do would read that as a
 * success. `cmd wifi set-wifi-enabled` answers with one `Invalid args for
 * set-wifi-enabled: java.lang.IllegalArgumentException: …` line, also on stdout, where
 * `am start` puts its refusals on stderr. Both streams are therefore read and neither is
 * treated as the authoritative one.
 */
export function acceptedNetworkChange(result: AdbResult): boolean {
	return isSilent(result);
}
