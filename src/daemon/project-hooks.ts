/**
 * The per-project hook file (D13) — what one project asks the host to do around a lease on it.
 *
 * **It lives on the host, one file per project.** Verbs run where the hardware is (D19), and
 * D19's own reasoning names the project hooks as the thing that must not end up stranded on the
 * far side of the network from the device they exist to serve. So this is host-operator
 * configuration sitting in the host's own `~/.rover`, beside `rover.sock`, `users.json` and
 * `artifacts/` — and it is **never accepted over the wire**: no IPC method reads one, writes one,
 * or takes a path into this directory. A lease carries a `project` *string* and nothing else.
 *
 * **A hook declares a program and its arguments, never a shell line.** The runner spawns with
 * `shell: false` (`./hook-command.ts`), so nothing a hook declares is word-split, glob-expanded,
 * or turned into a second command by a metacharacter somebody forgot. An operator who wants a
 * shell asks for one explicitly, by making it the program.
 *
 * **A file found under the root must have a `project` equal to its own name.** A mismatch is a
 * loud failure naming both, which stops a file copied from another project from quietly serving
 * this one and keeps the field meaningful to everything that later reads it. It is a property
 * of the *lookup* — of {@link readProjectHooks}, which is the only caller that builds the path
 * out of a name — and so it does not apply to a file somebody named outright
 * ({@link readProjectHooksFile}), where there is no second answer for the field to disagree
 * with.
 *
 * **It is re-read at every use and never cached** (D6) — exactly as the user store is re-read at
 * every connection attempt so that a `revoke` needs no restart. Editing a hook file takes effect
 * on the very next lease that ends.
 *
 * **A client may read a hook file too, for one field and nothing else.** Pointed at one by
 * {@link PROJECT_FILE_ENV_VAR}, `rover acquire` and the MCP server take the `project`
 * identifier out of it as the default for the string they would otherwise make somebody retype
 * on every call (D22). That is convenience and nothing more: the wire is unchanged, `apps`,
 * `install` and `teardown` are read by the host alone, and a client never runs anything a file
 * declares.
 *
 * This module reads a file and parses it, and imports nothing that starts a process, so it stays
 * safe to import from anywhere — which is what the paragraph above depends on, and what
 * `tests/unit/no-backend-in-a-client.test.ts` holds; running what it describes is
 * `./hook-command.ts`'s job alone.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AppIdSchema } from '../core/ids.js';
import { describeIssues } from '../ipc/protocol.js';

/** Environment variable naming the directory hook files live in, for a non-default install. */
export const PROJECTS_PATH_ENV_VAR = 'ROVER_PROJECTS_PATH';

/**
 * Environment variable naming **one** hook file, read by a *client* and by nothing else.
 *
 * The only thing in this module that is not host-side, and it changes nothing about the wire:
 * `project` stays a required, opaque attribution string the core never inspects (D22). What it
 * buys is that the string is stated once, in the project's own file, instead of retyped on
 * every `acquire` — so a client pointed at a file may leave `--project` off, and the MCP
 * `acquire_device` tool may leave the argument out. `owner` is never defaulted from this or
 * from anything else (D16, D20): who a lease is for is the caller's to say, always.
 *
 * It names a file rather than a directory because a client has no `project` string to look one
 * up with — that string is what it is trying to find. So there is no search, no walk up from
 * `cwd` and no `.rover/` convention: one explicit path, and a path that names nothing is a
 * mistake rather than a project nobody registered ({@link readProjectHooksFile}).
 */
export const PROJECT_FILE_ENV_VAR = 'ROVER_PROJECT_FILE';

/**
 * The shape of a project identifier, following the reasoning `USER_IDENTIFIER`
 * (`./user-store.ts`) and `APP_ID` (`src/core/ids.ts`) are written with: a shape says what is
 * allowed, a blocklist says what somebody thought of.
 *
 * It is **also a filename**, and that is what makes it the traversal guard. A `project` string
 * that fails this shape resolves to no hooks at all ({@link projectHooksPath} answers `null`),
 * so `../../etc/passwd` never becomes a path — not a sanitised one, not an escaped one, none:
 * no path is ever built from a string that did not match. No leading `-`, so an identifier can
 * never be read as a flag by something it is passed to, and no separator of any platform, no
 * whitespace and no control character can appear in one.
 */
const PROJECT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const ProjectIdentifierSchema = z
	.string()
	.regex(
		PROJECT_IDENTIFIER,
		'a project identifier is 1–64 characters of letters, digits, dot, underscore or -, ' +
			'starting with a letter or a digit (e.g. checkout-web, storefront.v2)',
	);

/**
 * One program the host runs on this project's behalf, declared as data.
 *
 * `args` rather than a command line, for the reason in this module's header. `env` is merged
 * over the daemon's own environment by the runner, which also adds what a hook cannot know for
 * itself — which device, and which project.
 */
export const HookCommandSchema = z
	.object({
		command: z.string().min(1, 'a hook command must name a program'),
		args: z.array(z.string()).default([]),
		/** Where the program runs. The daemon's own working directory when absent. */
		cwd: z.string().min(1, "a hook command's cwd must not be empty").optional(),
		env: z.record(z.string()).default({}),
	})
	.strict();
export type HookCommand = z.infer<typeof HookCommandSchema>;

/**
 * A project's hook file, whole.
 *
 * **No default here names an application** (D13), and none ever may: `apps` defaults to the
 * empty list, `install` and `teardown` to absent, so a host that has never been told about a
 * project does nothing to one and installs nothing for one. `tests/unit/daemon/project-hooks.test.ts` asserts exactly that of the parsed
 * minimal file, because the failure this rules out is a plausible-looking default rather than a
 * missing feature.
 *
 * `.strict()` for the reason every other schema in this tree carries it: the helper services are
 * a later phase of this row, and until they exist a file carrying them is a typo rather than a
 * forward-compatible file. A field and its consumer land together (ai/RULES.md §7).
 */
export const ProjectHooksSchema = z
	.object({
		project: ProjectIdentifierSchema,
		/** Stopped on the device when a lease on this project ends. Empty is a good answer. */
		apps: z.array(AppIdSchema).default([]),
		/**
		 * What installing *this project's* application means on this host — a build, a deploy
		 * script, whatever the project already has (D13).
		 *
		 * **Optional, and absent by default**, which is the same rule `apps` and `teardown`
		 * follow and is load-bearing rather than tidy: a default here would be the core naming
		 * an application, and there is no command this host could guess that is not somebody's
		 * project. A host that has never been told about a project runs nothing for one, and
		 * `install_app` with no bytes says so **by name** rather than doing something plausible
		 * (`src/verbs/errors.ts`, `install-hook-undeclared`).
		 *
		 * It is run by the verb a caller asks for and never at grant time, and — like every
		 * hook here — with `ROVER_DEVICE_SERIAL` set to the leased device, so what it installs
		 * lands where the lease says and never on a neighbour's device.
		 */
		install: HookCommandSchema.optional(),
		/** Run on the host when a lease on this project ends — on release **and** on expiry (D9). */
		teardown: HookCommandSchema.optional(),
	})
	.strict();
export type ProjectHooks = z.infer<typeof ProjectHooksSchema>;

/** `~/.rover/projects` — beside `rover.sock`, `users.json` and `artifacts/`. */
export function defaultProjectsRoot(): string {
	return join(homedir(), '.rover', 'projects');
}

/**
 * Resolve the directory hook files are read from.
 *
 * An empty value counts as unset, exactly as it does for the socket, the user store and the
 * archive root: an exported-but-blank variable is what a shell leaves behind, and reading it as
 * a real setting would start looking for hook files in the current directory.
 */
export function resolveProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[PROJECTS_PATH_ENV_VAR];
	return configured === undefined || configured === '' ? defaultProjectsRoot() : configured;
}

/**
 * The one hook file this client was pointed at, or `undefined` when nobody pointed it at one.
 *
 * An empty value counts as unset, exactly as it does for the projects root, the socket, the
 * user store and the archive: an exported-but-blank variable is what a shell leaves behind,
 * and reading it as a real setting would send a client looking for a file called `''`.
 */
export function resolveProjectFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const configured = env[PROJECT_FILE_ENV_VAR];
	return configured === undefined || configured === '' ? undefined : configured;
}

/**
 * Where this project's hook file would be, or `null` when the string is not an identifier.
 *
 * The `null` is the traversal guard and the whole of it — see {@link PROJECT_IDENTIFIER}. A
 * lease's `project` is an opaque, caller-supplied string the core never parses (D22), so this
 * is a *lookup*, not validation of the wire: a string that is not a hook-file name simply names
 * no hook file.
 */
export function projectHooksPath(root: string, project: string): string | null {
	return ProjectIdentifierSchema.safeParse(project).success ? join(root, `${project}.json`) : null;
}

/**
 * This project's hooks, or `null` when nobody has described it.
 *
 * `null` covers both of the ordinary cases — a `project` string that is not an identifier, and
 * a file that is not there — because a project nobody registered is the normal state of a host
 * rather than a failure (ai/CODING_STANDARDS.md "Error handling"). Everything else **throws**,
 * naming the path and the reason: a hook file that exists and will not parse is an operator's
 * mistake they need to see, and treating it as "no hooks" would silently stop tearing a project
 * down. `./restore.ts` contains that throw into one warning, so a single bad file costs that
 * project's own steps and nothing else.
 *
 * **Nothing from inside the file is interpolated into a message.** The diagnosis is over field
 * names and the schema's own words; a hook file's `env` may hold anything an operator put there,
 * and these messages end up in a daemon warning.
 */
export async function readProjectHooks(
	root: string,
	project: string,
): Promise<ProjectHooks | null> {
	const path = projectHooksPath(root, project);
	if (path === null) {
		return null;
	}
	const hooks = await readHookFileAt(path);
	if (hooks !== null && hooks.project !== project) {
		// A file copied from another project and edited nowhere else. Loud, because the quiet
		// version of this is one project's teardown running against another project's lease.
		// It belongs to the *lookup* rather than to the read: this is the only caller that has
		// a name to disagree with, because it is the only one that built the path from one.
		throw new Error(
			`The project hook file at ${path} declares project '${hooks.project}', but it is ` +
				`the hook file for '${project}'. Rename the file or fix the field so the two agree.`,
		);
	}
	return hooks;
}

/**
 * One **named** hook file, parsed — or a throw naming the path.
 *
 * The difference from {@link readProjectHooks} is the whole reason this exists, and it is the
 * ENOENT case: there, a file that is not there means a project nobody registered, which is the
 * normal state of a host; here, somebody named this file in {@link PROJECT_FILE_ENV_VAR}, so a
 * path pointing at nothing is their mistake and answering "no default" would attribute a lease
 * to nothing at all — the failure D20 and D22 exist to prevent.
 *
 * Nothing about the file's *name* is checked. The agreement between a file's `project` field
 * and its own name is what a lookup under a root needs, and there is no lookup here: the path
 * was given rather than built from a project string.
 */
export async function readProjectHooksFile(path: string): Promise<ProjectHooks> {
	const hooks = await readHookFileAt(path);
	if (hooks === null) {
		throw new Error(
			`There is no project hook file at ${path}, and ${PROJECT_FILE_ENV_VAR} names it. Create ` +
				`the file, point the variable at one that exists, or unset it to go back to naming ` +
				`the project on every call.`,
		);
	}
	return hooks;
}

/** A client's default `project`, and the file it was read out of. */
export interface ConfiguredProject {
	readonly path: string;
	readonly project: string;
}

/**
 * The `project` a client defaults to, or `undefined` when no hook file is configured.
 *
 * The whole of the client side of {@link PROJECT_FILE_ENV_VAR}, in one place so the CLI and
 * the MCP server cannot answer it differently. Unset or empty is `undefined` and today's
 * behaviour; anything else is read, and a file that is missing or will not parse throws.
 *
 * The path travels with the identifier because a caller who never typed a project has to be
 * told where the one on their lease came from.
 */
export async function readConfiguredProject(
	env: NodeJS.ProcessEnv = process.env,
): Promise<ConfiguredProject | undefined> {
	const path = resolveProjectFile(env);
	return path === undefined
		? undefined
		: { path, project: (await readProjectHooksFile(path)).project };
}

/** Read and parse one hook file, `null` for one that is not there. The shared half. */
async function readHookFileAt(path: string): Promise<ProjectHooks | null> {
	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	} catch (error) {
		if (isNotFound(error)) {
			return null;
		}
		throw new Error(`Could not read the project hook file at ${path}: ${describeError(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// The parser's own message quotes the text around the fault, and a hook file's `env` may
		// hold anything an operator put in it. This message ends up in a daemon warning, so it
		// names the file and stops there.
		throw new Error(
			`The project hook file at ${path} is not valid JSON. It has been left untouched — fix ` +
				`it rather than letting a lease end as though the project had no hooks at all.`,
		);
	}

	const result = ProjectHooksSchema.safeParse(parsed);
	if (!result.success) {
		// `describeIssues` reports field paths and the schema's own words, never the values it
		// rejected — which is what keeps the sentence above true of this branch as well.
		throw new Error(
			`The project hook file at ${path} is not a valid hook file: ${describeIssues(result.error)}`,
		);
	}
	return result.data;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code: unknown }).code === 'ENOENT'
	);
}
