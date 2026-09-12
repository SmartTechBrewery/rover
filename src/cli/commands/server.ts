/**
 * `rover server` — run this machine's Rover host in the foreground.
 *
 * **The same daemon every other command autostarts** (D5), started on purpose instead. The two
 * differ in the two ways that matter, and both are the reason this command exists:
 *
 * - **You see what it says.** An autostarted daemon's stderr is discarded, which is right for a
 *   process nobody asked for — but it is also every warning about a device that vanished, a
 *   project hook that failed and a host process left behind.
 * - **It may be reachable.** `ROVER_LISTEN_PORT` and `ROVER_HTTP_PORT` are cleared in any daemon a
 *   client brings up behind you, so a host other machines or the panel can reach has to be started
 *   deliberately (D17, D29) — and until now that meant `npm run daemon` from inside Rover's own
 *   checkout, which is not somewhere an operator necessarily is.
 *
 * **It asks no host and takes no `--host`**, which puts it with `users`, `init` and `doctor`'s
 * plain form: it does not talk to a host, it *becomes* one, and always this machine's. Starting a
 * host on another machine is that machine's operator's business (D17).
 *
 * **It spawns rather than imports**, and that is not an implementation detail: the daemon reaches
 * every device backend, and a client that imported it would be a client that can drive a device
 * (D19, `tests/unit/no-backend-in-a-client.test.ts`). So the entry comes from
 * `src/daemon/connect.ts`, which already owns where that file is, and the spawning from
 * `../_shared/foreground.ts`, which owns doing it once.
 */

import { daemonForegroundCommand } from '../../daemon/connect.js';
import { attemptConnect } from '../../daemon/socket-connect.js';
import { resolveSocketPath } from '../../daemon/socket-path.js';
import { createIpcClient } from '../../ipc/client.js';
import { EXIT_FAILED, EXIT_OK } from '../_shared/exit.js';
import { expectPositionals, parseCommandArgs } from '../_shared/flags.js';
import { runInForeground } from '../_shared/foreground.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover server — run this machine's Rover host in the foreground

Usage: rover server

Starts the daemon and stays attached to it: its log is this terminal's, and Ctrl-C stops it
through its own shutdown, which releases the leases it holds and ends what its backends
started. Every other command starts one of these by itself when none is running — what this
adds is that you can see it, and that it keeps the two settings an autostarted one drops.

  ROVER_LISTEN_PORT   serve the surface to other machines over TCP
  ROVER_HTTP_PORT     serve the panel and its data to a browser — this is the whole of it
  ROVER_SOCKET_PATH   the local socket, when the default is not wanted

Those two ports are exposure somebody has to choose, so a daemon a client autostarts clears
them and this one does not. Read on this machine, where the devices are.

Exits 1 without starting anything when another host already holds the socket — it names the
one that is there rather than replacing it. There is no --host: this runs a host here, and
never on another machine.`;

export async function run(argv: string[]): Promise<number> {
	// No GLOBAL_OPTIONS: `--host` would be a contradiction and `--json` has nothing to answer —
	// what this command emits is another process's log, for as long as that process lives.
	const { values, positionals } = parseCommandArgs('server', argv, {
		help: { type: 'boolean', short: 'h' },
	});
	if (values.help === true) {
		out.info(USAGE);
		return EXIT_OK;
	}
	expectPositionals('server', positionals, []);

	const socketPath = resolveSocketPath();
	const running = await hostAlreadyThere(socketPath);
	if (running !== null) {
		out.error(running);
		return EXIT_FAILED;
	}

	return runInForeground(daemonForegroundCommand(socketPath));
}

/**
 * The host already holding this socket, described — or `null` when the path is free.
 *
 * **This exists because the daemon's own answer is silence.** Losing the bind is a *success* for
 * the process that loses it (`src/daemon/main.ts`): three clients racing to autostart produce two
 * children that exit 0 saying nothing, which is right for a start nobody asked for and useless for
 * one somebody typed — the terminal would come straight back with no host and no reason.
 *
 * **It probes without starting anything.** `attemptConnect` rather than `connectToHost`, because
 * the latter *is* the autostart (D5) and would make asking whether a host is running the thing
 * that starts one.
 *
 * **The race it leaves is the one it should.** A daemon that appears between this probe and the
 * spawn is not caught here — and lands on exactly the path above, exiting quietly, which is the
 * behaviour this replaces rather than a regression. Reporting the winner accurately in that window
 * would take a handshake with a process that has not started yet.
 */
async function hostAlreadyThere(socketPath: string): Promise<string | null> {
	const attempt = await attemptConnect(socketPath);
	if (attempt.outcome !== 'connected') return null;

	const client = createIpcClient(attempt.socket);
	try {
		const status = await client.request('status', {});
		return (
			`A Rover host is already serving this machine — pid ${status.pid}, up for ` +
			`${out.formatDuration(status.uptimeMs)}. Nothing was started. Stop that one first, or ` +
			'leave it: every command finds it on its own.'
		);
	} catch {
		// Something holds the socket and will not answer the surface. Not this command's to
		// diagnose or to clear away — `src/daemon/listen.ts` owns a stale path — and starting a
		// second host at it is the one thing that must not happen either.
		return `Something is holding this machine's Rover socket but did not answer as a host. Nothing was started.`;
	} finally {
		await client.close();
	}
}
