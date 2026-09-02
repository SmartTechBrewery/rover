/**
 * The `list_projects` handler — what is registered under this host's projects root (R39, D31).
 *
 * **This is D31's read side, and there is no write side.** A hook file's `install`, every
 * `services[].start` / `stop` and its `teardown` are programs the host spawns with a `cwd` and an
 * `env` (`./project-hooks.ts`, `./hook-command.ts`), so accepting one over the wire is arbitrary
 * code execution as the daemon's user — and D27 records that, until a role model exists, every
 * named user may perform every panel action. Force-releasing a device ends a lease; writing a
 * hook file owns the host. So D13's *never accepted over the wire* clause is narrowed to the
 * **write** and not repealed: no method here creates, edits, renames or deletes a file, and none
 * takes a path into the projects directory. Registering stays `rover init`'s.
 *
 * **No `env` value and no host path is on any answer, structurally rather than by habit.**
 * `ListProjectsResultSchema` has no field either would fit in — not a program name, not an
 * `args` entry, not a `cwd`, not a `message` — so `install` and `teardown` are answered as
 * booleans and a service as its name alone. `src/ipc/server.ts` parses every handler's return
 * value against that `.strict()` schema, so a path smuggled onto a result would be
 * `invalid_result` on the host (D19). The diagnosis for a file the host cannot read goes where
 * the path already belongs: a warning here, on the host.
 *
 * **A file that will not parse is an entry, not an omission and not a throw.** That is the whole
 * cost this method exists to pay off: `readProjectHooks` throws on a file that is not JSON, does
 * not match the schema, or whose `project` field disagrees with its own name, and `./restore.ts`
 * contains that throw into one warning on stderr — so a project that stopped being torn down is
 * invisible until an operator reads a log they had no reason to open. It is answered as
 * `kind: 'unreadable'`, which is a **different arm** from a project that declares nothing at all
 * (`apps: []`, `services: []`, no `install`, no `teardown`) — the common, correct case the two
 * must never render alike as.
 *
 * **The reader is `./project-hooks.ts`'s, reused rather than reimplemented.** The same
 * `readProjectHooks` answers the restoration (`./project-resolver.ts`), the install
 * (`./project-install.ts`) and the services (`./project-services.ts`), so what this screen says
 * and what the host will actually run at lease end cannot diverge; it inherits the
 * filename-agreement check for free; and it inherits D6 — nothing is cached, so an operator who
 * fixes a hook file sees it fixed on the next request rather than on the next daemon restart.
 *
 * **Empty, missing and unreadable are three answers on purpose**, `list_archive`'s own three: a
 * host where nobody has ever registered a project is the ordinary state, and it must not render
 * like a root the host cannot read (D6, `docs/DESIGN.md` §7).
 *
 * **`list-archive.ts`'s resolved-root containment check has no counterpart to earn here.** There
 * is no caller-supplied path — this method takes no parameter at all, and every name comes out of
 * the root itself — and a symlinked hook file is one `readProjectHooks` would read at lease end
 * anyway, so answering it as registered is exactly what the host would do with that name. For
 * the same reason there is no dirent-type branch: the reader is the truth.
 */

import { readdir } from 'node:fs/promises';
import type { IpcHandlers, ProjectRegistration } from '../ipc/methods.js';
import { ProjectIdentifierSchema, readProjectHooks } from './project-hooks.js';

/** The suffix a hook file's name carries — `./project-hooks.ts`'s `projectHooksPath` builds it. */
const HOOK_FILE_SUFFIX = '.json';

export interface ListProjectsOptions {
	/** The projects root — `./project-hooks.ts`'s `resolveProjectsRoot`, resolved in `./main.ts`. */
	readonly root: string;
	/**
	 * Where a file the host cannot read is reported. Defaults to `console.warn`; injected by
	 * tests. This is the **only** place the reason and the path are said, for the reason the
	 * module header gives.
	 */
	readonly warn?: (message: string) => void;
}

export type ListProjectsHandler = Pick<IpcHandlers, 'list_projects'>;

export function createListProjectsHandler(options: ListProjectsOptions): ListProjectsHandler {
	const warn = options.warn ?? ((message: string) => console.warn(message));

	return {
		async list_projects() {
			let names: string[];
			try {
				names = await readdir(options.root);
			} catch (error) {
				// A root nobody has ever made is the ordinary state of a host, so it is `missing`
				// and it is **not** warned about: there is nothing here for an operator to fix.
				if (codeOf(error) === 'ENOENT') {
					return { outcome: 'missing' as const };
				}
				// `ENOTDIR`, `EACCES`, `EPERM`, `ELOOP`, … — it is there and the host cannot say
				// what is in it. The path and the reason stay on the host.
				warn(unreadableRootWarning(options.root, error));
				return { outcome: 'unreadable' as const };
			}

			// One pass, concurrent, for `list-archive.ts`'s reason: a projects root is tens of
			// files and serialising the reads buys nothing.
			const entries = await Promise.all(
				candidatesIn(names, warn).map((project) => registrationOf(options.root, project, warn)),
			);

			// One fixed order, unconditionally — determinism, not a sort option. Code-unit order
			// rather than `localeCompare`, which is locale-dependent and would make one host answer
			// differently from another (`./list-archive.ts` refuses it for the same reason).
			const projects = entries
				.filter((entry): entry is ProjectRegistration => entry !== null)
				.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
			return { outcome: 'listed' as const, projects };
		},
	};
}

/**
 * The identifiers a hook file could be looked up by, out of one `readdir` of the root.
 *
 * Anything that is not `<name>.json` — a `README.md`, a `.DS_Store`, a subdirectory — is not a
 * registration and is skipped in silence: nothing about it suggests one. A `*.json` whose stem is
 * **not** an identifier is skipped with a warning instead, because nothing will ever look that
 * file up (`projectHooksPath` builds no path from a string that failed the shape) — and it cannot
 * be answered as an entry either, since the answer's `project` is a string a lease may carry.
 */
function candidatesIn(names: readonly string[], warn: (message: string) => void): string[] {
	const projects: string[] = [];
	for (const name of names) {
		if (!name.endsWith(HOOK_FILE_SUFFIX)) {
			continue;
		}
		const project = name.slice(0, -HOOK_FILE_SUFFIX.length);
		if (!ProjectIdentifierSchema.safeParse(project).success) {
			warn(unusableNameWarning(name));
			continue;
		}
		projects.push(project);
	}
	return projects;
}

/**
 * What one candidate registration answers, or `null` for one that is no longer there.
 *
 * A file removed between the `readdir` and the read is the ordinary case rather than an
 * exception — the projects root is written to while it is being read — and a project that is no
 * longer registered is not a broken one, so it is dropped rather than answered as `unreadable`.
 */
async function registrationOf(
	root: string,
	project: string,
	warn: (message: string) => void,
): Promise<ProjectRegistration | null> {
	try {
		const hooks = await readProjectHooks(root, project);
		if (hooks === null) {
			return null;
		}
		return {
			kind: 'registered',
			project,
			apps: hooks.apps,
			hasInstall: hooks.install !== undefined,
			// Names alone, in declaration order — which is the order the host starts them in.
			services: hooks.services.map((service) => service.name),
			hasTeardown: hooks.teardown !== undefined,
		};
	} catch (error) {
		warn(unreadableFileWarning(project, error));
		return { kind: 'unreadable', project };
	}
}

/**
 * What the operator is told, on the host, about a projects root this listing could not read.
 *
 * Names the path and the errno, which is exactly what the answer may not carry: the wire says
 * only *unreadable*, and this is where the diagnosis lives instead (D19). The path goes through
 * `JSON.stringify` for `./list-archive.ts`'s reason — the daemon's stderr is the host's only
 * accountability trail, and a newline in a path would end this line and start a fabricated one.
 */
function unreadableRootWarning(root: string, error: unknown): string {
	return (
		`The project hook directory could not be read at ${JSON.stringify(root)}: ` +
		`${codeOf(error) ?? 'unknown error'}. ` +
		`The listing answered without it — no path or reason leaves this host.`
	);
}

/**
 * What the operator is told about a hook file that will not parse.
 *
 * The reason is `readProjectHooks`'s own thrown message, which names the path and — by that
 * module's documented contract — interpolates nothing out of the file's contents, so a hook
 * file's `env` cannot write itself into the daemon's log. The identifier is stringified for
 * {@link unreadableRootWarning}'s reason, even though the shape already refuses a control
 * character: the rule is the rendering, not a per-call audit of what the shape allows.
 */
function unreadableFileWarning(project: string, error: unknown): string {
	return (
		`The project hook file for ${JSON.stringify(project)} under the projects root will not ` +
		`parse: ${messageOf(error)} It is listed as unreadable rather than omitted — no path or ` +
		`reason leaves this host.`
	);
}

/**
 * What the operator is told about a `*.json` in the root whose stem is not an identifier.
 *
 * Worth a line precisely because nothing else will ever mention it: no lease can name it, so it
 * is a file that looks registered and is not.
 */
function unusableNameWarning(name: string): string {
	return (
		`The projects root holds ${JSON.stringify(name)}, whose name is not a project identifier, ` +
		`so no lease can ever select it. It was left out of the listing — rename it to register it.`
	);
}

/** The message of a failure, for the one place a reason is said. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The errno of a filesystem failure, or `null` for anything that is not one. */
function codeOf(error: unknown): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : null;
}
