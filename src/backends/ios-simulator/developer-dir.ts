/**
 * Which developer directory this backend will drive `simctl` from, located and **verified**
 * (`docs/IOS.md` §1).
 *
 * **Verified by asking the filesystem, not by running the binary** — the one deliberate
 * departure from `../android/adb-path.ts`, which accepts a candidate only once it has answered
 * `adb version`. For this failure mode the cheaper test is also the sharper one. Every
 * measurement in `docs/IOS.md` was taken on a machine whose `xcode-select -p` pointed at
 * `/Library/Developer/CommandLineTools`, where `xcrun simctl` fails with *"unable to find utility
 * simctl"*; that directory is still present on this one — macOS 26.6.2 (25G83), 2026-09-08 — and
 * still holds no `usr/bin/simctl`. That is the state a Mac is most likely to be in while looking
 * fully equipped, so the existence of a developer directory proves nothing and the utility inside
 * it is the whole question. A version call would answer it no better and would cost this module
 * the property that makes it importable anywhere: **nothing here spawns a process**, so the
 * search is `stat`, `access` and `readlink`, and a machine that has never had Xcode can run every
 * suite over it.
 *
 * **`/var/db/xcode_select_link` is the durable form of `xcode-select -p`, not a documented
 * interface.** It is a symlink to the selected developer directory — verified on macOS 26.6.2
 * (25G83), 2026-09-08, pointing at `/Applications/Xcode.app/Contents/Developer` — which is what
 * lets the operator's own selection be read with no process at all. Should Apple move it, the
 * candidate simply stops resolving and the standard install location behind it still answers, so
 * the cost of the assumption being wrong is bounded to losing a non-default selection.
 *
 * **`DEVELOPER_DIR` is Apple's variable, not a Rover setting.** Nothing new is being configured
 * here (ai/RULES.md §7): `xcrun` already honours it, every measurement in `docs/IOS.md` was
 * taken through it, and honouring it is what makes a machine whose `xcode-select` points at the
 * Command Line Tools workable at all.
 *
 * **Unmemoised.** Holding the answer for a process's life, and the rule that a *failure* must not
 * be held, are both daemon lifecycle and belong with the backend row that starts something on a
 * backoff — not here. Re-running this search costs a handful of `stat` calls and no process.
 */

import { accessSync, constants, readlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { InterruptionCause } from '../../core/device.js';

/** The one variable that overrides the whole search below — Apple's own, see the header. */
export const DEVELOPER_DIR_ENV_VAR = 'DEVELOPER_DIR';

/** Where `simctl` sits inside a developer directory, and the whole of what verifies one. */
export const SIMCTL_RELATIVE_PATH = 'usr/bin/simctl';

/** The symlink `xcode-select` writes its selection to (header). */
export const XCODE_SELECT_LINK = '/var/db/xcode_select_link';

/** Where Xcode's own installer puts it, and the only install location guessed at. */
const APPLICATIONS_ROOT = '/Applications';
const XCODE_DEVELOPER_DIR = join('Xcode.app', 'Contents', 'Developer');

/**
 * The interruption a caller reports when this search comes up empty (`src/core/device.ts`).
 *
 * It names `simctl` rather than Xcode or the platform, for the reason `ADB_NOT_INSTALLED` names
 * `adb`: the program is the half a person can act on, and shared code renders the name without
 * ever learning what it is for (ai/RULES.md §2). This is the `tooling-missing` case in its purest
 * form — a Command Line Tools selection will not start carrying `simctl` on its own, so every
 * attempt fails identically forever until somebody installs Xcode or points this elsewhere.
 */
export const SIMCTL_MISSING: InterruptionCause = { cause: 'tooling-missing', tool: 'simctl' };

/**
 * Every place was looked in and none of them held a `simctl` this host can run.
 *
 * The message names **each** place, in the order it was tried, and the variable that overrides
 * all of them — the difference between a failure an operator can act on and the same opaque
 * "utility not found" once per verb. Each line is the `simctl` path that was checked rather than
 * the developer directory holding it, because a directory that exists while the utility inside it
 * does not is exactly the confusion this failure has to clear up.
 */
export class SimctlNotFoundError extends Error {
	constructor(searched: readonly string[]) {
		super(
			[
				"'simctl' was not found under any of the developer directories this host looks in, in " +
					'this order:',
				...(searched.length === 0
					? ['  (nowhere — a developer directory is macOS-only, and this host is not macOS)']
					: searched.map((directory, index) => `  ${index + 1}. ${simctlIn(directory)}`)),
				`Set ${DEVELOPER_DIR_ENV_VAR} to the developer directory this host should use, or ` +
					'install Xcode — the Command Line Tools alone do not carry simctl.',
			].join('\n'),
		);
		this.name = 'SimctlNotFoundError';
	}
}

/** What {@link resolveDeveloperDir} reads the machine through, so a suite can describe another. */
export interface ResolveDeveloperDirOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly selectLinkPath?: string;
	readonly applicationsRoot?: string;
}

/**
 * The developer directories to look in, in order, whether or not each holds anything.
 *
 * The operator's `DEVELOPER_DIR`, then their `xcode-select` selection, then the one location
 * Xcode's installer uses — a bounded list rather than a walk of the disk, and one standard
 * location rather than every layout anybody has ever had, following `../android/adb-locations.mjs`
 * for both. Off macOS it is empty: there is no developer directory to find, which is also what
 * lets the suites here run unchanged on a Linux CI runner.
 */
export function developerDirSearchLocations(options: ResolveDeveloperDirOptions = {}): string[] {
	if ((options.platform ?? process.platform) !== 'darwin') return [];

	const env = options.env ?? process.env;
	// Empty counts as unset, as it does for every other variable Rover reads: an
	// exported-but-blank variable is what a shell leaves behind, and reading one as a real
	// selection would point the search at a relative path.
	const named = env[DEVELOPER_DIR_ENV_VAR];
	const selected = selectedDeveloperDir(options.selectLinkPath ?? XCODE_SELECT_LINK);

	// Deduped preserving order: `DEVELOPER_DIR` naming the same Xcode `xcode-select` already
	// selects is the ordinary case, and reporting it twice tells nobody anything.
	return [
		...new Set([
			...(named === undefined || named === '' ? [] : [named]),
			...(selected === null ? [] : [selected]),
			join(options.applicationsRoot ?? APPLICATIONS_ROOT, XCODE_DEVELOPER_DIR),
		]),
	];
}

/**
 * Walk that list once and answer with the first developer directory holding a usable `simctl`.
 *
 * Throws {@link SimctlNotFoundError} when every place has been tried.
 */
export function resolveDeveloperDir(options: ResolveDeveloperDirOptions = {}): string {
	const searched = developerDirSearchLocations(options);
	for (const candidate of searched) {
		if (holdsSimctl(candidate)) return candidate;
	}
	throw new SimctlNotFoundError(searched);
}

/**
 * What `xcode-select -p` would answer, read as the symlink it is, or `null` when there is no
 * selection to read — a missing link, or a path that is not one at all.
 *
 * `resolve` against the link's own directory, so a relative target means what the filesystem
 * means by it rather than something relative to whatever directory this process was started in.
 */
function selectedDeveloperDir(link: string): string | null {
	try {
		return resolve(dirname(link), readlinkSync(link));
	} catch {
		return null;
	}
}

/**
 * Does this developer directory hold a `simctl` this user may execute?
 *
 * A candidate that fails is *not found* and the sequence continues past it, so a Command Line
 * Tools selection never shadows a working Xcode behind it. Windows needs none of
 * `../android/adb-locations.mjs`' `PATHEXT` care: the only platform reaching this has one name
 * for the utility and honours the execute bit.
 */
function holdsSimctl(developerDir: string): boolean {
	const simctl = simctlIn(developerDir);
	try {
		if (!statSync(simctl).isFile()) return false;
		accessSync(simctl, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function simctlIn(developerDir: string): string {
	return join(developerDir, SIMCTL_RELATIVE_PATH);
}
