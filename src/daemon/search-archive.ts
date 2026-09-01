/**
 * The `search_archive` handler — one bounded walk of the artifact archive, answering **where** a
 * text appears in it (R38, `PROJECT.md` §10).
 *
 * **This reverses half of D24, at the operator's instruction.** D24 said listing a directory *is*
 * the whole query and that a parameter making it one is how an index gets built by accident. The
 * first clause is overruled: the archive is searchable. The second is not, and is why this module
 * is a **new method beside `./list-archive.ts` rather than a parameter on it** — `list_archive`'s
 * params, result, ordering, handler and CLI command are untouched by this file.
 *
 * **What is *not* reversed is the whole no-index half of D23/D24.** There is no database, no
 * catalogue kept in sync with the files, no cache of a previous walk, no memoised listing and no
 * warm-up on start. Every answer is derived from the filesystem at the instant it is asked for.
 * That is a deliberate cost, and the three bounds below are how it is paid rather than discovered.
 *
 * **Three bounds, and one meaning of `truncated`.** Depth is `MAX_ARCHIVE_PATH_DEPTH` — the same
 * bound `ListArchiveParamsSchema` accepts, so every match this answers is an address the next
 * request may carry. Matches are capped at `MAX_ARCHIVE_SEARCH_MATCHES`, structurally, in the
 * schema. Directories read are capped at {@link MAX_ARCHIVE_SEARCH_DIRECTORIES} here, because
 * that is the one bound that caps disk work when *nothing* matches. And `truncated` means exactly
 * one thing, the same sentence the schema carries: **at least one directory that exists was not
 * fully examined**, so matches may be missing. Any of the three bounds does it, and so does a
 * level the host could not read mid-walk — an unreadable level never fails the search. The two
 * bounds that can be hit with the walk still running behave differently on purpose: the match cap
 * ends it, because no further match could be carried, while the directory bound only stops it
 * **descending** — the names already read are still examined, since dropping them would cost the
 * archive that is large enough to reach the bound its whole answer for no disk saved.
 *
 * **The walk is breadth-first, and that is load-bearing rather than a coding preference.** Shallow
 * components are the ones an operator searches for — a project, a test name, a run whose name
 * carries an owner and a date; machine-named files sit deepest. Breadth-first means the match cap
 * truncates the deepest, least specific hits first. Depth-first would let one run directory of five
 * hundred screenshots fill the answer before the walk ever reached the second project.
 *
 * **Every component is opaque and nothing here parses one** (D22). The candidate is the entire
 * name as `readdir` gave it: nothing splits it on a hyphen, reads a timestamp, an owner or a hash
 * out of it, or decides what a level *is* from what its components say. Matching is
 * case-insensitive, folded with `toLowerCase` and never `toLocaleLowerCase`, for the reason
 * `./list-archive.ts` refuses `localeCompare` — a locale-dependent fold would make one host answer
 * differently from another.
 *
 * **Containment comes free here, and the reason is worth keeping.** This handler takes no
 * caller-supplied path, so there is no `join(root, ...path)` to escape and no counterpart to
 * `./list-archive.ts`'s resolved-root check to earn. The walk descends only into a dirent whose
 * `isDirectory()` is true, and **that is `false` for a symlink under `withFileTypes`** — so no
 * link is followed, the walk cannot leave the root, and a matching link is answered as `other` by
 * name, exactly as `list_archive` answers it one level at a time. A future reader "fixing" that
 * classification with a `stat` would take containment with it.
 *
 * **No host path is on any answer, structurally rather than by habit.** `SearchArchiveResultSchema`
 * has no field a path would fit in — not even a `message` — and `src/ipc/server.ts` parses every
 * handler's return value against that `.strict()` schema, so a path smuggled onto a result is
 * `invalid_result` on the host (D19). A level the host cannot read is therefore warned about
 * *here*, where the path already belongs, with every path through `JSON.stringify` for the reason
 * `./list-archive.ts`'s header gives: a component may legally carry a newline, and the daemon's
 * stderr is the host's only accountability trail.
 *
 * **Reads are sequential.** The directory bound is what caps the cost of a walk, so speculative
 * concurrency here would buy latency on the answers that are already cheap and nothing on the ones
 * that are not; it is left out on purpose rather than by omission.
 */

import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type ArchiveSearchMatch,
	type IpcHandlers,
	MAX_ARCHIVE_PATH_DEPTH,
	MAX_ARCHIVE_SEARCH_MATCHES,
	type SearchArchiveParams,
} from '../ipc/methods.js';

/**
 * How many directories one search may read.
 *
 * The only bound that caps disk work when nothing matches: depth stops a walk going deep and the
 * match cap stops one that is finding things, but a wide archive of empty runs is bounded by
 * neither. Five thousand `readdir`s is well past any archive an operator is searching by hand and
 * still a fraction of a second on a warm cache.
 */
export const MAX_ARCHIVE_SEARCH_DIRECTORIES = 5_000;

export interface SearchArchiveOptions {
	/** The archive root — `./archive-path.ts`'s `resolveArtifactsRoot`, resolved in `./main.ts`. */
	readonly root: string;
	/**
	 * Where a level the host cannot read is reported. Defaults to `console.warn`; injected by
	 * tests. This is the **only** place the reason and the path are said, for the reason the
	 * module header gives.
	 */
	readonly warn?: (message: string) => void;
	/**
	 * The directory bound, overridable so a test can assert the truncation without making five
	 * thousand directories. **A handler option with a default, never a wire parameter**: a
	 * caller-settable bound is the parameter D24 refused.
	 */
	readonly maxDirectories?: number;
}

export type SearchArchiveHandler = Pick<IpcHandlers, 'search_archive'>;

/** One directory whose entries have been read and are waiting to be examined. */
interface QueuedDirectory {
	/** The absolute path on the host — never on an answer. */
	readonly directory: string;
	/** Its address, as the components a `list_archive` walk would have reached it by. */
	readonly path: readonly string[];
	readonly dirents: readonly Dirent[];
}

export function createSearchArchiveHandler(options: SearchArchiveOptions): SearchArchiveHandler {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const maxDirectories = options.maxDirectories ?? MAX_ARCHIVE_SEARCH_DIRECTORIES;

	return {
		async search_archive(params: SearchArchiveParams) {
			let rootDirents: Dirent[];
			try {
				rootDirents = await readdir(options.root, { withFileTypes: true });
			} catch (error) {
				// The root's own absence: nothing has ever been archived on this host.
				if (codeOf(error) === 'ENOENT') {
					return { outcome: 'missing' as const };
				}
				warn(unreadableWarning(options.root, error));
				return { outcome: 'unreadable' as const };
			}

			const walk: Walk = {
				needle: params.text.toLowerCase(),
				maxDirectories,
				warn,
				// A FIFO queue, which is what makes the walk breadth-first — see the module header
				// for why that decides which matches survive the cap.
				queue: [{ directory: options.root, path: [], dirents: sortedByName(rootDirents) }],
				matches: [],
				directoriesRead: 1,
				truncated: false,
				capped: false,
			};

			while (walk.queue.length > 0 && !walk.capped) {
				// `shift()` on a queue of at most a few thousand entries; a ring buffer would be
				// the same answer with more code.
				const level = walk.queue.shift();
				if (level) {
					await examine(walk, level);
				}
			}

			return {
				outcome: 'searched' as const,
				matches: walk.matches,
				truncated: walk.truncated,
			};
		},
	};
}

/**
 * One walk in progress — the queue, what it has found, and the two counters the bounds are read
 * against.
 *
 * Mutable and passed by reference rather than threaded through return values, because every one of
 * these fields is updated from two places (a match and a descent) and the alternative is a tuple
 * nobody can read. It never leaves this module and no part of it reaches an answer.
 */
interface Walk {
	readonly needle: string;
	readonly maxDirectories: number;
	readonly warn: (message: string) => void;
	readonly queue: QueuedDirectory[];
	readonly matches: ArchiveSearchMatch[];
	directoriesRead: number;
	/** At least one directory that exists was not fully examined — the module header's sentence. */
	truncated: boolean;
	/** The match cap is reached and something else matched, so the walk itself is over. */
	capped: boolean;
}

/** Every entry of one level: what matched, and what is worth descending into. */
async function examine(walk: Walk, level: QueuedDirectory): Promise<void> {
	for (const dirent of level.dirents) {
		const kind = kindOf(dirent);
		if (dirent.name.toLowerCase().includes(walk.needle) && !record(walk, level, dirent, kind)) {
			// The cap is reached and something else matched: the answer is short by at least this
			// one, and no further match could be carried, so the walk is over.
			return;
		}
		if (kind === 'directory') {
			await descend(walk, level, dirent);
		}
	}
}

/** One match, or `false` when the cap has no room for it — which ends the walk. */
function record(
	walk: Walk,
	level: QueuedDirectory,
	dirent: Dirent,
	kind: ArchiveSearchMatch['kind'],
): boolean {
	if (walk.matches.length >= MAX_ARCHIVE_SEARCH_MATCHES) {
		walk.truncated = true;
		walk.capped = true;
		return false;
	}
	walk.matches.push({ path: [...level.path, dirent.name], kind });
	return true;
}

/**
 * Read one child directory and queue it, unless a bound says not to — in which case the answer is
 * truncated and the walk goes on.
 *
 * Neither bound here ends the walk. Past the depth bound, a deeper match would not be an
 * addressable path, so there is nothing to be gained by reading it. Past the directory bound, the
 * descent stops but the names already read are still examined: they cost no further disk work, and
 * dropping them would answer nothing at all for the one archive large enough to reach the bound.
 */
async function descend(walk: Walk, level: QueuedDirectory, dirent: Dirent): Promise<void> {
	if (
		level.path.length + 1 >= MAX_ARCHIVE_PATH_DEPTH ||
		walk.directoriesRead >= walk.maxDirectories
	) {
		walk.truncated = true;
		return;
	}

	const child = join(level.directory, dirent.name);
	let dirents: Dirent[];
	try {
		dirents = await readdir(child, { withFileTypes: true });
	} catch (error) {
		// `EACCES`, `EPERM`, `ELOOP`, `EIO`, a run removed between the two reads — never a failed
		// search. The path and the reason stay on the host, and the answer says matches may be
		// missing.
		walk.warn(unreadableWarning(child, error));
		walk.truncated = true;
		return;
	}
	walk.directoriesRead += 1;
	walk.queue.push({
		directory: child,
		path: [...level.path, dirent.name],
		dirents: sortedByName(dirents),
	});
}

/**
 * One level's entries in the one fixed order this archive is read in — ascending by name in
 * code-unit order, unconditionally.
 *
 * The same order `./list-archive.ts` answers with and for the same reasons: determinism rather
 * than a sort option, and code-unit order rather than `localeCompare`, which is locale-dependent
 * and would make one host answer differently from another. Here it also decides *which* matches
 * survive the cap within a level, which is why it is not left to `readdir`'s own order.
 */
function sortedByName(dirents: Dirent[]): Dirent[] {
	return [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * A dirent's kind, in `list_archive`'s exact three words.
 *
 * `readdir`'s dirent type answers this with no `stat` at all, which is also what gives this walk
 * containment: `isDirectory()` is `false` for a symlink, so nothing here descends into one.
 */
function kindOf(dirent: Dirent): ArchiveSearchMatch['kind'] {
	if (dirent.isDirectory()) {
		return 'directory';
	}
	return dirent.isFile() ? 'file' : 'other';
}

/**
 * What the operator is told, on the host, about something this search could not read.
 *
 * Names the path and the errno, which is exactly what the answer may not carry: the wire says
 * only that the answer is truncated, and this is where the diagnosis lives instead (D19).
 *
 * The path goes through `JSON.stringify`, never plain interpolation — it ends in names read off
 * disk, and a newline in one of those would otherwise end this line and start a fabricated one in
 * the daemon's log (`./lease-handlers.ts` renders the force-release audit record the same way).
 *
 * Its own wording rather than `./list-archive.ts`'s, which says "The listing answered without it":
 * that sentence is false of a search, whose answer says instead that it is truncated.
 */
function unreadableWarning(path: string, error: unknown): string {
	const code = codeOf(error);
	return (
		`The artifact archive could not be read at ${JSON.stringify(path)}: ` +
		`${code ?? 'unknown error'}. ` +
		`The search walked past it and answered as truncated — no path or reason leaves this host.`
	);
}

/** The errno of a filesystem failure, or `null` for anything that is not one. */
function codeOf(error: unknown): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : null;
}
