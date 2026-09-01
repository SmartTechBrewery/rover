/**
 * The `list_archive` handler — one directory level of the artifact archive (D24,
 * `PROJECT.md` §10).
 *
 * **This is D24's read side, and there is no index.** `./archive.ts` writes the tree and
 * `./archive-path.ts` builds its paths; nothing catalogues it, because listing a directory *is*
 * the whole query the tree is shaped to serve. So this method takes a level and answers that
 * level's entries — no filter, no search, no sort parameter, no recursion, no aggregate across
 * levels. A parameter that made it a query is how an index gets built by accident.
 *
 * **No host path is on any answer, structurally rather than by habit.** `ListArchiveResultSchema`
 * has no field a path would fit in — not even a `message`, which is why a level the host cannot
 * read is warned about *here*, where the path already belongs, instead of being described on the
 * wire. `src/ipc/server.ts` parses every handler's return value against that `.strict()` schema,
 * so a path smuggled onto a result would be `invalid_result` on the host (D19).
 *
 * **Every path in a warning goes through `JSON.stringify`, and that is the daemon's convention
 * for caller text in a log line** — `./lease-handlers.ts` renders the D28 force-release audit
 * record the same way, for the same reason. A component arrives verbatim off the wire and
 * `ArchivePathSegmentSchema` bounds its length and refuses `.`, `..`, a separator and a NUL; it
 * does not refuse `\n`, `\r` or ESC, because those are legal in a filename the host itself
 * answered with. Interpolated raw, one of them appends a fabricated line to the daemon's stderr —
 * which is the host's only accountability trail — or clears an operator's terminal. (The CLI
 * solves the same problem with `escapeControlCharacters` in `src/cli/_shared/output.ts`; that one
 * is a *renderer* for a table whose columns are measured, and the daemon has no such renderer, so
 * the two mechanisms stay where they are rather than one importing across the boundary.)
 *
 * **Containment is checked here, not only in the schema.** The schema keeps any *string* from
 * escaping the root — no component is `.`, `..` or carries a separator, so `join(root, ...path)`
 * stays under `root`. A symlink is the case that argument misses: `readdir` resolves links in its
 * own argument, so a link that a previous listing honestly named as `other` would, on the next
 * request, list whatever is on the far side of it. So the resolved directory is compared against
 * the resolved root before anything is read, and every read goes through the resolved path so
 * there is no second resolution to race.
 *
 * **Every component is opaque and nothing here parses one** (D22). A name is a directory name;
 * this module never splits one, never reads a timestamp or an owner out of one, and never decides
 * what a level *is* from what its components say. The one shape rule it does apply —
 * `onlyChild` — is about a directory holding exactly one entry, whatever that entry is called.
 *
 * **Empty, missing and unreadable are three answers on purpose.** Each renders differently, and
 * the pair that must never render alike is *the archive is empty* versus *the host cannot say
 * what is in the archive* — the same distinction `stale` draws on the device list (D6,
 * `docs/DESIGN.md` §7). A method that flattened them into one empty array would make that screen
 * impossible to build correctly, which is also why `childCount` is `null` rather than `0` for a
 * child directory the host cannot read into.
 */

import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { ArchiveEntry, IpcHandlers, ListArchiveParams } from '../ipc/methods.js';

export interface ListArchiveOptions {
	/** The archive root — `./archive-path.ts`'s `resolveArtifactsRoot`, resolved in `./main.ts`. */
	readonly root: string;
	/**
	 * Where a level the host cannot read is reported. Defaults to `console.warn`; injected by
	 * tests. This is the **only** place the reason and the path are said, for the reason the
	 * module header gives.
	 */
	readonly warn?: (message: string) => void;
}

export type ListArchiveHandler = Pick<IpcHandlers, 'list_archive'>;

export function createListArchiveHandler(options: ListArchiveOptions): ListArchiveHandler {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	// Resolved on the first request that finds it rather than in this constructor, which is
	// synchronous and runs on a host whose archive root does not exist until something is
	// archived; cached on success, so it is one `realpath` per daemon and not one per request.
	let resolvedRoot: string | null = null;

	return {
		async list_archive(params: ListArchiveParams) {
			// The schema keeps every component from being `.`, `..` or a separator, so this join
			// cannot escape as a string. A symlink can, which is what the check below is for.
			const requested = join(options.root, ...params.path);

			let directory: string;
			try {
				resolvedRoot ??= await realpath(options.root);
				directory = await realpath(requested);
			} catch (error) {
				// The root's own absence is this case too: nothing has ever been archived here.
				if (codeOf(error) === 'ENOENT') {
					return { outcome: 'missing' as const };
				}
				warn(unreadableWarning(requested, error));
				return { outcome: 'unreadable' as const };
			}
			if (directory !== resolvedRoot && !directory.startsWith(resolvedRoot + sep)) {
				// A link inside the root pointing out of it. `unreadable` rather than `missing`,
				// because something *is* there — this host will not read it through this method.
				warn(escapedWarning(requested, directory));
				return { outcome: 'unreadable' as const };
			}

			let dirents: Dirent[];
			try {
				dirents = await readdir(directory, { withFileTypes: true });
			} catch (error) {
				// `ENOTDIR`, `EACCES`, `EPERM`, `ELOOP`, `EIO`, … — it is there and the host cannot
				// say what is in it. The path and the reason stay on the host. Named as the request
				// addressed it, not as it resolved: that is the level the operator asked about, and
				// on a host whose root is itself a symlink it is the more useful of the two.
				warn(unreadableWarning(requested, error));
				return { outcome: 'unreadable' as const };
			}

			// One pass, concurrent: a directory of five hundred screenshots is five hundred
			// `stat`s, and serialising them buys nothing.
			const entries = await Promise.all(
				dirents.map(async (dirent): Promise<ArchiveEntry> => {
					const child = join(directory, dirent.name);
					if (dirent.isDirectory()) {
						return { kind: 'directory', name: dirent.name, ...(await childrenOf(child, warn)) };
					}
					if (dirent.isFile()) {
						return { kind: 'file', name: dirent.name, sizeBytes: await sizeOf(child, warn) };
					}
					// A symlink, a socket, a device node. `readdir`'s dirent type answers this with
					// no `stat` at all, so nothing here descends into a link or sizes what it
					// points at. Following one *by name on the next request* is a separate
					// question, and the containment check above is what answers it.
					return { kind: 'other', name: dirent.name };
				}),
			);

			// One fixed order, unconditionally — determinism, not a sort option. Code-unit order
			// rather than `localeCompare`, which is locale-dependent and would make one host answer
			// differently from another; and it is what makes D24's "the two most recent runs under
			// one test_name are the last two in the listing" true through this method, because a
			// lease directory leads with a UTC basic-format timestamp precisely so it sorts
			// chronologically as text (`./archive-path.ts`).
			entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			return { outcome: 'listed' as const, entries };
		},
	};
}

/**
 * How many entries a child directory holds, and the name of the one it holds when it holds
 * exactly one — **one level of descent and no deeper**, which is the budget a listing gets.
 *
 * `null` for both when its contents could not be read: a `0` there would say *empty* about a
 * directory the host cannot see into, which is the distinction this whole module is built around.
 */
async function childrenOf(
	directory: string,
	warn: (message: string) => void,
): Promise<{ childCount: number | null; onlyChild: string | null }> {
	try {
		const names = await readdir(directory);
		return {
			childCount: names.length,
			onlyChild: names.length === 1 ? (names[0] ?? null) : null,
		};
	} catch (error) {
		warn(unreadableWarning(directory, error));
		return { childCount: null, onlyChild: null };
	}
}

/**
 * A file's size from one `stat`, or `null`.
 *
 * A file removed between the `readdir` and the `stat` is the ordinary case here rather than an
 * exception — the archive is written to while it is being read.
 */
async function sizeOf(path: string, warn: (message: string) => void): Promise<number | null> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		warn(unreadableWarning(path, error));
		return null;
	}
}

/**
 * What the operator is told, on the host, about something this listing could not read.
 *
 * Names the path and the errno, which is exactly what the answer may not carry: the wire says
 * only *unreadable*, and this is where the diagnosis lives instead (D19). `ArtifactArchive.record`
 * warns the same way for the same reason.
 *
 * The path goes through `JSON.stringify`, never plain interpolation: it ends in components a
 * caller supplied, and a newline in one of those would otherwise end this line and start a
 * fabricated one in the daemon's log (`./lease-handlers.ts` renders the force-release audit
 * record the same way, and the module header says why).
 */
function unreadableWarning(path: string, error: unknown): string {
	const code = codeOf(error);
	return (
		`The artifact archive could not be read at ${JSON.stringify(path)}: ` +
		`${code ?? 'unknown error'}. ` +
		`The listing answered without it — no path or reason leaves this host.`
	);
}

/**
 * What the operator is told when a request resolved out of the archive root.
 *
 * Both paths are stringified for the reason {@link unreadableWarning} gives, and the target is
 * named because it is the only useful thing to know here: a link inside the root is something a
 * host process put there, so the operator has to see where it goes to decide whether it is theirs.
 */
function escapedWarning(requested: string, resolved: string): string {
	return (
		`The artifact archive was asked for ${JSON.stringify(requested)}, which resolves to ` +
		`${JSON.stringify(resolved)} — outside the archive root. The listing refused it; nothing ` +
		`about it leaves this host.`
	);
}

/** The errno of a filesystem failure, or `null` for anything that is not one. */
function codeOf(error: unknown): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : null;
}
