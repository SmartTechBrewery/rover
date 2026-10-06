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
import { pathSegment } from '@/daemon/archive-path.js';
import { isMintedGroupId } from '@/daemon/group-id.js';
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

/** The shell line a written hook file's `install` runs — `bash -lc <this>`. */
function installLine(written: Record<string, unknown>): string {
	return ((written.install as { args: string[] } | undefined)?.args[1] ?? '') as string;
}

/** A shared scheme whose Run action launches `product`, built in Debug. */
function xcodeScheme(product: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme version = "1.7">
   <LaunchAction
      buildConfiguration = "Debug">
      <BuildableProductRunnable>
         <BuildableReference
            BuildableName = "${product}">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
</Scheme>
`;
}

/** A workspace naming `projects`, relative to the folder it sits in. */
function xcodeWorkspace(...projects: string[]): string {
	const refs = projects.map((project) => `   <FileRef location = "group:${project}"></FileRef>`);
	return `<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version = "1.0">\n${refs.join('\n')}\n</Workspace>\n`;
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
		// A project with no product flavors has the plain debug variant, and keeps its task.
		expect(installLine(written)).toContain(':app:installDebug');
		const report = logged.join('\n');
		expect(report).toContain('from app/build.gradle.kts');
		expect(report).toContain('from gradlew');
	});

	it('proposes the one variant a single-flavor project has, and names the file it read', async () => {
		const directory = await createProject({
			gradlew: '#!/bin/sh\n',
			'app/build.gradle.kts':
				'android {\n  productFlavors {\n    create("free") { dimension = "tier" }\n  }\n}\n',
		});

		expect(await run(['init', directory])).toBe(EXIT_OK);

		// Not ':app:installDebug': a flavored project does not have that task at all.
		expect(installLine(await readJson(hookFile()))).toContain(':app:installFreeDebug');
		expect(logged.join('\n')).toContain('from app/build.gradle.kts');
	});

	it('registers no install when the flavors give several variants, and lists each one', async () => {
		const directory = await createProject({
			gradlew: '#!/bin/sh\n',
			'app/build.gradle.kts': `android {
  flavorDimensions += listOf("env", "tier")
  productFlavors {
    create("dev") { dimension = "env" }
    create("prod") { dimension = "env" }
    create("free") { dimension = "tier" }
    create("paid") { dimension = "tier" }
  }
}
`,
		});

		expect(await run(['init', directory])).toBe(EXIT_OK);

		// The hook file carries no install at all — picking one for somebody is the guess init
		// exists to avoid, and the four lines come back as flags they can paste instead.
		expect(await readJson(hookFile())).toEqual({ project });
		const report = logged.join('\n');
		for (const variant of ['DevFree', 'DevPaid', 'ProdFree', 'ProdPaid']) {
			expect(report).toContain(`:app:install${variant}Debug`);
		}
		expect(report).toContain("--install '");
		expect(report).not.toContain(':app:installDebug ');
		expect(errored.join('\n')).toContain('--force');
	});

	it('registers no install for flavors it cannot read, and says that is why', async () => {
		const directory = await createProject({
			gradlew: '#!/bin/sh\n',
			'app/build.gradle': `android {
  productFlavors {
    for (tier in tiers) {
      create(tier.name) { dimension "tier" }
    }
  }
}
`,
		});

		expect(await run(['init', directory])).toBe(EXIT_OK);

		expect(await readJson(hookFile())).toEqual({ project });
		expect(logged.join('\n')).toContain('could not read');
		expect(errored.join('\n')).toContain('./gradlew :app:tasks');
	});

	it('registers no install for dimensions whose order is declared outside the build file', async () => {
		const directory = await createProject({
			gradlew: '#!/bin/sh\n',
			'app/build.gradle.kts': `android {
  productFlavors {
    create("free") { dimension = "tier" }
    create("dev") { dimension = "env" }
  }
}
`,
		});

		expect(await run(['init', directory])).toBe(EXIT_OK);

		// Composing in the order the flavors were written would register ':app:installFreeDevDebug',
		// which does not exist — init writes no task name it could not order.
		expect(await readJson(hookFile())).toEqual({ project });
		expect(logged.join('\n')).not.toMatch(/:app:install[A-Z]/);
		expect(errored.join('\n')).toContain('./gradlew :app:tasks');
	});

	it('carries the variants it would not pick between into --json', async () => {
		const directory = await createProject({
			gradlew: '#!/bin/sh\n',
			'app/build.gradle.kts': `android {
  flavorDimensions += listOf("env", "tier")
  productFlavors {
    create("dev") { dimension = "env" }
    create("prod") { dimension = "env" }
    create("free") { dimension = "tier" }
    create("paid") { dimension = "tier" }
  }
}
`,
		});

		expect(await run(['init', directory, '--json'])).toBe(EXIT_OK);

		const document = JSON.parse(logged[0] ?? '') as {
			install: string | null;
			installChoices: { source: string; choices: string[] } | null;
		};
		expect(document.install).toBeNull();
		expect(document.installChoices?.source).toBe('app/build.gradle.kts');
		expect(document.installChoices?.choices).toHaveLength(4);
	});

	it('registers exactly the --install it was given, flavors or no flavors', async () => {
		const directory = await createProject({
			gradlew: '#!/bin/sh\n',
			'app/build.gradle.kts': `android {
  flavorDimensions += listOf("env", "tier")
  productFlavors {
    create("dev") { dimension = "env" }
    create("prod") { dimension = "env" }
    create("free") { dimension = "tier" }
    create("paid") { dimension = "tier" }
  }
}
`,
		});

		expect(
			await run(['init', directory, '--install', './gradlew :app:installDevFreeDebug', '--json']),
		).toBe(EXIT_OK);

		const document = JSON.parse(logged[0] ?? '') as { installChoices: unknown };
		expect(document.installChoices).toBeNull();
		expect(installLine(await readJson(hookFile()))).toBe('./gradlew :app:installDevFreeDebug');
	});

	describe('an Xcode project (#306)', () => {
		it('proposes a build for the leased simulator from the one shared app scheme', async () => {
			const directory = await createProject({
				'App.xcodeproj/project.pbxproj': '',
				'App.xcodeproj/xcshareddata/xcschemes/App.xcscheme': xcodeScheme('App.app'),
			});

			expect(await run(['init', directory])).toBe(EXIT_OK);

			const written = await readJson(hookFile());
			expect(ProjectHooksSchema.parse(written).install).toMatchObject({
				command: 'bash',
				cwd: directory,
			});
			const line = installLine(written);
			expect(line).toContain('xcodebuild -project App.xcodeproj -scheme App ');
			expect(line).toContain('-destination "id=$ROVER_DEVICE_SERIAL"');
			expect(line).toContain('Debug-iphonesimulator/App.app');
			expect(line).not.toContain('booted');
			expect(logged.join('\n')).toContain('from App.xcodeproj/xcshareddata/xcschemes/App.xcscheme');
		});

		it('builds through the workspace that names the project, and skips its dependencies', async () => {
			const directory = await createProject({
				'App.xcworkspace/contents.xcworkspacedata': xcodeWorkspace(
					'App.xcodeproj',
					'Pods/Pods.xcodeproj',
				),
				'App.xcodeproj/xcshareddata/xcschemes/App.xcscheme': xcodeScheme('App.app'),
				'Pods/Pods.xcodeproj/xcshareddata/xcschemes/Kit.xcscheme': xcodeScheme('Kit.framework'),
			});

			expect(await run(['init', directory])).toBe(EXIT_OK);

			const line = installLine(await readJson(hookFile()));
			expect(line).toContain('xcodebuild -workspace App.xcworkspace -scheme App ');
			expect(line).not.toContain('-project');
			expect(line).not.toContain('Kit');
		});

		it('finds a workspace one folder down, and runs from the project root', async () => {
			const directory = await createProject({
				'mobile/Runner.xcworkspace/contents.xcworkspacedata': xcodeWorkspace('Runner.xcodeproj'),
				'mobile/Runner.xcodeproj/xcshareddata/xcschemes/Runner.xcscheme': xcodeScheme('Runner.app'),
			});

			expect(await run(['init', directory])).toBe(EXIT_OK);

			const written = await readJson(hookFile());
			expect(written.install).toMatchObject({ cwd: directory });
			expect(installLine(written)).toContain(
				'-workspace mobile/Runner.xcworkspace -scheme Runner ',
			);
		});

		it('registers no install for several app schemes, and lists each one', async () => {
			const directory = await createProject({
				'App.xcodeproj/xcshareddata/xcschemes/App.xcscheme': xcodeScheme('App.app'),
				'App.xcodeproj/xcshareddata/xcschemes/App Staging.xcscheme': xcodeScheme('App.app'),
			});

			expect(await run(['init', directory])).toBe(EXIT_OK);

			expect(await readJson(hookFile())).toEqual({ project });
			const report = logged.join('\n');
			expect(report).toContain('-scheme App -configuration');
			expect(report).toContain("-scheme '\\''App Staging'\\''");
			expect(report).toContain("--install '");
			expect(errored.join('\n')).toContain('--force');
		});

		it('says so when no scheme is shared, and names the command that lists them', async () => {
			const directory = await createProject({ 'App.xcodeproj/project.pbxproj': '' });

			expect(await run(['init', directory])).toBe(EXIT_OK);

			expect(await readJson(hookFile())).toEqual({ project });
			expect(logged.join('\n')).toContain('shares no scheme');
			expect(errored.join('\n')).toContain('xcodebuild -list');
		});

		it('registers neither install when Gradle and Xcode are both here, and lists both', async () => {
			const directory = await createProject({
				gradlew: '#!/bin/sh\n',
				'app/build.gradle.kts': 'android {\n  applicationId = "com.example.demo"\n}\n',
				'App.xcodeproj/xcshareddata/xcschemes/App.xcscheme': xcodeScheme('App.app'),
			});

			expect(await run(['init', directory])).toBe(EXIT_OK);

			expect((await readJson(hookFile())).install).toBeUndefined();
			const report = logged.join('\n');
			expect(report).toContain(':app:installDebug');
			expect(report).toContain('xcodebuild -project App.xcodeproj');
		});

		it('carries the schemes it would not pick between into --json', async () => {
			const directory = await createProject({
				'App.xcodeproj/xcshareddata/xcschemes/App.xcscheme': xcodeScheme('App.app'),
				'App.xcodeproj/xcshareddata/xcschemes/Demo.xcscheme': xcodeScheme('Demo.app'),
			});

			expect(await run(['init', directory, '--json'])).toBe(EXIT_OK);

			const document = JSON.parse(logged[0] ?? '') as {
				install: string | null;
				installChoices: { source: string; choices: string[] } | null;
			};
			expect(document.install).toBeNull();
			expect(document.installChoices?.source).toBe('App.xcodeproj');
			expect(document.installChoices?.choices).toHaveLength(2);
		});
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
		// And that reason again: one call answers which runs share a group and which of their
		// artifacts share a label, across every project on the host (R41, #178).
		'list_archive_groups',
		// The fourth read of that archive, and the first that answers a number, on `list_archive`'s
		// terms (R49, #259): how much disk
		// the operator's archive takes is the operator's question, and an agent that could ask it
		// could size every other agent's project on the host.
		'measure_archive',
		// And the fifth read, which is that same question over the *grouped* runs of everything, of
		// one project or of one group (R49, #262) — the badge on the operator's own groups view. An
		// agent already knows its own group, having chosen it, and one call here would size every
		// other agent's grouped work on the host.
		'measure_archive_groups',
		// Not MCP tools: neither has a form that carries no bytes (R19 phase 3, #104).
		'push_file',
		'pull_file',
		// Host-operator configuration rather than anything an agent calls: what this host is
		// registered to run around a lease, on the panel's surface alone (R39, D31).
		'list_projects',
		// And removing one (D42, #271) — the registration, its whole archive subtree and its kept
		// entries, because an operator named it. An agent calling that would be destroying somebody
		// else's evidence in one request.
		'delete_project',
		// And removing one archived test at the finer address (D43, #272), for the same reason in
		// the same key: the runs under a test name are what *other* agents' leases wrote, since
		// `test_name` is deliberately not unique (D22).
		'delete_archived_test',
		// And the runs one testing group holds (D43, #277), which is the widest of the three: a
		// group is several agents' runs held together by a caller's own string.
		'delete_archived_group',
		// The operator's `Keep` flag on the host's own archive (D33, #234). Not an agent's to
		// decide at all — one that could untick a test would be clearing the exemption on
		// somebody else's run — and its read would enumerate what every other agent has kept.
		'list_kept_tests',
		'set_kept_tests',
		// And the sweep of that archive (§9.4, #238) — `force_release_device`'s reason with the
		// stakes raised: it deletes an operator's data on a shared host, which is an operator's
		// press and never a step in one agent's work.
		'sweep_archive',
		// What the host machine has installed, and installing it — a question about somebody's
		// laptop rather than about a device, answered in paths on that machine, and the install is
		// an operator's decision with an actor attached (D28). An agent that meets an unbacked
		// capability already gets the sentence it needs: a `missing-capability` failure naming the
		// program, the device and the backend, to relay to a person.
		'list_host_tooling',
		'install_host_tool',
	]);

	const page = roverDocument({
		project: 'demo',
		apps: ['com.example.demo'],
		install: 'bash -lc ./install.sh',
		projectDefaulted: true,
		remote: false,
		invocation: 'rover',
	});

	/** The same page for a project that declares no install — the other arm of `thisProject`. */
	const BARE_PAGE = roverDocument({
		project: 'demo',
		apps: [],
		install: undefined,
		projectDefaulted: false,
		remote: true,
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
	 * **The criterion the whole of #150 turns on**, as #205 amended it: an agent asked to compare a
	 * before and an after arrives at `groupId` and `label` without a human naming them, and this
	 * page is where it reads. So the worked example is asserted to be a worked example — both
	 * calls, the label that repeats between them, and the rule that ties the two fields together —
	 * rather than a mention.
	 *
	 * The `groupId` no longer repeats, and that is the point: the host mints the id it files and
	 * answers with it, so the second call carries **the first grant's id** rather than the name
	 * again. Two identical literals here would teach a group of one plus a second group nobody
	 * asked for.
	 */
	it('teaches the before/after pattern as a worked example, not as a field list', () => {
		// The trigger, in the words the ask actually arrives in.
		expect(page).toContain('before and after');
		// Two `acquire_device` calls sharing one label, differing in their name and their group.
		expect(page.match(/acquire_device \{/g) ?? []).toHaveLength(2);
		expect(page.match(/"label": "home-screen"/g) ?? []).toHaveLength(2);
		// The rule, and the one thing Rover deliberately does not do with the pair (ai/RULES.md §1).
		expect(page).toContain('A `label` needs a `groupId`');
		expect(page).toContain('does not diff');
	});

	/**
	 * The round trip, asserted on the example rather than only on the prose (#205). The first call
	 * sends the name; the page shows the id that came back; the second call sends **that**.
	 */
	it('sends the name once and the answered id after, never the same literal twice', () => {
		const section = page.slice(page.indexOf('## Comparing two runs'), page.indexOf('## The verbs'));
		const groups = [...section.matchAll(/"groupId": "([^"]+)"/g)].map(([, group]) => group);

		expect(groups).toHaveLength(2);
		const [named, answered] = groups as [string, string];
		expect(named).toBe('app-bar-top-space');
		// The second is the first with the host's separator and suffix on it, not a repeat.
		expect(answered).not.toBe(named);
		expect(answered.startsWith(`${named}.`)).toBe(true);
		expect(isMintedGroupId(answered)).toBe(true);
		// And the page says where that string came from, so the shape is not left to be guessed.
		expect(section).toContain(`lease.groupId == "${answered}"`);
		expect(section).toContain('the host');
		expect(section).toContain('mints the id');
		// A minted id survives `pathSegment` verbatim, exactly as the example's names do.
		expect(pathSegment(answered)).toBe(answered);
	});

	/**
	 * #177: the arms of a comparison are told apart by name rather than by timestamp, so the
	 * example is the shape it teaches — one `testName` per lease, each ending in its own letter.
	 */
	it('gives each run in the group its own suffixed testName', () => {
		const names = [...page.matchAll(/"testName": "([^"]+)"/g)].map(([, name]) => name);

		expect(names).toEqual(['app-bar-top-space_variantA', 'app-bar-top-space_variantB']);
		// A name the archive has to rewrite gets a `-<hash>` directory, so the example shows one
		// that survives `pathSegment` verbatim (`src/daemon/archive-path.ts`).
		for (const name of names) {
			expect(pathSegment(name)).toBe(name);
		}
	});

	// The rule has to be readable by an agent on its fourth run, so it is scoped to the section
	// rather than to the page: a mention anywhere else cannot satisfy it.
	it('states the suffix rule past the third letter, with its reason and its exclusion', () => {
		const section = page.slice(page.indexOf('## Comparing two runs'), page.indexOf('## The verbs'));

		expect(section).toContain('_variantA');
		expect(section).toContain('_variantB');
		expect(section).toContain('_variantC');
		expect(section).toContain('_variantD');
		// What it applies to, what it does not, and what it buys.
		expect(section).toContain('no `groupId`');
		expect(section).toContain('directory');
	});

	// `theLoop`'s step 2 is the paragraph an agent reads before its first call, so it names the
	// field and points at the example rather than leaving the two unconnected.
	it('names groupId in the step that describes acquire_device, and the round trip with it', () => {
		const step = page.slice(page.indexOf('2. **`acquire_device`**'), page.indexOf('3. **'));

		expect(step).toContain('groupId');
		expect(step).toContain('_variant');
		expect(step).toContain('Comparing two runs');
		// The host mints and the grant answers, so the step says what to pass next (#205).
		expect(step).toContain('mints the id');
		expect(step).toContain('lease.groupId');
	});

	// The snippet is the other place an agent reads, and it carries the trigger for the same
	// reason it carries the manual-testing one: an agent that never learns these exist does the
	// comparison anyway, and files four unrelated artifacts.
	it('gives the agent-file snippet the comparison trigger beside the manual-test one', () => {
		const snippet = agentSnippet('ROVER.md');

		expect(snippet).toContain('before and after');
		expect(snippet).toContain('`groupId`');
		expect(snippet).toContain('`label`');
		// Not "the same `groupId`" any more — the id the first grant answered with (#205).
		expect(snippet).toContain('first grant answered with');
		expect(snippet).not.toMatch(/same `groupId`/);
	});

	it('says what a project without an install will actually be told', () => {
		expect(BARE_PAGE).toContain('install-hook-undeclared');
		expect(BARE_PAGE).toContain('another machine');
	});

	/**
	 * #312: the incident this page is meant to prevent. An agent that met
	 * `install-hook-undeclared` fell back to the build tool's own install task and installed onto
	 * every device attached to the host, including ones other agents had leased.
	 *
	 * Asserted on **both** pages, because the rule holds whatever the project declares — a project
	 * *with* an install hook is the case where running the build directly looks most like doing
	 * the same thing one step sooner.
	 */
	it("tells an agent never to run a build tool's install task itself", () => {
		for (const text of [page, BARE_PAGE]) {
			expect(text).toContain('Never run a build tool');
			expect(text).toContain('`install_app`');
		}
	});

	// #306: the same bypass on the simulator, where `booted` is whichever one the tool picks.
	it('names the simulator route to that bypass too', () => {
		for (const text of [page, BARE_PAGE]) {
			expect(text).toContain('`xcodebuild`');
			expect(text).toContain('xcrun simctl install booted');
		}
	});

	// The sentence that invited the bypass is gone, and the remedy that replaced it names where a
	// hook comes from rather than leaving the agent to invent one.
	it('points a project with no install at declaring one, not at improvising', () => {
		expect(BARE_PAGE).not.toContain('some other way');
		expect(BARE_PAGE).toContain('init` proposes one');
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
