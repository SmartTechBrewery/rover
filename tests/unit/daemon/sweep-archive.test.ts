/**
 * `sweep_archive` over a real socket — the answer's shape, and the one thing about it that is a
 * structural promise rather than a wording choice (§9.4, #238).
 *
 * `./list-archive.test.ts`'s shape and its reasons: a real socket, a temp archive root, and the
 * daemon started in-process with every root pointed inside one `mkdtemp` directory so nothing here
 * can reach `~/.rover`. For a method whose job is **deletion** that is not a convention to bend.
 *
 * The promise is **no host path anywhere in the answer**: the result is matched against the temp
 * root as serialised JSON, which is the guarantee `list-archive.test.ts` makes for its own reads
 * (D19). `SweepArchiveResultSchema` has no field a path would fit in, and `src/ipc/server.ts`
 * parses every answer against it — this is what holds that true against a future field.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import type { SweepArchiveResult } from '@/ipc/methods.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
let warnings: string[];

beforeEach(async () => {
	temp = await createTempSocket();
	warnings = [];
	vi.spyOn(console, 'warn').mockImplementation((line: string) => warnings.push(line));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	await removeTempSocket(temp);
});

async function start(): Promise<void> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		keptTestsPath: temp.keptTestsPath,
		// One megabyte and one day, so a single filed run is over both bounds and the method has
		// something real to answer. The shipped defaults would sweep nothing here, which is the
		// right default and the wrong fixture.
		retention: { budgetMb: 1, maxAgeDays: 1 },
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

async function connect(): Promise<IpcClient> {
	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
}

/** One run directory old enough to be past the age bound, holding one file. */
async function fileAnOldRun(): Promise<void> {
	const run = new Date(Date.now() - 40 * DAY_MS)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z');
	const path = join(temp.artifactsRoot, 'rover', 'home-screen', `${run}-issue-1-abcd1234`);
	await mkdir(join(path, 'serial-1'), { recursive: true });
	await writeFile(join(path, 'serial-1', '001_screenshot.png'), 'x'.repeat(2048));
}

async function sweep(dryRun: boolean): Promise<SweepArchiveResult> {
	await start();
	return (await connect()).request('sweep_archive', { dryRun, actor: 'alice' });
}

describe('sweep_archive', () => {
	it('answers missing for a host with no archive at all', async () => {
		await expect(sweep(false)).resolves.toEqual({ outcome: 'missing' });
	});

	it('names each swept run by its components and nothing else', async () => {
		await fileAnOldRun();

		const result = await sweep(false);

		expect(result.outcome).toBe('swept');
		if (result.outcome !== 'swept') {
			return;
		}
		expect(result.runs).toHaveLength(1);
		expect(result.runs[0]?.project).toBe('rover');
		expect(result.runs[0]?.testName).toBe('home-screen');
		expect(result.runs[0]?.bound).toBe('age');
		expect(result.truncated).toBe(false);
		expect(result.freedBytes).toBe(2048);
		expect(result.totalBytesAfter).toBe(0);
	});

	/*
	 * **The structural promise.** The archive's root is a path on the host and is not the
	 * caller's to know (D19) — so it must not appear anywhere in the answer, including inside a
	 * component the host itself named.
	 */
	it('puts no host path anywhere in the answer', async () => {
		await fileAnOldRun();

		const result = await sweep(false);

		expect(JSON.stringify(result)).not.toContain(temp.artifactsRoot);
		expect(JSON.stringify(result)).not.toContain(temp.dir);
	});

	it('deletes nothing on a dry run, and says which it was', async () => {
		await fileAnOldRun();

		const result = await sweep(true);

		expect(result.outcome === 'swept' && result.dryRun).toBe(true);
		expect(result.outcome === 'swept' && result.runs).toHaveLength(1);
		// Asked again, the same run is still there to be found.
		const again: SweepArchiveResult = await (await connect()).request('sweep_archive', {
			dryRun: true,
			actor: 'alice',
		});
		expect(again.outcome === 'swept' && again.runs).toHaveLength(1);
	});

	/*
	 * **One audit line per call, naming the actor** — `force_release_device`'s record in this key
	 * (D28). The actor is caller-supplied attribution and is never derived from whoever
	 * authenticated (D20).
	 */
	it('records who asked, on the host', async () => {
		await fileAnOldRun();

		await sweep(false);

		expect(warnings.join('\n')).toContain('"alice"');
	});

	it('records that a dry run deleted nothing', async () => {
		await fileAnOldRun();

		await sweep(true);

		expect(warnings.join('\n')).toContain('nothing was deleted');
	});
});
