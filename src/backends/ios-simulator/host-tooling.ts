/**
 * What this backend needs installed on the host, and the one program it can install itself.
 *
 * Two rows, and they are deliberately asymmetric. `simctl` arrives with Xcode and Rover will never
 * fetch a platform SDK — a 10 GB download nobody asked for, on a machine whose developer tools are
 * the operator's business (D21's instinct, one step out from devices). `idb_companion` has no
 * installer at all, which is exactly why Rover carries one (`./idb-companion-install.ts`).
 *
 * **Both rows say where the thing came from**, not just whether it is there. A host with two Xcodes
 * and the wrong one selected looks identical to a working one until the path is on the page.
 *
 * **The searches are the daemon's own**, imported rather than re-derived: `resolveDeveloperDir` and
 * the `idb_companion` location list are what the verbs resolve through, so `rover doctor` cannot
 * report a machine the daemon would disagree with — #171's rule, one search per program.
 */

import type { HostToolingProvider, HostToolStatus } from '../manifest.js';
import { resolveDeveloperDir, SIMCTL_RELATIVE_PATH } from './developer-dir.js';
import { installIdbCompanion } from './idb-companion-install.js';
import { IDB_COMPANION, IDB_COMPANION_VERSION } from './idb-companion-locations.mjs';
import { resolveIdbCompanion } from './idb-companion-path.js';

/** The programs this backend reports on, and the subset it will fetch. */
export const iosSimulatorHostTooling: HostToolingProvider = {
	describe: async () => [describeSimctl(), describeIdbCompanion()],
	install: async (tool: string) => {
		if (tool !== IDB_COMPANION) {
			// Unreachable through the registry, which only calls this for a tool this provider
			// reported installable — but a provider that trusted its caller would install the wrong
			// thing the day a second one is added.
			throw new Error(`This backend installs '${IDB_COMPANION}', not '${tool}'.`);
		}
		const { path, installed } = await installIdbCompanion();
		return {
			tool: IDB_COMPANION,
			found: path,
			detail: installed
				? `Installed v${IDB_COMPANION_VERSION} at ${path}.`
				: `Already installed at ${path}; nothing was downloaded.`,
			installable: true,
		};
	},
};

/** Xcode's, and therefore the operator's — reported, never fetched. */
function describeSimctl(): HostToolStatus {
	try {
		const developerDir = resolveDeveloperDir();
		return {
			tool: 'simctl',
			found: `${developerDir}/${SIMCTL_RELATIVE_PATH}`,
			detail: `From the developer directory at ${developerDir}.`,
			installable: false,
		};
	} catch (cause) {
		return {
			tool: 'simctl',
			found: null,
			// The search's own message, which already names every place it looked and the variable
			// that overrides them — the actionable half, and not something to paraphrase here.
			detail: messageOf(cause),
			installable: false,
		};
	}
}

/**
 * Rover's, when the operator has none of their own.
 *
 * `installable` stays `true` on a host that already has one, because it describes what Rover *can*
 * do about this program rather than what it needs to do right now — and `installIdbCompanion` is
 * idempotent, so a `--fix` that reaches it answers "already installed" instead of downloading.
 */
function describeIdbCompanion(): HostToolStatus {
	try {
		const found = resolveIdbCompanion();
		return {
			tool: IDB_COMPANION,
			found,
			detail: `Found at ${found}.`,
			installable: true,
		};
	} catch (cause) {
		return {
			tool: IDB_COMPANION,
			found: null,
			// The search's own message, unabridged: it numbers every place it looked, which is the
			// half an operator acts on, and it ends by naming the command that fixes it.
			detail: messageOf(cause),
			installable: true,
		};
	}
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
