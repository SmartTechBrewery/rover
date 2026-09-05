/**
 * `npm install`'s one prerequisite check: is `adb` on this machine's `PATH`?
 *
 * README.md has listed `adb` under "What you need" since 2026-08-31 and nothing checked it, so a
 * machine with the Android SDK installed but its `platform-tools` never added to `PATH` got no
 * install-time signal at all — the first symptom was the panel's Devices screen reporting a host
 * view it could not make current, which names neither `adb` nor `PATH` (#167).
 *
 * **This resolves the name; it never runs the program.** `adb devices` would leave an adb server
 * running as a side effect of `npm install`, and a hung `adb` would hang the install — while the
 * prerequisite the README states is exactly "on `PATH`", which a walk of `PATH` answers directly
 * and with no subprocess to time out.
 *
 * **It reports and changes nothing.** No `PATH` edit, no shell rc file, no registry write: shells
 * and operating systems disagree about where that would even go, and an `npm install` that edits
 * a dotfile is the side effect that makes a package untrustworthy. Rover already treats bringing
 * hardware online as the operator's job (`PROJECT.md` D21); the host's shell configuration is the
 * same rule one step further out.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const ADB = 'adb';

/**
 * The file names that count as `adb` in one `PATH` entry. One on POSIX; on Windows a bare name is
 * not executable, so `PATHEXT` decides — with Windows' own default when the variable is unset.
 */
function executableNames() {
	if (process.platform !== 'win32') return [ADB];
	const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
	return extensions.map((extension) => ADB + extension.toLowerCase());
}

/** Present, a file, and executable by this user — `statSync` throws for the first two. */
function isExecutableFile(candidate) {
	try {
		if (!statSync(candidate).isFile()) return false;
		// X_OK is meaningless on Windows: every file answers yes, so PATHEXT above is the test.
		if (process.platform === 'win32') return true;
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function foundOnPath() {
	const names = executableNames();
	for (const entry of (process.env.PATH ?? '').split(delimiter)) {
		// An empty entry means the working directory on POSIX. Deliberately not honoured: an
		// `adb` in whatever directory npm happened to run in is not a machine that has `adb`.
		if (entry === '') continue;
		for (const name of names) {
			if (isExecutableFile(join(entry, name))) return true;
		}
	}
	return false;
}

const RULE = '─'.repeat(74);

const MESSAGE = `
  ${RULE}
  Rover: 'adb' was not found on PATH.
  ${RULE}
  Rover talks to every device through 'adb'. Until it is on PATH the daemon
  finds no devices at all: 'rover list' comes back empty and the web panel's
  Devices screen cannot make its host view current — with nothing in either
  naming the cause.

  The usual reason is an Android SDK that is installed while its
  'platform-tools' directory was never added to PATH. Where that directory
  lives depends on how the SDK was installed, so see 'What you need' in
  README.md for the prerequisites rather than a guess repeated here.

  Nothing on this machine was changed: this check never edits PATH, a shell
  profile or anything else, and it has not failed the install — 'npm install'
  itself does not need 'adb'.
  ${RULE}
`;

try {
	if (!foundOnPath()) console.error(MESSAGE);
} catch {
	// A warning about a later `rover` run is never a reason for `npm install` to fail (#167).
	// Nothing here sets an exit code, and anything unexpected — an exotic PATH, a stat that throws
	// in a way the walk did not anticipate, a closed stderr — is swallowed rather than becoming an
	// uncaught exception, which Node would exit 1 on and npm would report as a failed install.
}
