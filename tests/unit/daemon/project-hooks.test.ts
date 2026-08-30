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
	PROJECTS_PATH_ENV_VAR,
	ProjectHooksSchema,
	projectHooksPath,
	readProjectHooks,
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

		// The row's headline: no default anywhere names an application (D13).
		expect(parsed).toEqual({ project: PROJECT, apps: [] });
		expect(parsed.teardown).toBeUndefined();
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
		// `.strict()`, because the install command and the helper services are later phases of
		// this row. Until they exist, a file carrying one is a typo rather than a file from the
		// future.
		const result = ProjectHooksSchema.safeParse({ project: PROJECT, install: { command: 'x' } });

		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain('install');
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
