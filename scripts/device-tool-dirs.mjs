#!/usr/bin/env node
/**
 * The directories holding the programs the device backends spawn — `adb` and `idb_companion` —
 * as **this checkout's own search** finds them, one per line.
 *
 * **It exists for `bin/rover-server-agent`, and for one failure it has to prevent.** launchd starts
 * a job with a minimal `PATH` and reads none of the login shell's rc files, while the daemon spawns
 * both of these *by name*. A host whose `PATH` resolves `node` and nothing else starts perfectly
 * cleanly and then fails every single verb — up, holding devices, useful to nobody — which is the
 * worst shape of failure this project has.
 *
 * **Asked of the checkout rather than re-derived in bash**, because where these live is already one
 * list per program and #171 is the issue about what happens when it becomes two:
 * `src/backends/android/adb-locations.mjs` searches `ROVER_ADB_PATH`, `PATH`, `ANDROID_HOME`,
 * `ANDROID_SDK_ROOT` and the platform's standard SDK root, and
 * `src/backends/ios-simulator/idb-companion-locations.mjs` searches `ROVER_IDB_COMPANION_PATH`,
 * `PATH` and the copy `rover doctor --fix` unpacks under `~/.rover`. A second copy of either order
 * in a shell script would eventually disagree with the daemon about which binary is about to run.
 *
 * **Nothing here executes either program**, which is the rule both of those modules already keep:
 * they stat candidates and report what they found, so this cannot leave an adb server behind or
 * hang on a wedged binary.
 *
 * Plain `.mjs` under plain `node` — no TypeScript loader — for exactly the reason those two modules
 * are `.mjs`: they are importable as they stand, from a script that may run before anything is
 * installed. A program that is not on this machine contributes no line and is not an error; off
 * macOS the idb search is empty by construction.
 */

import { dirname } from 'node:path';
import { findAdb } from '../src/backends/android/adb-locations.mjs';
import { findIdbCompanion } from '../src/backends/ios-simulator/idb-companion-locations.mjs';

// The two searches answer differently — `findAdb` gives back the candidate it matched, including
// which location it came from, and `findIdbCompanion` gives back the path — so each is unwrapped
// where it is read rather than one of them being reshaped to match the other.
const adb = findAdb();
const found = [adb === null ? null : adb.path, findIdbCompanion()]
	.filter((path) => path !== null)
	.map((path) => dirname(path));

// Deduplicated, because an operator who keeps both under one directory should not get it twice.
for (const directory of [...new Set(found)]) {
	process.stdout.write(`${directory}\n`);
}
