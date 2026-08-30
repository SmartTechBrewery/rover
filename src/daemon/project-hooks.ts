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
 * **The file's `project` must equal the file's own name.** A mismatch is a loud parse failure
 * naming both, which stops a file copied from another project from quietly serving this one and
 * keeps the field meaningful to everything that later reads it.
 *
 * **It is re-read at every use and never cached** (D6) — exactly as the user store is re-read at
 * every connection attempt so that a `revoke` needs no restart. Editing a hook file takes effect
 * on the very next lease that ends.
 *
 * This module reads a file and parses it, and imports nothing that starts a process, so it stays
 * safe to import from anywhere; running what it describes is `./hook-command.ts`'s job alone.
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
 * empty list and `teardown` to absent, so a host that has never been told about a project does
 * nothing to one. `tests/unit/daemon/project-hooks.test.ts` asserts exactly that of the parsed
 * minimal file, because the failure this rules out is a plausible-looking default rather than a
 * missing feature.
 *
 * `.strict()` for the reason every other schema in this tree carries it: the install command and
 * the helper services are later phases of this row, and until they exist a file carrying them is
 * a typo rather than a forward-compatible file. A field and its consumer land together
 * (ai/RULES.md §7).
 */
export const ProjectHooksSchema = z
	.object({
		project: ProjectIdentifierSchema,
		/** Stopped on the device when a lease on this project ends. Empty is a good answer. */
		apps: z.array(AppIdSchema).default([]),
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
	if (result.data.project !== project) {
		// A file copied from another project and edited nowhere else. Loud, because the quiet
		// version of this is one project's teardown running against another project's lease.
		throw new Error(
			`The project hook file at ${path} declares project '${result.data.project}', but it is ` +
				`the hook file for '${project}'. Rename the file or fix the field so the two agree.`,
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
