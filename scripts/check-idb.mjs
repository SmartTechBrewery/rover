/**
 * `npm install`'s second prerequisite check: can a mac that lends simulators find an
 * `idb_companion`?
 *
 * The companion piece to `./check-adb.mjs`, and it exists for the failure that cost an afternoon:
 * a Mac with Xcode and eleven simulators installs Rover cleanly, `rover list` names every one of
 * them, a lease is granted reporting `canReadScreen: true` — and the **first** `tap` is where the
 * machine finally says it is missing a program. Everything before that point looks like a working
 * install, because the capability describes the platform rather than this host (D11), and because
 * every *required* method of the backend answers through `simctl` alone.
 *
 * **It reports and changes nothing** — `./check-adb.mjs`' rule, and now with somewhere to send
 * people: `rover doctor --fix` installs the pinned release on the host, so this check names one
 * command instead of a tarball, a directory choice and an environment variable. An `npm install`
 * that downloaded 19 MB by itself is the side effect that makes a package untrustworthy, and it
 * would do it inside every fresh worktree an agent creates.
 *
 * **It asks the daemon's own question, from the daemon's own list**
 * (`../src/backends/ios-simulator/idb-companion-locations.mjs`, #171): a check with its own idea of
 * where to look would warn on a machine Rover drives perfectly, which is worse than not warning.
 *
 * **Silent off macOS and silent on a host that has one.** A Linux host lending phones has no use
 * for this program at all, and neither does a mac whose operator already installed it.
 */

import { findIdbCompanion } from '../src/backends/ios-simulator/idb-companion-locations.mjs';

const RULE = '─'.repeat(74);

function message() {
	return `
  ${RULE}
  Rover: this mac has no 'idb_companion', so it cannot read or drive a simulator.
  ${RULE}
  Simulators still enumerate, still install apps and still take screenshots — every
  required method of the iOS backend goes through simctl. What needs this program is
  'read_screen' and every input verb: tap, swipe, type_text and press_key. Without it
  each of those fails at the first call of a session, not here.

  Homebrew no longer carries it and there is no installer, so Rover keeps its own:

      rover doctor --fix --actor "$(whoami)"

  That downloads the pinned release on the host, checks it against the checksum the
  release publishes, and unpacks it under ~/.rover where Rover looks last. Already have
  one? Point Rover at it with ROVER_IDB_COMPANION_PATH and this warning goes away.

  Nothing on this machine was changed: this check never downloads, never edits PATH or a
  shell profile, and has not failed the install.
  ${RULE}
`;
}

try {
	if (process.platform === 'darwin' && findIdbCompanion() === null) console.error(message());
} catch {
	// A warning about a later `rover` run is never a reason for `npm install` to fail — the rule
	// `./check-adb.mjs` states, and the same swallow: anything unexpected here would otherwise be
	// an uncaught exception, which Node exits 1 on and npm reports as a failed install.
}
