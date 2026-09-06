/**
 * Where Rover looks for `adb`, in order — the one list the daemon and `scripts/check-adb.mjs`
 * both read (#171, D32).
 *
 * The runner used to invoke `adb` by bare name, so every invocation resolved against the `PATH`
 * of whichever process happened to autostart the daemon (D5). When that process is an MCP server
 * launched by a desktop application, its `PATH` is the short one a GUI session hands out and no
 * `platform-tools` is on it — and the daemon then keeps that environment for its whole life,
 * blind on a machine whose own shell finds `adb` perfectly well.
 *
 * **A bounded list of known locations, never a walk of the filesystem.** A developer machine
 * typically holds several `adb` binaries at different versions — the Android Studio SDK, one
 * bundled with another toolchain, an old `platform-tools` in a downloads directory — and adb is
 * documented to kill a running server whose version does not match the client that reached it.
 * Picking an arbitrary copy off the disk would risk disrupting adb sessions belonging to other
 * tools on the operator's machine, and would make the versions `PROJECT.md` §6 pins its
 * measurements to a non-deterministic property of whatever the scan happened to find first.
 * Failing loudly beats a silent wrong choice, which is the rule ai/RULES.md §2 already states for
 * capabilities.
 *
 * **JavaScript rather than TypeScript, and that is the whole reason this is separate from
 * `./adb-path.ts`.** `scripts/check-adb.mjs` runs under plain `node` at `npm install` time,
 * without a loader and without anything in this repository having been built, so the only module
 * it can share with the daemon is one Node imports as it stands; `./adb-locations.d.mts` beside
 * this file is what the TypeScript half reads. The alternative — one copy of the order per
 * consumer — is exactly the drift #171 exists to prevent: an install-time check that answers a
 * narrower question than the daemon warns about a machine Rover works on perfectly, which is
 * worse than not warning at all. It is the same reasoning `bin/rover.mjs` states for itself — the
 * file that installs the TypeScript loader cannot need one — and this tree is run from source
 * through `tsx` rather than compiled, so nothing has to copy this file anywhere.
 *
 * **Nothing here executes anything**, which is what lets `npm install` use it: it stats
 * candidates and reports what it found. Confirming that a candidate will actually *run* is
 * `./adb-path.ts`'s half of the job and is deliberately not done here — an `npm install` must not
 * leave an adb server behind, and must not hang on a wedged binary.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The program every verb of the Android backend goes through. */
export const ADB = 'adb';

/** The one setting that overrides the whole search below. */
export const ADB_PATH_ENV_VAR = 'ROVER_ADB_PATH';

/** Windows' own default when `PATHEXT` is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * The file names that count as `adb` inside one directory. One on POSIX; on Windows a bare name
 * is not executable, so `PATHEXT` decides.
 *
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function executableNames(platform = process.platform, env = process.env) {
	if (platform !== 'win32') return [ADB];
	const extensions = (env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter(Boolean);
	return extensions.map((extension) => ADB + extension.toLowerCase());
}

/**
 * Present, a file, and executable by this user — `statSync` throws for the first two.
 *
 * A path that exists but cannot be executed is *not found* as far as the search is concerned, and
 * the sequence continues past it: an unreadable leftover in one location must never shadow a
 * working `adb` in the next one.
 *
 * @param {string} candidate
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isExecutableFile(candidate, platform = process.platform) {
	try {
		if (!statSync(candidate).isFile()) return false;
		// X_OK is meaningless on Windows: every file answers yes, so PATHEXT above is the test.
		if (platform === 'win32') return true;
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Where each platform's SDK installer puts the SDK when nobody chose otherwise.
 *
 * One location per platform, not a list of every layout anybody has ever had: the point of the
 * setting above is that an SDK somewhere unusual is named rather than guessed at.
 *
 * @param {NodeJS.Platform} platform
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function standardSdkRoot(platform, home, env) {
	if (platform === 'darwin') return join(home, 'Library', 'Android', 'sdk');
	if (platform === 'win32') {
		return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Android', 'Sdk');
	}
	return join(home, 'Android', 'Sdk');
}

/**
 * The `PATH` entries to look in.
 *
 * An empty entry means the working directory on POSIX. Deliberately not honoured: an `adb` in
 * whatever directory a daemon happened to be started from is not a machine that has `adb`, and
 * the daemon's working directory is inherited from a client nobody chose it for.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
function pathEntries(env, platform) {
	// The host's own `path.delimiter` would be right on the machine this runs on and wrong for a
	// suite that asks what the search looks like on another platform.
	const separator = platform === 'win32' ? ';' : ':';
	return (env.PATH ?? '').split(separator).filter((entry) => entry !== '');
}

/**
 * Every place Rover looks, in order, whether or not it yielded a candidate.
 *
 * The order is fixed and is the documented one (README.md, "Where Rover looks for `adb`"): the
 * operator's own setting, then the environment the daemon inherited, then the SDK's own
 * variables, then the one location the platform's installer uses. A location that yielded
 * nothing is still on the list, because "this variable is not set" is the actionable half of the
 * failure — see {@link describeAdbSearch}.
 *
 * `shown` and `paths` differ for `PATH` alone: the candidate *files* are one per entry per
 * executable name, while what a person needs told is the directories that were searched. On
 * Windows the `PATHEXT` expansion would otherwise multiply an already long list by four.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {string} [home]
 * @returns {import('./adb-locations.d.mts').AdbSearchLocation[]}
 */
export function adbSearchLocations(
	env = process.env,
	platform = process.platform,
	home = homedir(),
) {
	const names = executableNames(platform, env);
	const inDirectory = (directory) => names.map((name) => join(directory, name));
	const inSdk = (root) => inDirectory(join(root, 'platform-tools'));

	// Empty counts as unset, as it does for every other variable in the catalogue: an
	// exported-but-blank variable is what a shell leaves behind, and reading one as a real setting
	// would point the search at a relative path — the current directory, which the daemon inherited
	// from whichever client autostarted it.
	const named = (variable, toPaths) => {
		const value = env[variable];
		const paths = value === undefined || value === '' ? [] : toPaths(value);
		return { source: variable, shown: paths, paths };
	};

	const entries = pathEntries(env, platform);
	const standard = inSdk(standardSdkRoot(platform, home, env));

	return [
		// The one candidate that is a file rather than a directory: the operator names the `adb`
		// they want run, not the SDK it came from.
		named(ADB_PATH_ENV_VAR, (value) => [value]),
		{ source: 'PATH', shown: entries, paths: entries.flatMap(inDirectory) },
		named('ANDROID_HOME', inSdk),
		named('ANDROID_SDK_ROOT', inSdk),
		{ source: "this platform's standard Android SDK location", shown: standard, paths: standard },
	];
}

/**
 * The same list flattened into the candidate files to try, in order.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {string} [home]
 * @returns {import('./adb-locations.d.mts').AdbCandidate[]}
 */
export function adbCandidates(env = process.env, platform = process.platform, home = homedir()) {
	return adbSearchLocations(env, platform, home).flatMap(({ source, paths }) =>
		paths.map((path) => ({ source, path })),
	);
}

/**
 * The first candidate that is an executable file, or `null`.
 *
 * The whole of what an install-time check can answer, and the first half of what the daemon
 * answers — `./adb-path.ts` goes on to confirm that the file it names actually runs.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {string} [home]
 * @returns {import('./adb-locations.d.mts').AdbCandidate | null}
 */
export function findAdb(env = process.env, platform = process.platform, home = homedir()) {
	for (const candidate of adbCandidates(env, platform, home)) {
		if (isExecutableFile(candidate.path, platform)) return candidate;
	}
	return null;
}

/**
 * The search as lines a person reads when it found nothing — one per location, numbered in the
 * order they were tried, saying what was looked at or that the variable naming it is not set.
 *
 * Shared so the install-time warning and the daemon's own failure say the same thing about the
 * same machine, which is the point of this module.
 *
 * @param {readonly import('./adb-locations.d.mts').AdbSearchLocation[]} locations
 * @returns {string[]}
 */
export function describeAdbSearch(locations) {
	return locations.map(({ source, shown }, index) => {
		// Deduped preserving order: a `PATH` that lists one directory twice is common enough, and
		// saying so twice tells nobody anything.
		const places = [...new Set(shown)];
		return `${index + 1}. ${source} — ${places.length === 0 ? 'not set' : places.join(', ')}`;
	});
}
