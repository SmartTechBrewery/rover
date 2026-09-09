/**
 * `delete_archived_test` end to end: a real daemon on a temp socket, a real archive subtree and a
 * real kept-tests store, with a client asking over the real framing (D43, #272).
 *
 * `./delete-project.test.ts`'s shape and its reasons — the daemon suite's real-socket exception
 * (ai/TESTING.md), every root inside one `mkdtemp` so nothing here can reach `~/.rover`, and the
 * filesystem real rather than mocked because what this method does *is* files somebody can list.
 * For a method whose whole job is **deletion** that is not a convention to bend.
 *
 * Real rather than a direct call on the handler, because the `.strict()` result parse in
 * `src/ipc/server.ts` is half of what is asserted here: it is what makes *no host path and no
 * `errno` can be on an answer* structural (D19) rather than a habit of one module.
 *
 * The criterion is the issue's own, one level down from #271's: **four distinguishable outcomes,
 * and never a success that removed nothing** — plus the one this address adds, that *nothing
 * outside this test* is touched, which for a `<project>/<test_name>` pair means a sibling test and
 * a namesake under another project both stand.
 */

import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { MAX_SEGMENT_LENGTH, pathSegment } from '@/daemon/archive-path.js';
import { type KeptTest, readKeptTests, writeKeptTests } from '@/daemon/kept-tests.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import type { DeleteArchivedTestResult } from '@/ipc/methods.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';

const ATTACHED = createMockDevice({ serial: parseDeviceSerial('attached-1') });

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
/** Everything the host said on its own log. Spied rather than injected: the daemon builds it. */
let logged: string[];

beforeEach(async () => {
	temp = await createTempSocket();
	logged = [];
	vi.spyOn(console, 'warn').mockImplementation((line: string) => logged.push(line));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	if (temp) {
		// Anything a test made unwritable has to be writable again, or the temp directory cannot
		// be removed and the machine keeps it.
		await chmod(join(temp.artifactsRoot, 'checkout-web'), 0o755).catch(() => {});
		await removeTempSocket(temp);
	}
});

/** One attached device, so a test that needs a live lease can take one. */
function registerFakeBackend(): void {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([ATTACHED]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: {
				canReadScreen: true,
				canInput: true,
				canControlNetwork: true,
				canRecordVideo: true,
				canControlRecording: true,
			},
		},
		backend: createMockDeviceBackend({
			watchDevices,
			describeDevice: async (serial) => createMockDevice({ serial }),
		}),
	});
}

async function start(): Promise<void> {
	if (running.length > 0) {
		return;
	}
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		keptTestsPath: temp.keptTestsPath,
		// The shipped defaults: this suite's subject is a *named* delete, so nothing here may be
		// swept out from under it by either retention bound (D35, D38).
		retention: temp.retention,
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

async function connect(): Promise<IpcClient> {
	const existing = clients[0];
	if (existing) {
		return existing;
	}
	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
}

async function deleteTest(
	project: string,
	testName: string,
	actor = 'alice',
): Promise<DeleteArchivedTestResult> {
	await start();
	return (await connect()).request('delete_archived_test', { project, testName, actor });
}

/**
 * One run under `<project>/<test>`, holding one file of `bytes` bytes.
 *
 * The run directory's name is spelled as the archive spells one — a timestamp, an owner and a
 * short hash — because nothing here should be readable only because the fixture cheated on the
 * shape the writer actually produces.
 */
async function fileARun(
	project: string,
	testName: string,
	run: string,
	bytes: number,
): Promise<void> {
	const path = join(temp.artifactsRoot, project, testName, run, 'serial-1');
	await mkdir(path, { recursive: true });
	await writeFile(join(path, '001_screenshot.png'), 'x'.repeat(bytes));
}

/** One kept entry, spelled as the store spells one. */
function kept(project: string, testName: string): KeptTest {
	return { project, testName, keptBy: 'bob', keptAt: '2026-09-01T00:00:00.000Z' };
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** The `deleted`/`partial` report, or a failed test naming the outcome answered instead. */
function reportOf(result: DeleteArchivedTestResult) {
	if (result.outcome !== 'deleted' && result.outcome !== 'partial') {
		throw new Error(`Nothing reached the disk: ${result.outcome}`);
	}
	return result;
}

/**
 * Whether this process can still write into a directory it just made read-only — it can, when it
 * is root, and then the case being asserted does not exist on this machine.
 */
async function stillWritable(directory: string): Promise<boolean> {
	const probe = join(directory, '.probe');
	try {
		await writeFile(probe, 'x', 'utf8');
		await rm(probe, { force: true });
		return true;
	} catch {
		return false;
	}
}

describe('a delete takes one test and everything filed under it', () => {
	it('removes the test directory, every run in it and its kept entry in one call', async () => {
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 2048);
		await fileARun('checkout-web', 'home-screen', '20260901T101111Z-issue-1-abcd1235', 1024);
		await fileARun('checkout-web', 'login-flow', '20260901T101212Z-issue-1-abcd1236', 512);
		await writeKeptTests(temp.keptTestsPath, [kept('checkout-web', 'home-screen')]);

		const result = await deleteTest('checkout-web', 'home-screen');

		expect(result).toEqual({
			outcome: 'deleted',
			archive: 'removed',
			keptTests: 'removed',
			// Both runs, measured by the same `sizeOfTree` a badge and the sweep use.
			freedBytes: 3072,
			keptTestsRemoved: 1,
		});
		expect(await exists(join(temp.artifactsRoot, 'checkout-web', 'home-screen'))).toBe(false);
		// The sibling test and the project it lives in both stand.
		expect(
			await exists(
				join(temp.artifactsRoot, 'checkout-web', 'login-flow', '20260901T101212Z-issue-1-abcd1236'),
			),
		).toBe(true);
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([]);
	});

	/*
	 * **D35 as amended, one level down** (D43): the exemption is from the age limit and the disk
	 * budget, and an operator naming one test is neither of them — exactly as naming one project is
	 * not. What must *not* travel with it is another project's identically-named test, which is the
	 * whole reason the store's key is the `<project>/<test_name>` pair (D22, D33).
	 */
	it('takes a kept test, and leaves a namesake under another project kept', async () => {
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await fileARun('storefront', 'home-screen', '20260901T101010Z-issue-2-abcd9999', 256);
		await writeKeptTests(temp.keptTestsPath, [
			kept('checkout-web', 'home-screen'),
			kept('storefront', 'home-screen'),
		]);

		const result = await deleteTest('checkout-web', 'home-screen');

		expect(result).toMatchObject({ outcome: 'deleted', keptTestsRemoved: 1 });
		expect(await exists(join(temp.artifactsRoot, 'storefront', 'home-screen'))).toBe(true);
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([
			kept('storefront', 'home-screen'),
		]);
	});

	/*
	 * **An empty level is scaffolding rather than a record** (D34) — the sweep's own rule, applied
	 * to the one deletion that can newly empty a project. And the root is never a candidate.
	 */
	it('removes the project level its last test emptied, and never the archive root', async () => {
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await fileARun('storefront', 'home-screen', '20260901T101010Z-issue-2-abcd9999', 256);

		await expect(deleteTest('checkout-web', 'home-screen')).resolves.toMatchObject({
			outcome: 'deleted',
		});

		expect(await exists(join(temp.artifactsRoot, 'checkout-web'))).toBe(false);
		expect(await exists(temp.artifactsRoot)).toBe(true);
		expect(await exists(join(temp.artifactsRoot, 'storefront'))).toBe(true);
	});

	/*
	 * **A test addressed by the name the archive filed it under, over the segment bound**
	 * (PROJECT.md §6, #274). `pathSegment` is not idempotent — its own output runs to 73 characters
	 * and re-running it over that names a directory nothing was ever filed under — so a half that
	 * rewrote a component it was handed would miss the subtree and answer `absent` about it.
	 */
	it('removes a test whose filed component is over the segment bound', async () => {
		const filed = pathSegment('the checkout web end to end regression check for storefront carts');
		expect(filed.length).toBeGreaterThan(MAX_SEGMENT_LENGTH);
		await fileARun('checkout-web', filed, '20260901T101010Z-issue-1-abcd1234', 1024);
		await writeKeptTests(temp.keptTestsPath, [kept('checkout-web', filed)]);

		expect(await deleteTest('checkout-web', filed)).toEqual({
			outcome: 'deleted',
			archive: 'removed',
			keptTests: 'removed',
			freedBytes: 1024,
			keptTestsRemoved: 1,
		});
		expect(await exists(join(temp.artifactsRoot, 'checkout-web', filed))).toBe(false);
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([]);
	});
});

describe('the four outcomes never collapse into each other', () => {
	it('answers not-found when nothing at all was reached', async () => {
		const result = await deleteTest('never-filed', 'never-run');

		// Deliberately not a `deleted` that removed nothing: *there was no such test* and *the test
		// went* are two facts, and the schema is what keeps them two.
		expect(result).toEqual({ outcome: 'not-found' });
		expect(await exists(temp.artifactsRoot)).toBe(false);
		expect(await exists(temp.keptTestsPath)).toBe(false);
	});

	it('answers not-found for a test of a project that exists but never filed it', async () => {
		await fileARun('checkout-web', 'login-flow', '20260901T101010Z-issue-1-abcd1234', 512);

		expect(await deleteTest('checkout-web', 'home-screen')).toEqual({ outcome: 'not-found' });

		expect(await exists(join(temp.artifactsRoot, 'checkout-web', 'login-flow'))).toBe(true);
	});

	/*
	 * A tick with no directory beside it is a real state — the sweep's cleanup can remove a test
	 * level a `Keep` still names — and taking it did something, so it is `deleted` rather than
	 * `not-found`.
	 */
	it('answers deleted with the archive absent for a kept test with nothing filed', async () => {
		await writeKeptTests(temp.keptTestsPath, [kept('checkout-web', 'home-screen')]);

		expect(await deleteTest('checkout-web', 'home-screen')).toEqual({
			outcome: 'deleted',
			archive: 'absent',
			keptTests: 'removed',
			freedBytes: 0,
			keptTestsRemoved: 1,
		});
	});

	it('answers partial when the directory will not go, and still reports the kept half', async () => {
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await writeKeptTests(temp.keptTestsPath, [kept('checkout-web', 'home-screen')]);
		await start();
		// A directory is removed by writing to its *parent*, so the project level is what has to
		// refuse. Restored in `afterEach`, or the temp directory could not be removed.
		await chmod(join(temp.artifactsRoot, 'checkout-web'), 0o555);
		if (await stillWritable(join(temp.artifactsRoot, 'checkout-web'))) {
			// Running as root: there is no unremovable directory on this machine to assert about.
			return;
		}

		const result = reportOf(await deleteTest('checkout-web', 'home-screen'));

		expect(result).toMatchObject({
			outcome: 'partial',
			archive: 'failed',
			// The directory goes first, and the kept half still runs — the answer says which went.
			keptTests: 'removed',
			freedBytes: 0,
			keptTestsRemoved: 1,
		});
		expect(await exists(join(temp.artifactsRoot, 'checkout-web', 'home-screen'))).toBe(true);
	});

	it('answers partial without overwriting a kept-tests store it cannot read', async () => {
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await writeFile(temp.keptTestsPath, '{ not json', 'utf8');

		const result = reportOf(await deleteTest('checkout-web', 'home-screen'));

		expect(result).toMatchObject({
			outcome: 'partial',
			// The archive half still went, which is the direction that leaves the host holding less.
			archive: 'removed',
			keptTests: 'failed',
			keptTestsRemoved: 0,
		});
		// Byte-identical: resetting the file would delete every exemption on the host to make one
		// call succeed, which is `set_kept_tests`' own promise.
		expect(await readFile(temp.keptTestsPath, 'utf8')).toBe('{ not json');
	});
});

describe('a live lease filing into this test is refused, and nothing is touched', () => {
	it('refuses while the lease is live and leaves both halves alone', async () => {
		registerFakeBackend();
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await writeKeptTests(temp.keptTestsPath, [kept('checkout-web', 'home-screen')]);
		await start();
		await expect(
			(await connect()).request('acquire_device', {
				serial: ATTACHED.serial,
				owner: 'issue-272',
				project: 'checkout-web',
				testName: 'home-screen',
			}),
		).resolves.toMatchObject({ outcome: 'granted' });

		const result = await deleteTest('checkout-web', 'home-screen');

		// That directory is what the lease is filing into right now (D35), so the answer is data
		// with an obvious next move.
		expect(result).toEqual({ outcome: 'refused', reason: 'lease-live' });
		expect(await exists(join(temp.artifactsRoot, 'checkout-web', 'home-screen'))).toBe(true);
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toHaveLength(1);
	});

	it('refuses for the archive spelling of a lease’s two strings too', async () => {
		// The two spellings collapse for names that need no rewriting and come apart only for
		// caller strings `pathSegment` rewrote — exactly the case a single-sided check would miss.
		registerFakeBackend();
		const project = pathSegment('check out');
		const testName = pathSegment('home screen');
		expect(project).not.toBe('check out');
		await fileARun(project, testName, '20260901T101010Z-issue-1-abcd1234', 512);
		await start();
		await expect(
			(await connect()).request('acquire_device', {
				serial: ATTACHED.serial,
				owner: 'issue-272',
				project: 'check out',
				testName: 'home screen',
			}),
		).resolves.toMatchObject({ outcome: 'granted' });

		expect(await deleteTest(project, testName)).toEqual({
			outcome: 'refused',
			reason: 'lease-live',
		});
		expect(await exists(join(temp.artifactsRoot, project, testName))).toBe(true);
	});

	it('does not refuse for a live lease on a different test of the same project', async () => {
		registerFakeBackend();
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await start();
		await expect(
			(await connect()).request('acquire_device', {
				serial: ATTACHED.serial,
				owner: 'issue-272',
				project: 'checkout-web',
				testName: 'login-flow',
			}),
		).resolves.toMatchObject({ outcome: 'granted' });

		expect(await deleteTest('checkout-web', 'home-screen')).toMatchObject({ outcome: 'deleted' });
	});
});

describe('what leaves the host, and what stays on it', () => {
	it('puts no host path and no errno on any answer', async () => {
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);

		const serialised = JSON.stringify(await deleteTest('checkout-web', 'home-screen'));

		// The structural promise (D19): there is no field a path would fit in, and
		// `src/ipc/server.ts` parses every answer against the `.strict()` schema.
		expect(serialised).not.toContain(temp.dir);
		expect(serialised).not.toContain(temp.artifactsRoot);
		expect(serialised).not.toContain('ENOENT');
		expect(serialised).not.toContain('message');
	});

	it('says on its own log why a half did not go, naming the path there and only there', async () => {
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await start();
		await chmod(join(temp.artifactsRoot, 'checkout-web'), 0o555);
		if (await stillWritable(join(temp.artifactsRoot, 'checkout-web'))) {
			return;
		}

		const result = await deleteTest('checkout-web', 'home-screen');

		expect(result.outcome).toBe('partial');
		expect(JSON.stringify(result)).not.toContain(temp.artifactsRoot);
		expect(logged.join('\n')).toContain(join(temp.artifactsRoot, 'checkout-web', 'home-screen'));
		// And it says what it was, rather than reusing the project's own sentence.
		expect(logged.join('\n')).toContain('The archived test at ');
	});

	it('writes one audit line naming the actor, both components and the counts', async () => {
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await writeKeptTests(temp.keptTestsPath, [kept('checkout-web', 'home-screen')]);
		await start();
		logged.length = 0;

		await deleteTest('checkout-web', 'home-screen', 'jacek');

		// `Deleted test`, deliberately not `Deleted archived test`: the sweeper's own line for the
		// same subtree opens with the latter, and the daemon's log has to keep the two apart.
		const audit = logged.filter((line) =>
			line.startsWith('Deleted test "checkout-web"/"home-screen" —'),
		);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toContain('"jacek"');
		expect(audit[0]).toContain('1 kept test removed');
		// Nothing that is a credential is in scope on this path at all (D20).
		expect(audit[0]).not.toContain('token');
		// And no host path is on the record's own line either — the warning position is where a
		// path belongs, and this delete wrote no warning.
		expect(audit[0]).not.toContain(temp.dir);
	});

	it('says plainly that a delete which reached nothing deleted nothing', async () => {
		await start();
		logged.length = 0;

		await deleteTest('never-filed', 'never-run', 'jacek');

		const audit = logged.filter((line) => line.includes('Nothing was deleted for test'));
		expect(audit).toHaveLength(1);
		expect(audit[0]).toContain('"jacek"');
	});

	it('says plainly that a refused delete deleted nothing', async () => {
		registerFakeBackend();
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await start();
		await expect(
			(await connect()).request('acquire_device', {
				serial: ATTACHED.serial,
				owner: 'issue-272',
				project: 'checkout-web',
				testName: 'home-screen',
			}),
		).resolves.toMatchObject({ outcome: 'granted' });
		logged.length = 0;

		await deleteTest('checkout-web', 'home-screen', 'jacek');

		const audit = logged.filter((line) => line.includes('Refused to delete test'));
		expect(audit).toHaveLength(1);
		expect(audit[0]).toContain('nothing was touched');
		expect(audit[0]).toContain('"jacek"');
	});
});

describe('an address that could escape the archive is refused before anything is removed', () => {
	it('answers invalid_params for a component that is not one directory name', async () => {
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await start();

		for (const testName of ['..', '.', 'a/b', '']) {
			// The shape is on the wire (`ArchivePathSegmentSchema`), so this never reaches a
			// handler at all — which is the earliest of the three places containment is enforced.
			await expect(
				(await connect()).request('delete_archived_test', {
					project: 'checkout-web',
					testName,
					actor: 'alice',
				}),
			).rejects.toMatchObject({ code: 'invalid_params' });
		}

		expect(await exists(join(temp.artifactsRoot, 'checkout-web', 'home-screen'))).toBe(true);
	});
});
