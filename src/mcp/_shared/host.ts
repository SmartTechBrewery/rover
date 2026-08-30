/**
 * Which host this server asks — **server configuration, never a tool parameter** (D17).
 *
 * An MCP client launches each server with its own `env` block, so the environment already
 * *is* per-server configuration and there is nothing new to invent: `ROVER_HOST_ADDRESS` set
 * means the remote host, unset or empty means the local daemon. It is the same opt-in switch
 * `rover --host remote` reads, documented in README as the client-side one.
 *
 * **No tool takes a host argument, and an agent cannot see or change which one answered.**
 * Where the hardware sits is the operator's decision, made once when the server is wired up;
 * an agent that could redirect a call would be able to take a lease on a machine nobody
 * pointed it at, and a tool declaration carrying a host would put an address in front of a
 * model that has no way to know a good value for it.
 *
 * The choice is resolved **at startup, before a transport is connected** ({@link
 * resolveConfiguredHost} is called by `../index.ts`), so a server told `ROVER_HOST_ADDRESS`
 * with no port or no token dies with `resolveRemoteHost`'s own message naming every variable
 * still missing — rather than starting, advertising four tools and failing at the agent's
 * first call, which is where a configuration mistake is at its least legible.
 */

import { type HostName, LOCAL_HOST, REMOTE_HOST } from '../../daemon/host.js';
import { resolveRemoteHost } from '../../daemon/network-config.js';

/**
 * The host this server was configured to ask, or a throw naming what is missing.
 *
 * `resolveRemoteHost` answers `undefined` for an unset switch and throws for a half-set one,
 * which is exactly the two-way split this needs — so the switch is read once, here, instead
 * of being re-derived from a variable name this module would otherwise have to know.
 */
export function resolveConfiguredHost(env: NodeJS.ProcessEnv = process.env): HostName {
	return resolveRemoteHost(env) === undefined ? LOCAL_HOST : REMOTE_HOST;
}
