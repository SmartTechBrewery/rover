/**
 * Which `adb` this host runs, resolved once and held in memory (#171, D32).
 *
 * The ordered list of places to look is `./adb-locations.mjs` — shared with
 * `scripts/check-adb.mjs` so the install-time warning and the daemon can never disagree about
 * what counts as a machine that has `adb`. This file is the daemon's half of the job: it walks
 * that list, **confirms the candidate actually runs**, and memoises the answer.
 *
 * **Confirmed by running it, not by its mode bits.** The list already skips a path that is not a
 * file this user may execute, and that is as far as an `npm install` may go — it must not leave
 * an adb server behind or hang on a wedged binary. A daemon whose entire job is to run this
 * program is under no such constraint, and mode bits are not the question it needs answered: a
 * binary for the wrong architecture, a wrapper script with a missing interpreter, or a symlink
 * into an SDK that has been deleted all pass a `stat` and fail every verb afterwards. So each
 * candidate is asked for its version, and a candidate that does not answer is treated as not
 * found — the sequence continues to the next one.
 *
 * `adb version` is the acceptance check because it is the one adb subcommand that answers from
 * the client alone: measured on adb 37.0.1 / macOS 15 with `ANDROID_ADB_SERVER_PORT` pointed at
 * an unused port, it printed the client version, exited 0, and **started no server** (PROJECT.md
 * §6). Resolution therefore costs one short-lived process and changes nothing about the adb
 * server the operator already has running.
 *
 * **Nothing is written to disk.** A resolved path is exactly the re-derivable state D6 forbids
 * the daemon from keeping: one recorded before an SDK move or upgrade points at nothing while
 * looking authoritative. The only durable form is the operator's own `ROVER_ADB_PATH`.
 *
 * **A lazy memo rather than resolution at import**, because the unit suites import the runner on
 * machines with no SDK at all and a module that resolved on load would spawn a process to be
 * imported.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import {
	ADB_PATH_ENV_VAR,
	adbCandidates,
	adbSearchLocations,
	describeAdbSearch,
	isExecutableFile,
} from './adb-locations.mjs';

export { ADB_PATH_ENV_VAR };

/**
 * How long one candidate gets to say what version it is.
 *
 * Every external invocation has a timeout (ai/CODING_STANDARDS.md), and this one bounds the
 * search itself: a wedged binary early in the order must not hold up the candidate behind it,
 * let alone the daemon's first verb. Generous rather than tuned — `adb version` neither touches
 * a device nor starts a server, so anything approaching this is a binary that is not going to
 * work anyway, and the timeout is what turns it into "not found" instead of a hang.
 */
export const ADB_VERSION_TIMEOUT_MS = 5_000;

/**
 * Every location was tried and none of them held an `adb` this host can run.
 *
 * The message names **each** place, in the order they were tried, and the setting that overrides
 * all of them — the difference between a failure an operator can act on and `spawn adb ENOENT`
 * repeated once per verb. It is the same list `npm install` prints, from the same code.
 */
export class AdbNotFoundError extends Error {
	constructor(searched: readonly string[]) {
		super(
			[
				"'adb' was not found in any of the locations this host looks in, in this order:",
				...searched.map((line) => `  ${line}`),
				`Set ${ADB_PATH_ENV_VAR} to the 'adb' this host should run, or install the Android ` +
					"SDK's platform-tools.",
			].join('\n'),
		);
		this.name = 'AdbNotFoundError';
	}
}

/** What {@link resolveAdb} reads the machine through, so a suite can describe another one. */
export interface ResolveAdbOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly home?: string;
}

/**
 * Walk the candidate list once and answer with the first `adb` that runs.
 *
 * Unmemoised and injectable — {@link adbExecutable} is what the runners call. Throws {@link
 * AdbNotFoundError} when every candidate has been tried.
 */
export async function resolveAdb(options: ResolveAdbOptions = {}): Promise<string> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();

	for (const candidate of adbCandidates(env, platform, home)) {
		// Cheap first: a `stat` rules out most of the list without a process, and the two checks
		// have the same answer for a caller — a candidate that fails either is not found.
		if (!isExecutableFile(candidate.path, platform)) continue;
		if (await answersVersion(candidate.path)) return candidate.path;
	}

	throw new AdbNotFoundError(describeAdbSearch(adbSearchLocations(env, platform, home)));
}

/**
 * The resolution in flight or already answered — the whole of what "once per daemon lifetime"
 * means, and it lives here rather than anywhere durable (D6).
 */
let resolution: Promise<string> | null = null;

/**
 * The `adb` every runner in `./adb.ts` executes, resolved on first use.
 *
 * **A failure is not memoised**, deliberately, where a success is. `./backend.ts` restarts its
 * device tracker on a backoff precisely so that an `adb` arriving on a running daemon's machine
 * is picked up, and memoising the failure would make the first attempt of a daemon's life the
 * only one. Re-resolving costs a handful of `stat` calls, and reaches a process only for a
 * candidate that exists and will not run — a broken install rather than a machine without one.
 */
export function adbExecutable(): Promise<string> {
	resolution ??= resolveAdb().catch((error: unknown) => {
		resolution = null;
		throw error;
	});
	return resolution;
}

/**
 * Does this file answer as an adb client?
 *
 * Resolves rather than rejects: every way of failing — a non-zero exit, a signal, a timeout, an
 * `ENOENT` from a symlink into a deleted SDK — means the same thing to the search, which is that
 * this candidate is not the one and the next should be tried.
 */
function answersVersion(candidate: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		execFile(candidate, ['version'], { timeout: ADB_VERSION_TIMEOUT_MS }, (error) => {
			resolve(error === null);
		});
	});
}
