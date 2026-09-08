/**
 * The clock trigger, wired into a real daemon (#246, D38, §9.4).
 *
 * **A real daemon on a real socket**, for `sweep-after-lease.test.ts`'s reason: what this file
 * asserts is the *wiring* — that coming up is a trigger — and calling the schedule's own `start()`
 * would leave that untested and this file green with it. The daemon suite's socket exception
 * applies (`ai/TESTING.md`): a temp socket and a `mkdtemp` archive, never `~/.rover`, and every
 * daemon closed through its own handle. That matters more here than anywhere else in the suite,
 * because the subject is **deletion**.
 *
 * Three claims, each one a reviewer would otherwise take on trust: the pass at start takes a test
 * past the **age** limit, which no other trigger on this host does — the operator's `sweep_archive`
 * aside — and is therefore the whole of what this row delivers; `close()` **waits** for that pass,
 * because the `process.exit` behind it would otherwise land inside an `rm` of a run directory; and
 * a **loser of the bind sweeps nothing**, because two daemons deleting out of one archive root
 * would each be answering about a tree the other had already altered.
 *
 * Nothing here waits on a duration, and nothing polls either. The pass is behind the bind by
 * construction — it is `void`-ed inside the schedule — so what every assertion waits on is the
 * pass being *over*: a dry `sweep_archive` queued behind it on the same tree ({@link settled}), or
 * `close()` having resolved. Watching the archive until it stopped changing would be a duration
 * dressed as a condition, and would go red on a loaded machine for reasons that are not the
 * subject.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

/** The shipped policy: a budget a 1 KiB run is nowhere near, and a thirty-day window. */
const SHIPPED = { budgetMb: 1024, maxAgeDays: 30 } as const;

const DAY_MS = 24 * 60 * 60 * 1_000;

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
/** Everything the daemon said on its own stderr — where a sweep's whole record lives (D28). */
let warned: string[];

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
	vi.restoreAllMocks();
	if (temp) {
		await removeTempSocket(temp);
	}
});

async function start(): Promise<RunningDaemon> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		keptTestsPath: temp.keptTestsPath,
		retention: SHIPPED,
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

/**
 * Wait out the pass the daemon started as it came up, and **not** by polling for it.
 *
 * A dry `sweep_archive` is queued *behind* the start pass, because sweeps of one tree chain by the
 * root (`archive-sweep.ts`) — so this call's answer arriving means that pass is over. It deletes
 * nothing itself. The alternative, watching the archive until it stops changing, is a duration
 * dressed as a condition: it would be racing the walk rather than waiting for it, and would go red
 * on a loaded machine for reasons that have nothing to do with the subject.
 */
async function settled(): Promise<void> {
	await (await connect()).request('sweep_archive', { dryRun: true, actor: 'swarm-test' });
}

/** A run directory in the shape the archive writes (§10), so the walk measures a real subtree. */
async function fileRun(testName: string, run: string): Promise<void> {
	const path = join(temp.artifactsRoot, 'rover', testName, run, 'serial-1', 'screenshots');
	await mkdir(path, { recursive: true });
	await writeFile(join(path, '001_screenshot.png'), 'x'.repeat(1024));
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

describe('a daemon coming up', () => {
	/*
	 * **The age bound, enforced by nobody asking.** This is the row's headline claim: the archive
	 * is comfortably inside its budget, so the pass a lease's end runs would take nothing here and
	 * `rover sweep` was the only thing that ever would. A host that was asleep at midnight comes
	 * up and enforces the whole policy.
	 */
	it('runs a full pass, taking a test past the age limit an inside-budget archive kept', async () => {
		const ancient = runNameAt(Date.now() - 400 * DAY_MS);
		const recent = runNameAt(Date.now() - 1 * DAY_MS);
		// Two **test names**, because a test's age is the age of its newest run (D34): an old run
		// filed under a test that also holds yesterday's is not what the age bound comes for.
		await fileRun('old flow', ancient);
		await fileRun('checkout flow', recent);

		await start();
		await settled();

		expect(await remainingRuns()).toEqual([`checkout flow/${recent}`]);
		expect(warned).toContainEqual(
			expect.stringContaining('Swept the artifact archive: deleted 1 run'),
		);
	});

	/*
	 * **And `close()` waits for it**, which is the same invariant the pass a lease's end runs has
	 * and lands inside a much narrower window: a daemon started and stopped straight away — which
	 * is what a `startDaemon` in a test does — is stopped while its own first pass is still
	 * walking. Unawaited, the `process.exit` behind `close()` lands inside the `rm` and leaves a
	 * run directory holding part of what its lease wrote, which every listing still reports.
	 */
	it('holds close() open until the start pass is over', async () => {
		const ancient = runNameAt(Date.now() - 400 * DAY_MS);
		await fileRun('checkout flow', ancient);

		const daemon = await start();
		await daemon.close();

		// Asserted with nothing waited on in between, which is the whole claim: the deletion is
		// already over by the time `close()` resolves, so `close()` is what waited for it.
		expect(await remainingRuns()).toEqual([]);
	});

	/*
	 * **A loser of the bind sweeps nothing**, because the schedule is constructed in the
	 * winner-only path (`listen.ts`'s `running()`) beside the lease-sweep interval and for the same
	 * reason. Two daemons deleting out of one archive root would each be answering about a tree the
	 * other had already altered — and the loser has no devices to lend in any case.
	 */
	it('does not sweep when it lost the bind', async () => {
		// A run the winner's own pass keeps, so that pass has a tree to walk and something to say
		// about it — which is what makes "and then nothing more was said" the assertion below.
		const recent = runNameAt(Date.now() - 1 * DAY_MS);
		await fileRun('checkout flow', recent);
		await start();
		await settled();

		// Now something a full pass would certainly take, and a second daemon on the same socket
		// and the same archive root.
		const ancient = runNameAt(Date.now() - 400 * DAY_MS);
		await fileRun('old flow', ancient);
		warned.length = 0;

		const loser = await startDaemon({
			socketPath: temp.socketPath,
			artifactsRoot: temp.artifactsRoot,
			projectsRoot: temp.projectsRoot,
			keptTestsPath: temp.keptTestsPath,
			retention: SHIPPED,
		});

		expect(loser.started).toBe(false);
		expect(warned).toEqual([]);
		expect(await remainingRuns()).toEqual([`checkout flow/${recent}`, `old flow/${ancient}`]);
	});
});
