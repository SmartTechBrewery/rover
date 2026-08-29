/**
 * The local client half: connect to the daemon, starting one if nothing answers (D5).
 *
 * **Autostart lives here and only here, by construction.** This is the unix-socket path,
 * so the spawn cannot be reached by anything generic — and in particular not by R22's TCP
 * client, which will bind the same `createIpcClient` to a different transport. A client
 * never starts a host across a network: a remote host is a service its operator runs.
 * `tests/unit/daemon/remote-never-spawns.test.ts` holds that line as an executable gate.
 *
 * The precedent for starting a daemon behind the caller's back is the device bridge every
 * mobile toolchain already ships, which forks its own server on first use and nobody
 * notices. A manual start is a step somebody forgets at the worst possible moment.
 */

import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pause } from '../core/wait.js';
import { createIpcClient, type IpcClient } from '../ipc/client.js';
import { attemptConnect } from './socket-connect.js';
import { assertValidSocketPath, resolveSocketPath, SOCKET_PATH_ENV_VAR } from './socket-path.js';

/**
 * How long to keep re-checking for a daemon after spawning one. Generous because the child
 * is a whole Node process: on a cold start it loads a loader, this module tree and the
 * schemas before it binds.
 */
export const DEFAULT_START_TIMEOUT_MS = 5_000;

/**
 * The gap between connection attempts inside the bounded wait below. This is polling a
 * condition with a deadline, not a sleep (ai/RULES.md §2, D12): what ends the loop is the
 * daemon answering, and the timer only keeps the retry from spinning a core while the
 * child comes up.
 */
const RETRY_INTERVAL_MS = 25;

/** Where the daemon entrypoint and its dependencies live, for the spawned child's cwd. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export interface ConnectToLocalDaemonOptions {
	socketPath?: string;
	startTimeoutMs?: number;
}

/**
 * Connect to the local daemon, starting it if it is not running.
 *
 * Spawns **at most once** per call: the retry loop only re-checks the connection, so three
 * concurrent callers produce at most three short-lived processes and — because the bind is
 * the arbiter (`./listen.ts`) — exactly one daemon.
 */
export async function connectToLocalDaemon(
	options: ConnectToLocalDaemonOptions = {},
): Promise<IpcClient> {
	const socketPath =
		options.socketPath === undefined
			? resolveSocketPath()
			: assertValidSocketPath(options.socketPath);
	const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;

	const existing = await tryConnect(socketPath);
	if (existing.connected) {
		return createIpcClient(existing.socket);
	}
	requireAbsentDaemon(existing.error, socketPath);

	spawnDaemon(socketPath);

	const deadline = Date.now() + startTimeoutMs;
	while (Date.now() < deadline) {
		await pause(RETRY_INTERVAL_MS);
		const attempt = await tryConnect(socketPath);
		if (attempt.connected) {
			return createIpcClient(attempt.socket);
		}
		requireAbsentDaemon(attempt.error, socketPath);
	}

	throw new Error(
		`No daemon answered on '${socketPath}' within ${startTimeoutMs}ms of starting one. ` +
			`Run it in the foreground with 'npm run daemon' to see why it is not coming up.`,
	);
}

/**
 * "Nothing is listening" is the only failure autostart may answer.
 *
 * `ENOENT` and `ECONNREFUSED` are a stale unix socket or nothing at the path at all.
 * `ENOTSOCK` is the same conclusion by another route: a plain file left on the path — the
 * exact corpse a crashed daemon can leave, and what `startDaemon`'s own reclaim logic
 * already treats as absent (`listen.ts`'s `probeAnswers`) — answers this code, not
 * `ECONNREFUSED`, so a client that did not also treat it as absent would refuse to spawn a
 * replacement that `startDaemon` would otherwise happily reclaim the path for.
 *
 * `EACCES` and `EPERM` mean a daemon may well be there and this user may not talk to it —
 * spawning a second one would not fix that and would leave a stray process behind. The
 * path and the code are both in the message because they are the whole diagnosis.
 */
function requireAbsentDaemon(error: NodeJS.ErrnoException, socketPath: string): void {
	if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'ENOTSOCK') {
		return;
	}
	throw new Error(
		`Cannot reach the daemon socket '${socketPath}': ${error.code ?? 'unknown error'} — ` +
			error.message,
	);
}

interface ConnectSucceeded {
	readonly connected: true;
	readonly socket: Socket;
}

interface ConnectFailed {
	readonly connected: false;
	readonly error: NodeJS.ErrnoException;
}

async function tryConnect(socketPath: string): Promise<ConnectSucceeded | ConnectFailed> {
	const attempt = await attemptConnect(socketPath);
	return attempt.outcome === 'connected'
		? { connected: true, socket: attempt.socket }
		: { connected: false, error: attempt.error };
}

/**
 * Start a detached daemon that outlives this process.
 *
 * The entrypoint is `main` with **this module's own extension**, resolved next to this
 * file: `main.ts` when running from source under a TypeScript loader, `main.js` from a
 * compiled tree. That is one expression instead of a branch on how the process was
 * started, which is the kind of branch that is only ever wrong in the environment nobody
 * tested.
 *
 * `ROVER_SOCKET_PATH` is passed explicitly rather than left to the child's own default:
 * the child must bind the path this caller resolved, not re-derive one from an environment
 * that may differ.
 */
function spawnDaemon(socketPath: string): void {
	const entry = fileURLToPath(
		new URL(`main${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
	);
	const loaderArgs = entry.endsWith('.ts') ? ['--import', typeScriptLoader()] : [];

	const child = spawn(process.execPath, [...loaderArgs, entry], {
		detached: true,
		stdio: 'ignore',
		// Never the caller's cwd: a daemon outlives the command that started it, and holding a
		// directory that is later deleted is how a long-lived process ends up unable to
		// resolve anything. It never depends on a client's cwd either (D17, D19).
		cwd: PACKAGE_ROOT,
		env: { ...process.env, [SOCKET_PATH_ENV_VAR]: socketPath },
	});
	child.unref();
}

/**
 * The loader specifier for `node --import`, resolved to an absolute URL where possible so
 * it does not depend on how the spawning process was launched.
 *
 * `import.meta.resolve` is unavailable in a bundled or transformed module — the test
 * runner's transform replaces `import.meta` with a shim that has no `resolve` — so the
 * bare specifier is the documented fallback. It resolves from the child's cwd, which is
 * the package root, so it finds the same loader either way.
 */
function typeScriptLoader(): string {
	try {
		return import.meta.resolve('tsx/esm');
	} catch {
		return 'tsx/esm';
	}
}
