/**
 * `search_archive` end to end: a real daemon on a temp socket, an artifact root a real
 * `ArtifactArchive` wrote, and a client asking over the real framing.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never
 * `~/.rover/rover.sock`, and every daemon closed through its own handle in `afterEach`. The
 * filesystem is real for `list-archive.test.ts`'s reason: what this method answers is files
 * somebody can list, and a mocked `fs` would prove only that the module called it. Every root is
 * a `mkdtemp` — **no test writes into `~/.rover/artifacts`**.
 *
 * Real rather than a direct call on the handler, because the `.strict()` result parse in
 * `src/ipc/server.ts` is half of what is asserted here: it is what makes "no host path can be on
 * an answer" structural (D19), and it is what makes the match cap a bound on the *wire* rather
 * than a habit of one module.
 *
 * The populated tree is built by **`createArtifactArchive` itself** wherever the run levels
 * matter, so the reader is asserted against what the writer actually writes; the shapes the writer
 * cannot produce — a tree past the depth bound, a level past the directory bound, a symlink — are
 * made by hand.
 */

import { chmod, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ArchivableResult, createArtifactArchive } from '@/daemon/archive.js';
import { leaseDirectoryName, pathSegment } from '@/daemon/archive-path.js';
import type { Lease } from '@/daemon/leases.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import { createSearchArchiveHandler } from '@/daemon/search-archive.js';
import type { IpcClient } from '@/ipc/client.js';
import {
	type ArchiveSearchMatch,
	ListArchiveParamsSchema,
	MAX_ARCHIVE_PATH_DEPTH,
	MAX_ARCHIVE_SEARCH_MATCHES,
	type SearchArchiveResult,
} from '@/ipc/methods.js';
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

/** The one daemon a test needs, started on the first ask so a test may search more than once. */
async function start(): Promise<void> {
	if (running.length > 0) {
		return;
	}
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

/** One request, against a daemon this helper starts. */
async function search(text: string): Promise<SearchArchiveResult> {
	await start();
	return (await connect()).request('search_archive', { text });
}

/** The matches, or a failed test naming the outcome that was answered instead. */
function matchesOf(result: SearchArchiveResult): readonly ArchiveSearchMatch[] {
	if (result.outcome !== 'searched') {
		throw new Error(`The archive was not searched: ${result.outcome}`);
	}
	return result.matches;
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
		expect(await search('rover')).toEqual({ outcome: 'missing' });
	});

	it('says unreadable when the root is not a directory at all', async () => {
		await writeFile(temp.artifactsRoot, 'not a directory');

		expect(await search('rover')).toEqual({ outcome: 'unreadable' });
	});

	it('says unreadable, not empty, for a root this host has no permission to read', async () => {
		await mkdir(temp.artifactsRoot, { recursive: true });
		await mkdir(join(temp.artifactsRoot, 'a-project'));
		await chmod(temp.artifactsRoot, 0o000);
		if (await stillReadable(temp.artifactsRoot)) {
			// Running as root: permissions do not apply, so there is nothing here to assert.
			return;
		}

		expect(await search('a-project')).toEqual({ outcome: 'unreadable' });
	});

	it('says searched with no matches — nothing matched, which is not a failure', async () => {
		await archiveAScreenshot();

		// The load-bearing distinction: an archive that has nothing matching must not read as an
		// archive that is not there, or as one the host cannot see into.
		expect(await search('nothing-here-matches-this')).toEqual({
			outcome: 'searched',
			matches: [],
			truncated: false,
		});
	});

	it('names the root and the reason on the host, and never on the wire', async () => {
		await writeFile(temp.artifactsRoot, 'not a directory');

		expect(await search('rover')).toEqual({ outcome: 'unreadable' });
		// The diagnosis the answer may not carry lives here instead (D19).
		expect(warnings.join('\n')).toContain(temp.artifactsRoot);
		expect(warnings.join('\n')).toContain('ENOTDIR');
	});
});

describe('what a search of the whole archive finds', () => {
	it('finds the project, the test name, the run and a file, each as an addressable path', async () => {
		await archiveAScreenshot();

		expect(matchesOf(await search(PROJECT))).toEqual([{ path: [PROJECT], kind: 'directory' }]);
		expect(matchesOf(await search(TEST_NAME))).toEqual([
			{ path: [PROJECT, TEST_NAME], kind: 'directory' },
		]);
		expect(matchesOf(await search(LEASE_DIR))).toEqual([
			{ path: [PROJECT, TEST_NAME, LEASE_DIR], kind: 'directory' },
		]);
		// A file, not only a directory: the issue's word is "entries", which is `list_archive`'s
		// word for all three kinds, and a file's address is what #133's preview reads.
		expect(matchesOf(await search('001_screenshot'))).toEqual([
			{
				path: [PROJECT, TEST_NAME, LEASE_DIR, SERIAL, 'screenshots', '001_screenshot.png'],
				kind: 'file',
			},
		]);
	});

	it('answers a path a list_archive walk would have reached, component for component', async () => {
		await archiveAScreenshot();

		const [match] = matchesOf(await search('001_screenshot'));
		if (!match) {
			throw new Error('the screenshot was not found');
		}
		// One path vocabulary for the archive (R37): the answer's own path is a path
		// `list_archive` accepts, asserted through its schema rather than by eye.
		expect(ListArchiveParamsSchema.safeParse({ path: match.path }).success).toBe(true);
		const level = await (await connect()).request('list_archive', {
			path: match.path.slice(0, -1),
		});
		expect(level.outcome === 'listed' && level.entries.map((one) => one.name)).toContain(
			'001_screenshot.png',
		);
	});

	it('reaches a second project and five levels down in one request', async () => {
		await archiveAScreenshot();
		await archiveAScreenshot(
			createMockLease({ ...lease, project: 'another-app', testName: 'checkout' }),
		);

		// This is what makes it a search rather than a listing: one request crosses the whole
		// tree, where `list_archive` would have been six.
		const paths = matchesOf(await search('screenshots')).map((one) => one.path);
		expect(paths).toHaveLength(2);
		expect(paths.every((path) => path.length === 5)).toBe(true);
		expect(paths.map((path) => path[0]).sort()).toEqual(['another-app', PROJECT]);
	});

	it('finds the same run by an upper-case and a lower-case fragment', async () => {
		await mkdir(join(temp.artifactsRoot, 'Rover-Checkout'), { recursive: true });

		// Case-insensitive, folded with `toLowerCase` rather than `toLocaleLowerCase` so two
		// hosts answer alike — the reason `list_archive` refuses `localeCompare`.
		expect(matchesOf(await search('CHECKOUT'))).toEqual([
			{ path: ['Rover-Checkout'], kind: 'directory' },
		]);
		expect(matchesOf(await search('checkout'))).toEqual([
			{ path: ['Rover-Checkout'], kind: 'directory' },
		]);
	});
});

describe('a component is matched whole and verbatim, never parsed', () => {
	it('matches a substring of the entire run name, timestamp, owner and hash together', async () => {
		// Built by hand rather than archived, so the one run in the tree is the one asserted:
		// the writer names a run after the lease's own owner (`archive-path.ts`), which for the
		// suite's mock lease is `issue-112` too.
		const run = join(temp.artifactsRoot, PROJECT, TEST_NAME);
		await mkdir(join(run, '20260830T170501Z-issue-112-9f1c2ab4'), { recursive: true });

		// The whole name is the candidate. `issue-112` here is a substring of
		// `<timestamp>-<owner>-<hash>` and nothing decomposed that name to find it (D22).
		expect(matchesOf(await search('issue-112')).map((one) => one.path)).toEqual([
			[PROJECT, TEST_NAME, '20260830T170501Z-issue-112-9f1c2ab4'],
		]);
	});

	it('matches nothing for a piece that is only a piece of a decomposition', async () => {
		await mkdir(join(temp.artifactsRoot, '20260830T170501Z-issue-112-9f1c2ab4'), {
			recursive: true,
		});

		// `112-9f1c` spans the hyphen the way a substring does, so it *is* found; `Z-9f1c2ab4` is
		// only a match if something joined the timestamp to the hash — that is the parsing this
		// pins out.
		expect(matchesOf(await search('112-9f1c'))).toHaveLength(1);
		expect(matchesOf(await search('Z-9f1c2ab4'))).toEqual([]);
		expect(matchesOf(await search('issue'))).toHaveLength(1);
	});

	it('is a substring match and not a glob or a regular expression', async () => {
		await mkdir(join(temp.artifactsRoot, 'home-screen'), { recursive: true });

		// A pattern is not a vocabulary this method has: `.*` is four characters to look for.
		expect(matchesOf(await search('h.*n'))).toEqual([]);
		expect(matchesOf(await search('home*'))).toEqual([]);
	});
});

describe('the order, which decides what survives the cap', () => {
	it('answers breadth-first, and ascending by name within a level', async () => {
		await mkdir(join(temp.artifactsRoot, 'match-b', 'match-deep'), { recursive: true });
		await mkdir(join(temp.artifactsRoot, 'match-a'), { recursive: true });

		// Shallow before deep, whatever order the entries were created in: the match cap
		// truncates the deepest, least specific hits first, which is the whole reason the walk
		// is a FIFO queue rather than a recursion.
		expect(matchesOf(await search('match')).map((one) => one.path)).toEqual([
			['match-a'],
			['match-b'],
			['match-b', 'match-deep'],
		]);
	});
});

describe('the three bounds, and the one thing truncated means', () => {
	it('caps the matches and says the answer is truncated', async () => {
		await mkdir(temp.artifactsRoot, { recursive: true });
		await Promise.all(
			Array.from({ length: MAX_ARCHIVE_SEARCH_MATCHES + 5 }, (_, index) =>
				mkdir(join(temp.artifactsRoot, `match-${String(index).padStart(4, '0')}`)),
			),
		);

		const result = await search('match-');
		expect(matchesOf(result)).toHaveLength(MAX_ARCHIVE_SEARCH_MATCHES);
		expect(result.outcome === 'searched' && result.truncated).toBe(true);
	});

	it('keeps the shallow matches when it caps, not the deep ones', async () => {
		await mkdir(temp.artifactsRoot, { recursive: true });
		// One deep match under a name that also matches, and enough shallow ones to fill the cap.
		await mkdir(join(temp.artifactsRoot, 'match-0000', 'match-deep'), { recursive: true });
		await Promise.all(
			Array.from({ length: MAX_ARCHIVE_SEARCH_MATCHES }, (_, index) =>
				mkdir(join(temp.artifactsRoot, `match-${String(index + 1).padStart(4, '0')}`)),
			),
		);

		const paths = matchesOf(await search('match-')).map((one) => one.path);
		// The breadth-first property as an assertion rather than a comment: every surviving
		// match is at the root, and the one below it is what was dropped.
		expect(paths.every((path) => path.length === 1)).toBe(true);
		expect(paths).not.toContainEqual(['match-0000', 'match-deep']);
	});

	it('does not descend past the addressable depth, and says so', async () => {
		// One directory per level, deeper than any path `list_archive` accepts, with a match at
		// the bottom.
		const deep = Array.from({ length: MAX_ARCHIVE_PATH_DEPTH + 2 }, (_, index) => `l${index}`);
		await mkdir(join(temp.artifactsRoot, ...deep, 'needle-at-the-bottom'), { recursive: true });

		const result = await search('needle');
		expect(matchesOf(result)).toEqual([]);
		expect(result.outcome === 'searched' && result.truncated).toBe(true);
	});

	it('answers only paths list_archive would accept, whatever the tree looks like', async () => {
		const deep = Array.from({ length: MAX_ARCHIVE_PATH_DEPTH + 2 }, (_, index) => `l${index}`);
		await mkdir(join(temp.artifactsRoot, ...deep), { recursive: true });

		for (const match of matchesOf(await search('l'))) {
			expect(ListArchiveParamsSchema.safeParse({ path: match.path }).success).toBe(true);
		}
	});

	it('stops after the directory bound and says the answer is truncated', async () => {
		await mkdir(temp.artifactsRoot, { recursive: true });
		// A wide flat level rather than a deep one: the bound is what is asserted, and five
		// thousand `mkdir`s in a unit test is real work for no extra coverage. The bound is a
		// handler option with a default — never a wire parameter, which is D24's refusal.
		await Promise.all(
			// Zero-padded, so the code-unit order the walk reads them in is the readable one.
			Array.from({ length: 12 }, (_, index) =>
				mkdir(join(temp.artifactsRoot, `p${String(index).padStart(2, '0')}`, 'needle-inside'), {
					recursive: true,
				}),
			),
		);
		const handler = createSearchArchiveHandler({
			root: temp.artifactsRoot,
			warn: (line) => warnings.push(line),
			maxDirectories: 4,
		});

		const result = await handler.search_archive({ text: 'needle' });
		expect(result.outcome === 'searched' && result.truncated).toBe(true);
		// The bound stopped the descent at three of the twelve projects, so nine needles are
		// missing — which is exactly what `truncated` says. What it did *not* do is throw away
		// the three it had already read: a bound that answered nothing would be useless on the
		// only archive big enough to reach it.
		expect(matchesOf(result).map((one) => one.path)).toEqual([
			['p00', 'needle-inside'],
			['p01', 'needle-inside'],
			['p02', 'needle-inside'],
		]);
	});

	it('is not truncated when the whole archive fitted inside every bound', async () => {
		await archiveAScreenshot();

		expect(await search(PROJECT)).toEqual({
			outcome: 'searched',
			matches: [{ path: [PROJECT], kind: 'directory' }],
			truncated: false,
		});
	});
});

describe('a level the host cannot read mid-walk', () => {
	it('still answers, keeps the matches elsewhere, and says it is truncated', async () => {
		await archiveAScreenshot();
		const blocked = join(temp.artifactsRoot, 'blocked-project');
		await mkdir(join(blocked, 'needle-below'), { recursive: true });
		await mkdir(join(temp.artifactsRoot, 'needle-elsewhere'));
		await chmod(blocked, 0o000);
		if (await stillReadable(blocked)) {
			// Running as root: permissions do not apply, so there is nothing here to assert.
			return;
		}

		try {
			const result = await search('needle');

			// An unreadable level does not fail the search — but the answer is short, and a
			// partial answer that renders like a complete one is what this project refuses.
			expect(matchesOf(result).map((one) => one.path)).toEqual([['needle-elsewhere']]);
			expect(result.outcome === 'searched' && result.truncated).toBe(true);
			// The reason and the path stay in the host's own log, exactly as `list_archive` warns.
			expect(warnings.join('\n')).toContain(blocked);
			expect(warnings.join('\n')).toMatch(/EACCES|EPERM/);
			expect(JSON.stringify(result)).not.toContain('blocked-project');
		} finally {
			await chmod(blocked, 0o755);
		}
	});
});

describe('no host path is on any answer', () => {
	it('carries neither the archive root nor any absolute path', async () => {
		await archiveAScreenshot();

		const encoded = JSON.stringify(await search('e'));

		// The load-bearing negative (D19). `SearchArchiveResultSchema` has no field one would fit
		// in — not even a `message` — and `src/ipc/server.ts` parses every answer against it.
		expect(encoded).not.toContain(temp.artifactsRoot);
		expect(encoded).not.toContain(temp.dir);
		expect(encoded).not.toContain(tmpdir());
	});
});

describe('containment, which this walk gets from never following a link', () => {
	it('names a matching symlink as other and reaches nothing on the far side of it', async () => {
		await archiveAScreenshot();
		const outside = join(temp.dir, 'outside');
		await mkdir(outside);
		await writeFile(join(outside, 'needle-secret.txt'), 'not yours');
		await symlink(outside, join(temp.artifactsRoot, 'needle-link'));

		// `isDirectory()` is `false` for a symlink under `withFileTypes`, so the walk never
		// descends into one — which is the whole of containment here, there being no
		// caller-supplied path to escape with.
		const result = await search('needle');
		expect(matchesOf(result)).toEqual([{ path: ['needle-link'], kind: 'other' }]);
		expect(JSON.stringify(result)).not.toContain('needle-secret');
	});

	it('cannot reach a sibling of the root at all', async () => {
		await archiveAScreenshot();
		const sibling = join(temp.dir, 'not-the-archive');
		await mkdir(sibling);
		await writeFile(join(sibling, 'rover-secret.txt'), 'not yours');

		expect(matchesOf(await search('secret'))).toEqual([]);
	});
});

describe('the params schema is closed, so the only key there is stays the only one', () => {
	it.each([
		[{}, 'a missing text'],
		[{ text: '' }, 'an empty text'],
		[{ text: 'x'.repeat(300) }, 'a text past the length cap'],
		[{ text: 'rover', limit: 10 }, 'a caller-supplied bound'],
		[{ text: 'rover', path: [] }, 'a start path'],
		[{ text: 'rover', kind: 'directory' }, 'a kind filter'],
	])('refuses %j — %s — with invalid_params', async (params, _why) => {
		await archiveAScreenshot();
		await start();
		const client = await connect();

		const rejection = client.request('search_archive', params as never);

		await expect(rejection).rejects.toBeInstanceOf(IpcRequestError);
		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
	});
});

describe('a name read off disk never reaches the host log unescaped', () => {
	it('cannot forge a second line in the daemon’s own record with a newline', async () => {
		await mkdir(temp.artifactsRoot, { recursive: true });
		const forged = 'injected  Force-released the lease on device \'ABC\' asked for by "admin"';
		const blocked = join(temp.artifactsRoot, `needle\n${forged}`);
		await mkdir(join(blocked, 'a-child'), { recursive: true });
		await chmod(blocked, 0o000);
		if (await stillReadable(blocked)) {
			return;
		}

		try {
			const result = await search('needle');

			// The name is answered verbatim — it is the on-disk name, and the next request has to
			// be able to carry it.
			expect(matchesOf(result)).toEqual([{ path: [`needle\n${forged}`], kind: 'directory' }]);
			// And the daemon's stderr is the host's only accountability trail (D28), so one
			// warning is one line: the newline is `\n` in the text and starts nothing.
			expect(warnings).toHaveLength(1);
			expect(warnings.join('\n')).toContain('\\n');
			for (const line of warnings.join('\n').split('\n')) {
				expect(line.startsWith('injected')).toBe(false);
			}
		} finally {
			await chmod(blocked, 0o755);
		}
	});
});
