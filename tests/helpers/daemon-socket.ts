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
import {
	DEFAULT_ARTIFACTS_BUDGET_MB,
	DEFAULT_ARTIFACTS_MAX_AGE_DAYS,
	type RetentionPolicy,
} from '@/daemon/archive-retention.js';
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
	/**
	 * Where a daemon started on this socket files its artifact archive.
	 *
	 * **Nothing pre-creates it**, so "this verb archived nothing" is assertable as "the
	 * directory does not exist" rather than as "the directory is empty".
	 */
	readonly artifactsRoot: string;
	/**
	 * Where a daemon started on this socket looks for per-project hook files.
	 *
	 * **Nothing pre-creates it either**, and that is the safe default: a project with no hook
	 * file has no apps and no teardown, so a test that says nothing about hooks gets none.
	 * Never `~/.rover/projects` — a hook file declares a program the daemon runs, and a test
	 * that read the developer's own directory would start running their commands.
	 */
	readonly projectsRoot: string;
	/**
	 * Where a daemon started on this socket records which archived tests are kept (D33).
	 *
	 * **Nothing pre-creates it either**, so "nothing was kept" is assertable as "the file does not
	 * exist" rather than as "the file holds an empty list". Never `~/.rover/kept-tests.json`: it is
	 * the operator's own record, and it is the one thing on the surface a call *writes*, so a test
	 * pointed at the real path would rewrite it.
	 */
	readonly keptTestsPath: string;
	/**
	 * What a daemon started on this socket is allowed to keep in that archive (§9.4).
	 *
	 * **The shipped defaults, spelled out rather than resolved from the environment**: it is a
	 * required `startDaemonOptions` field for exactly that reason, so a suite must not be able to
	 * inherit a budget from the developer's shell and start deleting by it. A suite that needs a
	 * different policy passes its own — nothing here is a policy for anybody's real archive.
	 *
	 * **Holding one is no longer inert, and that is worth knowing before a suite seeds a tree.** A
	 * daemon started with this policy runs a full pass of it — both bounds — as it comes up, and
	 * another at local midnight (`PROJECT.md` D38, `src/daemon/retention-schedule.ts`), on top of
	 * the budget-only pass every lease's end triggers (D37). So an archive seeded **before**
	 * `startDaemon` with runs past the age window is swept by the start pass; a suite that means
	 * those runs to survive seeds them after the daemon is up, which is what every suite here
	 * already does. Nothing pre-creates {@link TempSocket.artifactsRoot}, so the start pass on a
	 * suite that files nothing walks a tree that does not exist and says nothing at all.
	 */
	readonly retention: RetentionPolicy;
}

/**
 * A socket path nobody else uses. Never `~/.rover/rover.sock`: a test that bound the real
 * default would take the developer's own daemon down mid-run.
 *
 * The archive root and the project hook directory beside it follow the same rule and for the
 * same reason: no test ever writes into `~/.rover/artifacts`, which is the developer's own
 * durable tree, and none ever reads `~/.rover/projects`, which names programs to run.
 */
export async function createTempSocket(): Promise<TempSocket> {
	const dir = await mkdtemp(join(tmpdir(), 'rover-'));
	return {
		dir,
		socketPath: join(dir, 'rover.sock'),
		artifactsRoot: join(dir, 'artifacts'),
		projectsRoot: join(dir, 'projects'),
		keptTestsPath: join(dir, 'kept-tests.json'),
		retention: {
			budgetMb: DEFAULT_ARTIFACTS_BUDGET_MB,
			maxAgeDays: DEFAULT_ARTIFACTS_MAX_AGE_DAYS,
		},
	};
}

/**
 * What only the artifact archive's **sweep** says, as the substrings that identify one of its
 * lines.
 *
 * Deliberately the sweep's own sentences rather than the openings it shares with the archive's
 * readers: `list_archive`, `search_archive`, `list_archive_groups` and the artifact route all
 * begin an unreadable-subtree warning with *The artifact archive could not be read at*, and a
 * filter keyed on that would hide the very line a suite about one of those is asserting.
 */
const SWEEP_LOG_MARKERS: readonly string[] = [
	// The one line every sweep writes, deleting or not, and the operator-triggered audit line.
	'Swept the artifact archive',
	'Asked what a sweep of the artifact archive would take',
	// One per run taken, or that would be taken.
	'Deleted archived run ',
	'Would delete archived run ',
	'The archived run at ',
	// And the same two for a project taken whole because an operator named it (D42) — this
	// module's third trigger, which is not a bound and is not on any schedule.
	'Deleted archived project ',
	'The archived project at ',
	// And the same two again for one test taken whole at the finer address (D43), which is that
	// same trigger and not a fourth one.
	'Deleted archived test ',
	'The archived test at ',
	// And the same two once more for a **run** taken because an operator named the group it is in
	// (D43, #277). A group's delete goes run by run through this module's own addressed removal, and
	// `nounFor` calls a three-component address exactly that — so these are the sweeper's lines for
	// that trigger, not a fourth trigger of its own.
	'Deleted archived address ',
	'The archived address at ',
	// A budget that cannot be met with only kept and live runs left.
	'The artifact archive is still ',
	// The sweep's own two failures, each named by the clause only it writes.
	'The sweep went on without it',
	'The sweep was abandoned and nothing was deleted',
	// And a pass that could not run at all, from either unattended trigger.
	'The artifact archive was not swept',
];

/**
 * Whether this line on a daemon's log is the retention sweep's own record.
 *
 * **Every daemon runs a full pass of its retention policy as it comes up** (`PROJECT.md` D38,
 * `src/daemon/retention-schedule.ts`), so a suite whose subject is a *different* line has lines it
 * did not ask for — and they arrive at a moment it does not control, because the pass is `void`-ed
 * and whether it has reached the log yet is a race rather than a sequence. A suite that counts its
 * own warnings drops these at the spy; a suite whose subject **is** the sweep
 * (`sweep-archive.test.ts`, `sweep-after-lease.test.ts`, `sweep-at-start.test.ts`) reads the log
 * unfiltered.
 */
export function isSweepLogLine(line: string): boolean {
	return SWEEP_LOG_MARKERS.some((marker) => line.includes(marker));
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
