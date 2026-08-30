/**
 * The predicate for `adb shell input` — `tap`, `swipe`, `text` and `keyevent`.
 *
 * Its own module rather than a line in `../backend.ts`, for the reason
 * `ai/CODING_STANDARDS.md` gives: output gets "a parser module with its own tests and its
 * own fixture files captured from a real device". It is pinned in
 * `tests/unit/backends/android/parsers/input.test.ts` against captures under
 * `tests/fixtures/adb/`.
 *
 * What the captures showed, on API 37 with adb 37.0.0 (PROJECT.md §6):
 *
 * - Every one of the four succeeded with **zero bytes on both streams and exit 0** — the
 *   shape `am force-stop` and the two network recipes have.
 * - Every *malformed* invocation exited 255 with a Java stack trace on stderr, so
 *   `../adb.js` rejects it before anything here is consulted.
 * - The one refusal that reaches this module is `input`'s own dispatch failure:
 *   `Unknown command: <x>` on **stdout**, exit 0.
 *
 * And the finding this module cannot help with, stated because silence would read as
 * coverage: an `input` that ran but did nothing — an unknown keycode name, an off-screen
 * coordinate — is byte-for-byte a success. `../input.js` is where that is caught, before
 * the call, and it is the reason that module exists.
 */

import type { AdbResult } from '../adb.js';
import { isSilent } from './app-control.js';

/**
 * Did the device accept the injection without comment?
 *
 * **Silence is the whole assertion**, and it delegates to {@link isSilent} rather than
 * re-deriving one, exactly as `./network.js` does: "silence" has to mean "nothing the
 * *device* said" and not "zero bytes on stderr", because adb's own
 * `* daemon started successfully` banner lands on the stderr of whatever ran first after a
 * server restart — on a call that worked. One definition of what it means to say nothing is
 * one place to get that wrong.
 *
 * Both streams are read and neither is treated as the authoritative one. `input`'s own
 * refusal (`Unknown command: …`) comes back on **stdout** at exit 0, where `am start` puts
 * its refusals on stderr; a predicate that picked a stream would read one of the two as a
 * success.
 */
export function acceptedInput(result: AdbResult): boolean {
	return isSilent(result);
}
