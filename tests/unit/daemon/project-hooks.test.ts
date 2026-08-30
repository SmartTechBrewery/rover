/**
 * The per-project hook file (D13, R17) — the schema, and reading one off a disk.
 *
 * Two of these are the row's own acceptance criteria rather than ordinary coverage:
 *
 * - **The core knows no application's name.** The minimal file parses to an empty `apps` list
 *   and no teardown, so a host told nothing about a project does nothing to one. A default that
 *   named an application would be the bug D13 exists to rule out, and this is its executable
 *   form.
 * - **A `project` string that is not an identifier never becomes a path.** That is the whole
 *   traversal guard: not a sanitiser and not an escape, but no path at all
 *   (`src/daemon/project-hooks.ts`).
 *
 * Against real temp directories, because what is being tested is a file reader; nothing here
 * touches `~/.rover/projects`, which on a developer's machine names programs to run.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	defaultProjectsRoot,
	PROJECT_FILE_ENV_VAR,
	PROJECTS_PATH_ENV_VAR,
	ProjectHooksSchema,
	projectHooksPath,
	readConfiguredProject,
	readProjectHooks,
	readProjectHooksFile,
	resolveProjectFile,
	resolveProjectsRoot,
} from '@/daemon/project-hooks.js';

const PROJECT = 'checkout-web';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'rover-projects-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Write `<root>/<name>.json` verbatim — including text that is not JSON at all. */
async function writeHookFile(name: string, contents: string): Promise<void> {
	await writeFile(join(root, `${name}.json`), contents, 'utf8');
}

describe('the schema is the source of truth for a hook file', () => {
	it('needs nothing but the project, and defaults to knowing no application', () => {
		const parsed = ProjectHooksSchema.parse({ project: PROJECT });

		// The row's headline: no default anywhere names an application (D13). An `install` that
		// defaulted to anything would be this host guessing at what a project builds, which is
		// exactly the plausible-looking default the rule rules out.
		expect(parsed).toEqual({ project: PROJECT, apps: [] });
		expect(parsed.install).toBeUndefined();
		expect(parsed.teardown).toBeUndefined();
	});

	it('carries the install command a project declares, in the shape every hook has', () => {
		const parsed = ProjectHooksSchema.parse({
			project: PROJECT,
			install: { command: 'bash', args: ['-lc', 'scripts/rover-install.sh'], cwd: '/srv/checkout' },
		});

		// The same `HookCommand` as the teardown, so there is one way to declare a program on
		// this host — and the same defaults, so a file that says less runs no more.
		expect(parsed.install).toEqual({
			command: 'bash',
			args: ['-lc', 'scripts/rover-install.sh'],
			cwd: '/srv/checkout',
			env: {},
		});
	});

	it('carries the apps a lease drove and a teardown command', () => {
		const parsed = ProjectHooksSchema.parse({
			project: PROJECT,
			apps: ['com.example.checkout', 'com.example.checkout.helper'],
			teardown: { command: 'bash', args: ['-lc', 'scripts/rover-teardown.sh'] },
		});

		expect(parsed.apps).toEqual(['com.example.checkout', 'com.example.checkout.helper']);
		// A hook declares a program and its arguments, never a shell line — and the two fields a
		// file may leave out default to something that does nothing.
		expect(parsed.teardown).toEqual({
			command: 'bash',
			args: ['-lc', 'scripts/rover-teardown.sh'],
			env: {},
		});
	});

	it('rejects a field it does not know, naming it', () => {
		// `.strict()`, because the helper services are a later phase of this row. Until they
		// exist, a file carrying one is a typo rather than a file from the future.
		const result = ProjectHooksSchema.safeParse({ project: PROJECT, services: [{ port: 8080 }] });

		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain('services');
	});

	it('rejects an install command that names no program', () => {
		expect(ProjectHooksSchema.safeParse({ project: PROJECT, install: {} }).success).toBe(false);
		expect(
			ProjectHooksSchema.safeParse({ project: PROJECT, install: { command: '' } }).success,
		).toBe(false);
	});

	it('rejects an app that is not an application identifier', () => {
		expect(ProjectHooksSchema.safeParse({ project: PROJECT, apps: ['checkout'] }).success).toBe(
			false,
		);
	});
});

describe('a project string that is not an identifier names no file', () => {
	it('builds no path from one at all', () => {
		// The traversal guard, stated as what it is: nothing is sanitised, escaped or rewritten,
		// because nothing is built.
		expect(projectHooksPath(root, '../../etc/passwd')).toBeNull();
		expect(projectHooksPath(root, '/etc/passwd')).toBeNull();
		expect(projectHooksPath(root, '..')).toBeNull();
		expect(projectHooksPath(root, '')).toBeNull();
		expect(projectHooksPath(root, '-flag')).toBeNull();
		expect(projectHooksPath(root, 'a\nb')).toBeNull();
	});

	it('resolves to no hooks rather than to a failure', async () => {
		await expect(readProjectHooks(root, '../../etc/passwd')).resolves.toBeNull();
	});

	it('builds the file beside the root for one that is', () => {
		expect(projectHooksPath(root, PROJECT)).toBe(join(root, `${PROJECT}.json`));
	});
});

describe('reading a project’s hooks', () => {
	it('answers null for a project nobody has registered', async () => {
		// The ordinary state of a host, not a failure (ai/CODING_STANDARDS.md "Error handling").
		await expect(readProjectHooks(root, PROJECT)).resolves.toBeNull();
	});

	it('reads what the file declares', async () => {
		await writeHookFile(
			PROJECT,
			JSON.stringify({
				project: PROJECT,
				apps: ['com.example.checkout'],
				teardown: { command: 'true', cwd: '/srv/checkout-web', env: { STAGE: 'local' } },
			}),
		);

		await expect(readProjectHooks(root, PROJECT)).resolves.toEqual({
			project: PROJECT,
			apps: ['com.example.checkout'],
			teardown: { command: 'true', args: [], cwd: '/srv/checkout-web', env: { STAGE: 'local' } },
		});
	});

	it('re-reads the file at every call, so an edit needs no restart', async () => {
		await writeHookFile(PROJECT, JSON.stringify({ project: PROJECT, apps: [] }));
		await expect(readProjectHooks(root, PROJECT)).resolves.toEqual({ project: PROJECT, apps: [] });

		await writeHookFile(
			PROJECT,
			JSON.stringify({ project: PROJECT, apps: ['com.example.checkout'] }),
		);

		// D6: the daemon holds nothing it cannot re-derive, so editing a hook file takes effect
		// on the very next lease that ends.
		await expect(readProjectHooks(root, PROJECT)).resolves.toEqual({
			project: PROJECT,
			apps: ['com.example.checkout'],
		});
	});

	it('refuses a file whose project is not its own name, naming both', async () => {
		await writeHookFile(PROJECT, JSON.stringify({ project: 'storefront' }));

		// A file copied from another project and edited nowhere else. The quiet version of this
		// is one project's teardown running against another project's lease.
		await expect(readProjectHooks(root, PROJECT)).rejects.toThrow(/storefront/);
		await expect(readProjectHooks(root, PROJECT)).rejects.toThrow(new RegExp(PROJECT));
	});

	it('refuses a file that is not JSON, naming the path and quoting nothing from it', async () => {
		await writeHookFile(PROJECT, '{ "project": "checkout-web", "env": "s3cr3t-token" ');

		const failure = await readProjectHooks(root, PROJECT).catch((error: Error) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(join(root, `${PROJECT}.json`));
		// A hook file's `env` may hold anything, and this message ends up in a daemon warning —
		// so the parser's own snippet of the text around the fault is deliberately not repeated.
		expect((failure as Error).message).not.toContain('s3cr3t-token');
	});

	it('refuses a file that does not match the schema, naming the path and the field', async () => {
		await writeHookFile(
			PROJECT,
			JSON.stringify({ project: PROJECT, apps: ['s3cr3t-not-an-app-id'] }),
		);

		const failure = await readProjectHooks(root, PROJECT).catch((error: Error) => error);

		expect((failure as Error).message).toContain(join(root, `${PROJECT}.json`));
		expect((failure as Error).message).toContain('apps');
		expect((failure as Error).message).not.toContain('s3cr3t-not-an-app-id');
	});
});

describe('the one file a client is pointed at', () => {
	it('reads nothing at all when the variable is unset or exported blank', async () => {
		// Today's behaviour, unchanged: no file, no default, `--project` still required. Blank
		// counts as unset as it does everywhere else — it is what a shell leaves behind.
		expect(resolveProjectFile({})).toBeUndefined();
		expect(resolveProjectFile({ [PROJECT_FILE_ENV_VAR]: '' })).toBeUndefined();
		await expect(readConfiguredProject({})).resolves.toBeUndefined();
	});

	it('takes the identifier out of the file the variable names', async () => {
		await writeHookFile(PROJECT, JSON.stringify({ project: PROJECT, apps: [] }));
		const path = join(root, `${PROJECT}.json`);

		expect(resolveProjectFile({ [PROJECT_FILE_ENV_VAR]: path })).toBe(path);
		await expect(readConfiguredProject({ [PROJECT_FILE_ENV_VAR]: path })).resolves.toEqual({
			path,
			project: PROJECT,
		});
	});

	it('fails naming the path when the file is not there, rather than answering no default', async () => {
		const path = join(root, 'nothing-here.json');

		// The difference from a lookup under the root, and the whole reason this reader exists:
		// a project nobody registered is the normal state of a host, but a *named* file that is
		// not there is a mistake — and a client that quietly attributed a lease to nothing is
		// what D20 and D22 exist to prevent.
		await expect(readProjectHooksFile(path)).rejects.toThrow(path);
		await expect(readConfiguredProject({ [PROJECT_FILE_ENV_VAR]: path })).rejects.toThrow(
			PROJECT_FILE_ENV_VAR,
		);
	});

	it('fails naming the path when the file will not parse', async () => {
		await writeHookFile(PROJECT, '{ "project": "checkout-web", "env": "s3cr3t-token" ');
		const path = join(root, `${PROJECT}.json`);

		const failure = await readProjectHooksFile(path).catch((error: Error) => error);

		expect((failure as Error).message).toContain(path);
		expect((failure as Error).message).not.toContain('s3cr3t-token');
	});

	it('does not ask a named file to agree with its own name', async () => {
		// The name check belongs to the lookup, which is the only caller with a second answer
		// for the field to disagree with. Here the path was given outright, so the field is the
		// only answer there is — and a project's file is free to be `.rover-project.json` in
		// the repository it belongs to.
		await writeHookFile('rover-project', JSON.stringify({ project: PROJECT }));
		const path = join(root, 'rover-project.json');

		await expect(readConfiguredProject({ [PROJECT_FILE_ENV_VAR]: path })).resolves.toEqual({
			path,
			project: PROJECT,
		});
	});
});

describe('where hook files live', () => {
	it('defaults to ~/.rover/projects, beside the socket and the user store', () => {
		expect(defaultProjectsRoot()).toBe(join(homedir(), '.rover', 'projects'));
		expect(resolveProjectsRoot({})).toBe(defaultProjectsRoot());
	});

	it('treats an exported-but-blank variable as unset', () => {
		// What a shell leaves behind. Reading it as a real setting would look for hook files in
		// the current directory — as it would for the socket, the user store and the archive.
		expect(resolveProjectsRoot({ [PROJECTS_PATH_ENV_VAR]: '' })).toBe(defaultProjectsRoot());
	});

	it('uses the variable when it names one', () => {
		expect(resolveProjectsRoot({ [PROJECTS_PATH_ENV_VAR]: '/srv/rover/projects' })).toBe(
			'/srv/rover/projects',
		);
	});
});
