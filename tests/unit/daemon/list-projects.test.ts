/**
 * `list_projects` end to end: a real daemon on a temp socket, real hook files in a real projects
 * root, and a client asking over the real framing.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never `~/.rover/rover.sock`,
 * and every daemon closed through its own handle in `afterEach`. The filesystem is real for
 * `list-archive.test.ts`'s reason: what this method answers is files somebody can list, and a
 * mocked `fs` would prove only that the module called it. Every root is a `mkdtemp` — **no test
 * reads or writes `~/.rover/projects`**, because a hook file names programs the daemon runs and a
 * test that read the developer's own directory would report on them.
 *
 * Real rather than a direct call on the handler, because the `.strict()` result parse in
 * `src/ipc/server.ts` is half of what is asserted here: it is what makes "no host path and no
 * `env` value can be on an answer" structural (D19) rather than a habit of one module.
 *
 * Hook files are written by hand — including text that is not JSON at all — exactly as
 * `project-hooks.test.ts` writes them: the shapes that matter most here are the ones no writer
 * would ever produce.
 */

import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import type { ListProjectsResult, ProjectRegistration } from '@/ipc/methods.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
/** Everything the handler said on the host. Spied rather than injected: the daemon builds it. */
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
	if (temp) {
		// Anything a test made unreadable has to be readable again, or the temp directory cannot
		// be removed and the machine keeps it.
		await chmod(temp.projectsRoot, 0o755).catch(() => {});
		await removeTempSocket(temp);
	}
});

/** The one daemon a test needs, started on the first ask so a test may list more than once. */
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
async function list(): Promise<ListProjectsResult> {
	await start();
	return (await connect()).request('list_projects', {});
}

/** The registrations, or a failed test naming the outcome that was answered instead. */
function projectsOf(result: ListProjectsResult): readonly ProjectRegistration[] {
	if (result.outcome !== 'listed') {
		throw new Error(`The projects root was not listed: ${result.outcome}`);
	}
	return result.projects;
}

/** One file in the projects root, written verbatim — valid JSON or not. */
async function writeRootFile(name: string, contents: string): Promise<void> {
	await mkdir(temp.projectsRoot, { recursive: true });
	await writeFile(join(temp.projectsRoot, name), contents, 'utf8');
}

/** One hook file, as an object the test spells out. */
async function writeHooks(project: string, hooks: Record<string, unknown>): Promise<void> {
	await writeRootFile(`${project}.json`, JSON.stringify(hooks));
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

describe('the three root answers, which must never be one', () => {
	it('says missing for a host where nobody has ever registered a project', async () => {
		// Nothing pre-creates `temp.projectsRoot`, so this is a host on its first day — the
		// ordinary state, and not a failure.
		expect(await list()).toEqual({ outcome: 'missing' });
		// And nothing is warned about, because there is nothing here for an operator to fix.
		expect(warnings).toEqual([]);
	});

	it('says listed with no projects for a root that exists and is empty', async () => {
		await mkdir(temp.projectsRoot, { recursive: true });

		// The load-bearing distinction: an empty root must not read as a root that is not there,
		// nor as one the host cannot see into.
		expect(await list()).toEqual({ outcome: 'listed', projects: [] });
	});

	it('says unreadable when the root is not a directory at all', async () => {
		await writeFile(temp.projectsRoot, 'not a directory');

		expect(await list()).toEqual({ outcome: 'unreadable' });
		expect(warnings.join('\n')).toContain('ENOTDIR');
		expect(warnings.join('\n')).toContain(temp.projectsRoot);
	});

	it('says unreadable when the host has no permission on the root', async () => {
		await mkdir(temp.projectsRoot, { recursive: true });
		await chmod(temp.projectsRoot, 0o000);
		if (await stillReadable(temp.projectsRoot)) {
			// Running as root: permissions do not apply, so there is nothing here to assert.
			return;
		}

		expect(await list()).toEqual({ outcome: 'unreadable' });
	});
});

describe('the completion test — three entries a caller can tell apart', () => {
	it('answers a good file, a disagreeing one and one that is not JSON as three entries', async () => {
		await writeHooks('good', { project: 'good', apps: ['com.example.good'] });
		// A file copied from another project and edited nowhere else — the mismatch
		// `readProjectHooks` refuses.
		await writeHooks('renamed', { project: 'somebody-else' });
		await writeRootFile('broken.json', 'this is not JSON at all');

		expect(await list()).toEqual({
			outcome: 'listed',
			projects: [
				{ kind: 'unreadable', project: 'broken' },
				{
					kind: 'registered',
					project: 'good',
					apps: ['com.example.good'],
					hasInstall: false,
					services: [],
					hasTeardown: false,
				},
				{ kind: 'unreadable', project: 'renamed' },
			],
		});
	});

	it('does not render a project that declares nothing like a broken one', async () => {
		await writeHooks('bare', { project: 'bare' });
		await writeRootFile('broken.json', '{');

		// The pair the per-entry union exists for: declaring nothing is the common, correct case,
		// and it must not be mistakable for a file the host could not read.
		expect(projectsOf(await list())).toEqual([
			{
				kind: 'registered',
				project: 'bare',
				apps: [],
				hasInstall: false,
				services: [],
				hasTeardown: false,
			},
			{ kind: 'unreadable', project: 'broken' },
		]);
	});
});

describe('what a registration declares', () => {
	it('answers the apps, both booleans and the service names in declaration order', async () => {
		await writeHooks('checkout', {
			project: 'checkout',
			apps: ['com.example.checkout', 'com.example.checkout.debug'],
			install: { command: 'make', args: ['install'] },
			services: [
				{ name: 'api', start: { command: 'make', args: ['api'] } },
				{ name: 'mock-payments', start: { command: 'make', args: ['payments'] } },
			],
			teardown: { command: 'make', args: ['teardown'] },
		});

		expect(projectsOf(await list())).toEqual([
			{
				kind: 'registered',
				project: 'checkout',
				apps: ['com.example.checkout', 'com.example.checkout.debug'],
				hasInstall: true,
				// Declaration order — the order the host starts them in, and the reverse of the
				// order it stops them in.
				services: ['api', 'mock-payments'],
				hasTeardown: true,
			},
		]);
	});

	it('puts no env value and no host path on the answer, structurally', async () => {
		await writeHooks('secrets', {
			project: 'secrets',
			install: {
				command: '/opt/tools/build.sh',
				args: ['--token', 'ARGUMENT-MARKER'],
				cwd: '/Users/somebody/code/secrets',
				env: { API_TOKEN: 'ENV-VALUE-MARKER' },
			},
			services: [
				{
					name: 'api',
					start: {
						command: '/opt/tools/api',
						cwd: '/Users/somebody/code/secrets',
						env: { DATABASE_URL: 'ENV-VALUE-MARKER-TWO' },
					},
					stop: { command: '/opt/tools/api', args: ['stop'] },
				},
			],
			teardown: { command: '/opt/tools/teardown.sh', env: { SSH_KEY: 'ENV-VALUE-MARKER-THREE' } },
		});

		const answer = JSON.stringify(await list());

		// The criterion, asserted over the whole frame rather than field by field: there is no
		// field on the schema an `env` value, a program, an argument, a `cwd` or the root itself
		// would fit in — and a `.strict()` result parse in `src/ipc/server.ts` is what makes that
		// structural (D19).
		expect(answer).not.toContain('MARKER');
		expect(answer).not.toContain('API_TOKEN');
		expect(answer).not.toContain(temp.projectsRoot);
		expect(answer).not.toContain('/');
	});
});

describe('a file that will not parse', () => {
	it('answers a schema-invalid file as unreadable rather than omitting it', async () => {
		// The `.strict()` branch: a key the hook schema does not know.
		await writeHooks('typo', { project: 'typo', teardwon: { command: 'make' } });
		// The bound branch: one service more than a project may declare.
		await writeHooks('crowded', {
			project: 'crowded',
			services: Array.from({ length: 9 }, (_, index) => ({
				name: `svc-${index}`,
				start: { command: 'make' },
			})),
		});

		expect(projectsOf(await list())).toEqual([
			{ kind: 'unreadable', project: 'crowded' },
			{ kind: 'unreadable', project: 'typo' },
		]);
	});

	it('keeps the diagnosis on the host and puts none of it on the wire', async () => {
		await writeRootFile('broken.json', 'not JSON');

		const answer = await list();

		expect(projectsOf(answer)).toEqual([{ kind: 'unreadable', project: 'broken' }]);
		// The path and the reason are the operator's, on the host, where a path already belongs.
		const said = warnings.join('\n');
		expect(said).toContain('broken');
		expect(said).toContain('not valid JSON');
		expect(JSON.stringify(answer)).not.toContain(temp.projectsRoot);
	});
});

describe('what the listing does not answer', () => {
	it('skips anything that is not a hook file, in silence', async () => {
		await writeHooks('real', { project: 'real' });
		await writeRootFile('README.md', '# notes for whoever comes next');
		await writeRootFile('.DS_Store', 'junk');
		await mkdir(join(temp.projectsRoot, 'nested'), { recursive: true });

		expect(projectsOf(await list()).map((entry) => entry.project)).toEqual(['real']);
		// Nothing about any of the three suggests a registration, so nothing is said about them.
		expect(warnings).toEqual([]);
	});

	it('warns about a *.json whose name no lease could ever select', async () => {
		await writeHooks('real', { project: 'real' });
		// A leading `-` is refused by the identifier shape, so `projectHooksPath` builds no path
		// from this name and nothing will ever look the file up.
		await writeRootFile('-leading-dash.json', '{"project":"leading-dash"}');

		expect(projectsOf(await list()).map((entry) => entry.project)).toEqual(['real']);
		// It is an operator mistake worth exactly one line, and it cannot be an entry: the
		// answer's `project` is a string a lease may carry, and this one is not.
		expect(warnings.join('\n')).toContain('-leading-dash.json');
		expect(warnings.join('\n')).toContain('not a project identifier');
	});
});

describe('order and freshness', () => {
	it('answers in code-unit order, never a locale-dependent one', async () => {
		await writeHooks('alpha', { project: 'alpha' });
		await writeHooks('Zebra', { project: 'Zebra' });
		await writeHooks('beta', { project: 'beta' });

		// `localeCompare` would put `alpha` first on most locales. Code-unit order puts every
		// capital ahead of every lower-case letter, and it is the same on every host.
		expect(projectsOf(await list()).map((entry) => entry.project)).toEqual([
			'Zebra',
			'alpha',
			'beta',
		]);
	});

	it('caches nothing, so a hook file fixed on disk reads as fixed on the next request', async () => {
		await writeRootFile('checkout.json', 'not JSON yet');

		expect(projectsOf(await list())).toEqual([{ kind: 'unreadable', project: 'checkout' }]);

		await writeHooks('checkout', { project: 'checkout', apps: ['com.example.checkout'] });

		// The same daemon, the same connection (D6): an operator who fixes a hook file sees it
		// fixed on the next request rather than on the next daemon restart.
		expect(projectsOf(await list())).toEqual([
			{
				kind: 'registered',
				project: 'checkout',
				apps: ['com.example.checkout'],
				hasInstall: false,
				services: [],
				hasTeardown: false,
			},
		]);
	});
});
