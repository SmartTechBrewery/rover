/**
 * Temp-directory sockets and daemon-process cleanup for `tests/unit/daemon/` and
 * `tests/unit/cli/`.
 *
 * These tests run against a **real** unix socket and, for autostart, real child processes
 * (ai/TESTING.md "The daemon suite is the exception"), so every one of them has to leave
 * the machine as it found it: no socket file in `~/.rover/`, no daemon still listening
 * after the run. That is what this module is for.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Observation, pause, waitForCondition } from '@/core/wait.js';
import { attemptConnect } from '@/daemon/socket-connect.js';
import { createIpcClient, type IpcClient } from '@/ipc/client.js';

/** Long enough for a killed process to be reaped, short enough to fail a stuck test. */
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const PROCESS_POLL_INTERVAL_MS = 25;

/**
 * How long the path has to stay unserved before {@link stopDaemonAt} calls it drained.
 *
 * Comfortably above the measured ~350 ms a spawned daemon takes to bind on this hardware,
 * because that latency is exactly what the drain is racing — see the note there.
 */
const DRAIN_QUIET_MS = 1_000;
const DRAIN_TIMEOUT_MS = 20_000;

export interface TempSocket {
	/** The temp directory holding the socket. Removed by {@link removeTempSocket}. */
	readonly dir: string;
	readonly socketPath: string;
}

/**
 * A socket path nobody else uses. Never `~/.rover/rover.sock`: a test that bound the real
 * default would take the developer's own daemon down mid-run.
 */
export async function createTempSocket(): Promise<TempSocket> {
	const dir = await mkdtemp(join(tmpdir(), 'rover-'));
	return { dir, socketPath: join(dir, 'rover.sock') };
}

export async function removeTempSocket(temp: TempSocket): Promise<void> {
	await rm(temp.dir, { recursive: true, force: true });
}

/**
 * Connect to a daemon **without** autostarting one, resolving `null` when nothing answers.
 *
 * `connectToLocalDaemon` deliberately starts a daemon when it finds none, which is exactly
 * wrong for a cleanup step and for the assertions that care whether a daemon is already
 * there.
 */
export async function connectWithoutStarting(socketPath: string): Promise<IpcClient | null> {
	const attempt = await attemptConnect(socketPath);
	return attempt.outcome === 'connected' ? createIpcClient(attempt.socket) : null;
}

/**
 * Leave `socketPath` unserved: stop whatever daemon is on it, and keep stopping until the
 * path has stayed quiet for {@link DRAIN_QUIET_MS}.
 *
 * **Stopping once is not enough, and that is not a bug in the daemon.** A test that fires
 * three concurrent clients spawns three daemons; two normally find the winner already bound
 * and exit. But one that is still starting up when the test kills the winner finds the path
 * free and binds it — which is exactly what a daemon should do, and leaves a stray process
 * behind once the test's temp directory is gone. Draining is the test's job.
 */
export async function stopDaemonAt(socketPath: string): Promise<void> {
	const deadline = Date.now() + DRAIN_TIMEOUT_MS;
	let lastStopped = Date.now();

	while (Date.now() < deadline) {
		if (await stopOneDaemonAt(socketPath)) {
			lastStopped = Date.now();
		} else if (Date.now() - lastStopped >= DRAIN_QUIET_MS) {
			return;
		}
		await pause(PROCESS_POLL_INTERVAL_MS);
	}

	throw new Error(`Daemons kept reappearing on '${socketPath}' for ${DRAIN_TIMEOUT_MS}ms`);
}

/**
 * Terminate the one daemon serving `socketPath`, if any. Resolves to whether there was one.
 *
 * The `status` result's `pid` is what makes this possible at all — a test that spawns a
 * detached daemon never holds its `ChildProcess`, so the protocol is the only handle on it.
 */
async function stopOneDaemonAt(socketPath: string): Promise<boolean> {
	const client = await connectWithoutStarting(socketPath);
	if (!client) {
		return false;
	}

	try {
		let pid: number | undefined;
		try {
			pid = (await client.request('status', {})).pid;
		} catch {
			// The daemon we just connected to went away before it answered — a sibling
			// cleanup killed it, or it exited on its own. There was something there, so the
			// caller should keep draining rather than treat this as "nothing to stop".
			return true;
		}

		// An in-process daemon (`startDaemon` called from the test itself) is this very
		// process; its own suite closes it, and signalling it would take the test runner down.
		if (pid === undefined || pid === process.pid) {
			return false;
		}
		await stopProcess(pid);
		return true;
	} finally {
		await client.close();
	}
}

/** `SIGTERM`, then wait for the process to disappear rather than assuming it did. */
export async function stopProcess(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
	try {
		process.kill(pid, signal);
	} catch {
		return;
	}
	await waitForExit(pid);
}

/**
 * Polls on the condition with a deadline — the process being gone (ai/RULES.md §2).
 *
 * Throws `WaitTimeoutError` naming the pid and that it was still running, which is the
 * whole diagnosis of a signal that did not take.
 */
export async function waitForExit(pid: number): Promise<void> {
	await waitForCondition({
		what: `process ${pid} to exit`,
		timeoutMs: PROCESS_EXIT_TIMEOUT_MS,
		pollIntervalMs: PROCESS_POLL_INTERVAL_MS,
		probe: (): Observation<void> =>
			isRunning(pid) ? { met: false, found: 'it still running' } : { met: true, value: undefined },
	});
}

export function isRunning(pid: number): boolean {
	try {
		// Signal 0 checks for the process without touching it.
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
