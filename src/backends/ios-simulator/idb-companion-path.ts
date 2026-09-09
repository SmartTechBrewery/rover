/**
 * Where this host's `idb_companion` is — the second external program this backend needs, located
 * and **verified**, plus the interruption a caller reports when there is none (`docs/IOS.md` §4).
 *
 * **The order itself lives in `./idb-companion-locations.mjs`**, which is JavaScript so that
 * `scripts/check-idb.mjs` can read it under plain `node` at `npm install` time — the split
 * `../android/adb-locations.mjs` and `../android/adb-path.ts` already make, for #171's reason. What
 * stays here is everything that needs types or the device vocabulary: the failure an operator
 * reads, the `InterruptionCause` a verb reports, and the walk that turns the list into a path.
 *
 * **Three rows**, in this order: the operator's `ROVER_IDB_COMPANION_PATH`, every `PATH` entry,
 * then the copy `rover doctor --fix` unpacks under `~/.rover`. The third one reverses the "there
 * is deliberately no third row" this module shipped with — see the header of the locations module
 * for why that premise stopped holding, and `PROJECT.md` R47 for the decision itself.
 *
 * **Verified by asking the filesystem, not by running the program.** `stat` for a file plus
 * `access(X_OK)`, through `../android/adb-locations.mjs`' `isExecutableFile` — that function is
 * exported, platform-parameterised and already this repository's answer to the question, so a
 * second copy here would only be somewhere for the two to drift apart. Two reasons this stops
 * short of `adb-path.ts`' run-it check:
 *
 * - **A search must not start a companion.** `adb version` is an acceptable acceptance check only
 *   because it was *measured* to start no adb server. `idb_companion --version` prints a build
 *   date and exits (measured on v1.5.2, 2026-09-08) but whether it is free of side effects is not
 *   something this bench established, and one companion process per target is the supervision a
 *   later phase owns — starting one as a side effect of a search is precisely the failure mode
 *   the check would exist to avoid.
 * - Nothing here spawning a process is what lets every suite import this module on a machine that
 *   has never had idb, and on a machine that is not macOS at all — the property `./developer-dir.ts`
 *   states for itself.
 *
 * Tightening the check belongs to the phase that starts a real companion on purpose and can
 * measure what an acceptance flag actually does.
 *
 * **Off macOS the list is empty** and the failure says so, which is what keeps these suites
 * runnable on a Linux CI runner.
 *
 * **Unmemoised**, `./developer-dir.ts`' stance: the search is `stat` and `access` and no process,
 * and holding a *failure* for a daemon's life would make the first attempt of that daemon's life
 * the only one — while an `idb_companion` that arrives on a running host is exactly what a
 * restart-on-a-backoff is there to pick up.
 */

import type { InterruptionCause } from '../../core/device.js';
import { isExecutableFile } from '../android/adb-locations.mjs';
import {
	IDB_COMPANION,
	IDB_COMPANION_PATH_ENV_VAR,
	type IdbCompanionSearchLocation,
	idbCompanionSearchLocations,
} from './idb-companion-locations.mjs';

// Re-exported rather than redefined, so every caller keeps importing the search from the module
// that owns it and there is still exactly one spelling of each (#171).
export {
	IDB_COMPANION,
	IDB_COMPANION_PATH_ENV_VAR,
	IDB_COMPANION_VERSION,
	type IdbCompanionSearchLocation,
	idbCompanionSearchLocations,
	managedIdbCompanion,
	managedIdbCompanionDirectory,
} from './idb-companion-locations.mjs';

/**
 * The interruption a caller reports when this search comes up empty (`src/core/device.ts`).
 *
 * It names the program rather than the platform or idb-the-project, for the reason
 * `SIMCTL_MISSING` and `ADB_NOT_INSTALLED` name theirs: the program is the half a person can act
 * on, and shared code renders the name without ever learning what it is for (ai/RULES.md §2).
 * `InterruptionCauseSchema.tool` is already a free program name, so a backend's *second* program
 * needs nothing from the device interface.
 */
export const IDB_COMPANION_MISSING: InterruptionCause = {
	cause: 'tooling-missing',
	tool: IDB_COMPANION,
};

/**
 * Every place was looked in and none of them held an `idb_companion` this host can run.
 *
 * The message names **each** place, in the order it was tried, and the setting that overrides
 * both — the difference between a failure an operator can act on and `spawn idb_companion ENOENT`
 * once per subscription. A `PATH` entry that contributed a candidate contributes the *file* that
 * was checked rather than the directory, because a directory on `PATH` that does not hold the
 * program is exactly the confusion this failure has to clear up.
 *
 * **What it tells you to do is now one command.** It used to end by naming the variable and
 * saying to unpack a tarball somewhere on `PATH`, which is two decisions an operator had to make
 * before they could act — and the wrong choice of either is silent (`~/.local/bin` is on no stock
 * macOS `PATH`). `rover doctor --fix` installs the pinned release into the last place on this
 * very list, so the instruction and the search cannot disagree.
 */
export class IdbCompanionNotFoundError extends Error {
	constructor(searched: readonly IdbCompanionSearchLocation[]) {
		super(
			[
				`'${IDB_COMPANION}' was not found in any of the locations this host looks in, in this ` +
					'order:',
				...(searched.length === 0
					? ['  (nowhere — idb is macOS-only, and this host is not macOS)']
					: searched.map(
							({ source, path, absent }, index) =>
								`  ${index + 1}. ${source} — ${path ?? absent ?? 'not set'}`,
						)),
				`Run 'rover doctor --fix' to install one, or set ${IDB_COMPANION_PATH_ENV_VAR} to the ` +
					`'${IDB_COMPANION}' this host should run.`,
			].join('\n'),
		);
		this.name = 'IdbCompanionNotFoundError';
	}
}

/** What {@link resolveIdbCompanion} reads the machine through, so a suite can describe another. */
export interface ResolveIdbCompanionOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	/** The home directory the managed row is derived from — `../android/adb-path.ts`' option. */
	readonly home?: string;
}

/**
 * Walk that list once and answer with the first `idb_companion` this host can execute.
 *
 * Throws {@link IdbCompanionNotFoundError} when every place has been tried. A candidate that is
 * not an executable file is *not found* and the sequence continues past it, so a broken leftover
 * early in the order never shadows a working binary later in it.
 */
export function resolveIdbCompanion(options: ResolveIdbCompanionOptions = {}): string {
	const platform = options.platform ?? process.platform;
	const searched = idbCompanionSearchLocations(options.env ?? process.env, platform, options.home);

	for (const { path } of searched) {
		if (path !== null && isExecutableFile(path, platform)) return path;
	}

	throw new IdbCompanionNotFoundError(searched);
}
