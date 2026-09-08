/**
 * One supervised `idb_companion` per target, spoken to over gRPC — the transport every screen
 * read and every input primitive on this platform will go through (`PROJECT.md` R47).
 *
 * **gRPC from Node, not the Python client.** The companion *is* a gRPC server; `fb-idb` is a
 * convenience wrapper around it (`docs/IOS.md` §4). Talking to it directly drops a Python
 * dependency and the ~70 ms per-call CLI start-up every measurement in that document paid — a
 * second call on an established channel came back in **1 ms** on this bench.
 *
 * **The process is `./idb-companion.ts`', and only the argv is this module's.** That runner
 * already decided the spawn, the two pipes, the `DEVELOPER_DIR` export and the kill, for
 * `watchDevices`' host-wide `--notify` companion; a per-target one is the same process with a
 * different argv, so nothing about running one is duplicated here. What is here is the socket,
 * the channel, the readiness, and the death.
 *
 * **A unix domain socket, not a TCP port**, and that is measured rather than assumed. Both routes
 * work: `--grpc-port 0` makes the companion bind an ephemeral port and print
 * `{"grpc_port":56927,…}` on stdout, and `--grpc-domain-sock <path>` makes it bind that path and
 * print `{"grpc_path":"…"}` — either way the companion reports what it settled on, so nothing has
 * to pre-bind a free port to find out (companion v1.5.2, 2026-09-08, `docs/IOS.md` §4). The
 * socket is chosen because of what the port route binds: `Swift server started on [IPv6]::/:::56927`
 * — **every interface, with no authentication of any kind**. Rover's whole shape is a host that
 * lends its devices to agents on other machines (D17), and the lease layer is the only lock in
 * this stack — two companions on one udid both bind and both accept commands (`docs/IOS.md` §4) —
 * so an open port carrying the full companion API is a way round that lock for anyone who can
 * reach the host. A socket file under this process's own `mkdtemp` directory is reachable by
 * whoever can already read this host's filesystem, which is a much smaller set than "the network".
 *
 * **Nothing here runs on its own.** There is no background task, no health timer and no eager
 * respawn: a companion is started by a call, and a companion that died is *forgotten* by a call so
 * that the next one starts a fresh one. That is deliberate rather than lazy — every entry point
 * here is reached from a backend method behind a lease, and a supervisor with a timer of its own
 * would be exactly the thing that reaches a device outside one.
 *
 * **A companion's death is an interruption, not a device fault** ({@link IdbCompanionInterruptedError}).
 * Killing one does not disturb the simulator — measured, the device stayed `Booted` across the
 * companion's exit (`docs/IOS.md` §4) — so a call that was in flight when its companion died has
 * lost *this host's way of talking to the device*, and nothing about the device. It never becomes
 * a `DeviceVanishedError` and never makes a device look offline.
 *
 * **`push` is never called, on any path, for any reason.** It crashes the companion
 * deterministically on v1.5.2 — exit 133 / SIGTRAP, *"NIOThrowingAsyncSequenceProducer allows only
 * a single AsyncIterator to be created"* — taking every other in-flight call for that device with
 * it, which is why a simulator's file transfers go through the host path instead (#228,
 * `./containers.ts`). {@link IDB_RPCS} is the closed list of RPCs this backend may name and `push`
 * is not on it; `tests/unit/backends/ios-simulator/no-idb-file-push.test.ts` is the executable
 * half, because a rule this expensive to break is worth more than a paragraph.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	credentials,
	type GrpcObject,
	loadPackageDefinition,
	type ServiceClientConstructor,
	type ServiceError,
	status,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { z } from 'zod';
import type { DeviceSerial } from '../../core/ids.js';
import { unwrap } from '../../core/ids.js';
import { type Observation, waitForCondition } from '../../core/wait.js';
import {
	IDB_COMPANION_STDERR_TAIL_CHARS,
	type IdbCompanionStream,
	streamIdbCompanion,
} from './idb-companion.js';
import { IDB_COMPANION } from './idb-companion-path.js';
import { quoteStream } from './simctl.js';

/**
 * Every RPC this backend is allowed to name, and nothing else.
 *
 * A closed list rather than the whole service, for one reason: `push` is on that service and
 * calling it kills the companion and every call in flight beside it (module header). A union
 * derived from this tuple is what makes naming it a *compile* error, and the scan beside it is
 * what makes adding it here a test failure — the two halves of one rule.
 *
 * Two entries: the handshake, and the screen read `readScreen` is built on
 * (`./parsers/accessibility.ts` owns which of its three formats is asked for). A phase that needs
 * `hid` adds it here deliberately, which is the point of the list.
 */
export const IDB_RPCS = ['describe', 'accessibility_info'] as const;
export type IdbRpc = (typeof IDB_RPCS)[number];

/**
 * The read-only call a start is proved with — the companion answering, not merely listening.
 *
 * `describe` because it touches nothing: it reports the target's udid, state, os version and
 * screen dimensions and changes nothing about the device. Cheap enough to be a handshake at 1 ms
 * on an established channel (module header).
 */
export const IDB_HEALTH_RPC: IdbRpc = 'describe';

/**
 * How long a companion has to be spawned, report its socket and answer a call.
 *
 * Measured on this bench, v1.5.2 against a booted iPhone 17: the socket was reported at **+353 ms**
 * and `describe` answered at **+423 ms** from spawn (`docs/IOS.md` §4). `RECORDING_START_TIMEOUT_MS`'
 * value with a twenty-fold margin over what was observed, for the same reason it has one — the
 * host may be busy, and the alternative to a generous bound is a flap on a loaded machine.
 *
 * It bounds the **whole** start rather than each of the two waits inside it, so a start can never
 * take twice what this says — including the handshake *call*, whose gRPC deadline is clamped to
 * what is left of this rather than being a call timeout of its own (`SupervisedCompanion.start`).
 */
export const IDB_COMPANION_START_TIMEOUT_MS = 10_000;

/**
 * How often a starting companion is checked for having got there.
 *
 * `waitForCondition`'s 250 ms default is a grid for conditions that take seconds; this one is two
 * pipes and a unix socket on this machine, and it is met at **+353 ms** for the socket and
 * **+423 ms** for the first answer (`docs/IOS.md` §4). On that grid the first call of a lease pays
 * up to a quarter second of pure rounding, twice — so the interval is the one a local pipe
 * deserves, and polling it finely costs nothing because each check is a string search or a call
 * that is already in flight.
 */
const IDB_COMPANION_START_POLL_MS = 25;

/**
 * The deadline on one gRPC call.
 *
 * Every external invocation gets a timeout (ai/CODING_STANDARDS.md), and a gRPC deadline is the
 * companion's own version of one — it travels with the call, so a companion that is wedged rather
 * than dead cannot hold a lease open. `SCREENSHOT_SIMCTL_TIMEOUT_MS`' value: the slowest thing
 * this transport will carry is a screen read, and that is the bound this backend already decided
 * for one.
 */
export const IDB_CALL_TIMEOUT_MS = 30_000;

/**
 * How long a dropped channel is given to be explained by the process ending, and how often that
 * is checked — {@link SupervisedCompanion}'s `#failed` carries why it has to be at all.
 *
 * Short and finely polled, because this is only ever paid on a failure and what it is waiting for
 * is two pipes flushing: the gap between a socket closing and Node reporting the child's `close`
 * is milliseconds, so the bound is generous by two orders of magnitude and the interval is what
 * keeps a crash from *feeling* like a hang.
 */
const IDB_COMPANION_END_GRACE_MS = 500;
const IDB_COMPANION_END_POLL_MS = 10;

/**
 * The vendored service definition, and the service inside it.
 *
 * Loaded at run time by `@grpc/proto-loader` because this repository runs from source through
 * `tsx` and has no build step: generated clients would have to be committed and hand-kept in step
 * with the `.proto` they came from (`./idb/idb.proto`'s header).
 */
const IDB_PROTO_PATH = fileURLToPath(new URL('./idb/idb.proto', import.meta.url));
const IDB_PACKAGE = 'idb';
const IDB_SERVICE = 'CompanionService';

/**
 * `keepCase` is the load-bearing one: without it the loader would rename every field and method
 * into camelCase, and the names in this repository would then match neither the vendored proto
 * beside it nor idb's own documentation — including the one name a scan has to be able to find.
 * The other four are `@grpc/proto-loader`'s standard set for reading a message without surprises:
 * a 64-bit field arrives as a string rather than as a lossy `number`, an enum as its name, an
 * unset scalar as its default, and a `oneof` says which arm it is.
 */
const PROTO_LOADER_OPTIONS = {
	keepCase: true,
	longs: String,
	enums: String,
	defaults: true,
	oneofs: true,
} as const;

/**
 * Where a companion's socket goes: one `mkdtemp` directory per companion, removed when it dies.
 *
 * A fresh directory rather than a derived path, because a socket file left behind by a companion
 * this host did not shut down cleanly would otherwise sit exactly where the next one wants to
 * bind. Nothing has to re-derive it — unlike a recording, which outlives the call that made it
 * (`./backend.ts`'s `RECORDING_PATH_PREFIX`), a socket is meaningless once its process is gone.
 *
 * **The name is short on purpose.** A unix socket path is bounded by `sun_path`, 104 bytes on
 * macOS, and the whole of this one measured 80 on this bench — `/var/folders/…/T` is 48 of them.
 * A host with a much longer `TMPDIR` would fail to bind, and it fails *legibly*: the companion's
 * own complaint is on the stderr that {@link IdbCompanionInterruptedError} carries.
 */
export const IDB_COMPANION_DIRECTORY_PREFIX = 'rover-idb-';
const COMPANION_SOCKET_NAME = 'companion.sock';

/**
 * What the companion prints on stdout once it has bound, parsed rather than assumed.
 *
 * It reports the path *it* settled on rather than echoing the argv, which is the same courtesy
 * `--grpc-port 0` does with the port it chose, and it is read back for that reason: what the
 * program says it bound is more authoritative than what it was asked to bind.
 *
 * A schema rather than a regex, ai/CODING_STANDARDS.md's rule for external output, and inline
 * rather than in `./parsers/` because this is one key of this module's own handshake — the shapes
 * in that directory are the ones with captured fixtures behind them.
 */
const CompanionReadySchema = z.object({ grpc_path: z.string().min(1) });

/** The mode this module starts a companion in: one target, one socket. */
function companionArgv(udid: string, socketPath: string): string[] {
	return ['--udid', udid, '--grpc-domain-sock', socketPath];
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The companion this call was talking to is gone.
 *
 * **This is an interruption, not a device fault**, and the distinction is the whole reason the
 * class exists. Killing a companion does not disturb the simulator — the device stayed `Booted`
 * across the exit, measured (`docs/IOS.md` §4) — so what was lost is this host's way of talking to
 * a device that is still perfectly fine. A caller that turned this into a
 * {@link DeviceVanishedError} would take a working device out of the inventory over a process
 * this host is supposed to supervise.
 *
 * It names the program, because the program is the half an operator can act on
 * (`./idb-companion-path.ts`'s reasoning for `IDB_COMPANION_MISSING`), and it says that another
 * one will be started — which is true and is what makes the failure worth retrying rather than
 * reporting upwards.
 */
export class IdbCompanionInterruptedError extends Error {
	constructor(
		readonly udid: string,
		/** The RPC that was in flight, or `null` when the companion never got as far as answering. */
		readonly rpc: IdbRpc | null,
		readonly reason: string,
	) {
		super(
			`${IDB_COMPANION} for ${udid} ended ${
				rpc === null ? 'before it was ready to answer' : `while '${rpc}' was in flight`
			}: ${reason}\n` +
				'The device itself was not disturbed — a new companion is started for the next call.',
		);
		this.name = 'IdbCompanionInterruptedError';
	}
}

/** The vendored service, loaded once. */
let service: ServiceClientConstructor | null = null;

/**
 * The client constructor for `idb.CompanionService`.
 *
 * **Memoised, unlike `resolveIdbCompanion()`**, and the contrast is the point: that search reads
 * a *host* that can gain an `idb_companion` while the daemon runs, so holding its answer would
 * make the first attempt of a daemon's life the only one. This reads a file shipped beside this
 * source, which cannot change under a running process, so parsing 1,200 lines of proto once per
 * companion would buy nothing.
 */
function companionService(): ServiceClientConstructor {
	if (service !== null) return service;

	const loaded = loadPackageDefinition(loadSync(IDB_PROTO_PATH, PROTO_LOADER_OPTIONS));
	const found = (loaded[IDB_PACKAGE] as GrpcObject | undefined)?.[IDB_SERVICE];
	if (typeof found !== 'function') {
		// The vendored proto was replaced by a release that renamed the service. Worth its own
		// sentence: the alternative is `found is not a constructor` at the first call of a lease.
		throw new Error(
			`${IDB_PROTO_PATH} does not define ${IDB_PACKAGE}.${IDB_SERVICE} — the vendored proto and ` +
				'this client have come apart.',
		);
	}
	service = found as ServiceClientConstructor;
	return service;
}

/** One RPC, as `@grpc/grpc-js` exposes it on a dynamically loaded client. */
type UnaryCall = (
	request: object,
	options: { deadline: Date },
	callback: (error: ServiceError | null, response: unknown) => void,
) => void;

/**
 * One `idb_companion` for one target: the child, the channel, and everything that happens when it
 * dies.
 *
 * Its whole lifetime is owned by {@link IdbCompanions}, which is what decides when one is needed;
 * this holds no timer and starts nothing on its own.
 */
class SupervisedCompanion {
	/**
	 * Every byte of stdout until the socket has been read, and **nothing is retained after that**
	 * — `null` is what the handler checks, rather than an array something clears once.
	 *
	 * The handshake is the only thing on this stream anyone reads, and a companion is meant to
	 * outlive many calls: a handler that kept pushing would grow a buffer nobody drains for as
	 * long as the daemon holds the companion. `#stderrTail` is bounded for the same reason and
	 * survives, because that one is read on every death.
	 */
	#stdout: Buffer[] | null = [];
	#stderrTail = '';
	#stream: IdbCompanionStream | null = null;
	#client: InstanceType<ServiceClientConstructor> | null = null;
	#death: string | null = null;
	/** The removal of {@link directory}, once something has started it — see {@link collect}. */
	#collected: Promise<void> | null = null;
	/** Calls in flight, each of which fails the moment the companion does. */
	readonly #waiting = new Set<(reason: string) => void>();

	constructor(
		readonly udid: string,
		readonly directory: string,
		/**
		 * Told once, when this companion stops being usable, so its holder can forget it — and
		 * handed the removal of the socket directory, which is the one thing a companion leaves
		 * behind. A holder that dropped it could not tell a collected directory from a pending
		 * `rm`, which is a race for anything that has to know the host is tidy.
		 */
		private readonly onDeath: (collected: Promise<void>) => void,
	) {}

	/**
	 * Spawn, wait for the socket, then wait for an answer — and resolve only then.
	 *
	 * Two conditions with one deadline between them (ai/RULES.md §2: waiting is on a condition,
	 * never on a duration). The second is not redundant on the first: a companion that has printed
	 * its socket has bound it, but what a caller is about to do is make a call, and the only
	 * evidence that a call will be answered is a call being answered. It costs one `describe`,
	 * which is 1 ms on an established channel and is also what warms the lazily-connected channel
	 * so the caller's own first call does not pay the connect.
	 */
	async start(timeoutMs: number, callTimeoutMs: number): Promise<void> {
		const socketPath = join(this.directory, COMPANION_SOCKET_NAME);
		const deadline = Date.now() + timeoutMs;
		const remaining = (): number => Math.max(0, deadline - Date.now());

		// Let out synchronously by the runner when this host has no companion at all, and let out
		// of here the same way: `IdbCompanionNotFoundError` names every place that was looked in,
		// and burying it in a readiness timeout would lose all of it.
		this.#stream = streamIdbCompanion(companionArgv(this.udid, socketPath), {
			onStdout: (chunk) => {
				// `null` once the handshake has been read: nothing reads this stream again, so
				// what is handed over past that point is dropped rather than accumulated.
				this.#stdout?.push(chunk);
			},
			onStderr: (chunk) => {
				this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-IDB_COMPANION_STDERR_TAIL_CHARS);
			},
			onEnd: (reason) => {
				this.#end(`${reason}\nstderr: ${quoteStream(this.#stderrTail)}`);
			},
		});

		const reported = await waitForCondition({
			what: `${IDB_COMPANION} for ${this.udid} to report the socket it bound`,
			timeoutMs,
			pollIntervalMs: IDB_COMPANION_START_POLL_MS,
			probe: () => this.#probeSocket(),
		});
		this.#stdout = null;

		this.#client = new (companionService())(`unix://${reported}`, credentials.createInsecure());

		await waitForCondition({
			what: `${IDB_COMPANION} for ${this.udid} to answer '${IDB_HEALTH_RPC}'`,
			// What is left of the one deadline, never a second full one. `waitForCondition` probes
			// before it waits, so a value clamped to zero still costs exactly one check.
			timeoutMs: remaining(),
			pollIntervalMs: IDB_COMPANION_START_POLL_MS,
			// And the *call* is bounded the same way, because `waitForCondition` awaits a probe to
			// completion before it looks at its deadline: a full call deadline in here would let a
			// companion that binds and never answers hold a start for the start budget plus a call
			// timeout, which is the opposite of what `IDB_COMPANION_START_TIMEOUT_MS` promises.
			probe: () => this.#probeAnswer(Math.min(callTimeoutMs, remaining())),
		});
	}

	/**
	 * One unary call, with a deadline, that fails the instant its companion dies.
	 *
	 * The race is against the *process*, not against the channel: a companion killed mid-call
	 * would otherwise be reported by gRPC as whatever the socket looked like on the way down,
	 * which is a message about a transport rather than about the program a person can restart.
	 */
	async call(rpc: IdbRpc, request: object, timeoutMs: number): Promise<unknown> {
		const client = this.#client;
		if (this.#death !== null || client === null) {
			throw new IdbCompanionInterruptedError(this.udid, rpc, this.#death ?? 'it was never started');
		}

		const invoke = client[rpc] as UnaryCall;
		return await new Promise<unknown>((resolve, reject) => {
			const died = (reason: string): void => {
				reject(new IdbCompanionInterruptedError(this.udid, rpc, reason));
			};
			this.#waiting.add(died);

			invoke.call(
				client,
				request,
				{ deadline: new Date(Date.now() + timeoutMs) },
				(error, response) => {
					this.#waiting.delete(died);
					if (error !== null) {
						this.#failed(rpc, error).then(reject, reject);
						return;
					}
					resolve(response);
				},
			);
		});
	}

	/**
	 * What to fail a call with when gRPC refuses it — the interruption, or the companion's own
	 * answer.
	 *
	 * **gRPC sees a companion die before Node does**, and that is not a subtlety this module can
	 * skip: the socket closes the moment the process goes, while `onEnd` waits on the child's
	 * `close`, which is one flush of two pipes later. Without this, every crash mid-call would be
	 * reported as `14 UNAVAILABLE: Connection dropped` — a sentence about a transport, from which
	 * nobody could tell that the program a person can restart is the thing that died.
	 *
	 * So `UNAVAILABLE`, and only `UNAVAILABLE`, is given a moment to be explained by the process
	 * ending, because it is the one status that means the channel rather than the call. A status
	 * the companion chose — a deadline, a bad argument — is its answer and is passed straight on.
	 * If the grace runs out with the process still running, this stays the plain failure: claiming
	 * an interruption would promise a replacement companion that nothing is going to start.
	 */
	async #failed(rpc: IdbRpc, error: ServiceError): Promise<Error> {
		const reason = error.code === status.UNAVAILABLE ? await this.#endReason() : this.#death;
		if (reason !== null) return new IdbCompanionInterruptedError(this.udid, rpc, reason);

		// A live companion that refused the call: its own answer, with the two things it cannot
		// know it is missing — which device, and which call.
		return new Error(`${IDB_COMPANION} for ${this.udid}: '${rpc}' failed: ${message(error)}`, {
			cause: error,
		});
	}

	/** How this companion ended, waited for briefly, or `null` if it has not ended at all. */
	async #endReason(): Promise<string | null> {
		if (this.#death !== null) return this.#death;
		try {
			return await waitForCondition({
				what: `${IDB_COMPANION} for ${this.udid} to report how it ended`,
				timeoutMs: IDB_COMPANION_END_GRACE_MS,
				pollIntervalMs: IDB_COMPANION_END_POLL_MS,
				probe: () =>
					this.#death === null
						? { met: false, found: 'a process that is still running' }
						: { met: true, value: this.#death },
			});
		} catch {
			return null;
		}
	}

	/**
	 * Kill this companion and take its socket directory with it.
	 *
	 * The calls in flight are failed *first*, and told plainly that they were stopped: the runner's
	 * `stop()` silences every handler, so a call left waiting for an `onEnd` that will never come
	 * would sit out its own deadline instead.
	 */
	async stop(): Promise<void> {
		const stream = this.#stream;
		this.#stream = null;
		this.#end(`${IDB_COMPANION} for ${this.udid} was stopped`);
		await stream?.stop();
		// The same promise `#end` already started, not a second removal — so a caller that awaited
		// `stop()` is looking at a host with nothing of this companion left on it.
		await this.collect();
	}

	/**
	 * Remove the directory this companion's socket lived in, at most once, and answer with that
	 * removal however many times it is asked for.
	 *
	 * Memoised because there are two ways in — the companion dying and this host stopping it —
	 * and "the directory is gone" has to be a state something can wait on rather than a side
	 * effect started twice and observable from nowhere.
	 *
	 * Failures are swallowed deliberately: the directory is a `mkdtemp` under the host's temporary
	 * path, so the worst a failure costs is a file the operating system collects later — while
	 * throwing here would turn tidying up into the reason a call failed.
	 */
	collect(): Promise<void> {
		this.#collected ??= rm(this.directory, { recursive: true, force: true }).catch(() => {});
		return this.#collected;
	}

	/**
	 * Everything that has to happen exactly once, whether the companion died or was stopped.
	 *
	 * The socket directory is collected from here rather than from `onEnd` alone, because a
	 * companion that died on its own is never handed to `stop()`: `#companion`'s death handler
	 * drops it from the pool, so without a collector on this path a daemon restarting a crashing
	 * companion accumulates one directory holding one dead socket per crash. The removal runs
	 * concurrently with the kill in the `stop()` path, which is safe — the channel is closed
	 * above and a bound socket keeps its file descriptor after its name is unlinked.
	 */
	#end(reason: string): void {
		if (this.#death !== null) return;
		this.#death = reason;
		this.#client?.close();
		this.#client = null;
		for (const waiting of this.#waiting) waiting(reason);
		this.#waiting.clear();
		this.onDeath(this.collect());
	}

	/** The socket the companion says it bound, once it has said so. */
	#probeSocket(): Observation<string> {
		if (this.#death !== null) {
			// Not a timeout, and `waitForCondition` lets a probe's throw out unchanged for exactly
			// this: a companion that is already gone will not become ready by being waited for.
			throw new IdbCompanionInterruptedError(this.udid, null, this.#death);
		}

		const printed = Buffer.concat(this.#stdout ?? []).toString('utf8');
		const end = printed.indexOf('\n');
		if (end === -1) return { met: false, found: 'nothing on stdout yet' };

		// A line that is not the handshake is this module and the companion disagreeing about the
		// protocol, which no amount of waiting fixes — so it throws rather than reporting `found`.
		return {
			met: true,
			value: CompanionReadySchema.parse(JSON.parse(printed.slice(0, end))).grpc_path,
		};
	}

	/** Whether the companion answers a call, which is the only proof that it will. */
	async #probeAnswer(timeoutMs: number): Promise<Observation<null>> {
		try {
			await this.call(IDB_HEALTH_RPC, {}, timeoutMs);
			return { met: true, value: null };
		} catch (cause) {
			// A companion that died mid-handshake is not a condition still worth polling for.
			if (cause instanceof IdbCompanionInterruptedError) throw cause;
			return { met: false, found: message(cause) };
		}
	}
}

/** What a suite replaces to keep a case off a real clock; not a configuration surface. */
export interface IdbCompanionsOptions {
	readonly startTimeoutMs?: number;
	/** Every call, the handshake included — otherwise a start would still be on a real clock. */
	readonly callTimeoutMs?: number;
}

/**
 * The companions this host is supervising, one per target.
 *
 * **Every method is called from a backend method behind a lease**, and there is deliberately
 * nothing else here to call: no watcher, no timer, no pre-warm. Two companions on one udid both
 * bind and both accept commands (`docs/IOS.md` §4), so the lease layer is the only lock in this
 * stack — a transport that started one on a schedule of its own would be reaching a device outside
 * it.
 *
 * Held by the backend for its own lifetime, which is what makes the channel worth keeping: the
 * companion outlives the call, so the second call on a device pays 1 ms rather than a spawn.
 */
export class IdbCompanions {
	readonly #startTimeoutMs: number;
	readonly #callTimeoutMs: number;
	/** One entry per udid, holding the start rather than the result, so two callers share one. */
	readonly #companions = new Map<string, Promise<SupervisedCompanion>>();
	/**
	 * The socket directories still being removed, for the companions this pool no longer holds.
	 *
	 * A companion that died on its own is dropped from `#companions` by its own death handler, so
	 * `stopAll()` would otherwise return while the last thing it left on the host was still going
	 * away — a shutdown nobody can wait on, and the shape of an intermittent failure for anything
	 * that then looks at the temporary path.
	 */
	readonly #collecting = new Set<Promise<void>>();

	constructor(options: IdbCompanionsOptions = {}) {
		this.#startTimeoutMs = options.startTimeoutMs ?? IDB_COMPANION_START_TIMEOUT_MS;
		this.#callTimeoutMs = options.callTimeoutMs ?? IDB_CALL_TIMEOUT_MS;
	}

	/**
	 * Make one call against `serial`, starting a companion for it if none is running.
	 *
	 * Throws {@link IdbCompanionInterruptedError} when the companion dies before the call is
	 * answered, `IdbCompanionNotFoundError` when this host has no companion to run, and a
	 * {@link WaitTimeoutError} when one starts but never answers.
	 */
	async call(serial: DeviceSerial, rpc: IdbRpc, request: object): Promise<unknown> {
		const companion = await this.#companion(unwrap(serial));
		return await companion.call(rpc, request, this.#callTimeoutMs);
	}

	/** Stop the companion for `serial`, if there is one. A device with none is not an error. */
	async stop(serial: DeviceSerial): Promise<void> {
		await this.#stop(unwrap(serial));
	}

	/**
	 * Stop every companion this host is running — the daemon shutting down, or a suite ending.
	 *
	 * And wait for what the ones that died on their own left behind: `#stop()` covers a companion
	 * this pool still holds, `#collecting` covers the rest, and between them this resolving means
	 * the host is tidy rather than nearly tidy.
	 */
	async stopAll(): Promise<void> {
		await Promise.all([...this.#companions.keys()].map((udid) => this.#stop(udid)));
		await Promise.all([...this.#collecting]);
	}

	async #stop(udid: string): Promise<void> {
		const held = this.#companions.get(udid);
		if (held === undefined) return;
		this.#companions.delete(udid);

		// A start that failed left nothing to stop, and its failure belongs to whoever asked for
		// the call — not to whoever is tidying up.
		const companion = await held.catch(() => null);
		await companion?.stop();
	}

	/**
	 * The companion for `udid`, started if there is none.
	 *
	 * A companion that died is forgotten by its own death handler, so this starts a replacement
	 * without ever checking one for health: the *next* call is the restart, and there is no
	 * background respawn to be the thing that touches a device outside a lease (module header).
	 */
	#companion(udid: string): Promise<SupervisedCompanion> {
		const held = this.#companions.get(udid);
		if (held !== undefined) return held;

		// Declared before the start so the handler can recognise *its own* entry: a companion that
		// dies after a later one has replaced it must not evict the replacement.
		let entry: Promise<SupervisedCompanion> | undefined;
		const forget = (): void => {
			if (this.#companions.get(udid) === entry) this.#companions.delete(udid);
		};
		// A dead companion is forgotten *and* its socket directory's removal is kept hold of, so
		// dropping it from this pool does not drop the last thing anyone can wait on.
		const died = (collected: Promise<void>): void => {
			forget();
			this.#collecting.add(collected);
			void collected.finally(() => {
				this.#collecting.delete(collected);
			});
		};

		entry = this.#start(udid, died);
		// A start that failed is forgotten too, so the next call tries again rather than being
		// handed a stale failure forever — the same reason `./idb-companion-path.ts` is unmemoised.
		entry.catch(forget);
		this.#companions.set(udid, entry);
		return entry;
	}

	async #start(
		udid: string,
		died: (collected: Promise<void>) => void,
	): Promise<SupervisedCompanion> {
		const directory = await mkdtemp(join(tmpdir(), IDB_COMPANION_DIRECTORY_PREFIX));
		const companion = new SupervisedCompanion(udid, directory, died);
		try {
			await companion.start(this.#startTimeoutMs, this.#callTimeoutMs);
		} catch (cause) {
			// Whatever went wrong, this host is not left holding a companion nobody can reach or a
			// socket directory nobody will collect.
			await companion.stop();
			throw cause;
		}
		return companion;
	}
}
