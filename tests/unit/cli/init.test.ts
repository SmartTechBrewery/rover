/**
 * `rover init` end to end, against real files in a temp directory.
 *
 * Two acceptance criteria shape this suite, and both are negative:
 *
 * - **It asks no host** (the second such command, after `rover users`). Asserted the way
 *   `users.test.ts` asserts it: `ROVER_SOCKET_PATH` points at a temp path nobody serves, and
 *   `afterEach` fails if anything turned up there. A command that reached `connectToHost()`
 *   would have autostarted a real daemon on it.
 * - **It never destroys what it did not write.** A hook file that exists is kept, a `.mcp.json`
 *   holding other servers keeps them, and an unparseable one is left alone — the three ways this
 *   command could cost somebody more than it gives them.
 *
 * `ROVER_PROJECTS_PATH` is stubbed for every case, for the reason the socket is: the developer
 * running this suite has real projects registered under `~/.rover/projects`, and a test that
 * wrote `demo.json` into it would quietly register a project on their host.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invocationFor } from '@/cli/_shared/output.js';
import { EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import {
	agentSnippet,
	DOCUMENT_MARKER,
	roverDocument,
	SNIPPET_BEGIN,
	withSnippet,
} from '@/cli/init/documents.js';
import { MCP_SERVER_KEY } from '@/cli/init/mcp-config.js';
import { ProjectHooksSchema } from '@/daemon/project-hooks.js';
import { IPC_METHODS } from '@/ipc/methods.js';
import { ROVER_MCP_NAME } from '@/mcp/server.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	stopDaemonAt,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

let temp: TempSocket;
let projectsRoot: string;
let project: string;
let logged: string[];
let errored: string[];

/** A project directory named after the test's own project identifier. */
async function createProject(files: Record<string, string> = {}): Promise<string> {
	const directory = join(temp.dir, project);
	for (const [relative, contents] of Object.entries({ '.keep': '', ...files })) {
		const file = join(directory, relative);
		await mkdirFor(file);
		await writeFile(file, contents, 'utf8');
	}
	return directory;
}

async function mkdirFor(file: string): Promise<void> {
	const { mkdir } = await import('node:fs/promises');
	await mkdir(join(file, '..'), { recursive: true });
}

async function read(file: string): Promise<string> {
	return await readFile(file, 'utf8');
}

async function readJson(file: string): Promise<Record<string, unknown>> {
	return JSON.parse(await read(file)) as Record<string, unknown>;
}

function hookFile(): string {
	return join(projectsRoot, `${project}.json`);
}

beforeEach(async () => {
	temp = await createTempSocket();
	projectsRoot = join(temp.dir, 'projects');
	// A fresh identifier per test, so nothing can pass by reading another case's leftovers.
	project = `demo-${Math.random().toString(36).slice(2, 8)}`;
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	vi.stubEnv('ROVER_PROJECTS_PATH', projectsRoot);
	vi.stubEnv('ROVER_HOST_ADDRESS', '');
	logged = [];
	errored = [];
	vi.spyOn(console, 'log').mockImplementation((line: string) => logged.push(line));
	vi.spyOn(console, 'warn').mockImplementation((line: string) => errored.push(line));
	vi.spyOn(console, 'error').mockImplementation((line: string) => errored.push(line));
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	// The negative criterion: nothing may have started a daemon on the temp socket.
	const stray = await connectWithoutStarting(temp.socketPath);
	await stopDaemonAt(temp.socketPath);
	await removeTempSocket(temp);
	expect(stray).toBeNull();
});

describe('rover init', () => {
	it('writes a hook file the daemon would accept, named after its own project', async () => {
		const directory = await createProject();

		expect(await run(['init', directory])).toBe(EXIT_OK);

		const written = await readJson(hookFile());
		expect(written).toEqual({ project });
		// The agreement `readProjectHooks` refuses a lookup over, checked on what init produced.
		expect(ProjectHooksSchema.parse(written).project).toBe(project);
	});

	it('detects the application and the install, and names the file each came from', async () => {
		const directory = await createProject({
			gradlew: '#!/bin/sh\n',
			'app/build.gradle.kts': 'android {\n  applicationId = "com.example.demo"\n}\n',
		});

		expect(await run(['init', directory])).toBe(EXIT_OK);

		const written = await readJson(hookFile());
		expect(written.apps).toEqual(['com.example.demo']);
		expect(written.install).toMatchObject({ command: 'bash', cwd: directory });
		const report = logged.join('\n');
		expect(report).toContain('from app/build.gradle.kts');
		expect(report).toContain('from gradlew');
	});

	it('proposes no install for a project it does not recognise', async () => {
		const directory = await createProject({ 'app/build.gradle.kts': 'android {}\n' });

		expect(await run(['init', directory])).toBe(EXIT_OK);

		expect(await readJson(hookFile())).toEqual({ project });
		expect(logged.join('\n')).toContain('install-hook-undeclared');
	});

	it('keeps a hook file that is already there, and says so, until --force', async () => {
		const directory = await createProject();
		expect(await run(['init', directory])).toBe(EXIT_OK);
		await writeFile(
			hookFile(),
			JSON.stringify({ project, teardown: { command: 'true', args: [] } }, null, 2),
			'utf8',
		);
		logged = [];
		errored = [];

		expect(await run(['init', directory, '--app', 'com.example.demo'])).toBe(EXIT_OK);

		// The teardown somebody added by hand is still there, and the run said it did nothing.
		expect((await readJson(hookFile())).teardown).toBeDefined();
		expect(errored.join('\n')).toContain('left exactly as it is');

		expect(await run(['init', directory, '--app', 'com.example.demo', '--force'])).toBe(EXIT_OK);
		expect(await readJson(hookFile())).toEqual({ project, apps: ['com.example.demo'] });
	});

	it('merges into an existing .mcp.json rather than replacing it', async () => {
		const directory = await createProject({
			'.mcp.json': JSON.stringify(
				{
					mcpServers: {
						other: { command: 'other-server' },
						[MCP_SERVER_KEY]: { command: 'node', args: [], env: { ROVER_LOG_LEVEL: 'debug' } },
					},
				},
				null,
				2,
			),
		});

		expect(await run(['init', directory])).toBe(EXIT_OK);

		const config = (await readJson(join(directory, '.mcp.json'))) as {
			mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
		};
		expect(config.mcpServers.other).toEqual({ command: 'other-server' });
		expect(config.mcpServers[MCP_SERVER_KEY]?.args[0]).toContain('bin/rover-mcp.mjs');
		expect(config.mcpServers[MCP_SERVER_KEY]?.env).toEqual({
			// Theirs survives, ours lands beside it.
			ROVER_LOG_LEVEL: 'debug',
			ROVER_PROJECT_FILE: hookFile(),
		});
	});

	it('writes nothing when the .mcp.json it was given cannot be parsed', async () => {
		const directory = await createProject({ '.mcp.json': '{ not json' });

		// Exit 1, not 2: the caller typed nothing wrong. And the file is untouched.
		expect(await run(['init', directory])).toBe(1);
		expect(await read(join(directory, '.mcp.json'))).toBe('{ not json');
	});

	it('prints the snippet by default and writes nothing into an agent file', async () => {
		const directory = await createProject({ 'AGENTS.md': '# Rules\n' });

		expect(await run(['init', directory])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain(SNIPPET_BEGIN);
		expect(await read(join(directory, 'AGENTS.md'))).toBe('# Rules\n');
		expect(errored.join('\n')).toContain('Nothing was written into an agent file');
	});

	it('inserts the snippet once, however many times it runs', async () => {
		const directory = await createProject({ 'AGENTS.md': '# Rules\n' });

		expect(await run(['init', directory, '--write'])).toBe(EXIT_OK);
		expect(await run(['init', directory, '--write'])).toBe(EXIT_OK);

		const contents = await read(join(directory, 'AGENTS.md'));
		expect(contents.startsWith('# Rules')).toBe(true);
		expect(contents.split(SNIPPET_BEGIN)).toHaveLength(2);
	});

	it('leaves a pointer file alone and names the document the snippet belongs in', async () => {
		const directory = await createProject({
			'CLAUDE.md': 'Before any work here, read `ai/RULES.md` in full.\n',
		});

		expect(await run(['init', directory, '--write'])).toBe(EXIT_OK);

		expect(await read(join(directory, 'CLAUDE.md'))).not.toContain(SNIPPET_BEGIN);
		expect(errored.join('\n')).toContain('The snippet belongs in ai/RULES.md');
		// And no AGENTS.md was invented beside it: the project has an agent file, it is a pointer.
		await expect(read(join(directory, 'AGENTS.md'))).rejects.toThrow();
	});

	it('creates one agent file when the project has none and --write was asked for', async () => {
		const directory = await createProject();

		expect(await run(['init', directory, '--write'])).toBe(EXIT_OK);

		expect(await read(join(directory, 'AGENTS.md'))).toContain(SNIPPET_BEGIN);
	});

	it('refuses a directory whose name cannot be a project identifier', async () => {
		const awkward = await mkdtemp(join(temp.dir, 'not an id '));
		try {
			expect(await run(['init', awkward])).toBe(EXIT_USAGE);
			expect(errored.join('\n')).toContain('--project');
		} finally {
			await rm(awkward, { recursive: true, force: true });
		}
	});

	it('refuses an --app that is not a package name, naming the flag', async () => {
		const directory = await createProject();

		expect(await run(['init', directory, '--app', 'nonsense'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain("--app 'nonsense'");
		await expect(read(hookFile())).rejects.toThrow();
	});

	it('writes one JSON document on stdout under --json', async () => {
		const directory = await createProject();

		expect(await run(['init', directory, '--json'])).toBe(EXIT_OK);

		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0] ?? '')).toMatchObject({
			project,
			directory,
			hookFile: { path: hookFile(), outcome: 'created' },
		});
	});
});

describe('where the page goes', () => {
	it('rewrites the page where a human moved it, rather than making a second one', async () => {
		const directory = await createProject();
		expect(await run(['init', directory])).toBe(EXIT_OK);
		const moved = join(directory, 'docs', 'testing', 'ROVER.md');
		await mkdirFor(moved);
		await writeFile(moved, await read(join(directory, 'ROVER.md')), 'utf8');
		await rm(join(directory, 'ROVER.md'));
		logged = [];

		expect(await run(['init', directory, '--write'])).toBe(EXIT_OK);

		expect(await read(moved)).toContain(DOCUMENT_MARKER);
		await expect(read(join(directory, 'ROVER.md'))).rejects.toThrow();
		// And the snippet points an agent at where the page actually is.
		expect(await read(join(directory, 'AGENTS.md'))).toContain('`docs/testing/ROVER.md`');
	});

	it('finds the page under a name it was never given', async () => {
		const directory = await createProject();
		expect(await run(['init', directory])).toBe(EXIT_OK);
		const renamed = join(directory, 'ai', 'device-testing.md');
		await mkdirFor(renamed);
		await writeFile(renamed, await read(join(directory, 'ROVER.md')), 'utf8');
		await rm(join(directory, 'ROVER.md'));
		logged = [];

		expect(await run(['init', directory])).toBe(EXIT_OK);

		expect(await read(renamed)).toContain(DOCUMENT_MARKER);
		expect(logged.join('\n')).toContain('found where you moved it');
	});

	it('writes nothing when two of its own pages are in one project', async () => {
		const directory = await createProject();
		expect(await run(['init', directory])).toBe(EXIT_OK);
		const second = join(directory, 'docs', 'ROVER.md');
		await mkdirFor(second);
		await writeFile(second, await read(join(directory, 'ROVER.md')), 'utf8');
		await rm(hookFile());
		errored = [];

		expect(await run(['init', directory])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--document');
		// Nothing was written: the refusal happens before the first write, not after two.
		await expect(read(hookFile())).rejects.toThrow();
	});

	it('never overwrites a ROVER.md this command did not write', async () => {
		const directory = await createProject({ 'ROVER.md': '# My own notes\n' });

		expect(await run(['init', directory])).toBe(EXIT_USAGE);

		expect(await read(join(directory, 'ROVER.md'))).toBe('# My own notes\n');
		expect(errored.join('\n')).toContain('was not written by this command');
	});

	it('puts the page where --document says, creating the directory for it', async () => {
		const directory = await createProject();

		expect(await run(['init', directory, '--document', 'docs/rover/guide.md', '--write'])).toBe(
			EXIT_OK,
		);

		expect(await read(join(directory, 'docs', 'rover', 'guide.md'))).toContain(DOCUMENT_MARKER);
		expect(await read(join(directory, 'AGENTS.md'))).toContain('`docs/rover/guide.md`');
	});

	it('refuses a --document outside the project', async () => {
		const directory = await createProject();

		expect(await run(['init', directory, '--document', '../elsewhere.md'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('outside');
	});

	it('does not go looking inside node_modules', async () => {
		const directory = await createProject();
		expect(await run(['init', directory])).toBe(EXIT_OK);
		const vendored = join(directory, 'node_modules', 'somebody-else', 'ROVER.md');
		await mkdirFor(vendored);
		await writeFile(vendored, await read(join(directory, 'ROVER.md')), 'utf8');
		logged = [];

		// Two pages exist, one of them vendored — and the run is not ambiguous, because the
		// walk never descends there.
		expect(await run(['init', directory])).toBe(EXIT_OK);
		expect(logged.join('\n')).toContain(join(directory, 'ROVER.md'));
	});
});

describe('the generated ROVER.md', () => {
	/**
	 * The drift gate, and the reason this document is generated at all: a verb that lands with
	 * no line in the page is a red test here rather than a silent gap in somebody else's
	 * repository (`src/cli/init/documents.ts`).
	 */
	const NOT_AN_AGENT_S = new Set([
		// Operator surface: keyed on the serial precisely because the lease id belongs to its
		// holder, so this is never an agent's next move on its own lease (D20, D28).
		'force_release_device',
		// Deliberately not an MCP tool: it would hand every agent a listing of every other
		// agent's runs on the host (R36).
		'list_archive',
		// The same reason with more force: one call, and an agent has every other agent's run
		// names rather than having to walk to them a level at a time (R38).
		'search_archive',
		// Not MCP tools: neither has a form that carries no bytes (R19 phase 3, #104).
		'push_file',
		'pull_file',
		// Host-operator configuration rather than anything an agent calls: what this host is
		// registered to run around a lease, on the panel's surface alone (R39, D31).
		'list_projects',
	]);

	const page = roverDocument({
		project: 'demo',
		apps: ['com.example.demo'],
		install: 'bash -lc ./install.sh',
		projectDefaulted: true,
		remote: false,
		invocation: 'rover',
	});

	it('names every verb an agent can call', () => {
		const missing = Object.keys(IPC_METHODS).filter(
			(method) => !NOT_AN_AGENT_S.has(method) && !page.includes(`\`${method}\``),
		);
		expect(missing).toEqual([]);
	});

	it('excludes only rows that really exist, so the list cannot rot', () => {
		for (const method of NOT_AN_AGENT_S) {
			expect(Object.keys(IPC_METHODS)).toContain(method);
		}
	});

	it('calls the MCP server what the server calls itself', () => {
		expect(MCP_SERVER_KEY).toBe(ROVER_MCP_NAME);
		expect(agentSnippet('ROVER.md')).toContain(`\`${ROVER_MCP_NAME}\` MCP server`);
	});

	/**
	 * **The criterion the whole of #150 turns on**: an agent asked to compare a before and an after
	 * arrives at `groupId` and `label` without a human naming them, and this page is where it
	 * reads. So the worked example is asserted to be a worked example — both calls, the string that
	 * repeats between them, and the rule that ties the two fields together — rather than a mention.
	 */
	it('teaches the before/after pattern as a worked example, not as a field list', () => {
		// The trigger, in the words the ask actually arrives in.
		expect(page).toContain('before and after');
		// Two `acquire_device` calls sharing one group, and a `screenshot` in each sharing a label.
		expect(page.match(/acquire_device \{/g) ?? []).toHaveLength(2);
		expect(page.match(/"groupId": "app-bar-top-space"/g) ?? []).toHaveLength(2);
		expect(page.match(/"label": "home-screen"/g) ?? []).toHaveLength(2);
		// The rule, and the one thing Rover deliberately does not do with the pair (ai/RULES.md §1).
		expect(page).toContain('A `label` needs a `groupId`');
		expect(page).toContain('does not diff');
	});

	// `theLoop`'s step 2 is the paragraph an agent reads before its first call, so it names the
	// field and points at the example rather than leaving the two unconnected.
	it('names groupId in the step that describes acquire_device', () => {
		const step = page.slice(page.indexOf('2. **`acquire_device`**'), page.indexOf('3. **'));

		expect(step).toContain('groupId');
		expect(step).toContain('Comparing two runs');
	});

	// The snippet is the other place an agent reads, and it carries the trigger for the same
	// reason it carries the manual-testing one: an agent that never learns these exist does the
	// comparison anyway, and files four unrelated artifacts.
	it('gives the agent-file snippet the comparison trigger beside the manual-test one', () => {
		const snippet = agentSnippet('ROVER.md');

		expect(snippet).toContain('before and after');
		expect(snippet).toContain('`groupId`');
		expect(snippet).toContain('`label`');
	});

	it('says what a project without an install will actually be told', () => {
		const bare = roverDocument({
			project: 'demo',
			apps: [],
			install: undefined,
			projectDefaulted: false,
			remote: true,
			invocation: 'rover',
		});
		expect(bare).toContain('install-hook-undeclared');
		expect(bare).toContain('another machine');
	});
});

describe('the snippet', () => {
	it('replaces itself in place rather than stacking up', () => {
		const first = withSnippet('# Rules\n', agentSnippet('ROVER.md'));
		const second = withSnippet(first, agentSnippet('ROVER.md'));
		expect(second).toBe(first);
	});

	it('keeps what was written after it', () => {
		const with_ = withSnippet(
			`# Rules\n\n${agentSnippet('ROVER.md')}\n\n## Afterwards\n`,
			agentSnippet('ROVER.md'),
		);
		expect(with_).toContain('## Afterwards');
		expect(with_.split(SNIPPET_BEGIN)).toHaveLength(2);
	});
});

describe('how `rover` is typed', () => {
	it('is the bare command when the process came through the launcher', () => {
		expect(invocationFor('/usr/local/bin/rover')).toBe('rover');
		expect(invocationFor('/somewhere/rover/bin/rover.mjs')).toBe('rover');
	});

	it('is the npm form everywhere else', () => {
		expect(invocationFor('/somewhere/rover/src/cli/index.ts')).toBe('npm run rover --');
		expect(invocationFor(undefined)).toBe('npm run rover --');
	});
});
