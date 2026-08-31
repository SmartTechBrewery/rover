/**
 * The {@link ProjectResolver} `./restore.ts` declares, over the hook files of
 * `./project-hooks.ts` (D13, R17).
 *
 * **Three modules rather than one, and the split is load-bearing.** `./project-hooks.ts` reads
 * and parses, so anything may import it; `./hook-command.ts` is the only one that starts a
 * process; and `./restore.ts` — which `./lease-handlers.ts` imports — names the seam and stays
 * free of both. This module is the one line that joins them, and `./listen.ts` is the one line
 * that wires it in.
 *
 * **Nothing is cached** (D6): every call re-reads the file, so an operator editing a hook file
 * changes what the next lease that ends does, with the daemon still running and nothing to
 * restart.
 */

import type { HookCommandContext } from './hook-command.js';
import { runHookCommand } from './hook-command.js';
import { readProjectHooks } from './project-hooks.js';
import type { ProjectResolver } from './restore.js';

export interface ProjectResolverOptions {
	/** Where the hook files are — `ROVER_PROJECTS_PATH`, resolved once in `./main.ts`. */
	readonly root: string;
	/**
	 * Passed through to every hook this resolver runs. A test seam in the spirit of
	 * `DeviceRestorerOptions.teardownTimeoutMs`, not a configuration surface.
	 */
	readonly hookTimeoutMs?: number;
}

/**
 * Resolve a lease's `project` string to what its hook file asks to have undone.
 *
 * `null` for a project with no hook file and for a string that is not an identifier at all —
 * both are the ordinary case (`./project-hooks.ts`). A file that exists and will not parse
 * **throws**, into the containment `./restore.ts` already has for exactly this: one warning
 * naming the project, and a device that is still put back.
 *
 * The teardown is handed over as a closure rather than as data, because that is the shape the
 * seam names: the restorer bounds the *wait* on it and knows nothing about processes.
 */
export function createProjectResolver(options: ProjectResolverOptions): ProjectResolver {
	return async (project, serial, slot) => {
		const hooks = await readProjectHooks(options.root, project);
		if (hooks === null) {
			return null;
		}

		const teardown = hooks.teardown;
		if (teardown === undefined) {
			return { apps: hooks.apps };
		}

		const context: HookCommandContext = {
			project,
			serial,
			slot,
			...(options.hookTimeoutMs === undefined ? {} : { timeoutMs: options.hookTimeoutMs }),
		};
		return { apps: hooks.apps, teardown: () => runHookCommand(teardown, context) };
	};
}
