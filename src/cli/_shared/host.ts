/**
 * The one place a transport is chosen.
 *
 * `--host` names which host to ask, and no flag means the local one (R10). There are two,
 * and there are exactly two: `local`, the daemon on this machine, and `remote`, the one
 * `ROVER_HOST_ADDRESS`, `ROVER_HOST_PORT` and `ROVER_HOST_TOKEN` name. Any other value is a
 * loud usage error rather than a connection that hangs or an empty list that looks like an
 * answer.
 *
 * This is a **seam, not a registry.** The deployment Rover is built for has exactly one
 * machine with hardware (D18, revised 2026-08-29), so a device handle is a bare serial,
 * `remote` is one host rather than the first of many, and nothing here catalogues hosts or
 * aggregates two of them.
 *
 * Autostart (D5) is reachable only through the local arm, because
 * {@link connectToLocalDaemon} is the only thing that arm calls and
 * {@link connectToNetworkHost} starts nothing at all — a client never starts a host across a
 * network. Keeping the choice in one function is what makes that containment a property of
 * the code rather than of every command remembering it.
 */

import { connectToLocalDaemon } from '../../daemon/connect.js';
import {
	HOST_ADDRESS_ENV_VAR,
	HOST_CA_ENV_VAR,
	HOST_PORT_ENV_VAR,
	HOST_TOKEN_ENV_VAR,
	type RemoteHostConfig,
	resolveRemoteHost,
} from '../../daemon/network-config.js';
import { connectToNetworkHost } from '../../daemon/network-connect.js';
import type { IpcClient } from '../../ipc/client.js';
import { UsageError } from './flags.js';

/** No flag means this one (R10). */
export const LOCAL_HOST = 'local';
/** The one host the environment names (D18 — one host per deployment, not the first of many). */
export const REMOTE_HOST = 'remote';

export type HostName = typeof LOCAL_HOST | typeof REMOTE_HOST;

/** What `--host remote` reads, named once so a failure and the docs cannot drift apart. */
const REMOTE_VARIABLES = `${HOST_ADDRESS_ENV_VAR}, ${HOST_PORT_ENV_VAR} and ${HOST_TOKEN_ENV_VAR}`;

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
 * Connect to `host`: the local daemon, starting it if nothing answers (D5), or the remote
 * one, which is never started from here.
 *
 * Adds nothing to either transport — no probe, no retry, no spawn of its own. Their failures
 * already name the socket or the address and port, which is what makes an unreachable host a
 * loud failure instead of an empty list.
 */
export async function connectToHost(host: HostName): Promise<IpcClient> {
	return host === REMOTE_HOST ? connectToNetworkHost(remoteHost()) : connectToLocalDaemon();
}

/**
 * The configured remote host, or a `UsageError`.
 *
 * Both failures are exit 2 rather than exit 1, and for the same reason: nothing was asked of
 * a host, so neither is a failed operation. Asking for `--host remote` on a machine that was
 * never told where that is — or was told half of it — is the caller's setup, the same class
 * of mistake as a missing `--owner`, and it gets the same answer: the usage text, not a
 * connection error for a connection that was never attempted.
 */
function remoteHost(): RemoteHostConfig {
	let configured: RemoteHostConfig | undefined;
	try {
		configured = resolveRemoteHost();
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	if (configured === undefined) {
		throw new UsageError(
			`--host ${REMOTE_HOST} needs ${REMOTE_VARIABLES} in the environment, and ` +
				`${HOST_ADDRESS_ENV_VAR} is not set. A remote host is a service its operator runs; ` +
				`export the address, port and token they gave you (plus ${HOST_CA_ENV_VAR} if its ` +
				`certificate is its own), or omit --host to use this machine's own daemon.`,
		);
	}
	return configured;
}
