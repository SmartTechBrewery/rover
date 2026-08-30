/**
 * Running a project's own install command — the host half of `install_app` with no bytes
 * (D13, R17 phase 3).
 *
 * **The `./project-resolver.ts` shape, for the other end of a lease.** That module joins
 * `./project-hooks.ts` (which reads and parses, and so may be imported from anywhere) to
 * `./hook-command.ts` (the only module that starts a process) for the teardown a lease ends
 * with; this one joins the same two for the install a lease is asked for while it is held.
 * Neither seam is filled by the verb layer, and that is mechanical rather than stylistic:
 * `src/ipc/verb-methods.ts` imports the verb schemas, so a spawn under `src/verbs/` would be a
 * spawn in every client's module graph (D19, `tests/unit/daemon/remote-never-spawns.test.ts`).
 * `src/verbs/files.ts` names the shape (`ProjectInstaller`); this supplies it, exactly as
 * `./frames.ts` supplies the frame extractor.
 *
 * **Every way this can go wrong is named data.** A project nobody registered, a hook file that
 * declares no `install`, and a command that ran and did not succeed are three answers an agent
 * acts on differently, so they are three verb-layer errors (`src/verbs/errors.ts`) and never
 * `internal_error` — which keeps that code meaning "the host broke".
 *
 * **Nothing is cached** (D6), for `./project-resolver.ts`'s reason: the file is re-read on every
 * call, so an operator editing a project's install command changes what the next call does with
 * the daemon still running.
 */

import type { DeviceSerial } from '../core/ids.js';
import {
	InstallHookFailedError,
	InstallHookUndeclaredError,
	ProjectNotRegisteredError,
} from '../verbs/errors.js';
import { INSTALL_HOOK_TIMEOUT_MS } from '../verbs/files.js';
import { HookCommandFailedError, runHookCommand } from './hook-command.js';
import { readProjectHooks } from './project-hooks.js';

/**
 * How a lease's `project` and its device become an install that has happened.
 *
 * Takes both, and takes them separately, for the reason `ProjectResolver` does
 * (`./restore.ts`): the project selects the hook file and the serial is what the command is
 * told to install onto, and neither is derivable from the other. Both come off the lease and
 * nothing a caller sent, which is what makes an install land on the leased device and never on
 * a neighbour's — the worst failure this tool has, and one that looks like success from both
 * sides (PROJECT.md §2).
 *
 * **And a way to stop one that is still running.** A build is the longest thing a verb call
 * awaits on this host and it is not a backend call, so `./verb-traffic.ts`'s guard cannot reach
 * it: revoking a backend stops the *next* method, and a spawned process has none. So
 * `./verb-handlers.ts` hands the verb call's own signal down, and a `release_device` — or an
 * expiry — kills the child instead of leaving `VerbTraffic.settle`, the restoration behind it
 * and every later `acquire_device` on that device parked for the rest of
 * `INSTALL_HOOK_TIMEOUT_MS`. Optional because the signal belongs to a verb call: a caller
 * without one gets the budget and nothing else.
 */
export type ProjectInstall = (
	project: string,
	serial: DeviceSerial,
	signal?: AbortSignal,
) => Promise<void>;

export interface ProjectInstallOptions {
	/** Where the hook files are — `ROVER_PROJECTS_PATH`, resolved once in `./main.ts`. */
	readonly root: string;
	/**
	 * Defaults to `INSTALL_HOOK_TIMEOUT_MS` (`src/verbs/files.ts`), which is where the bound and
	 * its relationship to the lease TTL and the client's request timeout are stated. A test seam
	 * in the spirit of `ProjectResolverOptions.hookTimeoutMs`, not a configuration surface — a
	 * real five-minute bound and a unit test cannot both be in the same run.
	 */
	readonly hookTimeoutMs?: number;
}

/**
 * The {@link ProjectInstall} `./verb-handlers.ts` hands to `installProjectApp`.
 *
 * @throws ProjectNotRegisteredError when `project` has no hook file on this host — which
 *   includes a `project` string that is not a hook-file identifier at all, since that names no
 *   file either (`./project-hooks.ts`).
 * @throws InstallHookUndeclaredError when the file exists and declares no `install`.
 * @throws InstallHookFailedError when the command ran and did not succeed.
 */
export function createProjectInstall(options: ProjectInstallOptions): ProjectInstall {
	return async (project, serial, signal) => {
		// Throws for a file that exists and will not parse, and that throw is *not* contained
		// here the way `./restore.ts` contains the resolver's: a teardown swallowing it still
		// leaves the device restored, while an install swallowing it would report the caller's
		// application installed by a host that never read the command. It becomes an
		// `internal_error` naming the file, which is what an operator has to fix.
		const hooks = await readProjectHooks(options.root, project);
		if (hooks === null) {
			throw new ProjectNotRegisteredError(serial, project);
		}

		const install = hooks.install;
		if (install === undefined) {
			throw new InstallHookUndeclaredError(serial, project);
		}

		try {
			await runHookCommand(install, {
				project,
				serial,
				timeoutMs: options.hookTimeoutMs ?? INSTALL_HOOK_TIMEOUT_MS,
				// Omitted rather than passed as `undefined`, so a caller without a verb call behind
				// it reads as one that never had a signal.
				...(signal === undefined ? {} : { signal }),
			});
		} catch (error) {
			if (error instanceof HookCommandFailedError) {
				// The runner's vocabulary becoming the verb layer's, the way a backend's
				// `FileTooLargeError` becomes `ArtifactTooLargeError`: what reaches an agent is one
				// named answer it can branch on, and the exit code and the stderr tail the runner
				// already captured travel with it rather than being re-derived from a message.
				throw new InstallHookFailedError({
					serial,
					project,
					command: error.command,
					exitCode: error.exitCode,
					signal: error.signal,
					stderr: error.stderr,
					outcome: error.outcome,
				});
			}
			throw error;
		}
	};
}
