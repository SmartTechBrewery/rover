/**
 * The CLI's half of the host choice: `--host` in, an exit code out.
 *
 * The **choice itself** — which transport a host name means, and the autostart containment
 * that goes with it — lives in `src/daemon/host.ts`, because the MCP server is a client of a
 * host too (D4, R19) and a second copy of that function would be a second place a transport is
 * chosen. What is left here is the part that is genuinely the CLI's: translating a `--host`
 * string typed by a human, and turning a host nobody configured into exit 2 rather than exit 1.
 *
 * `--host` names which host to ask, and no flag means the local one (R10). Any other value is
 * a loud usage error rather than a connection that hangs or an empty list that looks like an
 * answer.
 */

import {
	connectToHost as connectToChosenHost,
	type HostName,
	LOCAL_HOST,
	REMOTE_HOST,
	REMOTE_VARIABLES,
	RemoteHostUnconfiguredError,
} from '../../daemon/host.js';
import { HOST_ADDRESS_ENV_VAR, HOST_CA_ENV_VAR } from '../../daemon/network-config.js';
import type { IpcClient } from '../../ipc/client.js';
import { UsageError } from './flags.js';

export { type HostName, LOCAL_HOST, REMOTE_HOST } from '../../daemon/host.js';

export function resolveHost(requested: string | undefined): HostName {
	if (requested === undefined || requested === LOCAL_HOST) {
		return LOCAL_HOST;
	}
	if (requested === REMOTE_HOST) {
		return REMOTE_HOST;
	}
	throw new UsageError(
		`Unknown host '${requested}'. There are two: '${LOCAL_HOST}', the daemon on this machine, ` +
			`started for you if it is not running; and '${REMOTE_HOST}', the host ` +
			`${REMOTE_VARIABLES} name (${HOST_CA_ENV_VAR} for a certificate to trust). Omit --host ` +
			`for the local one.`,
	);
}

/**
 * Connect to `host`, translating "no remote host is configured" into a usage error.
 *
 * That translation is the whole reason this wrapper exists. Both shapes of it are exit 2
 * rather than exit 1, and for the same reason: nothing was asked of a host, so neither is a
 * failed operation. Asking for `--host remote` on a machine that was never told where that
 * is — or was told half of it — is the caller's setup, the same class of mistake as a missing
 * `--owner`, and it gets the same answer: the usage text, not a connection error for a
 * connection that was never attempted.
 */
export async function connectToHost(host: HostName): Promise<IpcClient> {
	try {
		return await connectToChosenHost(host);
	} catch (error) {
		if (error instanceof RemoteHostUnconfiguredError) {
			// The half-configured case already names every variable still missing; only the
			// nothing-at-all case gets reworded, because its next step is `--host`, which is
			// vocabulary `src/daemon/host.ts` has no business knowing.
			throw new UsageError(error.unset ? unconfiguredRemoteHost() : error.message);
		}
		throw error;
	}
}

function unconfiguredRemoteHost(): string {
	return (
		`--host ${REMOTE_HOST} needs ${REMOTE_VARIABLES} in the environment, and ` +
		`${HOST_ADDRESS_ENV_VAR} is not set. A remote host is a service its operator runs; ` +
		`export the address, port and token they gave you (plus ${HOST_CA_ENV_VAR} if its ` +
		`certificate is its own), or omit --host to use this machine's own daemon.`
	);
}
