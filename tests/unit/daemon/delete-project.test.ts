/**
 * `delete_project` end to end: a real daemon on a temp socket, a real hook file, a real archive
 * subtree and a real kept-tests store, with a client asking over the real framing (D42, #271).
 *
 * `./list-projects.test.ts`'s shape and its reasons — the daemon suite's real-socket exception
 * (ai/TESTING.md), every root inside one `mkdtemp` so nothing here can reach `~/.rover`, and the
 * filesystem real rather than mocked because what this method does *is* files somebody can list.
 * For a method whose whole job is **deletion** that is not a convention to bend.
 *
 * Real rather than a direct call on the handler, because the `.strict()` result parse in
 * `src/ipc/server.ts` is half of what is asserted here: it is what makes *no host path and no
 * `errno` can be on an answer* structural (D19) rather than a habit of one module.
 *
 * The criterion the suite is built around is the issue's own: **four distinguishable outcomes, and
 * never a success that removed nothing**. So every arm has a case, the four never collapse into
 * each other, and *nothing outside that subtree is touched* is asserted directly rather than
 * implied.
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
import { pathSegment } from '@/daemon/archive-path.js';
import { readKeptTests, writeKeptTests } from '@/daemon/kept-tests.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import type { DeleteProjectResult, ListProjectsResult } from '@/ipc/methods.js';
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
		await chmod(temp.artifactsRoot, 0o755).catch(() => {});
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

async function deleteProject(project: string, actor = 'alice'): Promise<DeleteProjectResult> {
	await start();
	return (await connect()).request('delete_project', { project, actor });
}

/** One hook file under the projects root, as an object the test spells out. */
async function register(project: string, hooks: Record<string, unknown> = {}): Promise<void> {
	await mkdir(temp.projectsRoot, { recursive: true });
	await writeFile(
		join(temp.projectsRoot, `${project}.json`),
		JSON.stringify({ project, ...hooks }),
		'utf8',
	);
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

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** The `deleted`/`partial` report, or a failed test naming the outcome answered instead. */
function reportOf(result: DeleteProjectResult) {
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

describe('a delete takes the registration and everything filed under it', () => {
	it('removes the hook file, the archive subtree and the kept entries in one call', async () => {
		await register('checkout-web', { apps: ['com.example.checkout'] });
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 2048);
		await fileARun('checkout-web', 'login-flow', '20260901T101111Z-issue-1-abcd1235', 1024);
		await writeKeptTests(temp.keptTestsPath, [
			{
				project: 'checkout-web',
				testName: 'home-screen',
				keptBy: 'bob',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
			{
				project: 'checkout-web',
				testName: 'login-flow',
				keptBy: 'bob',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
		]);

		const result = await deleteProject('checkout-web');

		expect(result).toEqual({
			outcome: 'deleted',
			registration: 'removed',
			archive: 'removed',
			keptTests: 'removed',
			// Exactly what was written, measured by the same `sizeOfTree` a badge and the sweep use.
			freedBytes: 3072,
			keptTestsRemoved: 2,
		});
		expect(await exists(join(temp.projectsRoot, 'checkout-web.json'))).toBe(false);
		expect(await exists(join(temp.artifactsRoot, 'checkout-web'))).toBe(false);
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([]);
	});

	it('takes a kept test too, because naming a project is not a retention bound', async () => {
		// D35 as amended: the exemption is from the age limit and the disk budget, and an operator
		// naming one project is neither of them. The alternative — a `Keep` that survives a delete
		// — would leave a half-deleted archive nothing ever finishes.
		await register('checkout-web');
		await fileARun('checkout-web', 'kept-test', '20260901T101010Z-issue-1-abcd1234', 512);
		await writeKeptTests(temp.keptTestsPath, [
			{
				project: 'checkout-web',
				testName: 'kept-test',
				keptBy: 'bob',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
		]);

		const result = await deleteProject('checkout-web');

		expect(result).toMatchObject({ outcome: 'deleted', keptTestsRemoved: 1 });
		expect(await exists(join(temp.artifactsRoot, 'checkout-web', 'kept-test'))).toBe(false);
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([]);
	});

	it('touches nothing outside that one project', async () => {
		await register('checkout-web');
		await register('storefront');
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await fileARun('storefront', 'home-screen', '20260901T101010Z-issue-2-abcd9999', 512);
		await writeKeptTests(temp.keptTestsPath, [
			{
				project: 'storefront',
				testName: 'home-screen',
				keptBy: 'bob',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
		]);
		// A document of the host's own beside the store, standing in for `users.json`: no write on
		// this path has any business in one.
		const users = join(temp.dir, 'users.json');
		await writeFile(users, '{"users":[]}', 'utf8');

		await expect(deleteProject('checkout-web')).resolves.toMatchObject({ outcome: 'deleted' });

		expect(await exists(join(temp.projectsRoot, 'storefront.json'))).toBe(true);
		expect(
			await exists(
				join(temp.artifactsRoot, 'storefront', 'home-screen', '20260901T101010Z-issue-2-abcd9999'),
			),
		).toBe(true);
		expect(await readFile(users, 'utf8')).toBe('{"users":[]}');
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toMatchObject([
			{ project: 'storefront', testName: 'home-screen' },
		]);
	});

	it('stops being answered by list_projects afterwards', async () => {
		await register('checkout-web');

		await expect(deleteProject('checkout-web')).resolves.toMatchObject({ outcome: 'deleted' });

		const listed: ListProjectsResult = await (await connect()).request('list_projects', {});
		expect(listed).toEqual({ outcome: 'listed', projects: [] });
	});
});

describe('the four outcomes never collapse into each other', () => {
	it('answers not-registered when nothing at all was reached', async () => {
		const result = await deleteProject('never-registered');

		// Deliberately not a `deleted` that removed nothing: *there was no such project* and *the
		// project went* are two facts, and the schema is what keeps them two.
		expect(result).toEqual({ outcome: 'not-registered' });
		expect(await exists(temp.projectsRoot)).toBe(false);
		expect(await exists(temp.artifactsRoot)).toBe(false);
		expect(await exists(temp.keptTestsPath)).toBe(false);
	});

	it('answers deleted with the archive absent for a registration that filed nothing', async () => {
		await register('checkout-web');

		expect(await deleteProject('checkout-web')).toEqual({
			outcome: 'deleted',
			registration: 'removed',
			archive: 'absent',
			keptTests: 'absent',
			freedBytes: 0,
			keptTestsRemoved: 0,
		});
	});

	it('answers deleted with the registration absent for a subtree nobody registered', async () => {
		// Ordinary rather than exotic: a lease may name any project string (D22), so an archive
		// subtree with no hook file beside it is a real state — and taking it did something.
		await fileARun('ad-hoc', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 256);

		expect(await deleteProject('ad-hoc')).toEqual({
			outcome: 'deleted',
			registration: 'absent',
			archive: 'removed',
			keptTests: 'absent',
			freedBytes: 256,
			keptTestsRemoved: 0,
		});
	});

	it('answers partial with the registration still removed when the subtree will not go', async () => {
		await register('checkout-web');
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await start();
		// A directory is removed by writing to its *parent*, so the archive root is what has to
		// refuse. Restored in `afterEach`, or the temp directory could not be removed.
		await chmod(temp.artifactsRoot, 0o555);
		if (await stillWritable(temp.artifactsRoot)) {
			// Running as root: there is no unremovable directory on this machine to assert about.
			return;
		}

		const result = reportOf(await deleteProject('checkout-web'));

		expect(result).toMatchObject({
			outcome: 'partial',
			// The registration goes **first**, which is the direction that leaves the host doing
			// less: a project whose hook file went starts no services and runs no teardown, even
			// though its artifacts are still there.
			registration: 'removed',
			archive: 'failed',
			freedBytes: 0,
		});
		expect(await exists(join(temp.artifactsRoot, 'checkout-web'))).toBe(true);
	});

	it('answers partial without overwriting a kept-tests store it cannot read', async () => {
		await register('checkout-web');
		await writeFile(temp.keptTestsPath, '{ not json', 'utf8');

		const result = reportOf(await deleteProject('checkout-web'));

		expect(result).toMatchObject({
			outcome: 'partial',
			registration: 'removed',
			keptTests: 'failed',
			keptTestsRemoved: 0,
		});
		// Byte-identical: resetting the file would delete every exemption on the host to make one
		// call succeed, which is `set_kept_tests`' own promise.
		expect(await readFile(temp.keptTestsPath, 'utf8')).toBe('{ not json');
	});
});

describe('a live lease on the project is refused, and nothing is touched', () => {
	it('refuses while the lease is live and leaves all three halves alone', async () => {
		registerFakeBackend();
		await register('checkout-web');
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await writeKeptTests(temp.keptTestsPath, [
			{
				project: 'checkout-web',
				testName: 'home-screen',
				keptBy: 'bob',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
		]);
		await start();
		await expect(
			(await connect()).request('acquire_device', {
				serial: ATTACHED.serial,
				owner: 'issue-271',
				project: 'checkout-web',
				testName: 'home-screen',
			}),
		).resolves.toMatchObject({ outcome: 'granted' });

		const result = await deleteProject('checkout-web');

		// The hook file carries the teardown D9 still owes that lease, and the subtree is what it
		// is filing into right now (D35). So the answer is data with an obvious next move.
		expect(result).toEqual({ outcome: 'refused', reason: 'lease-live' });
		expect(await exists(join(temp.projectsRoot, 'checkout-web.json'))).toBe(true);
		expect(await exists(join(temp.artifactsRoot, 'checkout-web'))).toBe(true);
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toHaveLength(1);
	});

	it('refuses for the archive spelling of a lease project too', async () => {
		// The two spellings collapse for a registered identifier and come apart only for a caller
		// string `pathSegment` rewrote into something that reads as one — exactly the case a
		// single-sided check would miss.
		registerFakeBackend();
		const filed = pathSegment('check out');
		expect(filed).not.toBe('check out');
		await fileARun(filed, 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await start();
		await expect(
			(await connect()).request('acquire_device', {
				serial: ATTACHED.serial,
				owner: 'issue-271',
				project: 'check out',
				testName: 'home-screen',
			}),
		).resolves.toMatchObject({ outcome: 'granted' });

		expect(await deleteProject(filed)).toEqual({ outcome: 'refused', reason: 'lease-live' });
		expect(await exists(join(temp.artifactsRoot, filed))).toBe(true);
	});
});

describe('what leaves the host, and what stays on it', () => {
	it('puts no host path and no errno on any answer', async () => {
		await register('checkout-web');
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);

		const serialised = JSON.stringify(await deleteProject('checkout-web'));

		// The structural promise (D19): there is no field a path would fit in, and
		// `src/ipc/server.ts` parses every answer against the `.strict()` schema.
		expect(serialised).not.toContain(temp.dir);
		expect(serialised).not.toContain(temp.projectsRoot);
		expect(serialised).not.toContain(temp.artifactsRoot);
		expect(serialised).not.toContain('ENOENT');
		expect(serialised).not.toContain('message');
	});

	it('says on its own log why a half did not go, naming the path there and only there', async () => {
		await register('checkout-web');
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await start();
		await chmod(temp.artifactsRoot, 0o555);
		if (await stillWritable(temp.artifactsRoot)) {
			return;
		}

		const result = await deleteProject('checkout-web');

		expect(result.outcome).toBe('partial');
		expect(JSON.stringify(result)).not.toContain(temp.artifactsRoot);
		expect(logged.join('\n')).toContain(join(temp.artifactsRoot, 'checkout-web'));
	});

	it('writes one audit line naming the actor, the project and the counts', async () => {
		await register('checkout-web');
		await fileARun('checkout-web', 'home-screen', '20260901T101010Z-issue-1-abcd1234', 512);
		await writeKeptTests(temp.keptTestsPath, [
			{
				project: 'checkout-web',
				testName: 'home-screen',
				keptBy: 'bob',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
		]);
		await start();
		logged.length = 0;

		await deleteProject('checkout-web', 'jacek');

		const audit = logged.filter((line) => line.startsWith('Deleted project "checkout-web"'));
		expect(audit).toHaveLength(1);
		expect(audit[0]).toContain('"jacek"');
		expect(audit[0]).toContain('1 kept test removed');
		// Nothing that is a credential is in scope on this path at all (D20).
		expect(audit[0]).not.toContain('token');
	});

	it('says plainly that a refused delete deleted nothing', async () => {
		registerFakeBackend();
		await register('checkout-web');
		await start();
		await expect(
			(await connect()).request('acquire_device', {
				serial: ATTACHED.serial,
				owner: 'issue-271',
				project: 'checkout-web',
				testName: 'home-screen',
			}),
		).resolves.toMatchObject({ outcome: 'granted' });
		logged.length = 0;

		await deleteProject('checkout-web', 'jacek');

		const audit = logged.filter((line) => line.includes('Refused to delete project'));
		expect(audit).toHaveLength(1);
		expect(audit[0]).toContain('nothing was touched');
		expect(audit[0]).toContain('"jacek"');
	});
});
