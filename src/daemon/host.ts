/**
 * The one place a transport is chosen.
 *
 * There are two hosts, and there are exactly two: `local`, the daemon on this machine, and
 * `remote`, the one `ROVER_HOST_ADDRESS`, `ROVER_HOST_PORT` and `ROVER_HOST_TOKEN` name.
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
 *
 * **It lives here rather than under `src/cli/` because there are two clients** (D4, R19): the
 * CLI picks its host from `--host` and the MCP server picks its host from its own environment
 * (D17), and a copy of this function under `src/mcp/` would be the second place a transport is
 * chosen — the thing the paragraph above exists to prevent. Nothing in this module knows how
 * either client was asked; `src/cli/_shared/host.ts` keeps the `--host` translation and the
 * exit codes, and `src/mcp/_shared/host.ts` keeps the environment one.
 *
 * It sits beside `./connect.ts` and `./network-connect.ts`, the client halves of the two
 * transports, rather than becoming a fifth top-level component. Nothing here loads the
 * daemon: a client importing this module gets the two connectors and no host.
 */

import type { IpcClient } from '../ipc/client.js';
import { connectToLocalDaemon } from './connect.js';
import {
	HOST_ADDRESS_ENV_VAR,
	HOST_CA_ENV_VAR,
	HOST_PORT_ENV_VAR,
	HOST_TOKEN_ENV_VAR,
	type RemoteHostConfig,
	resolveRemoteHost,
} from './network-config.js';
import { connectToNetworkHost } from './network-connect.js';

/** The host on this machine — the zero-config one, and what a client falls back to (R10). */
export const LOCAL_HOST = 'local';
/** The one host the environment names (D18 — one host per deployment, not the first of many). */
export const REMOTE_HOST = 'remote';

export type HostName = typeof LOCAL_HOST | typeof REMOTE_HOST;

/** What the remote host is configured from, named once so a failure and the docs cannot drift. */
export const REMOTE_VARIABLES = `${HOST_ADDRESS_ENV_VAR}, ${HOST_PORT_ENV_VAR} and ${HOST_TOKEN_ENV_VAR}`;

/**
 * A remote host was asked for and the environment does not name one.
 *
 * Its own type rather than a bare `Error` because it is the one failure here that is a
 * **setup** problem rather than a failed operation: nothing was asked of a host, so the CLI
 * turns it into exit 2 and its own usage text (`src/cli/_shared/host.ts`). `unset` separates
 * the two shapes of it — nothing at all configured, versus half configured — because only the
 * first has a next step a client words in its own vocabulary, and the second already carries
 * `resolveRemoteHost`'s message naming every variable still missing.
 */
export class RemoteHostUnconfiguredError extends Error {
	/** Nothing names a remote host at all, as opposed to a half-configured one. */
	readonly unset: boolean;

	constructor(message: string, unset: boolean) {
		super(message);
		this.name = 'RemoteHostUnconfiguredError';
		this.unset = unset;
	}
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
 * The configured remote host, or a {@link RemoteHostUnconfiguredError}.
 *
 * Both failures are the same class of mistake — a client told to ask a host it was never told
 * how to reach, or was told half of — and neither is a connection error, because no
 * connection was attempted.
 */
function remoteHost(): RemoteHostConfig {
	let configured: RemoteHostConfig | undefined;
	try {
		configured = resolveRemoteHost();
	} catch (error) {
		throw new RemoteHostUnconfiguredError(
			error instanceof Error ? error.message : String(error),
			false,
		);
	}
	if (configured === undefined) {
		throw new RemoteHostUnconfiguredError(
			`Nothing names a remote host: ${REMOTE_VARIABLES} name one, and ` +
				`${HOST_ADDRESS_ENV_VAR} is not set. A remote host is a service its operator runs; ` +
				`export the address, port and token they gave you (plus ${HOST_CA_ENV_VAR} if its ` +
				`certificate is its own).`,
			true,
		);
	}
	return configured;
}
