/**
 * Run one long-lived process in the foreground, as a child of this CLI, and answer its exit code.
 *
 * The **one** place a client starts a process on purpose. `src/daemon/connect.ts` is the other
 * module allowed to spawn and it is the *automatic* start — a daemon nobody asked for, detached,
 * its output discarded (D5). This is the opposite case in every respect, and both of the commands
 * that need it — `rover server` and `rover panel` — need exactly the same three things, so they
 * share one implementation rather than each growing its own signal handling to get subtly wrong.
 * `tests/unit/daemon/remote-never-spawns.test.ts` and
 * `tests/unit/no-backend-in-a-client.test.ts` both name this file, which is what keeps the count of
 * such places at two.
 *
 * - **The output is the operator's.** `stdio: 'inherit'`, so a host's warnings and a dev server's
 *   URL arrive in the terminal that asked for them.
 * - **It dies with you.** Not detached, and the two signals are forwarded rather than left to the
 *   process group, so a `kill` aimed at this process still reaches the child — which matters for
 *   the daemon, whose shutdown path is what releases the leases and ends what its backends started.
 * - **It exits as a shell expects.** The child's code, or `128 + n` when a signal ended it.
 *
 * It never asks whether the thing is already running. Both children answer that question properly
 * themselves — the daemon by losing the bind, a dev server by failing to take its port — and a
 * check here would be a race with whatever else is coming up at the same moment.
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export interface ForegroundCommand {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
	/** The program, when it is not this Node. Absent means `process.execPath`. */
	readonly command?: string;
}

export function runInForeground(command: ForegroundCommand): Promise<number> {
	const child = spawn(command.command ?? process.execPath, [...command.args], {
		stdio: 'inherit',
		cwd: command.cwd,
		env: command.env ?? process.env,
	});

	const handlers = (['SIGINT', 'SIGTERM'] as const).map(
		(signal) => [signal, () => child.kill(signal)] as const,
	);
	for (const [signal, handler] of handlers) process.on(signal, handler);

	return new Promise<number>((resolve, reject) => {
		child.on('error', reject);
		child.on('exit', (code, signal) => {
			for (const [name, handler] of handlers) process.off(name, handler);
			resolve(code ?? (signal === null ? 0 : 128 + (constants.signals[signal] ?? 0)));
		});
	});
}
