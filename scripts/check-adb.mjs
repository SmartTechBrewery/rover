/**
 * `npm install`'s one prerequisite check: can this machine find an `adb` for Rover to run?
 *
 * README.md has listed `adb` under "What you need" since 2026-08-31 and nothing checked it, so a
 * machine with the Android SDK installed but its `platform-tools` never added to `PATH` got no
 * install-time signal at all — the first symptom was the panel's Devices screen reporting a host
 * view it could not make current, which names neither `adb` nor `PATH` (#167).
 *
 * **It asks the question the daemon asks, from the daemon's own list.** The order of places to
 * look lives in `src/backends/android/adb-locations.mjs` and this file imports it (#171). A check
 * that answered only "is it on `PATH`" once the daemon had learned to look further would warn on
 * a machine Rover works on perfectly, which is worse than not warning; and two hand-kept copies
 * of the same order drift the first time one of them is edited.
 *
 * **This resolves a path; it never runs the program.** `adb devices` would leave an adb server
 * running as a side effect of `npm install`, and a hung `adb` would hang the install — so what is
 * checked here is that a candidate exists and is executable by this user, which is exactly what
 * the shared list answers with no subprocess to time out. The daemon goes one step further and
 * confirms that the file it picked actually runs (`src/backends/android/adb-path.ts`); the
 * asymmetry is deliberate and is about `npm install`, not about a daemon whose entire job is to
 * run this program.
 *
 * **It reports and changes nothing.** No `PATH` edit, no shell rc file, no registry write: shells
 * and operating systems disagree about where that would even go, and an `npm install` that edits
 * a dotfile is the side effect that makes a package untrustworthy. Rover already treats bringing
 * hardware online as the operator's job (`PROJECT.md` D21); the host's shell configuration is the
 * same rule one step further out.
 */

import {
	ADB_PATH_ENV_VAR,
	adbSearchLocations,
	describeAdbSearch,
	findAdb,
} from '../src/backends/android/adb-locations.mjs';

const RULE = '─'.repeat(74);

/** The same numbered list the daemon's own failure prints, indented into the block below. */
function searched() {
	return describeAdbSearch(adbSearchLocations())
		.map((line) => `    ${line}`)
		.join('\n');
}

function message() {
	return `
  ${RULE}
  Rover: no 'adb' was found in any of the places Rover looks.
  ${RULE}
  Rover talks to every device through 'adb'. Until it can find one the daemon
  finds no devices at all: 'rover list' comes back empty and the web panel's
  Devices screen cannot make its host view current — with nothing in either
  naming the cause.

  Looked here, in this order — the same order the daemon uses:

${searched()}

  The usual reason is an Android SDK installed somewhere else. Set
  ${ADB_PATH_ENV_VAR} to the 'adb' you want Rover to run, or see 'What you
  need' in README.md for the prerequisites.

  Nothing on this machine was changed: this check never edits PATH, a shell
  profile or anything else, and it has not failed the install — 'npm install'
  itself does not need 'adb'.
  ${RULE}
`;
}

try {
	if (findAdb() === null) console.error(message());
} catch {
	// A warning about a later `rover` run is never a reason for `npm install` to fail (#167).
	// Nothing here sets an exit code, and anything unexpected — an exotic PATH, a stat that throws
	// in a way the walk did not anticipate, a closed stderr — is swallowed rather than becoming an
	// uncaught exception, which Node would exit 1 on and npm would report as a failed install.
}
