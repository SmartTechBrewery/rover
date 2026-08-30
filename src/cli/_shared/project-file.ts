/**
 * The CLI's half of `ROVER_PROJECT_FILE`: a hook file in, a `--project` default out.
 *
 * The **reading** lives in `src/daemon/project-hooks.ts`, because the MCP server defaults the
 * same argument from the same file and two readers would be two answers. What is left here is
 * the part that is genuinely the CLI's: turning a file that is missing or will not parse into
 * exit 2 rather than exit 1.
 *
 * That is the same call `./host.ts` makes about an unconfigured `--host remote`, for the same
 * reason. Nothing was asked of a host, so nothing failed; a variable pointing at a file that
 * is not there is the caller's own setup, the same class of mistake as a missing `--owner`,
 * and it gets the same answer: the message, the command's usage under it, and exit 2.
 *
 * **The file is read whenever the variable is set, even when `--project` was typed.** The flag
 * still wins — that is `./flags.ts`'s `attributionWithDefault` — but a broken configuration that only
 * surfaced on the invocations where somebody happened to leave the flag off would be an
 * intermittent failure, and this is the loud one D22 asks for.
 */

import { type ConfiguredProject, readConfiguredProject } from '../../daemon/project-hooks.js';
import { UsageError } from './flags.js';

/** The project the configured hook file supplies, or `undefined` when none is configured. */
export async function configuredProject(command: string): Promise<ConfiguredProject | undefined> {
	try {
		return await readConfiguredProject();
	} catch (error) {
		throw new UsageError(
			`rover ${command}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
