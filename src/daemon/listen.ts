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
 *
 * **One handler, two transports.** The `IpcServer` is built once here and handed to both the
 * unix socket and — when the operator opted in (`./network-config.ts`) — the TLS listener of
 * `./network-listen.ts`. That is what makes "the same surface, a second transport" (D17)
 * structural rather than a claim: there is one method table and one dispatcher, and neither
 * transport can drift from the other because there is nothing to drift from.
 */

import { mkdir, open, rm, stat } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { pause } from '../core/wait.js';
import type { IpcHandlers } from '../ipc/methods.js';
import type { IpcServer } from '../ipc/server.js';
import { createIpcServer } from '../ipc/server.js';
import { type ArtifactArchive, createArtifactArchive } from './archive.js';
import { createDeviceInventory, type DeviceInventory } from './inventory.js';
import { createLeaseHandlers } from './lease-handlers.js';
import { createLeaseStore, type LeaseStore } from './leases.js';
import { createListDevicesHandler } from './list-devices.js';
import type { NetworkListenerConfig } from './network-config.js';
import { type NetworkListener, startNetworkListener } from './network-listen.js';
import { createProjectInstall, type ProjectInstall } from './project-install.js';
import { createProjectResolver } from './project-resolver.js';
import { createDeviceRestorer, type DeviceRestorer } from './restore.js';
import { createSlotAllocator, type SlotAllocator } from './slots.js';
import { attemptConnect } from './socket-connect.js';
import { assertValidSocketPath } from './socket-path.js';
import { handleStatus } from './status.js';
import { createVerbHandlers } from './verb-handlers.js';
import { createVerbTraffic, type VerbTraffic } from './verb-traffic.js';

/**
 * How long the stale-socket probe waits for a connection before giving up. A daemon that
 * has bound the path answers from the kernel's accept queue, so this only has to outlast
 * scheduling noise; it is a bound on the probe, not an assumption about how fast a daemon
 * replies.
 */
const PROBE_TIMEOUT_MS = 500;

/**
 * How long `close()` waits for the device watches to stop before giving up on them and
 * saying so. Nothing below that call is bounded — a watch stops by signalling a child and
 * waiting for it to exit — and an unbounded wait on the shutdown path is the worse failure
 * of the two: a daemon whose `close()` never resolves neither dies nor stops serving, which
 * is exactly the stale-host state D6 is about. Generous enough that a child exiting normally
 * is never reported as a leak.
 */
const WATCH_STOP_TIMEOUT_MS = 5_000;

/**
 * How often the daemon looks for a lease that has expired.
 *
 * It **observes** expiry rather than defining it: a lease is expired when its `expiresAtMs`
 * has passed, whether or not this interval has come round, and every read of the store already
 * drops such a record. What the sweep buys is that a device whose holder died — and so asks no
 * further questions — is restored (D9) rather than waiting for the next caller who happens to
 * name it. So this number is how long a restoration may be *late* by, and nothing else; there
 * is no second piece of state for it to disagree with (D6).
 *
 * Not a `sleep`: a poll on a condition with a deadline, like the reclaim lock's below
 * (ai/RULES.md §2, D12).
 */
const LEASE_SWEEP_INTERVAL_MS = 30_000;

/**
 * How long `close()` waits for the restorations still in flight before shutting down anyway
 * and saying so.
 *
 * Waiting at all is the point: a restoration has no second chance. A lease dies with the host
 * (D6), so a successor daemon sees no expired holder and nothing ever re-fires the teardown —
 * the device keeps whatever the last lessee left it with, permanently. `release_device`
 * deliberately answers before the restoration finishes (`lease-handlers.ts`), so `rover
 * release` followed straight away by killing the daemon lands inside exactly that window.
 *
 * Bounded for the same reason as {@link WATCH_STOP_TIMEOUT_MS}: every step below is a backend
 * call carrying its own timeout and the project hook is bounded by the restorer, so this only
 * has to outlast a device that is answering slowly, and a `close()` that never resolves would
 * be the worse failure.
 */
const RESTORE_SETTLE_TIMEOUT_MS = 10_000;

/**
 * How long `close()` waits for the TLS listener to stop before shutting down anyway and saying
 * so.
 *
 * Bounded for the same reason as {@link WATCH_STOP_TIMEOUT_MS}: `NetworkListener.close()` waits
 * on `net.Server`'s connection count reaching zero, which is a count kept by Node over sockets
 * this process does not fully control. A defect there — or a socket state nobody anticipated —
 * may delay a shutdown, but it must never be able to prevent one, because a daemon whose
 * `close()` never resolves neither dies nor stops serving (D6). Generous enough that dropping a
 * handful of live TLS connections is never reported as a leak.
 */
const NETWORK_CLOSE_TIMEOUT_MS = 5_000;

export interface StartDaemonOptions {
	readonly socketPath: string;
	/**
	 * Defaults to {@link LEASE_SWEEP_INTERVAL_MS}. A test seam in the spirit of
	 * `LeaseStoreOptions.ttlMs`, not a configuration surface: the interval is how *late* an
	 * expiry may be observed and nothing else (see above), so there is nothing here for an
	 * operator to tune. It exists so a socket-level test can prove that a dead holder's device
	 * is restored with nobody asking, rather than by calling `sweep()` by hand.
	 */
	readonly sweepIntervalMs?: number;
	/** Defaults to the lease store's own TTL (D8). The same test seam, for the same test. */
	readonly leaseTtlMs?: number;
	/**
	 * The network listener, or absent for a host that serves the local socket only.
	 *
	 * The operator's opt-in, resolved from the environment by `./main.ts` and deliberately
	 * **never** read from `process.env` here: a `startDaemon()` in a unit test must not open a
	 * port because the developer happened to export `ROVER_LISTEN_PORT` in that shell.
	 */
	readonly network?: NetworkListenerConfig;
	/**
	 * Where the durable artifact archive writes (D23, `./archive.ts`).
	 *
	 * **Required**, and resolved from the environment by `./main.ts` rather than here, for the
	 * reason {@link StartDaemonOptions.network} is: a `startDaemon()` in a unit test must not
	 * write into the developer's own `~/.rover/artifacts` because of a variable in their shell
	 * — or, with a default here, because nobody thought to override one.
	 */
	readonly artifactsRoot: string;
	/**
	 * Where the per-project hook files are (D13, `./project-hooks.ts`).
	 *
	 * **Required**, and resolved from the environment by `./main.ts`, for
	 * {@link StartDaemonOptions.artifactsRoot}'s reason and rather more sharply: what a hook
	 * file declares is a program the host runs with the daemon's own privileges, so a
	 * `startDaemon()` in a unit test must not be able to reach the developer's own
	 * `~/.rover/projects` and start running commands out of it.
	 */
	readonly projectsRoot: string;
}

/** The daemon this process owns. Only the winner of the bind gets one. */
export interface RunningDaemon {
	readonly started: true;
	/**
	 * The TCP port the network listener actually bound, or `null` when none was configured. A
	 * configured port of `0` resolves to a real one here, which is what lets a test find out
	 * where to connect and lets `./main.ts` print what it opened.
	 */
	readonly networkPort: number | null;
	/**
	 * Stops accepting on both transports, drops live connections, waits out the restorations
	 * still owed (bounded) and unlinks the socket. Safe to call twice.
	 */
	close(): Promise<void>;
}

/** Somebody else won the bind and is already serving the path. */
export interface DaemonAlreadyRunning {
	readonly started: false;
}

export type StartResult = RunningDaemon | DaemonAlreadyRunning;

/**
 * The method table the daemon serves — status, the device list, the two lease operations and
 * the verbs, on one surface (D19). A new verb family is one more spread, or one more entry in
 * `./verb-handlers.ts`; nothing about the connection lifecycle changes to carry it.
 */
export function createDaemonHandlers(
	inventory: DeviceInventory,
	leases: LeaseStore,
	restorer: DeviceRestorer,
	traffic: VerbTraffic,
	archive: ArtifactArchive,
	installProject: ProjectInstall,
	slots: SlotAllocator,
): IpcHandlers {
	return {
		status: handleStatus,
		...createListDevicesHandler(inventory, leases),
		...createLeaseHandlers(inventory, leases, restorer, slots),
		...createVerbHandlers(inventory, leases, traffic, archive, installProject),
	};
}

/**
 * Bind `socketPath` and serve every connection through the IPC server.
 *
 * Returns `{ started: false }` — never throws — when another daemon holds the path. Any
 * other failure (`EACCES` on the directory, a path over the address limit) throws: it is
 * a misconfiguration the caller has to see, not a race it should quietly lose.
 */
export async function startDaemon(options: StartDaemonOptions): Promise<StartResult> {
	const socketPath = assertValidSocketPath(options.socketPath);
	await mkdir(dirname(socketPath), { recursive: true });

	// Constructed once, here, and started only by the winner of the bind. `listenOnce` runs up
	// to twice (this call and `reclaimAndRetry`'s), so building the inventory in there would
	// build two; starting one per attempt would leave the losing attempt's watches — and their
	// child processes — running with nobody holding a handle on them. Construction subscribes
	// to nothing, so a loser that never starts it has spawned nothing to clean up.
	const inventory = createDeviceInventory();
	// The register of what is driving a device right now. Constructed before both of the
	// below, because both consult it: a restoration waits for the ending lease's verbs, and
	// the store's end hook revokes the device from them. It holds nothing until a verb call
	// arrives, so a loser of the bind leaves nothing behind here either.
	const traffic = createVerbTraffic();
	// One pool per daemon, and the only thing on this host that hands out helper-service ports
	// (R18). Constructed before the restorer, which gives slots back, and before the handlers,
	// which take them. It holds nothing until a grant, so a loser of the bind leaves nothing
	// behind here either — and a slot is host state that dies with the host (D6): after a
	// restart there are no leases, so there are no slots to reclaim from a predecessor.
	const slots = createSlotAllocator();
	// Constructed before the store, because the store's end hook calls into it. It starts
	// nothing either: a restoration only ever begins when a lease ends, and a process that
	// never granted one has nothing to undo.
	const restorer = createDeviceRestorer({
		inventory,
		// The one line that gives the seam something to resolve: a lease's `project` string
		// becomes that project's hook file, re-read every time a lease ends (D6).
		resolveProject: createProjectResolver({ root: options.projectsRoot }),
		settleTraffic: (serial) => traffic.settle(serial),
		// The lease's ports go back into the pool here rather than in `onLeaseEnded` below,
		// because the teardown that just ran was the thing using them — see
		// `DeviceRestorerOptions.onRestored`.
		onRestored: (lease) => slots.release(lease.slot),
	});
	// Built before the store for the restorer's reason: the store's end hook calls into it. It
	// creates no directory until a verb call actually produces bytes, so a loser of the bind
	// leaves nothing behind here either — not even an empty root.
	const archive = createArtifactArchive({ root: options.artifactsRoot });
	// Built here for the same reason and with the same lifecycle: one store per process,
	// constructed once for both bind attempts. It starts nothing, so a loser leaves nothing
	// behind, and a lease is host state that dies with the host by design (D6) — nothing
	// about it is persisted or reclaimed from a predecessor.
	//
	// The hook is where D9 is wired: `forget` is the one place a lease ends, so a release and
	// an expiry reach the restorer by the same path and a caller can neither ask for this nor
	// opt out of it.
	//
	// Both halves of a lease's end are here, in that order: the device is taken away from
	// whatever verb is still running under this lease *first* — a release the server did not
	// wait for is exactly how a verb outlives its lease — and the restoration is queued
	// second, where it waits for those calls to unwind before undoing anything. Both are
	// synchronous and neither throws, which is what this hook requires (`./leases.ts`).
	const leases = createLeaseStore({
		...(options.leaseTtlMs === undefined ? {} : { ttlMs: options.leaseTtlMs }),
		onLeaseEnded: (lease, reason) => {
			traffic.stop(lease);
			restorer.restore(lease, reason);
			// Last, so it cannot delay either of the two above, and third rather than folded into
			// them because it undoes nothing on the device: it drops this lease's sequence
			// counters so the daemon does not grow with the number of leases it has granted.
			archive.forget(lease);
			// The lease's slot is deliberately **not** a fourth line here: its ports are what the
			// teardown queued above was told, so they come back at the tail of that restoration
			// instead (`DeviceRestorerOptions.onRestored`, wired at the restorer above).
		},
	});
	// Built once, for **both** transports. Not once per bind attempt and not once per
	// listener: one method table and one dispatcher is what makes the network listener an
	// added transport rather than a second implementation of the surface (D17). It holds no
	// resources of its own, so a loser of the bind leaves nothing behind here either.
	const ipcServer = createIpcServer(
		createDaemonHandlers(
			inventory,
			leases,
			restorer,
			traffic,
			archive,
			// The second line that gives a seam something to resolve, beside the restorer's: a
			// lease's `project` string becomes that project's *install* command, re-read on every
			// call for the reason the teardown's is (D6).
			createProjectInstall({ root: options.projectsRoot }),
			slots,
		),
	);

	const parts: DaemonParts = {
		ipcServer,
		inventory,
		leases,
		restorer,
		sweepIntervalMs: options.sweepIntervalMs ?? LEASE_SWEEP_INTERVAL_MS,
		network: options.network,
	};

	const first = await listenOnce(socketPath, ipcServer);
	if (first.listening) {
		return running(first, socketPath, parts);
	}
	if (first.error.code !== 'EADDRINUSE') {
		throw first.error;
	}

	return reclaimAndRetry(socketPath, parts);
}

/**
 * Everything a daemon is built from, carried as one value so the two bind attempts and the
 * start-up and shutdown paths all name the same set rather than each threading its own list
 * of positional arguments.
 */
interface DaemonParts {
	readonly ipcServer: IpcServer;
	readonly inventory: DeviceInventory;
	readonly leases: LeaseStore;
	readonly restorer: DeviceRestorer;
	readonly sweepIntervalMs: number;
	readonly network: NetworkListenerConfig | undefined;
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
async function reclaimAndRetry(socketPath: string, parts: DaemonParts): Promise<StartResult> {
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

		const second = await listenOnce(socketPath, parts.ipcServer);
		if (second.listening) {
			return running(second, socketPath, parts);
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

/**
 * The winner-only path: start what a serving daemon runs, network listener included.
 *
 * The listener goes up **here** rather than in `startDaemon` because this is the only branch
 * that won the bind. A loser must not open a port: two daemons on one machine would then race
 * for it, and the one that lost the socket has no devices to lend anyway.
 */
async function running(
	listening: ListenSucceeded,
	socketPath: string,
	parts: DaemonParts,
): Promise<RunningDaemon> {
	// Captured while we hold the path, so `close()` can tell our own socket file from one a
	// successor bound after us and only ever unlinks the former.
	const ownInode = boundInodeOf(listening.server);
	let closed: Promise<void> | undefined;
	let network: NetworkListener | undefined;

	// Only ever reached by the winner of the bind — a `{ started: false }` caller has no
	// inventory running and nothing to stop.
	parts.inventory.start();

	const sweep = setInterval(() => parts.leases.sweep(), parts.sweepIntervalMs);
	// Unreferenced, like every other timer here: this exists to notice an expiry while the
	// daemon is serving, never to keep a process alive that is otherwise finished.
	sweep.unref();

	const close = (): Promise<void> => {
		closed ??= closeServer(listening, socketPath, ownInode, parts, { sweep, network });
		return closed;
	};

	if (parts.network !== undefined) {
		try {
			network = await startNetworkListener(parts.network, parts.ipcServer);
		} catch (error) {
			// A failed network bind fails the whole start. Serving only locally while the
			// operator believes the host is reachable is silent degradation, and it would leave
			// this process holding the socket a working host should have.
			await close();
			throw error;
		}
	}

	return { started: true, networkPort: network?.port ?? null, close };
}

/** What `close()` has to wind down besides the local socket itself. */
interface ShutdownWork {
	readonly sweep: NodeJS.Timeout;
	readonly network: NetworkListener | undefined;
}

async function closeServer(
	{ server, connections, startClosing }: ListenSucceeded,
	socketPath: string,
	ownInode: Promise<bigint | undefined>,
	{ inventory, leases, restorer }: DaemonParts,
	{ sweep, network }: ShutdownWork,
): Promise<void> {
	// First, and unconditionally: nothing below waits for a sweep that fires halfway through
	// the shutdown, so the interval stops before anything else does.
	clearInterval(sweep);
	// Then one last look, on purpose. A lease that expired seconds ago has a device owed a
	// restoration and no holder left to ask for it; if this process does not notice now,
	// nothing ever will — leases die with the host (D6), so a successor sees no expired holder
	// at all. Synchronous, and the restorations it starts are what `settleAll` below waits for.
	leases.sweep();

	// Started here, awaited at the end. Stopping the watches and refusing new connections are
	// independent, and doing them in sequence would leave the socket accepting and dispatching
	// for as long as a child takes to die — a window in which `list_devices` is answered by an
	// inventory that has already dropped its subscriptions. Awaiting it below still means
	// `RunningDaemon.close()` resolving is a statement that the watches are gone, not merely
	// that they were asked to go.
	const stopped = stopWatches(inventory);
	// Started here for the same reason and awaited beside it: the two are independent — a
	// restoration drives a backend directly and needs no watch — and doing them in sequence
	// would add one bound to the other for nothing. Snapshotted now, after the final sweep, so
	// it covers every restoration this daemon ever owed.
	const restored = settleRestorations(restorer);
	// And the network listener beside them, for the same reason: stopping the TLS server and
	// stopping the watches are independent, and a peer holding an idle TLS connection would
	// otherwise be waited on in sequence with them. `undefined` when this host never opened
	// one — the local socket is the whole of it.
	const networkClosed = network === undefined ? undefined : closeNetworkListener(network);

	await new Promise<void>((resolve) => {
		// Set before `close()`, not after: a connection already past `accept()` in the kernel
		// can still reach this server's `'connection'` handler for a moment after `close()` is
		// called, and one added to `connections` after this loop already ran would never be
		// destroyed and would hold `close()`'s callback (and the socket file) open forever.
		// `startClosing()` makes that handler destroy such a connection on arrival instead of
		// tracking it.
		startClosing();
		server.close(() => resolve());
		// `close()` only stops accepting; it resolves when the last connection ends, which a
		// client holding an idle connection never does. A daemon asked to shut down has to
		// actually go away, so live connections are dropped rather than waited on.
		for (const connection of connections) {
			connection.destroy();
		}
	});

	await stopped;
	await restored;
	await networkClosed;

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

/**
 * Stop the device watches, bounded.
 *
 * `DeviceInventory.stop()` never rejects, but it is not bounded either: it awaits each
 * backend's watch, and a backend typically stops one by signalling a child process and
 * waiting for it to exit. A child that ignores the signal would hold this promise — and so
 * `RunningDaemon.close()`, and so `main.ts`'s exit — open forever. The timeout is a leak
 * reported out loud in exchange for a daemon that actually goes away; the alternative is one
 * that does neither.
 */
async function stopWatches(inventory: DeviceInventory): Promise<void> {
	if (await timesOut(inventory.stop(), WATCH_STOP_TIMEOUT_MS)) {
		console.warn(
			`The device watches did not stop within ${WATCH_STOP_TIMEOUT_MS}ms. Shutting down ` +
				`anyway; something they started may still be running.`,
		);
	}
}

/**
 * Wait out the restorations still in flight, bounded — see {@link RESTORE_SETTLE_TIMEOUT_MS}.
 *
 * `DeviceRestorer.settleAll` never rejects (a contained step is a warning, not a throw), so
 * the only two outcomes are "everything owed was done" and "it was not, and here is that in
 * writing". A device left half-restored is worth a line in the log, because no later run of
 * anything will discover it.
 */
async function settleRestorations(restorer: DeviceRestorer): Promise<void> {
	if (await timesOut(restorer.settleAll(), RESTORE_SETTLE_TIMEOUT_MS)) {
		console.warn(
			`Device restoration did not finish within ${RESTORE_SETTLE_TIMEOUT_MS}ms. Shutting ` +
				`down anyway; a device may be left in the state its last lease put it in, and ` +
				`nothing will retry it.`,
		);
	}
}

/**
 * Stop the TLS listener, bounded — see {@link NETWORK_CLOSE_TIMEOUT_MS}.
 *
 * `NetworkListener.close()` never rejects: it stops accepting, destroys every socket it tracks,
 * and resolves when the server's last connection is gone. The bound is here because that last
 * clause is Node's bookkeeping rather than ours, and the shutdown path is the one place where
 * "waited too long" has to beat "waited forever".
 */
async function closeNetworkListener(network: NetworkListener): Promise<void> {
	if (await timesOut(network.close(), NETWORK_CLOSE_TIMEOUT_MS)) {
		console.warn(
			`The network listener did not stop within ${NETWORK_CLOSE_TIMEOUT_MS}ms. Shutting down ` +
				`anyway; the port may stay bound until this process exits.`,
		);
	}
}

/** Whether `work` outlasted `limitMs`. The work itself is never cancelled — nothing here can. */
async function timesOut(work: Promise<void>, limitMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const expiry = new Promise<'timed-out'>((resolve) => {
		timer = setTimeout(() => resolve('timed-out'), limitMs);
		// Unreferenced: this timer exists to stop us waiting, never to keep a process alive that
		// is otherwise finished.
		timer.unref();
	});

	try {
		return (await Promise.race([work, expiry])) === 'timed-out';
	} finally {
		clearTimeout(timer);
	}
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
	/** Switches the connection handler from tracking new sockets to destroying them on arrival. */
	readonly startClosing: () => void;
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
function listenOnce(
	socketPath: string,
	ipcServer: IpcServer,
): Promise<ListenSucceeded | ListenFailed> {
	const connections = new Set<Socket>();
	let closing = false;
	const server = createServer((socket: Socket) => {
		if (closing) {
			socket.destroy();
			return;
		}
		connections.add(socket);
		socket.on('close', () => connections.delete(socket));
		ipcServer.handleConnection(socket);
	});
	const startClosing = () => {
		closing = true;
	};

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
			resolve({ listening: true, server, connections, startClosing });
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

/**
 * Whether something is accepting connections on the path.
 *
 * Any failure means "nothing is serving here": a stale socket left by a killed daemon
 * answers `ECONNREFUSED`, and a plain file sitting on the path answers `ENOTSOCK` on
 * macOS 25.6 — different codes for the same conclusion, and enumerating them would just
 * be a list to get wrong on the next platform.
 *
 * A bound socket answers from the kernel's accept queue — no application code has to run
 * for `connect` to fire — so hitting the timeout is not a slow-but-live daemon; it is the
 * same "nothing is serving here" conclusion by a third route, reached because a corpse
 * produces no event at all rather than an error. Treating it as "answered" would leave a
 * corpse un-reclaimed for a full `startTimeoutMs` at the caller instead of the ~500ms this
 * probe budgets for it.
 */
async function probeAnswers(socketPath: string): Promise<boolean> {
	const attempt = await attemptConnect(socketPath, PROBE_TIMEOUT_MS);
	return attempt.outcome === 'connected';
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
