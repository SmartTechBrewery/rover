/**
 * Who, if anybody, is already serving this machine's Rover socket — asked **without starting one**.
 *
 * **This exists because the daemon's own answer is silence.** Losing the bind is a *success* for
 * the process that loses it (`./main.ts`): three clients racing to autostart produce two children
 * that exit 0 saying nothing, which is right for a start nobody asked for and useless for one
 * somebody typed — the terminal would come straight back with no host and no reason.
 *
 * **It probes without starting anything.** `attemptConnect` rather than `connectToLocalDaemon`,
 * because the latter *is* the autostart (D5) and would make asking whether a host is running the
 * thing that starts one. That property is the whole reason this module is separate: it has
 * **two** callers now, and both of them are guards that must never create what they are checking
 * for — `src/cli/commands/server.ts`, which refuses to start a second host, and
 * `scripts/host-on-socket.mjs`, which is how `bin/rover-server-agent install` refuses to install a
 * launchd agent that would crash-loop against a socket somebody else holds. A second, independently
 * written check is exactly the thing that eventually disagrees with this one, and the two disagreeing
 * answers would be *a host is already there* and *install a `KeepAlive` job anyway*.
 *
 * **The race it leaves is the one it should.** A daemon that appears between this probe and
 * whatever the caller does next is not caught here — and lands on exactly the path above, exiting
 * quietly, which is the behaviour this replaces rather than a regression. Reporting the winner
 * accurately in that window would take a handshake with a process that has not started yet.
 */

import { createIpcClient } from '../ipc/client.js';
import { attemptConnect } from './socket-connect.js';

export type HostOnSocket =
	/** Nothing is listening. Starting a host here is safe, modulo the race above. */
	| { readonly outcome: 'free' }
	/** A Rover host answered the surface, and said which process it is. */
	| { readonly outcome: 'host'; readonly pid: number; readonly uptimeMs: number }
	/**
	 * Something holds the path and will not answer as a host. Not this module's to diagnose or to
	 * clear away — `./listen.ts` owns a stale path — and starting a second host at it is the one
	 * thing that must not happen either.
	 */
	| { readonly outcome: 'foreign' };

/** The {@link HostOnSocket} for `socketPath`, having started nothing. */
export async function hostOnSocket(socketPath: string): Promise<HostOnSocket> {
	const attempt = await attemptConnect(socketPath);
	if (attempt.outcome !== 'connected') {
		return { outcome: 'free' };
	}

	const client = createIpcClient(attempt.socket);
	try {
		const status = await client.request('status', {});
		return { outcome: 'host', pid: status.pid, uptimeMs: status.uptimeMs };
	} catch {
		return { outcome: 'foreign' };
	} finally {
		await client.close();
	}
}
