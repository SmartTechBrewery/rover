/**
 * Binding the transport-agnostic IPC surface to a local unix socket.
 *
 * **The bind is the mutual exclusion.** Two invocations racing to start a daemon are not
 * arbitrated by a lock file or a PID file — both call `listen()` on the same path, the
 * kernel lets exactly one through, and the loser reports `{ started: false }` and connects
 * to the winner instead. A lock file *as the election* would add a second piece of state
 * that can go stale independently of the socket, which is the failure mode `PROJECT.md` D6
 * is about.
 *
 * **Removing a corpse is the one step the kernel does not arbitrate**, and it is the one
 * step that can destroy a working daemon: `unlink` takes whatever is at the path, not the
 * inode you decided was dead. So the *unlink* — and only the unlink — is serialized by the
 * short-lived reclaim lock below. It never decides who becomes the daemon, it cannot strand
 * one, and it is discarded on age rather than believed forever, so it is not the stale
 * second source of truth D6 warns about.
 */

import { mkdir, open, rm, stat } from 'node:fs/promises';
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

	return reclaimAndRetry(socketPath);
}

/**
 * The path was already occupied: work out whether what is there is a corpse, and re-bind.
 *
 * The reclaim lock is held across **both** the unlink and the retried `listen()`, which is
 * what makes the pair safe. While we hold it nobody else may unlink, and the path can only
 * be re-bound by someone who first unlinked it — so the socket we probed is still the
 * socket we remove, and the window in which the path is free belongs to us.
 *
 * Failing to take the lock is not an error and not a reason to give up: we simply do not
 * unlink. The holder either re-binds the path — this retry then loses honestly on
 * `EADDRINUSE` — or leaves it free, and this retry takes it.
 */
async function reclaimAndRetry(socketPath: string): Promise<StartResult> {
	// Cheap check before queueing for the lock: a daemon that is simply already running is
	// the common loser, and it needs no reclamation at all.
	if (await probeAnswers(socketPath)) {
		return { started: false };
	}

	const lock = await acquireReclaimLock(socketPath);
	try {
		if (lock && !(await removeCorpse(socketPath))) {
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
	} finally {
		await lock?.release();
	}
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
 * Unlink the socket at `socketPath` if it is a corpse. Answers whether the retry may go on.
 *
 * **Only ever called under the reclaim lock**, and that is what makes it correct: the probe
 * and the `rm` are separated by an await, and without the lock a second reclaimer could bind
 * a live daemon into that gap and have its address deleted here — alive, listening, and
 * unreachable.
 *
 * The inode re-check is defence in depth rather than the safety mechanism. Nothing inside
 * this process can move the path while the lock is held; the check catches an *outside*
 * hand — an operator clearing `~/.rover` by hand, a stray cleanup script — replacing the
 * file mid-reclaim.
 */
async function removeCorpse(socketPath: string): Promise<boolean> {
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
		return false;
	}

	await rm(socketPath, { force: true });
	return true;
}

/** The reclaim lock's address: the socket path plus a suffix, so it shares its directory. */
export function reclaimLockPath(socketPath: string): string {
	return `${socketPath}.reclaim`;
}

/**
 * How long to queue for the reclaim lock before giving up and retrying the bind unarmed.
 *
 * The lock is held for one probe, one `unlink` and one `listen`, so this covers several
 * reclaimers ahead of us. Giving up costs nothing but a lost race — the caller still gets a
 * truthful `{ started: false }` or a daemon — so there is no reason to wait longer.
 */
const RECLAIM_LOCK_WAIT_MS = 2_000;

/**
 * How old a reclaim lock has to be before it is treated as abandoned rather than held.
 *
 * Comfortably beyond the ~600 ms a legitimate hold can take. Without this, one `SIGKILL`
 * landing inside that window would leave a lock nobody will ever release and make the path
 * permanently unreclaimable — a stale-state trap exactly like the PID file D6 rejects.
 * Discarding on age is what keeps this lock from becoming one.
 */
const RECLAIM_LOCK_STALE_MS = 10_000;

/** The gap between attempts on the lock. A poll on a condition with a deadline, not a sleep. */
const RECLAIM_LOCK_POLL_MS = 20;

interface ReclaimLock {
	release(): Promise<void>;
}

/**
 * Take the exclusive right to unlink `socketPath`, or resolve `undefined` if someone else
 * has it. `open(…, 'wx')` is `O_CREAT | O_EXCL`: the kernel lets exactly one creator through,
 * the same arbitration the bind itself relies on.
 *
 * Two processes that both find the *same* abandoned lock can both discard it and both
 * proceed — that is the pre-existing unserialized behaviour, reachable only by killing a
 * process inside a sub-millisecond window, and it is why the inode re-check in
 * {@link removeCorpse} is kept rather than dropped.
 */
async function acquireReclaimLock(socketPath: string): Promise<ReclaimLock | undefined> {
	const lockPath = reclaimLockPath(socketPath);
	const deadline = Date.now() + RECLAIM_LOCK_WAIT_MS;

	do {
		if (await createExclusively(lockPath)) {
			return { release: () => rm(lockPath, { force: true }) };
		}
		await discardAbandonedLock(lockPath);
		await pause(RECLAIM_LOCK_POLL_MS);
	} while (Date.now() < deadline);

	return undefined;
}

/** Whether this call was the one that created `lockPath`. */
async function createExclusively(lockPath: string): Promise<boolean> {
	try {
		await (await open(lockPath, 'wx')).close();
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			return false;
		}
		// Anything else is the directory refusing us, which the caller has to see rather than
		// have quietly downgraded into a lost race.
		throw error;
	}
}

async function discardAbandonedLock(lockPath: string): Promise<void> {
	let heldSince: number;
	try {
		heldSince = (await stat(lockPath)).mtimeMs;
	} catch {
		// Released while we looked. The next attempt takes it.
		return;
	}
	if (Date.now() - heldSince > RECLAIM_LOCK_STALE_MS) {
		await rm(lockPath, { force: true });
	}
}

/** The gap between polls above. Never a wait *instead* of a check (ai/RULES.md §2, D12). */
function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
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
