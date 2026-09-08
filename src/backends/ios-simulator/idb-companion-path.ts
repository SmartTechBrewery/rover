/**
 * Where this host's `idb_companion` is — the second external program this backend needs, located
 * and **verified**, plus the interruption a caller reports when there is none (`docs/IOS.md` §4).
 *
 * Modelled on `./developer-dir.ts` rather than on `../android/adb-path.ts`, and it should read
 * like it: a bounded list of places, each row kept whether or not it named anything, and
 * acceptance decided by the filesystem.
 *
 * **Two rows, and there is deliberately no third.** `adb` gets four more because the Android SDK
 * *has* a canonical location per platform; this program has none at all. `brew` no longer carries
 * `idb-companion` — the old `facebook/fb` tap is gone — so the supported install is the release's
 * `idb-companion.macos-arm64.tar.gz` unpacked wherever the operator put it (`docs/IOS.md` §4).
 * That is the argument `README.md` already makes for `ffmpeg`: no canonical install location, so
 * `PATH` remains the right answer. What this program adds on top of that case is the override,
 * and it is necessary rather than speculative — a tarball unpacked into a scratch directory is on
 * no `PATH` at all, least of all the short one a GUI-launched daemon inherits (D5). **Never a
 * walk of the disk** (D32).
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

import { join } from 'node:path';
import type { InterruptionCause } from '../../core/device.js';
import { isExecutableFile } from '../android/adb-locations.mjs';

/** The program, named the way an operator would name it. */
export const IDB_COMPANION = 'idb_companion';

/** The one setting that overrides the whole search below. */
export const IDB_COMPANION_PATH_ENV_VAR = 'ROVER_IDB_COMPANION_PATH';

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
 * One place the search consults, and the file it named — or `null` when it named nothing.
 *
 * **A place that yielded nothing stays on the list**, which is `../android/adb-locations.mjs`'
 * rule and for its reason: *"this variable is not set"* is the actionable half of the failure,
 * and without it the numbering below would mean a different place on every machine.
 */
export interface IdbCompanionSearchLocation {
	/** What this place is, named the way a person would name it. */
	readonly source: string;
	/** The executable it named — already the file, not a directory holding it — or `null`. */
	readonly path: string | null;
	/** What to say in place of a path when it named nothing. */
	readonly absent?: string;
}

/**
 * Every place was looked in and none of them held an `idb_companion` this host can run.
 *
 * The message names **each** place, in the order it was tried, and the setting that overrides
 * both — the difference between a failure an operator can act on and `spawn idb_companion ENOENT`
 * once per subscription. A `PATH` entry that contributed a candidate contributes the *file* that
 * was checked rather than the directory, because a directory on `PATH` that does not hold the
 * program is exactly the confusion this failure has to clear up.
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
				`Set ${IDB_COMPANION_PATH_ENV_VAR} to the '${IDB_COMPANION}' this host should run, or ` +
					"unpack idb's release tarball somewhere on PATH — there is no canonical install " +
					'location for this program and Homebrew no longer carries it.',
			].join('\n'),
		);
		this.name = 'IdbCompanionNotFoundError';
	}
}

/** What {@link resolveIdbCompanion} reads the machine through, so a suite can describe another. */
export interface ResolveIdbCompanionOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
}

/**
 * The places to look, in order, whether or not each named anything.
 *
 * The operator's own setting, then the environment the daemon inherited — and nothing else, for
 * the reason in the header. Off macOS the list is empty: there is no companion to find, which is
 * also what lets the suites here run unchanged on a Linux CI runner.
 *
 * Each `PATH` entry contributes its own row — see the comment on it below.
 */
export function idbCompanionSearchLocations(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): IdbCompanionSearchLocation[] {
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
	];
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
	const searched = idbCompanionSearchLocations(options.env ?? process.env, platform);

	for (const { path } of searched) {
		if (path !== null && isExecutableFile(path, platform)) return path;
	}

	throw new IdbCompanionNotFoundError(searched);
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
 */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
	return (env.PATH ?? '').split(':').filter((entry) => entry !== '');
}
