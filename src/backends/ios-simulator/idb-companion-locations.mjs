/**
 * Where Rover looks for `idb_companion`, and where `rover doctor --fix` puts the copy it
 * installs — the one list the daemon, the command and `scripts/check-idb.mjs` all read (D32's
 * rule, `../android/adb-locations.mjs`' shape, #171's reason).
 *
 * **JavaScript rather than TypeScript, and that is the whole reason this is separate from
 * `./idb-companion-path.ts`.** `scripts/check-idb.mjs` runs under plain `node` at `npm install`
 * time, without a loader and without anything in this repository having been built, so the only
 * module it can share with the daemon is one Node imports as it stands;
 * `./idb-companion-locations.d.mts` beside this file is what the TypeScript half reads. One copy
 * of the order per consumer is exactly the drift #171 exists to prevent — and here it would be
 * worse than a stale warning: an install-time check that looked in fewer places than the daemon
 * would tell somebody to run `rover doctor --fix` on a machine whose companion already works.
 *
 * **Three rows now, and the third one reverses a decision.** This search shipped with two rows
 * and the statement that there was *deliberately no third, because this program has no canonical
 * install location at all* — brew no longer carries it, the `facebook/fb` tap is gone, and the
 * supported install was a release tarball unpacked wherever the operator put it. That premise
 * held exactly as long as **the operator** was the one unpacking it. `rover doctor --fix` now
 * unpacks a pinned release into {@link managedIdbCompanionDirectory}, so there *is* a canonical
 * location for the copy Rover manages, and the row that looks there is what lets the daemon find
 * it with no setting at all — which is the whole point of the command: an operator who ran it
 * never types `ROVER_IDB_COMPANION_PATH`, and never has to work out which of their shells the
 * daemon will inherit (D5). `PROJECT.md` R47 carries the reversal with its reasoning rewritten in
 * place (ai/RULES.md §1).
 *
 * The row order is the point: the operator's own setting first, then their `PATH`, then Rover's
 * copy. A machine that already had a companion keeps using that one, and nothing the command
 * downloads can shadow a deliberate install.
 *
 * **Nothing here executes anything**, which is what lets `npm install` use it: it stats
 * candidates and reports what it found. That is also this backend's own rule — a search must not
 * start a companion, because one supervised process per target is something the daemon owns
 * deliberately (`./idb-companion-path.ts`).
 *
 * **Off macOS every list is empty.** idb is macOS-only, so a Linux host looks nowhere, installs
 * nothing, and every suite here stays runnable on a Linux CI runner.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { isExecutableFile } from '../android/adb-locations.mjs';

/** The program, named the way an operator would name it. */
export const IDB_COMPANION = 'idb_companion';

/** The one setting that overrides the whole search below. */
export const IDB_COMPANION_PATH_ENV_VAR = 'ROVER_IDB_COMPANION_PATH';

/**
 * The release Rover installs, pinned.
 *
 * A tag rather than `latest`, for the reason `PROJECT.md` §6 pins every measurement to a version:
 * `idb_companion --version` prints only a build date and time, so the tag is the only durable
 * name for what is on a machine — and an `npm install` that silently moved to a new upstream
 * release would change what the daemon drives without anything in the repository saying so.
 */
export const IDB_COMPANION_VERSION = '1.5.2';

/** The one asset that release publishes for this platform — Apple silicon only, see below. */
export const IDB_COMPANION_ASSET = 'idb-companion.macos-arm64.tar.gz';

/**
 * The architecture {@link IDB_COMPANION_ASSET} runs on.
 *
 * The v1.5.2 release publishes **no** Intel build — checked against the release's own asset list
 * on 2026-09-09 — and an arm64 binary cannot run under Rosetta, which translates the other
 * direction. So an Intel Mac is a machine the installer tells rather than serves.
 */
export const IDB_COMPANION_ARCH = 'arm64';

/** Where that asset and its checksum live. */
export function idbCompanionReleaseUrl(version = IDB_COMPANION_VERSION) {
	return `https://github.com/facebook/idb/releases/download/v${version}/${IDB_COMPANION_ASSET}`;
}

/** @param {string} [version] */
export function idbCompanionChecksumUrl(version = IDB_COMPANION_VERSION) {
	return `${idbCompanionReleaseUrl(version)}.sha256`;
}

/**
 * The directory Rover unpacks that release into — `~/.rover/idb-companion-<version>`.
 *
 * Beside `rover.sock`, `users.json` and `artifacts/`: the host's own data, in the host's own
 * directory (`src/daemon/archive-path.ts` derives its root the same way). **Versioned**, so a
 * pinned upgrade lands beside the old tree rather than on top of a binary a running daemon may be
 * executing, and so the "is it already here" check below is a question about *this* release
 * rather than about whatever happens to be unpacked.
 *
 * The whole tree matters, not just the file: the tarball unpacks `idb_companion` beside a
 * `Resources/` directory and three `.bundle`s it needs, so the binary cannot be moved out on its
 * own (`docs/IOS.md` §4).
 *
 * @param {string} [home]
 * @param {string} [version]
 */
export function managedIdbCompanionDirectory(home = homedir(), version = IDB_COMPANION_VERSION) {
	return join(home, '.rover', `idb-companion-${version}`);
}

/**
 * The executable inside that tree.
 *
 * @param {string} [home]
 * @param {string} [version]
 */
export function managedIdbCompanion(home = homedir(), version = IDB_COMPANION_VERSION) {
	return join(managedIdbCompanionDirectory(home, version), IDB_COMPANION);
}

/**
 * The places to look, in order, whether or not each named anything.
 *
 * A place that yielded nothing **stays on the list**, which is `../android/adb-locations.mjs`'
 * rule and for its reason: *"this variable is not set"* is the actionable half of the failure,
 * and without it the numbering in the message would mean a different place on every machine.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {string} [home]
 * @returns {{ source: string, path: string | null, absent?: string }[]}
 */
export function idbCompanionSearchLocations(
	env = process.env,
	platform = process.platform,
	home = homedir(),
) {
	if (platform !== 'darwin') return [];

	// Empty counts as unset, as it does for every other variable in the catalogue: an
	// exported-but-blank variable is what a shell leaves behind, and reading one as a real setting
	// would point the search at a relative path.
	const named = env[IDB_COMPANION_PATH_ENV_VAR];

	return [
		{
			// The operator names the executable they want run, not a directory it came from —
			// `ROVER_ADB_PATH`'s row verbatim, including that nothing is appended to it.
			source: IDB_COMPANION_PATH_ENV_VAR,
			path: named === undefined || named === '' ? null : named,
			absent: 'not set',
		},
		// One row per entry rather than one row listing them all: the numbering is what makes the
		// failure readable, and a `PATH` folded into a single line hides which of its twenty
		// directories actually got looked in — while each row here names a real candidate file.
		...pathEntries(env).map((entry) => ({
			source: 'PATH',
			path: join(entry, IDB_COMPANION),
		})),
		{
			// Last, so a companion the operator installed themselves always wins over the copy
			// `npm install` unpacked — theirs is a decision, Rover's is a default.
			source: `Rover's own copy (${IDB_COMPANION_VERSION})`,
			path: managedIdbCompanion(home),
		},
	];
}

/**
 * Walk that list and answer with the first `idb_companion` this host can execute, or `null`.
 *
 * The half `scripts/check-idb.mjs` and `rover doctor` both need — they ask "does this machine
 * already answer?" and have no use for the failure message the daemon renders
 * (`./idb-companion-path.ts`).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {string} [home]
 * @returns {string | null}
 */
export function findIdbCompanion(env = process.env, platform = process.platform, home = homedir()) {
	for (const { path } of idbCompanionSearchLocations(env, platform, home)) {
		if (path !== null && isExecutableFile(path, platform)) return path;
	}
	return null;
}

/**
 * The `PATH` entries to look in.
 *
 * An empty entry means the working directory on POSIX. Deliberately not honoured, for
 * `../android/adb-locations.mjs`' stated reason: an `idb_companion` in whatever directory a
 * daemon happened to be started from is not a machine that has one, and that directory was
 * inherited from whichever client autostarted it.
 *
 * The POSIX separator is hard-coded rather than taken from `path.delimiter`, because the only
 * platform that reaches this line is macOS.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function pathEntries(env) {
	return (env.PATH ?? '').split(':').filter((entry) => entry !== '');
}
