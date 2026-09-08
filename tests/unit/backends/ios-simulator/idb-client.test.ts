import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	IDB_COMPANION_DIRECTORY_PREFIX,
	IDB_HEALTH_RPC,
	IDB_STREAM_RPCS,
	IDB_UNARY_RPCS,
	IdbCompanionInterruptedError,
	IdbCompanions,
} from '@/backends/ios-simulator/idb-client.js';
import { IdbCompanionNotFoundError } from '@/backends/ios-simulator/idb-companion-path.js';
import { WaitTimeoutError } from '@/core/errors.js';
import { parseDeviceSerial } from '@/core/ids.js';

/**
 * The supervisor and the channel, driven against **stub executables** in a `mkdtemp` directory —
 * `./idb-companion.test.ts`' technique one layer up, and here for the sharper version of its
 * reason. What this module is is a spawn, a socket, a channel and a kill, so a mocked
 * `@grpc/grpc-js` would leave every claim in this file asserting the mock's own behaviour.
 *
 * The lifecycle stubs are `sh` scripts; the one that has to *answer* is a Node program serving the
 * **vendored proto** (`tests/helpers/idb-stub-companion.mjs`). So this suite needs no idb, passes
 * on a machine that has never had one, and passes on Linux — while still proving the real
 * `.proto` loads and that the RPC this client names is on that service.
 *
 * **What a green run here cannot claim** is that a real companion behaves as this stub does: the
 * handshake line, the socket and the crash are all modelled from measurements rather than served
 * by Meta's program. `tests/device/ios-simulator/idb.test.ts` is what closes that gap.
 *
 * Nothing here waits on a duration. Every case waits on a call answering or a process dying, and
 * the two timeout cases are timeouts — the condition that never becomes true (ai/RULES.md §2).
 */

const { resolveDeveloperDirMock, resolveIdbCompanionMock } = vi.hoisted(() => ({
	resolveDeveloperDirMock: vi.fn<() => string>(),
	resolveIdbCompanionMock: vi.fn<() => string>(),
}));

vi.mock('@/backends/ios-simulator/idb-companion-path.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/backends/ios-simulator/idb-companion-path.js')>()),
	resolveIdbCompanion: resolveIdbCompanionMock,
}));

/** Whether this machine has an Xcode is not what this suite is about — `./idb-companion.test.ts`. */
vi.mock('@/backends/ios-simulator/developer-dir.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/backends/ios-simulator/developer-dir.js')>()),
	resolveDeveloperDir: resolveDeveloperDirMock,
}));

const STUB_COMPANION = fileURLToPath(
	new URL('../../../helpers/idb-stub-companion.mjs', import.meta.url),
);

/** A udid-shaped serial, so nothing in this suite depends on the shape of an identifier. */
const SERIAL = parseDeviceSerial('88D8476E-F4A4-4A18-A89B-0C47E077CC8B');

/**
 * Short enough that the two cases about a companion that never becomes ready finish quickly, and
 * far longer than a stub needs — `waitForCondition` probes before it waits, so a stub that is
 * already answering never pays any of it.
 */
const START_TIMEOUT_MS = 4_000;

let directory: string;
let sockets: string;
let startsFile: string;
const pools: IdbCompanions[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'rover-stub-companion-'));
	startsFile = join(directory, 'starts.txt');
	/**
	 * **The temporary path the module under test sees is this suite's, not the host's**, and that
	 * is what makes the two cases below assertions rather than races. `IdbCompanions` joins its
	 * `mkdtemp` onto `tmpdir()`, so a scan of the real one cannot tell this suite's directories
	 * from `rover-idb-companion-…` — the prefix `./idb-companion.test.ts` and
	 * `./idb-companion-path.test.ts` use, which *also* starts with `rover-idb-`, in other workers,
	 * at the same time. Scoping it means the only thing in here is what this suite's own calls
	 * made, and it means the suite leaves nothing behind in the operator's own temporary path.
	 *
	 * `rv-` because a unix socket path is bounded by `sun_path`, 104 bytes on macOS, and
	 * `/var/folders/…/T` is already half of that (`idb-client.ts`'
	 * `IDB_COMPANION_DIRECTORY_PREFIX`): a directory named as legibly as `directory` is would
	 * push the socket the module binds over the limit.
	 */
	sockets = await mkdtemp(join(tmpdir(), 'rv-'));
	resolveDeveloperDirMock.mockReturnValue('/Applications/Xcode.app/Contents/Developer');
	vi.stubEnv('TMPDIR', sockets);
	vi.stubEnv('ROVER_STUB_STARTS_FILE', startsFile);
});

afterEach(async () => {
	await Promise.all(pools.splice(0).map((pool) => pool.stopAll()));
	await rm(directory, { recursive: true, force: true });
	await rm(sockets, { recursive: true, force: true });
});

/** A stub companion: `body` as an `sh` script, executable unless a case says otherwise. */
async function stub(body: string, mode = 0o755): Promise<string> {
	const path = join(directory, 'idb_companion');
	await writeFile(path, `#!/bin/sh\n${body}`);
	await chmod(path, mode);
	resolveIdbCompanionMock.mockReturnValue(path);
	return path;
}

/** The one stub that really answers: the Node program serving the vendored proto. */
async function answering(): Promise<void> {
	await stub(`exec '${process.execPath}' '${STUB_COMPANION}' "$@"\n`);
}

/** How many companions were started, counted by the stub itself. */
async function starts(): Promise<number> {
	const written = await readFile(startsFile, 'utf8').catch(() => '');
	return written.split('\n').filter((line) => line !== '').length;
}

/** The socket directories this module has left in the temporary path it was pointed at. */
async function socketDirectories(): Promise<string[]> {
	const entries = await readdir(sockets);
	return entries.filter((entry) => entry.startsWith(IDB_COMPANION_DIRECTORY_PREFIX));
}

function pool(): IdbCompanions {
	const created = new IdbCompanions({ startTimeoutMs: START_TIMEOUT_MS });
	pools.push(created);
	return created;
}

/** The `describe` response, as the stub serves it. */
interface StubDescribe {
	target_description: { udid: string; state: string };
}

describe('the vendored proto', () => {
	/**
	 * The plan's first step, as one case: the client loads with **no companion running at all**.
	 * A `.proto` read at run time is a file that can be moved, renamed or replaced by a newer
	 * release, and the failure of that is otherwise a spawn away from a lease.
	 */
	it('loads and carries every RPC this backend is allowed to name', async () => {
		await answering();

		// Proved through the client rather than by reading the file: a call is what needs the RPC
		// to exist, and one that answers is the only evidence the loaded service really has it.
		// Both lists, each through the call shape it is on that list for — a client-streaming RPC
		// invoked as a unary one is a callback handed to a method that wants none.
		for (const rpc of IDB_UNARY_RPCS) {
			await expect(pool().call(SERIAL, rpc, {})).resolves.toBeDefined();
		}
		for (const rpc of IDB_STREAM_RPCS) {
			await expect(pool().stream(SERIAL, rpc, [])).resolves.toBeUndefined();
		}
	});
});

describe('starting a companion', () => {
	it('answers a call with what the companion said', async () => {
		await answering();

		const answer = (await pool().call(SERIAL, IDB_HEALTH_RPC, {})) as StubDescribe;

		expect(answer.target_description.udid).toBe('88D8476E-F4A4-4A18-A89B-0C47E077CC8B');
		expect(answer.target_description.state).toBe('Booted');
	});

	/** One companion per target: a second call reuses the one already answering. */
	it('starts one companion for a device however many calls are made', async () => {
		await answering();
		const companions = pool();

		await companions.call(SERIAL, IDB_HEALTH_RPC, {});
		await companions.call(SERIAL, IDB_HEALTH_RPC, {});

		expect(await starts()).toBe(1);
	});

	/**
	 * And two calls that race each other share one too — the entry holds the *start*, not the
	 * result, so the second caller waits on the first companion rather than spawning another.
	 */
	it('starts one companion for two calls made at once', async () => {
		await answering();
		const companions = pool();

		await Promise.all([
			companions.call(SERIAL, IDB_HEALTH_RPC, {}),
			companions.call(SERIAL, IDB_HEALTH_RPC, {}),
		]);

		expect(await starts()).toBe(1);
	});

	/**
	 * The resolution's failure comes out of the call naming every place that was looked in — the
	 * runner lets it out synchronously for exactly this, and burying it in a readiness timeout
	 * would lose the only actionable half of it (`./idb-companion-path.test.ts`).
	 */
	it('lets a host with no companion at all say so', async () => {
		resolveIdbCompanionMock.mockImplementation(() => {
			throw new IdbCompanionNotFoundError([]);
		});

		await expect(pool().call(SERIAL, IDB_HEALTH_RPC, {})).rejects.toThrow(
			IdbCompanionNotFoundError,
		);
	});

	/**
	 * A companion that dies before it ever answers is an interruption too, and the message says
	 * which of the two it was — nothing was in flight, so nothing can be named as having failed.
	 */
	it('reports a companion that exits before its handshake as an interruption', async () => {
		await stub("echo 'could not connect to CoreSimulator' >&2\nexit 3\n");

		const failure = await pool()
			.call(SERIAL, IDB_HEALTH_RPC, {})
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(IdbCompanionInterruptedError);
		expect((failure as Error).message).toContain('idb_companion');
		expect((failure as Error).message).toContain('before it was ready to answer');
		// The stderr tail is what explains it, and the runner hands it over rather than quoting it.
		expect((failure as Error).message).toContain('could not connect to CoreSimulator');
	});

	/**
	 * A companion that runs and says nothing is a **timeout**, not an interruption: nothing died,
	 * and what the caller needs to hear is what was waited for.
	 */
	it('times out on a companion that never reports a socket', async () => {
		await stub('exec tail -f /dev/null\n');

		await expect(
			new IdbCompanions({ startTimeoutMs: 300 }).call(SERIAL, IDB_HEALTH_RPC, {}),
		).rejects.toThrow(WaitTimeoutError);
	});

	/**
	 * And a companion whose first line is not the handshake is this client and that program
	 * disagreeing about the protocol, which no amount of waiting fixes — so it fails at once
	 * rather than at the deadline.
	 */
	it('refuses a first line that is not the handshake, without waiting out the timeout', async () => {
		await stub("echo 'not json at all'\nexec tail -f /dev/null\n");

		await expect(
			new IdbCompanions({ startTimeoutMs: 30_000 }).call(SERIAL, IDB_HEALTH_RPC, {}),
		).rejects.not.toBeInstanceOf(WaitTimeoutError);
	});

	/**
	 * And a companion that binds, prints its handshake and then answers nothing is bounded by the
	 * **start** budget rather than by a call timeout — which is a claim about the handshake's own
	 * gRPC deadline, not about the wait around it. `waitForCondition` runs a probe to completion
	 * before it looks at its deadline, so a handshake carrying the full call timeout would make a
	 * start cost the start budget *plus* that timeout.
	 *
	 * `callTimeoutMs` is set two orders of magnitude above `startTimeoutMs` on purpose: a
	 * regression is then this case hanging past the suite's own timeout rather than a number that
	 * is subtly too large.
	 */
	it('bounds a companion that binds and never answers by the start timeout', async () => {
		await answering();
		vi.stubEnv('ROVER_STUB_NEVER_ANSWERS', '1');

		await expect(
			new IdbCompanions({ startTimeoutMs: 300, callTimeoutMs: 60_000 }).call(
				SERIAL,
				IDB_HEALTH_RPC,
				{},
			),
		).rejects.toThrow(WaitTimeoutError);
	});
});

/**
 * The client-streaming call, which is `hid` and nothing else — every input primitive on this
 * platform goes through it.
 *
 * What makes it worth its own block rather than a line in the one above is that a client-streaming
 * call is a different shape in `@grpc/grpc-js`: the requests are written rather than passed, and
 * the options and the callback are told apart **by type rather than by position**, so a leading
 * callback silently discards the deadline. The stub records what it received, which is the only
 * thing such a call has to show for itself.
 */
describe('a streaming call', () => {
	/** The events arrive, in order, as the messages the vendored proto defines. */
	it('writes every event the caller batched, in order', async () => {
		await answering();
		const events = join(directory, 'hid.jsonl');
		vi.stubEnv('ROVER_STUB_HID_FILE', events);

		await pool().stream(SERIAL, 'hid', [
			{ press: { action: { button: { button: 'HOME' } }, direction: 'DOWN' } },
			{ press: { action: { button: { button: 'HOME' } }, direction: 'UP' } },
		]);

		const received = (await readFile(events, 'utf8'))
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => JSON.parse(line) as { press: { direction: string } });
		expect(received.map((event) => event.press.direction)).toEqual(['DOWN', 'UP']);
	});

	/**
	 * An empty batch still reaches the companion and still comes back — which is what makes a
	 * `typeText('')` against a device that has gone a reported failure rather than a local no-op.
	 */
	it('answers an empty batch', async () => {
		await answering();

		await expect(pool().stream(SERIAL, 'hid', [])).resolves.toBeUndefined();
	});

	/**
	 * **The deadline really is on the call**, and this is the case that proves the argument order:
	 * `@grpc/grpc-js` reads a leading function as the callback and throws everything after it away,
	 * so the wrong order here is a stream with no bound at all. The stub binds, prints its
	 * handshake and never answers `describe`, so what ends this is the client's own clock.
	 */
	it('is bounded by a deadline rather than waiting on a wedged companion forever', async () => {
		await answering();
		const companions = new IdbCompanions({
			startTimeoutMs: START_TIMEOUT_MS,
			callTimeoutMs: 50,
		});
		pools.push(companions);
		vi.stubEnv('ROVER_STUB_HID_NEVER_ANSWERS', '1');

		await expect(companions.stream(SERIAL, 'hid', [])).rejects.toThrow(/DEADLINE/i);
	});

	/**
	 * A companion that dies part-way through a batch fails it as an **interruption** naming the
	 * RPC, the same as a unary call — never as a device fault, because killing one leaves the
	 * simulator booted.
	 */
	it('fails a batch whose companion died mid-stream, as an interruption', async () => {
		await answering();
		vi.stubEnv('ROVER_STUB_HID_DIES', '1');

		const failure = await pool()
			.stream(SERIAL, 'hid', [
				{ press: { action: { button: { button: 'HOME' } }, direction: 'DOWN' } },
			])
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(IdbCompanionInterruptedError);
		expect((failure as IdbCompanionInterruptedError).rpc).toBe('hid');
	});
});

describe('a companion that dies', () => {
	/**
	 * The headline: a call in flight when its companion dies fails **naming the program**, saying
	 * it is being replaced, and saying the device was not disturbed — which is measured rather
	 * than claimed (`docs/IOS.md` §4: the device stayed `Booted` across the exit).
	 *
	 * The stub exits 133 without answering, which is the shape of the real crash this transport
	 * is built around.
	 */
	it('fails the call in flight, naming the program and what happens next', async () => {
		await answering();

		const failure = await pool()
			.call(SERIAL, IDB_HEALTH_RPC, { fetch_diagnostics: true })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(IdbCompanionInterruptedError);
		expect((failure as Error).message).toContain('idb_companion');
		expect((failure as Error).message).toContain(`'${IDB_HEALTH_RPC}' was in flight`);
		expect((failure as Error).message).toContain('The device itself was not disturbed');
	});

	/** It is an interruption and nothing else — never a device that vanished or went offline. */
	it('carries the udid, so a caller can say which device lost its transport', async () => {
		await answering();

		const failure = (await pool()
			.call(SERIAL, IDB_HEALTH_RPC, { fetch_diagnostics: true })
			.catch((error: unknown) => error)) as IdbCompanionInterruptedError;

		expect(failure.udid).toBe('88D8476E-F4A4-4A18-A89B-0C47E077CC8B');
		expect(failure.rpc).toBe(IDB_HEALTH_RPC);
	});

	/**
	 * Restart-on-death, and it is the **next call** that performs it: a dead companion is
	 * forgotten rather than eagerly replaced, because a respawn on a schedule of its own would be
	 * this transport reaching a device outside a lease.
	 */
	it('starts a fresh companion for the next call', async () => {
		await answering();
		const companions = pool();

		await expect(
			companions.call(SERIAL, IDB_HEALTH_RPC, { fetch_diagnostics: true }),
		).rejects.toThrow(IdbCompanionInterruptedError);
		const answer = (await companions.call(SERIAL, IDB_HEALTH_RPC, {})) as StubDescribe;

		expect(answer.target_description.state).toBe('Booted');
		expect(await starts()).toBe(2);
	});

	/** A start that failed is forgotten the same way, so a host that gains a companion is picked up. */
	it('retries a start that failed rather than holding its failure forever', async () => {
		await stub('exit 3\n');
		const companions = pool();

		await expect(companions.call(SERIAL, IDB_HEALTH_RPC, {})).rejects.toThrow(
			IdbCompanionInterruptedError,
		);
		await answering();

		await expect(companions.call(SERIAL, IDB_HEALTH_RPC, {})).resolves.toBeDefined();
	});
});

describe('the socket directory', () => {
	/**
	 * One `mkdtemp` directory per companion, and it goes when the companion does — **including
	 * when the companion is the one that ended it**. That is the half worth a case: `stop()` is
	 * what collects a companion this host shut down and is never called for one that crashed, so
	 * without a second collector a daemon restarting a crashing companion accumulates one
	 * directory holding one dead socket per crash, for the life of the host.
	 */
	it('is collected after the companion dies on its own', async () => {
		await answering();
		const companions = pool();

		await expect(
			companions.call(SERIAL, IDB_HEALTH_RPC, { fetch_diagnostics: true }),
		).rejects.toThrow(IdbCompanionInterruptedError);
		// **Waited for, never sampled.** The removal is started by the death and this pool no
		// longer holds the companion, so reading the directory straight after the rejection would
		// race an `rm` that is still in flight. `stopAll()` is what that removal is reachable
		// through, and it cannot be doing the collecting itself: this companion was dropped from
		// the pool the moment it died, so a green run here is the death's own collector or nothing.
		await companions.stopAll();

		expect(await socketDirectories()).toEqual([]);
	});

	/** The other way in, and nothing is waited for here because `stop()` resolves after the `rm`. */
	it('is collected after the companion is stopped', async () => {
		await answering();
		const companions = pool();

		await companions.call(SERIAL, IDB_HEALTH_RPC, {});
		await companions.stop(SERIAL);

		expect(await socketDirectories()).toEqual([]);
	});
});

describe('stop', () => {
	it('kills the companion, so the next call starts another', async () => {
		await answering();
		const companions = pool();

		await companions.call(SERIAL, IDB_HEALTH_RPC, {});
		await companions.stop(SERIAL);
		await companions.call(SERIAL, IDB_HEALTH_RPC, {});

		expect(await starts()).toBe(2);
	});

	it('treats a device with no companion as nothing to do rather than an error', async () => {
		await answering();

		await expect(pool().stop(SERIAL)).resolves.toBeUndefined();
	});

	/** A failed start left no companion behind, and tidying up must not re-raise its failure. */
	it('resolves after a start that failed', async () => {
		await stub('exit 3\n');
		const companions = pool();

		await expect(companions.call(SERIAL, IDB_HEALTH_RPC, {})).rejects.toThrow();

		await expect(companions.stopAll()).resolves.toBeUndefined();
	});
});
