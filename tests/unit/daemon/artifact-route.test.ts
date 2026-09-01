/**
 * R37's host half end to end: `GET /artifact/<component>/…` on a real HTTP listener, behind the
 * real token gate, over an artifact tree a real `ArtifactArchive` wrote.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md), and the filesystem is real for
 * the reason `archive.test.ts` and `list-archive.test.ts` both give: what this route serves is
 * bytes somebody can open, and a mocked `fs` would prove only that the module called it. Every
 * root is a `mkdtemp` — **no test reads or writes `~/.rover/artifacts`** — the store is a real
 * `users.json` beside it, and the listener binds `127.0.0.1:0`.
 *
 * The client is `node:http`'s own `request` rather than a Rover client, because a browser is not a
 * Rover client and there is nothing here for one to prove; unlike `http-listener.test.ts`'s
 * helper, this one collects the response into a **`Buffer`**, since these bodies are not text.
 *
 * **The populated tree is written by `createArtifactArchive` itself**, and the address of the file
 * the first test fetches is walked out of `list_archive`'s own answers, so "the bytes are
 * addressed by path components a listing answered" is pinned structurally rather than by a
 * hand-built path that happens to agree today.
 *
 * The gate itself is asserted in `http-listener.test.ts`, where the gate is: that route is
 * authenticated exactly as the rest of the surface is, which is a property of the listener rather
 * than of the archive.
 */

import { chmod, readFile, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import {
	type ArchivableResult,
	type ArtifactArchive,
	createArtifactArchive,
} from '@/daemon/archive.js';
import { leaseDirectoryName, pathSegment } from '@/daemon/archive-path.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import type { ArchiveEntry, ListArchiveResult } from '@/ipc/methods.js';
import type { Artifact } from '@/verbs/result.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import {
	createMockDevice,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockLease,
	createMockLogEntry,
	createMockLogRead,
} from '../../helpers/factories.js';
import { createTestUserStore, type TestUserStore } from '../../helpers/user-store.js';

let temp: TempSocket;
let store: TestUserStore;
/** Everything the reader said on the host. Spied rather than injected: the daemon builds it. */
let warnings: string[];
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];

const lease = createMockLease({ project: 'rover', testName: 'home-screen' });

/** The four components of `lease`'s own run, as the writer names them (`archive-path.ts`). */
const PROJECT = pathSegment(lease.project);
const TEST_NAME = pathSegment(lease.testName);
const LEASE_DIR = leaseDirectoryName(lease);
const SERIAL = pathSegment(lease.serial);
/** The run directory's four components, which every address below is built from. */
const RUN = [PROJECT, TEST_NAME, LEASE_DIR, SERIAL];

/** Bytes and their base64, so a test can compare what came back against what was archived. */
function artifactOf(mediaType: string, bytes: readonly number[]): Artifact {
	const buffer = Buffer.from(Uint8Array.from(bytes));
	return { mediaType, base64: buffer.toString('base64'), byteLength: buffer.byteLength };
}

const CAPTURE = artifactOf('image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RECORDING = artifactOf('video/mp4', [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
/** A media type the writer has no extension for, so it lands as `.bin` (`archive.ts`). */
const UNKNOWN = artifactOf('application/x-rover-unknown', [0x01, 0x02, 0x03, 0x04]);

beforeEach(async () => {
	temp = await createTempSocket();
	store = await createTestUserStore(temp.dir);
	warnings = [];
	vi.spyOn(console, 'warn').mockImplementation((line: string) => warnings.push(line));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	if (temp) {
		// Anything a test made unreadable has to be readable again, or the temp directory cannot
		// be removed and the machine keeps it.
		await chmod(join(temp.artifactsRoot, ...RUN, 'screenshots', '001_screenshot.png'), 0o644).catch(
			() => {},
		);
		await removeTempSocket(temp);
	}
});

/**
 * A backend has to be registered before `startDaemon`, because the daemon builds its inventory on
 * start. Nothing here drives a device — the archive is already on disk — so one idle fake is all
 * this suite needs.
 */
function registerFakeBackend(devices: Device[] = [createMockDevice({ serial: lease.serial })]) {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices(devices);
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
			},
		},
		backend: createMockDeviceBackend({
			watchDevices,
			describeDevice: async (serial) => createMockDevice({ serial }),
		}),
	});
	return watchDevices;
}

/** A daemon on the temp socket, with the HTTP listener up beside it, and its port. */
async function start(): Promise<number> {
	registerFakeBackend();
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		http: { address: '127.0.0.1', port: 0, usersPath: store.path },
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
	if (result.httpPort === null) {
		throw new Error('The daemon opened no HTTP listener');
	}
	return result.httpPort;
}

async function connect(): Promise<IpcClient> {
	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
}

interface Answer {
	readonly status: number;
	readonly headers: IncomingHttpHeaders;
	/** A `Buffer`, not a string: an artifact is bytes, and a `.mp4` decoded as UTF-8 is not it. */
	readonly body: Buffer;
	/** The body as text, for the small JSON refusals and for the `.txt` artifact. */
	readonly text: string;
}

interface Call {
	readonly port: number;
	readonly path: string;
	/** Omitted entirely when absent, so "no credential at all" is reachable. */
	readonly authorization?: string;
	readonly range?: string;
}

/** One `GET`, with the response collected as bytes. */
function get(options: Call): Promise<Answer> {
	return new Promise<Answer>((resolve, reject) => {
		const request = httpRequest(
			{
				host: '127.0.0.1',
				port: options.port,
				path: options.path,
				method: 'GET',
				headers: {
					...(options.authorization === undefined ? {} : { authorization: options.authorization }),
					...(options.range === undefined ? {} : { range: options.range }),
				},
			},
			(response: IncomingMessage) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () => {
					const body = Buffer.concat(chunks);
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body,
						text: body.toString('utf8'),
					});
				});
			},
		);
		request.on('error', reject);
		request.end();
	});
}

/** The URL for one artifact, from the components a listing would have answered with. */
function addressOf(...components: string[]): string {
	return `/artifact/${components.map((component) => encodeURIComponent(component)).join('/')}`;
}

/** One authenticated `GET` of one artifact, against a daemon this helper starts. */
async function fetchArtifact(components: string[], range?: string): Promise<Answer> {
	const port = await start();
	return get({
		port,
		path: addressOf(...components),
		authorization: `Bearer ${store.token}`,
		...(range === undefined ? {} : { range }),
	});
}

/**
 * One result written into the archive by the production writer.
 *
 * The archive is passed in rather than made here, because its per-lease sequence counters live on
 * the instance: two instances would both number their screenshot `001` and the second would
 * overwrite the first.
 */
async function archiveA(
	archive: ArtifactArchive,
	verb: string,
	overrides: Partial<ArchivableResult> = {},
): Promise<void> {
	await archive.record(lease, {
		verb,
		device: createMockDeviceInfo({ serial: lease.serial }),
		target: null,
		after: { kind: 'screen', elements: [] },
		artifact: null,
		...overrides,
	});
}

/** The production writer, over the temp root, with its own warnings kept off the spy. */
function writer(): ArtifactArchive {
	return createArtifactArchive({ root: temp.artifactsRoot, warn: () => {} });
}

/** One archived screenshot under the shared lease — what most tests here need and no more. */
function archiveAScreenshot(artifact: Artifact = CAPTURE): Promise<void> {
	return archiveA(writer(), 'screenshot', { artifact });
}

/** Every artifact the tree can hold, so one start covers the whole content-type table. */
async function archiveEverything(): Promise<void> {
	const archive = writer();
	await archiveA(archive, 'screenshot', { artifact: CAPTURE });
	await archiveA(archive, 'record_video', { artifact: RECORDING });
	await archiveA(archive, 'read_logs', {
		logs: createMockLogRead({ entries: [createMockLogEntry({ message: 'hello' })] }),
	});
	await archiveA(archive, 'screenshot', { artifact: UNKNOWN });
}

describe('the bytes are addressed by the components a listing answered (D19)', () => {
	it('serves the screenshot at the path walked out of list_archive itself', async () => {
		await archiveAScreenshot();
		const port = await start();
		const client = await connect();

		// Walk the tree the way the panel will: each level's answer names the next component, and
		// nothing here composes a host path or knows the archive's shape.
		const components: string[] = [];
		let file: string | undefined;
		for (;;) {
			const level: ListArchiveResult = await client.request('list_archive', {
				path: components,
			});
			if (level.outcome !== 'listed') {
				throw new Error(`The level ${JSON.stringify(components)} was ${level.outcome}`);
			}
			const found: ArchiveEntry | undefined = level.entries.find(
				(entry) => entry.kind === 'file' || entry.kind === 'directory',
			);
			if (found === undefined) {
				throw new Error(`Nothing to descend into at ${JSON.stringify(components)}`);
			}
			components.push(found.name);
			if (found.kind === 'file') {
				file = found.name;
				break;
			}
		}

		const answer = await get({
			port,
			path: addressOf(...components),
			authorization: `Bearer ${store.token}`,
		});

		expect(file).toBeDefined();
		expect(answer.status).toBe(200);
		// The archive's own file, byte for byte — `device_info.json` is the first entry a listing
		// answers at the run level, so that is what this walk lands on.
		expect(answer.body.length).toBeGreaterThan(0);
		expect(Number(answer.headers['content-length'])).toBe(answer.body.length);
	});

	it('serves the exact bytes the archive wrote for a screenshot', async () => {
		await archiveAScreenshot();

		const answer = await fetchArtifact([...RUN, 'screenshots', '001_screenshot.png']);

		expect(answer.status).toBe(200);
		expect(answer.body).toEqual(Buffer.from(CAPTURE.base64, 'base64'));
	});
});

describe('the response says what the file is, so a browser renders it', () => {
	it('gives each of the tree’s kinds its own content type', async () => {
		await archiveEverything();
		const port = await start();
		const fetch = (components: string[]) =>
			get({
				port,
				path: addressOf(...components),
				authorization: `Bearer ${store.token}`,
			});

		const expected: ReadonlyArray<readonly [string[], string]> = [
			[[...RUN, 'screenshots', '001_screenshot.png'], 'image/png'],
			[[...RUN, 'recordings', '001.mp4'], 'video/mp4'],
			[[...RUN, 'logs', '001_read_logs.txt'], 'text/plain; charset=utf-8'],
			[[...RUN, 'device_info.json'], 'application/json'],
			// Nothing recognised these bytes, and that is served honestly rather than refused: a
			// file the listing answered with must not be un-fetchable.
			[[...RUN, 'screenshots', '002_screenshot.bin'], 'application/octet-stream'],
		];

		for (const [components, contentType] of expected) {
			const answer = await fetch(components);
			expect(answer.status).toBe(200);
			expect(answer.headers['content-type']).toBe(contentType);
			expect(Number(answer.headers['content-length'])).toBe(answer.body.length);
			// Same-origin bytes whose names this host did not choose: without `nosniff` a browser
			// may sniff an octet-stream into HTML and run script in the panel's own origin.
			expect(answer.headers['x-content-type-options']).toBe('nosniff');
		}
	});

	it('serves a log file as the text the archive wrote', async () => {
		await archiveA(writer(), 'read_logs', {
			logs: createMockLogRead({ entries: [createMockLogEntry({ message: 'a line' })] }),
		});

		const answer = await fetchArtifact([...RUN, 'logs', '001_read_logs.txt']);

		expect(answer.status).toBe(200);
		expect(answer.text).toContain('a line');
	});

	it('is a view and not a transfer: no download affordance on any answer', async () => {
		await archiveAScreenshot();

		const answer = await fetchArtifact([...RUN, 'screenshots', '001_screenshot.png']);

		// `docs/DESIGN.md` §10 records this as a choice rather than a limitation. A
		// `content-disposition: attachment` here would make every preview a download.
		expect(answer.headers['content-disposition']).toBeUndefined();
		expect(answer.headers['cache-control']).toBe('no-store');
		expect(answer.headers['accept-ranges']).toBe('bytes');
	});
});

describe('missing, unreadable and refused are three answers, and none is an empty 200', () => {
	it('answers 404 for a path nothing is filed at, naming no host path', async () => {
		await archiveAScreenshot();

		const answer = await fetchArtifact([...RUN, 'screenshots', '404_screenshot.png']);

		expect(answer.status).toBe(404);
		expect(JSON.parse(answer.text)).toEqual({ outcome: 'missing' });
		// The rule `ListArchiveResultSchema` enforces by having no field a path fits in (D19).
		expect(answer.text).not.toContain(temp.dir);
	});

	it('answers 404 for a root nothing has ever archived into', async () => {
		const answer = await fetchArtifact([...RUN, 'device_info.json']);

		expect(answer.status).toBe(404);
		expect(JSON.parse(answer.text)).toEqual({ outcome: 'missing' });
	});

	it('answers 500 for a file this host has no permission to read', async () => {
		await archiveAScreenshot();
		const path = join(temp.artifactsRoot, ...RUN, 'screenshots', '001_screenshot.png');
		await chmod(path, 0o000);
		if (await readable(path)) {
			// Running as root: permissions do not apply, so there is nothing here to assert.
			return;
		}

		const answer = await fetchArtifact([...RUN, 'screenshots', '001_screenshot.png']);

		expect(answer.status).toBe(500);
		expect(JSON.parse(answer.text)).toEqual({ outcome: 'unreadable' });
		expect(answer.text).not.toContain(temp.dir);
		// The diagnosis the answer may not carry lives on the host instead (D19).
		expect(warnings.join('\n')).toContain(path);
		expect(warnings.join('\n')).toContain('EACCES');
	});

	it('answers 500 for a directory addressed as a file, never a 200 with no bytes', async () => {
		await archiveAScreenshot();

		const answer = await fetchArtifact([...RUN, 'screenshots']);

		expect(answer.status).toBe(500);
		expect(JSON.parse(answer.text)).toEqual({ outcome: 'unreadable' });
		expect(warnings.join('\n')).toContain('not a regular file');
	});
});

describe('nothing escapes the archive root', () => {
	it('refuses a symlink inside the root that resolves out of it, and serves none of it', async () => {
		await archiveAScreenshot();
		const secret = join(temp.dir, 'outside.png');
		await writeFile(secret, 'SECRET-BYTES-OUTSIDE-THE-ROOT');
		const link = join(temp.artifactsRoot, ...RUN, 'screenshots', 'escape.png');
		await symlink(secret, link);

		const answer = await fetchArtifact([...RUN, 'screenshots', 'escape.png']);

		expect(answer.status).toBe(500);
		expect(JSON.parse(answer.text)).toEqual({ outcome: 'unreadable' });
		expect(answer.text).not.toContain('SECRET-BYTES');
		// Both paths named for the operator, and nowhere else: a link inside the root is
		// something a host process put there, so they have to see where it goes.
		expect(warnings.join('\n')).toContain(link);
		expect(warnings.join('\n')).toContain('outside the archive root');
	});

	it('still serves a symlink that points back inside the root — containment, not a ban', async () => {
		await archiveAScreenshot();
		const directory = join(temp.artifactsRoot, ...RUN, 'screenshots');
		await symlink(join(directory, '001_screenshot.png'), join(directory, 'alias.png'));

		const answer = await fetchArtifact([...RUN, 'screenshots', 'alias.png']);

		expect(answer.status).toBe(200);
		expect(answer.body).toEqual(Buffer.from(CAPTURE.base64, 'base64'));
	});

	it('refuses every address no listing could have answered, and reads nothing', async () => {
		await archiveAScreenshot();
		const port = await start();

		const refused = [
			// `..` and `.`, whether written plainly or percent-encoded.
			'/artifact/..%2F..%2Fetc%2Fpasswd',
			`/artifact/${RUN.join('/')}/../../../../../../etc/passwd`,
			'/artifact/.',
			'/artifact/..',
			// A separator or a NUL smuggled inside one component.
			'/artifact/a%2Fb',
			'/artifact/a%00b',
			// An empty component, a malformed escape, and no component at all.
			'/artifact//screenshots',
			'/artifact/%zz',
			'/artifact/',
			// Nine components — one past `MAX_ARCHIVE_PATH_DEPTH`.
			`/artifact/${['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('/')}`,
		];

		for (const path of refused) {
			const answer = await get({ port, path, authorization: `Bearer ${store.token}` });
			expect(answer.status, path).toBe(400);
			expect(JSON.parse(answer.text)).toEqual({ outcome: 'invalid_path' });
		}
		// Nothing was opened, so nothing was warned about: these never reached the filesystem.
		expect(warnings).toEqual([]);
	});
});

describe('one byte range, and everything else serves the whole file', () => {
	const bytes = Buffer.from(CAPTURE.base64, 'base64');

	it('answers a satisfiable range with 206 and exactly those bytes', async () => {
		await archiveAScreenshot();
		const port = await start();
		const fetch = (range: string) =>
			get({
				port,
				path: addressOf(...RUN, 'screenshots', '001_screenshot.png'),
				authorization: `Bearer ${store.token}`,
				range,
			});

		const cases: ReadonlyArray<readonly [string, number, number]> = [
			['bytes=0-3', 0, 3],
			// Safari's own probe before it will play a `<video>` at all, which is the reason this
			// branch exists rather than a nicety.
			['bytes=0-1', 0, 1],
			['bytes=4-', 4, bytes.length - 1],
			['bytes=-2', bytes.length - 2, bytes.length - 1],
			// Past the end is clamped rather than refused.
			['bytes=2-9999', 2, bytes.length - 1],
		];

		for (const [range, start, end] of cases) {
			const answer = await fetch(range);
			expect(answer.status, range).toBe(206);
			expect(answer.headers['content-range']).toBe(`bytes ${start}-${end}/${bytes.length}`);
			expect(answer.body).toEqual(bytes.subarray(start, end + 1));
			expect(Number(answer.headers['content-length'])).toBe(answer.body.length);
		}
	});

	it('ignores every other range header and serves the whole file with 200', async () => {
		await archiveAScreenshot();
		const port = await start();
		const fetch = (range: string) =>
			get({
				port,
				path: addressOf(...RUN, 'screenshots', '001_screenshot.png'),
				authorization: `Bearer ${store.token}`,
				range,
			});

		// A multi-range, a malformed one, an unsatisfiable one, a unit that is not `bytes`, and a
		// suffix of nothing. RFC 9110 permits ignoring the header, which is what removes `416` and
		// every partial-content edge case from this route.
		for (const range of [
			'bytes=0-9,20-29',
			'bytes=abc',
			`bytes=${bytes.length}-`,
			'items=0-1',
			'bytes=-0',
			'bytes=5-1',
		]) {
			const answer = await fetch(range);
			expect(answer.status, range).toBe(200);
			expect(answer.headers['content-range']).toBeUndefined();
			expect(answer.body).toEqual(bytes);
		}
	});
});

/** Whether this process can still read a file it just made unreadable — it can, when it is root. */
async function readable(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}
