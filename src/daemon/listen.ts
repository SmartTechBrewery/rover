/**
 * Binding the transport-agnostic IPC surface to a local unix socket.
 *
 * **The bind is the mutual exclusion.** Two invocations racing to start a daemon are not
 * arbitrated by a lock file or a PID file — both call `listen()` on the same path, the
 * kernel lets exactly one through, and the loser reports `{ started: false }` and connects
 * to the winner instead. A lock file would add a second piece of state that can go stale
 * independently of the socket, which is the failure mode `PROJECT.md` D6 is about.
 */

import { mkdir, rm, stat } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { IpcHandlers } from '../ipc/methods.js';
import { createIpcServer } from '../ipc/server.js';
import { handleStatus } from './status.js';

/**
 * How long the stale-socket probe waits for a connection before giving up. A daemon that
 * has bound the path answers from the kernel's accept queue, so this only has to outlast
 * scheduling noise; it is a bound on the probe, not an assumption about how fast a daemon
 * replies.
 */
const PROBE_TIMEOUT_MS = 500;

export interface StartDaemonOptions {
	readonly socketPath: string;
}

/** The daemon this process owns. Only the winner of the bind gets one. */
export interface RunningDaemon {
	readonly started: true;
	/** Stops accepting, drops live connections and unlinks the socket. Safe to call twice. */
	close(): Promise<void>;
}

/** Somebody else won the bind and is already serving the path. */
export interface DaemonAlreadyRunning {
	readonly started: false;
}

export type StartResult = RunningDaemon | DaemonAlreadyRunning;

/** The method table the daemon serves. One row today; a row per verb as R21 lands. */
export function createDaemonHandlers(): IpcHandlers {
	return { status: handleStatus };
}

/**
 * Bind `socketPath` and serve every connection through the IPC server.
 *
 * Returns `{ started: false }` — never throws — when another daemon holds the path. Any
 * other failure (`EACCES` on the directory, a path over the address limit) throws: it is
 * a misconfiguration the caller has to see, not a race it should quietly lose.
 */
export async function startDaemon({ socketPath }: StartDaemonOptions): Promise<StartResult> {
	await mkdir(dirname(socketPath), { recursive: true });

	const first = await listenOnce(socketPath);
	if (first.listening) {
		return running(first, socketPath);
	}
	if (first.error.code !== 'EADDRINUSE') {
		throw first.error;
	}

	if (!(await reclaimStaleSocket(socketPath))) {
		return { started: false };
	}

	const second = await listenOnce(socketPath);
	if (second.listening) {
		return running(second, socketPath);
	}
	if (second.error.code !== 'EADDRINUSE') {
		throw second.error;
	}
	// Somebody bound the path between our unlink and our retry. One retry is the whole
	// budget: looping here would trade a lost race for a spin against a live daemon.
	return { started: false };
}

function running(listening: ListenSucceeded, socketPath: string): RunningDaemon {
	// Captured while we hold the path, so `close()` can tell our own socket file from one a
	// successor bound after us and only ever unlinks the former.
	const ownInode = boundInodeOf(listening.server);
	let closed: Promise<void> | undefined;

	return {
		started: true,
		close(): Promise<void> {
			closed ??= closeServer(listening, socketPath, ownInode);
			return closed;
		},
	};
}

async function closeServer(
	{ server, connections }: ListenSucceeded,
	socketPath: string,
	ownInode: Promise<bigint | undefined>,
): Promise<void> {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
		// `close()` only stops accepting; it resolves when the last connection ends, which a
		// client holding an idle connection never does. A daemon asked to shut down has to
		// actually go away, so live connections are dropped rather than waited on.
		for (const connection of connections) {
			connection.destroy();
		}
	});

	// Node unlinks the path itself on a clean close, so this is the crash-shaped case and a
	// belt-and-braces guarantee that the address is free. Skipped when the inode changed:
	// the file there is then a successor's socket, not ours.
	const before = await ownInode;
	const now = await inodeOf(socketPath);
	if (now !== undefined && before !== undefined && now !== before) {
		return;
	}
	await rm(socketPath, { force: true });
}

interface ListenSucceeded {
	readonly listening: true;
	readonly server: Server;
	/**
	 * The live connections, tracked by hand: `net.Server` has no `closeAllConnections()` —
	 * that one is `http.Server`'s — and without it `close()` waits forever on a client that
	 * is holding an idle connection open.
	 */
	readonly connections: ReadonlySet<Socket>;
}

interface ListenFailed {
	readonly listening: false;
	readonly error: NodeJS.ErrnoException;
}

/**
 * One bind attempt on a fresh server. Fresh because a `net.Server` that failed to bind has
 * no handle to close, and re-`listen()`ing the same object is the shape that produces
 * `ERR_SERVER_NOT_RUNNING` from the cleanup rather than a second honest attempt.
 */
function listenOnce(socketPath: string): Promise<ListenSucceeded | ListenFailed> {
	const ipcServer = createIpcServer(createDaemonHandlers());
	const connections = new Set<Socket>();
	const server = createServer((socket: Socket) => {
		connections.add(socket);
		socket.on('close', () => connections.delete(socket));
		ipcServer.handleConnection(socket);
	});

	return new Promise((resolve) => {
		const onError = (error: NodeJS.ErrnoException) => {
			server.removeListener('listening', onListening);
			resolve({ listening: false, error });
		};
		const onListening = () => {
			server.removeListener('error', onError);
			// Past the bind, a socket error is one client's transport failing. Swallowing it is
			// what keeps a single broken connection from taking the whole daemon down.
			server.on('error', () => {});
			resolve({ listening: true, server, connections });
		};

		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(socketPath);
	});
}

/**
 * Decide whether the socket already at `socketPath` is a corpse we may remove.
 *
 * **The inode comparison is a heuristic, not the safety mechanism.** What guarantees at
 * most one daemon is the retried `listen()`: `bind()` is atomic in the kernel, so two
 * processes that both judge the socket stale, both unlink and both re-listen still produce
 * exactly one winner — the other gets a second `EADDRINUSE` and reports `{ started: false }`.
 * The inode check exists only to avoid *deleting* the address of a daemon that came up
 * while we were probing, which would strand it: alive, listening, and unreachable.
 */
async function reclaimStaleSocket(socketPath: string): Promise<boolean> {
	const before = await inodeOf(socketPath);
	if (before === undefined) {
		// Gone between our failed bind and this stat. Nothing to reclaim and nothing to
		// unlink, so the retry is exactly the right move.
		return true;
	}

	if (await probeAnswers(socketPath)) {
		return false;
	}

	const after = await inodeOf(socketPath);
	if (after === undefined) {
		return true;
	}
	if (after !== before) {
		// A live daemon bound the path while we were probing the corpse. Unlinking now would
		// delete a working daemon's address and leave it running but unreachable.
		return false;
	}

	await rm(socketPath, { force: true });
	return true;
}

/**
 * Whether something is accepting connections on the path.
 *
 * Any failure means "nothing is serving here": a stale socket left by a killed daemon
 * answers `ECONNREFUSED`, and a plain file sitting on the path answers `ENOTSOCK` on
 * macOS 25.6 — different codes for the same conclusion, and enumerating them would just
 * be a list to get wrong on the next platform.
 */
function probeAnswers(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		let settled = false;
		const settle = (answered: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.destroy();
			resolve(answered);
		};

		socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(true));
		socket.once('connect', () => settle(true));
		// `on`, not `once`: the `destroy()` above can raise a second error, and an 'error'
		// event with no listener is what turns a probe into a crashed process.
		socket.on('error', () => settle(false));
	});
}

async function inodeOf(socketPath: string): Promise<bigint | undefined> {
	try {
		return (await stat(socketPath, { bigint: true })).ino;
	} catch {
		return undefined;
	}
}

/** The inode of the socket file this server bound, read off its own address. */
function boundInodeOf(server: Server): Promise<bigint | undefined> {
	const address = server.address();
	return typeof address === 'string' ? inodeOf(address) : Promise.resolve(undefined);
}
