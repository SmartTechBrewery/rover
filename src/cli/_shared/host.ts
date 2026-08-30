/**
 * The one place a transport is chosen.
 *
 * `--host` names which host to ask, and no flag means the local one (R10). Today `local`
 * is the only value that resolves to anything: reaching another machine needs the host
 * network listener (PROJECT.md R22), and until that exists any other name is a loud usage
 * error rather than a connection that hangs or an empty list that looks like an answer.
 *
 * This is a **seam, not a registry.** The deployment Rover is built for has exactly one
 * machine with hardware (D18, revised 2026-08-29), so a device handle is a bare serial and
 * nothing here catalogues hosts or aggregates two of them.
 *
 * Autostart (D5) is reachable only through the local arm, because
 * {@link connectToLocalDaemon} is the only thing that arm calls — a client never starts a
 * host across a network. Keeping the choice in one function is what makes that containment
 * a property of the code rather than of every command remembering it.
 */

import { connectToLocalDaemon } from '../../daemon/connect.js';
import type { IpcClient } from '../../ipc/client.js';
import { UsageError } from './flags.js';

/** No flag means this one (R10). */
export const LOCAL_HOST = 'local';

export type HostName = typeof LOCAL_HOST;

export function resolveHost(requested: string | undefined): HostName {
	if (requested === undefined || requested === LOCAL_HOST) {
		return LOCAL_HOST;
	}
	throw new UsageError(
		`Unknown host '${requested}'. '${LOCAL_HOST}' is the only host reachable today; asking ` +
			`another machine needs the host network listener (PROJECT.md R22), which is not built ` +
			`yet. Omit --host for the local one.`,
	);
}

/**
 * Connect to `host`, starting the local daemon if nothing answers (D5).
 *
 * Adds nothing to {@link connectToLocalDaemon} — no probe, no retry, no spawn of its own.
 * Its failures already name the socket, which is what makes an unreachable host a loud
 * failure instead of an empty list.
 */
export async function connectToHost(host: HostName): Promise<IpcClient> {
	if (host !== LOCAL_HOST) {
		// Unreachable while `HostName` has one member. It is the line R22 replaces with a second
		// transport, and until then it keeps "one place chooses" true rather than assumed.
		throw new UsageError(`Unknown host '${String(host)}'`);
	}
	return connectToLocalDaemon();
}
