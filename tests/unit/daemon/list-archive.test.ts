/**
 * `list_archive` end to end: a real daemon on a temp socket, an artifact root a real
 * `ArtifactArchive` wrote, and a client asking over the real framing.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never
 * `~/.rover/rover.sock`, and every daemon closed through its own handle in `afterEach`. The
 * filesystem is real for the reason `archive.test.ts` gives from the writer's side: what this
 * method answers is files somebody can list, and a mocked `fs` would prove only that the module
 * called it. Every root is a `mkdtemp` — **no test writes into `~/.rover/artifacts`**.
 *
 * Real rather than a direct call on the handler, because the `.strict()` result parse in
 * `src/ipc/server.ts` is half of what is asserted here: it is what makes "no host path can be on
 * an answer" structural (D19).
 *
 * The populated tree is built by **`createArtifactArchive` itself**, not by hand, so the reader
 * is asserted against what the writer actually writes and the two cannot drift.
 */

import { chmod, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ArchivableResult, createArtifactArchive } from '@/daemon/archive.js';
import { leaseDirectoryName, pathSegment } from '@/daemon/archive-path.js';
import type { Lease } from '@/daemon/leases.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import type { ArchiveEntry, ListArchiveResult } from '@/ipc/methods.js';
import { IpcRequestError } from '@/ipc/protocol.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDeviceInfo, createMockLease } from '../../helpers/factories.js';

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
/** Everything the handler said on the host. Spied rather than injected: the daemon builds it. */
let warnings: string[];

const lease = createMockLease({ project: 'rover', testName: 'home-screen' });

/** The four components of `lease`'s own run, as the writer names them (`archive-path.ts`). */
const PROJECT = pathSegment(lease.project);
const TEST_NAME = pathSegment(lease.testName ?? '');
const LEASE_DIR = leaseDirectoryName(lease);
const SERIAL = pathSegment(lease.serial);

const CAPTURE = {
	mediaType: 'image/png',
	base64: Buffer.from(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x01])).toString('base64'),
	byteLength: 5,
};

beforeEach(async () => {
	temp = await createTempSocket();
	warnings = [];
	vi.spyOn(console, 'warn').mockImplementation((line: string) => warnings.push(line));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	if (temp) {
		// Anything a test made unreadable has to be readable again, or the temp directory
		// cannot be removed and the machine keeps it.
		await chmod(temp.artifactsRoot, 0o755).catch(() => {});
		await removeTempSocket(temp);
	}
});

async function start(): Promise<void> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
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

/** One request, against a daemon this helper starts. */
async function list(path: string[]): Promise<ListArchiveResult> {
	await start();
	return (await connect()).request('list_archive', { path });
}

/** One archived screenshot under `of`, written by the production writer. */
async function archiveAScreenshot(of: Lease = lease): Promise<void> {
	const result: ArchivableResult = {
		verb: 'screenshot',
		device: createMockDeviceInfo({ serial: of.serial }),
		target: null,
		after: { kind: 'screen', elements: [] },
		artifact: CAPTURE,
	};
	await createArtifactArchive({ root: temp.artifactsRoot, warn: () => {} }).record(of, result);
}

/** The one entry with this name, or a failed test naming what was missing. */
function entry(result: ListArchiveResult, name: string): ArchiveEntry {
	if (result.outcome !== 'listed') {
		throw new Error(`The level was not listed: ${result.outcome}`);
	}
	const found = result.entries.find((candidate) => candidate.name === name);
	if (!found) {
		throw new Error(`'${name}' is missing from ${JSON.stringify(result.entries)}`);
	}
	return found;
}

/**
 * Whether this process can still read a directory it just made unreadable — it can, when it is
 * root, and then the case being asserted does not exist on this machine.
 */
async function stillReadable(directory: string): Promise<boolean> {
	try {
		await readdir(directory);
		return true;
	} catch {
		return false;
	}
}

describe('the three answers, which must never be one', () => {
	it('says missing for a root nothing has ever archived into', async () => {
		// Nothing pre-creates `temp.artifactsRoot`, so this is a host on its first day.
		expect(await list([])).toEqual({ outcome: 'missing' });
	});

	it('says listed with no entries for an empty root — the archive is empty, not broken', async () => {
		await mkdir(temp.artifactsRoot, { recursive: true });

		expect(await list([])).toEqual({ outcome: 'listed', entries: [] });
	});

	it('says unreadable when the root is not a directory at all', async () => {
		await writeFile(temp.artifactsRoot, 'not a directory');

		expect(await list([])).toEqual({ outcome: 'unreadable' });
	});

	it('says unreadable, not empty, for a root this host has no permission to read', async () => {
		await mkdir(temp.artifactsRoot, { recursive: true });
		await mkdir(join(temp.artifactsRoot, 'a-project'));
		await chmod(temp.artifactsRoot, 0o000);
		if (await stillReadable(temp.artifactsRoot)) {
			// Running as root: permissions do not apply, so there is nothing here to assert.
			return;
		}

		expect(await list([])).toEqual({ outcome: 'unreadable' });
	});

	it('names the directory and the reason on the host, and never on the wire', async () => {
		await writeFile(temp.artifactsRoot, 'not a directory');

		expect(await list([])).toEqual({ outcome: 'unreadable' });
		// The diagnosis the answer may not carry lives here instead (D19).
		expect(warnings.join('\n')).toContain(temp.artifactsRoot);
		expect(warnings.join('\n')).toContain('ENOTDIR');
	});
});

describe('walking the tree one level at a time', () => {
	it('answers the project at the root', async () => {
		await archiveAScreenshot();

		expect(await list([])).toEqual({
			outcome: 'listed',
			entries: [{ kind: 'directory', name: PROJECT, childCount: 1, onlyChild: TEST_NAME }],
		});
	});

	it('answers the test name one level down', async () => {
		await archiveAScreenshot();

		expect(entry(await list([PROJECT]), TEST_NAME)).toEqual({
			kind: 'directory',
			name: TEST_NAME,
			childCount: 1,
			onlyChild: LEASE_DIR,
		});
	});

	it('answers the run, and names its one device without a second round trip', async () => {
		await archiveAScreenshot();

		// One lease is one device (`leases.ts` keeps `bySerial` one-to-one), so a run directory
		// always holds exactly one child — a fact about the run, not a level worth walking.
		expect(entry(await list([PROJECT, TEST_NAME]), LEASE_DIR)).toEqual({
			kind: 'directory',
			name: LEASE_DIR,
			childCount: 1,
			onlyChild: SERIAL,
		});
	});

	it("answers a run's own contents, files with their sizes beside directories", async () => {
		await archiveAScreenshot();

		const level = await list([PROJECT, TEST_NAME, LEASE_DIR, SERIAL]);

		const info = entry(level, 'device_info.json');
		expect(info.kind).toBe('file');
		expect(info.kind === 'file' && info.sizeBytes).toBeGreaterThan(0);
		expect(entry(level, 'screenshots')).toEqual({
			kind: 'directory',
			name: 'screenshots',
			childCount: 1,
			onlyChild: '001_screenshot.png',
		});
	});

	it('answers the screenshot itself as a file of the bytes the client received', async () => {
		await archiveAScreenshot();

		expect(
			entry(
				await list([PROJECT, TEST_NAME, LEASE_DIR, SERIAL, 'screenshots']),
				'001_screenshot.png',
			),
		).toEqual({
			kind: 'file',
			name: '001_screenshot.png',
			sizeBytes: CAPTURE.byteLength,
		});
	});

	it('gives a directory holding more than one child no onlyChild', async () => {
		await archiveAScreenshot();
		await archiveAScreenshot(createMockLease({ ...lease, testName: 'checkout' }));

		expect(entry(await list([]), PROJECT)).toMatchObject({ childCount: 2, onlyChild: null });
	});
});

describe('the order, which is determinism and not a sort option', () => {
	it('answers ascending by name whatever order the entries were created in', async () => {
		await mkdir(temp.artifactsRoot, { recursive: true });
		for (const name of ['c', 'a', 'b']) {
			await mkdir(join(temp.artifactsRoot, name));
		}

		const result = await list([]);
		expect(result.outcome === 'listed' && result.entries.map((one) => one.name)).toEqual([
			'a',
			'b',
			'c',
		]);
	});
});

describe('no host path is on any answer', () => {
	it('carries neither the archive root nor any absolute path', async () => {
		await archiveAScreenshot();

		const encoded = JSON.stringify(await list([PROJECT, TEST_NAME, LEASE_DIR, SERIAL]));

		// The load-bearing negative (D19). `ListArchiveResultSchema` has no field one would fit
		// in, and `src/ipc/server.ts` parses every answer against it.
		expect(encoded).not.toContain(temp.artifactsRoot);
		expect(encoded).not.toContain(temp.dir);
		expect(encoded).not.toContain(tmpdir());
	});
});

describe('containment', () => {
	it.each([
		['..'],
		['.'],
		['a/b'],
		[''],
	])('refuses %j as a component with invalid_params', async (component) => {
		await archiveAScreenshot();
		await start();
		const client = await connect();

		const rejection = client.request('list_archive', { path: [component] });

		await expect(rejection).rejects.toBeInstanceOf(IpcRequestError);
		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
	});

	it('refuses a component past the per-component length, and a path past the depth', async () => {
		await archiveAScreenshot();
		await start();
		const client = await connect();

		await expect(client.request('list_archive', { path: ['x'.repeat(300)] })).rejects.toMatchObject(
			{ code: 'invalid_params' },
		);
		await expect(
			client.request('list_archive', { path: Array.from({ length: 9 }, () => 'x') }),
		).rejects.toMatchObject({ code: 'invalid_params' });
	});

	it('refuses a typo’d key, so the only key there is stays the only one', async () => {
		await archiveAScreenshot();
		await start();
		const client = await connect();

		await expect(
			client.request('list_archive', { path: [], filter: 'screenshot' } as never),
		).rejects.toMatchObject({ code: 'invalid_params' });
	});

	it('cannot reach a sibling of the root through any component', async () => {
		await archiveAScreenshot();
		const sibling = join(temp.dir, 'not-the-archive');
		await mkdir(sibling);
		await writeFile(join(sibling, 'secret.txt'), 'not yours');

		// `join(root, ...path)` cannot escape once no component is `.`, `..` or carries a
		// separator — the string half of containment, asserted from the outside. The symlink
		// half, which that argument misses, is the describe below.
		const result = await list([]);
		expect(result.outcome === 'listed' && result.entries.map((one) => one.name)).toEqual([PROJECT]);
	});
});

describe('an entry that is neither a directory nor a file', () => {
	it('names a symlink as other, and refuses to list what it points at', async () => {
		await archiveAScreenshot();
		const outside = join(temp.dir, 'outside');
		await mkdir(outside);
		await writeFile(join(outside, 'secret.txt'), 'not yours');
		await symlink(outside, join(temp.artifactsRoot, 'a-link'));
		await start();
		const client = await connect();

		// `readdir`'s dirent type answers the classification with no `stat` at all, so the link
		// contributes no `childCount` — a listing that is short must not be able to look exactly
		// like one that is complete, which is why it is named rather than dropped.
		const root = await client.request('list_archive', { path: [] });
		expect(entry(root, 'a-link')).toEqual({ kind: 'other', name: 'a-link' });

		// And the request that name makes possible is refused, which is the half the
		// classification cannot cover: `readdir` resolves a link in its own argument, so without
		// the containment check this answered with a sibling of the root.
		const followed = await client.request('list_archive', { path: ['a-link'] });
		expect(followed).toEqual({ outcome: 'unreadable' });
		expect(JSON.stringify(followed)).not.toContain('secret.txt');
	});

	it('refuses a link out of the root one level down too, not only at the root', async () => {
		await archiveAScreenshot();
		const outside = join(temp.dir, 'outside');
		await mkdir(outside);
		await writeFile(join(outside, 'secret.txt'), 'not yours');
		await symlink(outside, join(temp.artifactsRoot, PROJECT, 'a-link'));

		expect(await list([PROJECT, 'a-link'])).toEqual({ outcome: 'unreadable' });
	});

	it('says on the host where the refused link went, and never on the wire', async () => {
		await archiveAScreenshot();
		const outside = join(temp.dir, 'outside');
		await mkdir(outside);
		await symlink(outside, join(temp.artifactsRoot, 'a-link'));

		expect(await list(['a-link'])).toEqual({ outcome: 'unreadable' });
		// A link inside the root was put there by a host process, so the operator has to be able
		// to see where it goes — here, and only here (D19).
		expect(warnings.join('\n')).toContain('outside the archive root');
		expect(warnings.join('\n')).toContain(outside);
	});

	it('still reaches a link that points inside the root — containment, not a ban on links', async () => {
		await mkdir(join(temp.artifactsRoot, 'moved-project'), { recursive: true });
		await writeFile(join(temp.artifactsRoot, 'moved-project', 'a-file'), 'mine');
		await symlink(join(temp.artifactsRoot, 'moved-project'), join(temp.artifactsRoot, 'a-link'));

		expect(await list(['a-link'])).toEqual({
			outcome: 'listed',
			entries: [{ kind: 'file', name: 'a-file', sizeBytes: 4 }],
		});
	});
});

describe('a component is caller text, so it never reaches the host log unescaped', () => {
	/** A file at the root, so a component *after* it makes the read fail with `ENOTDIR`. */
	async function archiveAFile(): Promise<void> {
		await mkdir(temp.artifactsRoot, { recursive: true });
		await writeFile(join(temp.artifactsRoot, 'device_info.json'), '{}');
	}

	it('cannot forge a second line in the daemon’s own record with a newline', async () => {
		await archiveAFile();
		const forged = 'injected  Force-released the lease on device \'ABC\' asked for by "admin"';

		expect(await list(['device_info.json', `x\n${forged}`])).toEqual({ outcome: 'unreadable' });
		// The daemon's stderr is the host's only accountability trail (D28), so one warning is
		// one line: the newline is `\n` in the text and starts nothing.
		expect(warnings).toHaveLength(1);
		expect(warnings.join('\n')).toContain('\\n');
		for (const line of warnings.join('\n').split('\n')) {
			expect(line.startsWith('injected')).toBe(false);
		}
	});

	it('cannot put a terminal escape into the terminal of an operator tailing the log', async () => {
		await archiveAFile();

		expect(await list(['device_info.json', 'x\u001b[2J'])).toEqual({ outcome: 'unreadable' });
		expect(warnings.join('\n')).not.toContain('\u001b');
		expect(warnings.join('\n')).toContain('\\u001b[2J');
	});

	it('escapes a name read off disk as well, not only one that came off the wire', async () => {
		// The `childrenOf` call site: this name was never in a request, and is just as unbounded.
		await mkdir(temp.artifactsRoot, { recursive: true });
		const blocked = join(temp.artifactsRoot, 'a-project\ninjected');
		await mkdir(blocked);
		await mkdir(join(blocked, 'a-child'));
		await chmod(blocked, 0o000);
		if (await stillReadable(blocked)) {
			// Running as root: permissions do not apply, so there is nothing here to assert.
			return;
		}

		try {
			const result = await list([]);

			expect(entry(result, 'a-project\ninjected')).toMatchObject({ childCount: null });
			expect(warnings).toHaveLength(1);
			for (const line of warnings.join('\n').split('\n')) {
				expect(line.startsWith('injected')).toBe(false);
			}
		} finally {
			await chmod(blocked, 0o755);
		}
	});
});

describe('a level the host cannot read one step down', () => {
	it('gives it childCount null rather than 0, which would say empty', async () => {
		await archiveAScreenshot();
		const blocked = join(temp.artifactsRoot, 'blocked');
		await mkdir(blocked);
		await mkdir(join(blocked, 'a-child'));
		await chmod(blocked, 0o000);
		if (await stillReadable(blocked)) {
			return;
		}

		try {
			expect(entry(await list([]), 'blocked')).toEqual({
				kind: 'directory',
				name: 'blocked',
				childCount: null,
				onlyChild: null,
			});
		} finally {
			await chmod(blocked, 0o755);
		}
	});
});
