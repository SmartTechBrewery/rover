/**
 * The disk budget enforced on the path a lease already ends on (#245, D9, D35, D37, §9.4).
 *
 * **A real daemon on a real socket**, for `restore-lifecycle.test.ts`'s reason: what this suite
 * asserts is the *wiring* — that a lease ending is a trigger — and calling `sweep()` by hand
 * would leave that wiring untested and this file green with it. The daemon suite's socket
 * exception applies (ai/TESTING.md): a temp socket and a `mkdtemp` archive, never `~/.rover`, and
 * every daemon closed through its own handle. That matters more here than anywhere else in the
 * suite, because the subject is **deletion**.
 *
 * Six claims, and each is one a reviewer would otherwise take on trust: a **released** lease and
 * an **expired** one both sweep, so this is a teardown rather than a happy path; the bound is the
 * **budget alone**, so a month-old run inside the budget survives; a **live** lease's run is not
 * taken by a sweep another lease's end triggered; a sweep that cannot run leaves the release
 * successful and says so on the host's log; and **a shutdown waits for the walk** — both for the
 * one a release started and for the one the shutdown's own final `leases.sweep()` causes —
 * because the `process.exit` behind `close()` would otherwise land inside an `rm` of a run
 * directory.
 *
 * Nothing here waits on a duration to decide that something happened. The sweep is behind the
 * release by construction — it is `void`-ed on the tail of the restoration — so every assertion
 * waits on the condition it is about: the daemon's own summary line, the run directory being
 * gone, or `close()` having resolved. The one clock this file watches is a lease's TTL in the
 * last test, where waiting on anything the daemon answers would resolve the expiry that test
 * needs the *shutdown* to be the first to notice.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { DeviceBackend } from '@/core/device.js';
import { type DeviceSerial, type LeaseId, parseDeviceSerial } from '@/core/ids.js';
import { type Observation, waitForCondition } from '@/core/wait.js';
import { pathSegment } from '@/daemon/archive-path.js';
import { type ArchiveSweeper, sweepAfterLease } from '@/daemon/archive-sweep.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import {
	createMockDevice,
	createMockDeviceBackend,
	createMockLease,
} from '../../helpers/factories.js';

/** Two devices, so a lease can end while another one is still live on the other. */
const FIRST = parseDeviceSerial('attached-1');
const SECOND = parseDeviceSerial('attached-2');

/** Short enough that the expiry lands inside the test, long enough to survive the acquire. */
const SHORT_TTL_MS = 25;
const SHORT_SWEEP_MS = 5;

/**
 * A sweep interval no test here reaches, for the one case whose subject is the *shutdown's* own
 * last look at the store: the interval noticing the expiry first would leave that path untested.
 */
const UNREACHED_SWEEP_MS = 60_000;

/** How long a condition below may stay unmet before the test gives up on it. */
const CONDITION_TIMEOUT_MS = 5_000;
const CONDITION_POLL_MS = 5;

/** One MiB, the unit the budget is counted in. */
const MB = 1024 * 1024;

/** The live lease's test name. Sanitised by the archive, which is why it is named once here. */
const LIVE_TEST = 'live run';

/** A budget one run of the sizes below comfortably exceeds. */
const TIGHT_BUDGET = { budgetMb: 1, maxAgeDays: 30 } as const;

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
/** Everything the daemon said on its own stderr — where a sweep's whole record lives (D28). */
let warned: string[];

/** A backend reporting both devices, with a screenshot of whatever size a test needs. */
function registerBackend(capture = new Uint8Array([1, 2, 3])): void {
	const overrides: Partial<DeviceBackend> = {
		watchDevices: (watcher) => {
			watcher.onDevices([
				createMockDevice({ serial: FIRST }),
				createMockDevice({ serial: SECOND }),
			]);
			return { stop: async () => {} };
		},
		describeDevice: async (serial) => createMockDevice({ serial }),
		screenshot: async () => capture,
	};

	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: {
				canReadScreen: true,
				canInput: false,
				canControlNetwork: true,
				canRecordVideo: true,
				canControlRecording: true,
			},
		},
		backend: createMockDeviceBackend(overrides),
	});
}

async function start(
	options: {
		retention?: TempSocket['retention'];
		sweepIntervalMs?: number;
		leaseTtlMs?: number;
	} = {},
) {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		keptTestsPath: temp.keptTestsPath,
		retention: temp.retention,
		...options,
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
	return result;
}

async function connect(): Promise<IpcClient> {
	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
}

/** Take a lease on one device, answering its id. */
async function acquire(
	client: IpcClient,
	serial: DeviceSerial,
	testName: string,
): Promise<LeaseId> {
	const granted = await client.request('acquire_device', {
		serial,
		owner: 'issue-245',
		project: 'rover',
		testName,
	});
	if (granted.outcome !== 'granted') {
		throw new Error(`expected a granted lease, got '${granted.outcome}'`);
	}
	return granted.lease.leaseId;
}

/**
 * A run directory holding one file of `sizeBytes` under a `<serial>` level, which is the shape
 * the archive actually writes (§10) — so what the walk measures is what a real run would measure.
 */
async function fileRun(testName: string, run: string, sizeBytes: number): Promise<void> {
	const path = join(temp.artifactsRoot, 'rover', testName, run);
	await mkdir(join(path, 'serial-1', 'screenshots'), { recursive: true });
	await writeFile(
		join(path, 'serial-1', 'screenshots', '001_screenshot.png'),
		'x'.repeat(sizeBytes),
	);
}

/** A run name for an instant, in the format `archive-path.ts` writes. */
function runNameAt(instantMs: number, owner = 'issue-1'): string {
	const timestamp = new Date(instantMs)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z');
	return `${timestamp}-${owner}-abcd1234`;
}

/** Every run directory left on disk, as `<test>/<run>` — the project is `rover` throughout. */
async function remainingRuns(): Promise<string[]> {
	const found: string[] = [];
	for (const project of await readdir(temp.artifactsRoot, { withFileTypes: true })) {
		const projectPath = join(temp.artifactsRoot, project.name);
		for (const test of await readdir(projectPath, { withFileTypes: true })) {
			for (const run of await readdir(join(projectPath, test.name))) {
				found.push(`${test.name}/${run}`);
			}
		}
	}
	return found.sort();
}

/** Wait for the daemon to say it swept — the one line every sweep writes, deleting or not. */
async function sweepReported(): Promise<void> {
	await waitForCondition({
		what: 'the daemon to report a sweep of the artifact archive',
		timeoutMs: CONDITION_TIMEOUT_MS,
		pollIntervalMs: CONDITION_POLL_MS,
		probe: (): Observation<void> =>
			warned.some((line) => line.startsWith('Swept the artifact archive:'))
				? { met: true, value: undefined }
				: { met: false, found: `only ${warned.length} lines on the host's log` },
	});
}

/** Wait for the archive to hold exactly these runs, so nothing asserts against a walk in flight. */
async function runsSettleTo(expected: string[]): Promise<void> {
	await waitForCondition({
		what: `the archive to be left holding ${expected.join(', ') || 'nothing'}`,
		timeoutMs: CONDITION_TIMEOUT_MS,
		pollIntervalMs: CONDITION_POLL_MS,
		probe: async (): Promise<Observation<void>> => {
			const found = await remainingRuns();
			return found.length === expected.length && found.every((run, at) => run === expected[at])
				? { met: true, value: undefined }
				: { met: false, found: found.join(', ') || 'nothing' };
		},
	});
}

beforeEach(async () => {
	temp = await createTempSocket();
	warned = [];
	vi.spyOn(console, 'warn').mockImplementation((line: string) => {
		warned.push(line);
	});
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	vi.restoreAllMocks();
	if (temp) {
		await removeTempSocket(temp);
	}
});

describe('the budget after a lease ends', () => {
	it('takes the oldest run when the lease was released', async () => {
		registerBackend();
		await start({ retention: TIGHT_BUDGET });
		const oldest = runNameAt(Date.UTC(2026, 0, 1));
		const newest = runNameAt(Date.UTC(2026, 5, 1));
		await fileRun('checkout flow', oldest, 0.9 * MB);
		await fileRun('checkout flow', newest, 0.9 * MB);
		const client = await connect();
		const leaseId = await acquire(client, FIRST, 'checkout flow');

		// The release answers as soon as the store has forgotten the lease — the restoration and
		// the sweep behind it are both still ahead of us, which is the whole arrangement.
		expect(await client.request('release_device', { leaseId })).toEqual({ released: true });

		await runsSettleTo([`checkout flow/${newest}`]);
	});

	it('takes it just the same when the lease expired with nobody asking', async () => {
		registerBackend();
		await start({
			retention: TIGHT_BUDGET,
			leaseTtlMs: SHORT_TTL_MS,
			sweepIntervalMs: SHORT_SWEEP_MS,
		});
		const oldest = runNameAt(Date.UTC(2026, 0, 1));
		const newest = runNameAt(Date.UTC(2026, 5, 1));
		await fileRun('checkout flow', oldest, 0.9 * MB);
		await fileRun('checkout flow', newest, 0.9 * MB);
		const client = await connect();

		// The row's headline criterion: the agent holding this device is gone. Nothing releases
		// the lease and nothing asks another question — the daemon's own interval is the only
		// thing that can notice, and the budget has to be enforced off that path too.
		await acquire(client, FIRST, 'checkout flow');

		await runsSettleTo([`checkout flow/${newest}`]);
	});

	it('enforces the budget alone, leaving a run past the age limit where it is', async () => {
		registerBackend();
		// The shipped budget — 1 GiB — which the tiny run below is nowhere near, against the
		// shipped thirty days, which a run from 2020 is comfortably past.
		await start();
		const ancient = runNameAt(Date.UTC(2020, 0, 1));
		await fileRun('checkout flow', ancient, 1024);
		const client = await connect();
		const leaseId = await acquire(client, FIRST, 'checkout flow');

		await client.request('release_device', { leaseId });

		// Waited on the sweep having *happened*, so this is "the age bound did not act" rather
		// than "the sweep had not got round to it yet".
		await sweepReported();
		expect(await remainingRuns()).toEqual([`checkout flow/${ancient}`]);
		expect(warned).toContainEqual(
			expect.stringContaining('Swept the artifact archive: deleted 0 runs'),
		);
	});

	it('never takes the run of a lease that is still live on another device', async () => {
		// A capture large enough that the live lease's own run is what puts this archive over
		// its budget — so the sweep genuinely reaches that run and refuses it, rather than
		// stopping before it (D35, D36).
		registerBackend(new Uint8Array(2 * MB));
		await start({ retention: TIGHT_BUDGET });
		const stale = runNameAt(Date.UTC(2026, 0, 1));
		await fileRun('checkout flow', stale, 0.5 * MB);
		const client = await connect();

		const live = await acquire(client, FIRST, LIVE_TEST);
		expect(await client.request('screenshot', { leaseId: live })).toMatchObject({
			outcome: 'ok',
		});
		const ending = await acquire(client, SECOND, 'checkout flow');
		await client.request('release_device', { leaseId: ending });

		// The stale run goes; the live lease's own run stays, and the archive is left over its
		// budget saying exactly why.
		await sweepReported();
		const left = await remainingRuns();
		expect(left).toHaveLength(1);
		// Through `pathSegment`, because that is the name the *writer* filed it under and the
		// exemption is matched by path rather than by the caller's own string (D22, D35).
		expect(left[0]).toMatch(new RegExp(`^${pathSegment(LIVE_TEST)}/`));
		expect(warned).toContainEqual(expect.stringContaining('held by a live lease'));
	});
});

describe('a sweep that cannot run', () => {
	it('leaves release_device answering success, and says so on the host log', async () => {
		registerBackend();
		await start({ retention: TIGHT_BUDGET });
		const oldest = runNameAt(Date.UTC(2026, 0, 1));
		await fileRun('checkout flow', oldest, 2 * MB);
		// The exemption list is what a deletion may not proceed without, so a store that will not
		// parse abandons the sweep — the failure this trigger has to survive without taking a
		// release down with it.
		await writeFile(temp.keptTestsPath, '{ this is not json');
		const client = await connect();
		const leaseId = await acquire(client, FIRST, 'checkout flow');

		expect(await client.request('release_device', { leaseId })).toEqual({ released: true });

		await waitForCondition({
			what: 'the daemon to report the kept-tests store it could not read',
			timeoutMs: CONDITION_TIMEOUT_MS,
			pollIntervalMs: CONDITION_POLL_MS,
			probe: (): Observation<void> =>
				warned.some((line) => line.includes('The kept-tests store at'))
					? { met: true, value: undefined }
					: { met: false, found: `only ${warned.length} lines on the host's log` },
		});
		// And the archive it would have swept is untouched: an unreadable exemption list deletes
		// nothing at all, over budget or not.
		expect(await remainingRuns()).toEqual([`checkout flow/${oldest}`]);
	});

	it('turns a sweeper that throws into one warning naming the device, and nothing else', async () => {
		const thrown = new Error('the archive volume went away');
		const sweeper: ArchiveSweeper = {
			sweep: () => Promise.reject(thrown),
			settle: () => Promise.resolve(),
		};
		const lease = createMockLease({ serial: FIRST });
		const captured: string[] = [];

		// Resolves rather than rejects: this is `void`-ed on a lease's end path, so a rejection
		// here would be an unhandled one on a release that was otherwise perfectly successful.
		await expect(sweepAfterLease(sweeper, lease, (line) => captured.push(line))).resolves.toBe(
			undefined,
		);

		expect(captured).toHaveLength(1);
		expect(captured[0]).toContain(FIRST);
		expect(captured[0]).toContain(thrown.message);
	});
});

describe('a daemon stopped while a sweep is in flight', () => {
	it('holds close() open until the sweep the release started is over', async () => {
		registerBackend();
		const daemon = await start({ retention: TIGHT_BUDGET });
		const oldest = runNameAt(Date.UTC(2026, 0, 1));
		const newest = runNameAt(Date.UTC(2026, 5, 1));
		await fileRun('checkout flow', oldest, 0.9 * MB);
		await fileRun('checkout flow', newest, 0.9 * MB);
		const client = await connect();
		const leaseId = await acquire(client, FIRST, 'checkout flow');
		await client.request('release_device', { leaseId });

		// `rover release` and `rover stop` back to back, which is what `main.ts` turns into
		// `await daemon.close(); process.exit(0)`.
		await daemon.close();

		// Asserted with nothing waited on in between, which is the whole claim: the deletion is
		// already over by the time `close()` resolves, so `close()` is what waited for it.
		// Unawaited, the `process.exit` behind it lands inside the `rm` and leaves `oldest`
		// present and holding a subset of its own files — a run every listing still reports.
		expect(await remainingRuns()).toEqual([`checkout flow/${newest}`]);
		expect(warned).toContainEqual(
			expect.stringContaining('Swept the artifact archive: deleted 1 run'),
		);
	});

	it('waits for the sweep caused by a lease it expired on its own way out', async () => {
		registerBackend();
		const daemon = await start({
			retention: TIGHT_BUDGET,
			leaseTtlMs: SHORT_TTL_MS,
			// Long enough never to fire inside this test, so the expiry is observed by
			// `close()`'s own last look at the store and by nothing else — the restoration it
			// starts, and the sweep behind *that*, are then owed by a daemon already shutting
			// down.
			sweepIntervalMs: UNREACHED_SWEEP_MS,
		});
		const oldest = runNameAt(Date.UTC(2026, 0, 1));
		const newest = runNameAt(Date.UTC(2026, 5, 1));
		await fileRun('checkout flow', oldest, 0.9 * MB);
		await fileRun('checkout flow', newest, 0.9 * MB);
		const client = await connect();
		await acquire(client, FIRST, 'checkout flow');
		const expiresAtMs = Date.now() + SHORT_TTL_MS;

		// Waited on the clock, and deliberately not on anything the daemon would answer: every
		// read of the store resolves expiry on the way out (`leases.ts`), so a question here
		// would make the question the thing that noticed rather than the shutdown.
		await waitForCondition({
			what: "the lease's TTL to elapse with nobody having asked the daemon anything",
			timeoutMs: CONDITION_TIMEOUT_MS,
			pollIntervalMs: CONDITION_POLL_MS,
			probe: (): Observation<void> =>
				Date.now() >= expiresAtMs
					? { met: true, value: undefined }
					: { met: false, found: `${expiresAtMs - Date.now()}ms still on the lease` },
		});

		await daemon.close();

		expect(await remainingRuns()).toEqual([`checkout flow/${newest}`]);
	});
});
