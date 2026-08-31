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
 * **Everything a lease's end undoes on the host comes through here** — the project's teardown
 * hook and, ahead of it, the stops for the helper services its grant started
 * (`./project-services.ts` is the starting half). One resolver rather than two seams, because
 * both are the same question asked of the same file at the same moment, and answering it twice
 * would mean reading the file twice for one lease.
 *
 * **Nothing is cached** (D6): every call re-reads the file, so an operator editing a hook file
 * changes what the next lease that ends does, with the daemon still running and nothing to
 * restart.
 */

import type { HookCommandContext } from './hook-command.js';
import { runHookCommand } from './hook-command.js';
import { readProjectHooks } from './project-hooks.js';
import type { ProjectResolver, ProjectServiceStop } from './restore.js';

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
 * The teardown and the service stops are handed over as closures rather than as data, because
 * that is the shape the seam names: the restorer bounds the *wait* on each and knows nothing
 * about processes.
 *
 * **The services come back in the reverse of the order they are declared in** (R17 phase 4).
 * The grant starts them in declaration order (`./project-services.ts`), so reversing here is
 * what lets a project write a database before the thing that talks to it and have the two go
 * down the other way round. A service declaring no `stop` contributes no step at all, which is
 * what declaring none means.
 */
export function createProjectResolver(options: ProjectResolverOptions): ProjectResolver {
	return async (project, serial) => {
		const hooks = await readProjectHooks(options.root, project);
		if (hooks === null) {
			return null;
		}

		const context: HookCommandContext = {
			project,
			serial,
			...(options.hookTimeoutMs === undefined ? {} : { timeoutMs: options.hookTimeoutMs }),
		};

		const services: ProjectServiceStop[] = [];
		for (const service of [...hooks.services].reverse()) {
			const stop = service.stop;
			if (stop !== undefined) {
				services.push({ name: service.name, stop: () => runHookCommand(stop, context) });
			}
		}

		const teardown = hooks.teardown;
		return {
			apps: hooks.apps,
			// Omitted rather than empty when a project declares none, so "this project has nothing
			// to stop" and "this project has an empty list of things to stop" are not two states.
			...(services.length === 0 ? {} : { services }),
			...(teardown === undefined ? {} : { teardown: () => runHookCommand(teardown, context) }),
		};
	};
}
