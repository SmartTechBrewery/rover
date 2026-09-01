/**
 * Opening **one** file out of the artifact archive, contained under its root (D19, D24, D29;
 * `PROJECT.md` §10).
 *
 * **This is the byte half of the read side `list_archive` opened**, one directory level deeper.
 * `./list-archive.ts` answers *what is filed*; this answers *what is in one of those files*, and
 * it addresses that file by the very components that listing answered — the same
 * `ArchivePathSegmentSchema`, the same root, the same containment rule. There is deliberately no
 * second path vocabulary for the archive, and no caller ever names a host path (D19).
 *
 * **It opens a file; it does not serve one.** No status code, no header, no HTTP type is named
 * here — `./http-listen.ts` owns the wire and this module owns the disk, which is what keeps the
 * listener free of filesystem and path logic and keeps this module testable without a socket. The
 * one thing it does decide is the content type, because that is a fact about the *file* — its
 * extension — rather than about the transport, and the alternative is a second extension table
 * beside `./archive.ts`'s.
 *
 * **`missing` and `unreadable` are `list_archive`'s own words**, so the archive has one outcome
 * vocabulary across both of its reads and a screen renders the pair the same way on either. The
 * distinction is the one that module is built around: *nothing is there* versus *something is
 * there and this host will not serve it through this route*. A directory, a socket or a FIFO
 * addressed as a file is therefore `unreadable` and never a `200` with empty bytes.
 *
 * **No path and no errno leaves this host.** The result carries neither — there is no field one
 * would fit in — and the diagnosis goes to the host's own log instead, exactly as
 * `list_archive` and `ArtifactArchive.record` warn (D19). Every path in a warning goes through
 * `JSON.stringify`, because a component may legally carry a `\n` or an ESC and a record another
 * line can be forged into is not a record; `./lease-handlers.ts` renders the D28 audit line the
 * same way for the same reason.
 *
 * **Containment is two rules, not one**, as it is one level up. The schema keeps any *string*
 * from escaping — its enforcement is the caller's, since the caller owns the address's shape —
 * and the resolved path is compared against the resolved root before anything is read, because a
 * symlink escapes the root without a single refused character. A link pointing back *inside* the
 * root stays served: this is containment, not a ban on links. Every operation after the resolve
 * uses the resolved path, so there is no second resolution to race.
 *
 * **An unrecognised extension is served, not refused.** `application/octet-stream` is the honest
 * "this host does not know what this is"; refusing it would make a file the listing honestly
 * answered with un-fetchable, which is the trap `ArchivePathSegmentSchema`'s backslash rule
 * records from the other side.
 */

import type { FileHandle } from 'node:fs/promises';
import { open, realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import type { Readable } from 'node:stream';

export interface ArchiveFileReaderOptions {
	/** The archive root — `./archive-path.ts`'s `resolveArtifactsRoot`, resolved in `./main.ts`. */
	readonly root: string;
	/**
	 * Where a file the host will not read is reported. Defaults to `console.warn`; injected by
	 * tests. This is the **only** place the reason and the path are said, for the reason the
	 * module header gives.
	 */
	readonly warn?: (message: string) => void;
}

/** One byte range, both ends inclusive, as an HTTP `Range` names them. */
export interface ArchiveByteRange {
	readonly start: number;
	readonly end: number;
}

export interface OpenedArchiveFile {
	/** From the `fstat` of the handle actually opened, never from a `stat` of the name. */
	readonly sizeBytes: number;
	/** From the extension. See the module header for why an unknown one is not a refusal. */
	readonly contentType: string;
	/**
	 * `range`'s bytes, or the whole file. Releases the handle when the stream ends, errors or is
	 * destroyed, so a peer that hangs up mid-recording does not leak a descriptor.
	 */
	stream(range?: ArchiveByteRange): Readable;
	/** Release the handle without reading it — the path that opened one and then answered. */
	close(): Promise<void>;
}

export type ArchiveFileResult =
	| { readonly outcome: 'opened'; readonly file: OpenedArchiveFile }
	| { readonly outcome: 'missing' }
	| { readonly outcome: 'unreadable' };

export interface ArchiveFileReader {
	/**
	 * One file, addressed by the components a listing answered.
	 *
	 * `path` is **already-validated** components: the caller owns the address's shape, because the
	 * caller is where an address arrives from a peer and where a refusal has to be worded. This
	 * module still resolves and compares, which is the half a schema cannot give.
	 */
	open(path: readonly string[]): Promise<ArchiveFileResult>;
}

/**
 * Extension to content type — `PROJECT.md` §10's tree exactly, plus `./archive.ts`'s own `.bin`
 * fallback for bytes nothing recognised.
 *
 * Keyed by extension rather than by media type, which is the opposite direction from
 * `EXTENSIONS` in `./archive.ts`: that one names a file it is about to write from a media type
 * the device gave it, and this one reads a name that already exists. Two small maps rather than
 * one inverted at runtime, because the writer's is not exhaustive over what the tree holds —
 * `.txt` and `.json` are written by other code paths entirely.
 */
const CONTENT_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.mp4': 'video/mp4',
	'.txt': 'text/plain; charset=utf-8',
	'.json': 'application/json',
};

/** What a file this host cannot name is served as. Honest, and never a refusal. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export function createArchiveFileReader(options: ArchiveFileReaderOptions): ArchiveFileReader {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	// Resolved on the first request that finds it rather than in this constructor, which is
	// synchronous and runs on a host whose archive root does not exist until something is
	// archived; cached on success, so it is one `realpath` per daemon and not one per request.
	// `./list-archive.ts` caches its own for the same reason — deliberately not shared, because
	// sharing it would mean one of these two modules owning the other's lifecycle.
	let resolvedRoot: string | null = null;

	return {
		async open(path: readonly string[]): Promise<ArchiveFileResult> {
			// The caller's schema keeps every component from being `.`, `..` or a separator, so this
			// join cannot escape as a string. A symlink can, which is what `contain` is for.
			const requested = join(options.root, ...path);

			const contained = await contain(options.root, requested, resolvedRoot, warn);
			if ('outcome' in contained) {
				return contained;
			}
			// Cached here rather than inside `contain`, which takes it as a value: one `realpath` of
			// the root per daemon, and a failed request does not poison the cache.
			resolvedRoot = contained.resolvedRoot;

			const handle = await openRegularFile(requested, contained.resolved, warn);
			if (!('handle' in handle)) {
				return handle;
			}

			return {
				outcome: 'opened',
				file: {
					sizeBytes: handle.sizeBytes,
					// From the **addressed** name rather than the resolved one, so the type is a
					// function of the address a listing answered with. The two differ only through a
					// symlink, which `list_archive` reports as `other` and so never addresses as a
					// file — and a link named `.png` over an `.mp4` would then be served as the thing
					// nobody asked for.
					contentType: contentTypeOf(path[path.length - 1] ?? ''),
					stream(range?: ArchiveByteRange): Readable {
						// `autoClose` is the default and is spelled out: the handle goes when the
						// stream does, which includes the destroy a peer hanging up mid-recording
						// produces, and this is the only thing that releases it on the served path.
						return handle.handle.createReadStream(
							range === undefined
								? { autoClose: true }
								: { autoClose: true, start: range.start, end: range.end },
						);
					},
					close(): Promise<void> {
						return handle.handle.close();
					},
				},
			};
		},
	};
}

/**
 * `requested` resolved, once it is established to be inside the root — or the outcome that
 * establishes it is not.
 *
 * **This is the half a schema cannot give.** No component can be `.`, `..` or a separator, so the
 * join is under the root as a *string*; a symlink resolves out of it without one of those
 * characters, and every operation after this one uses the resolved path, so there is no second
 * resolution to race.
 */
async function contain(
	root: string,
	requested: string,
	cachedRoot: string | null,
	warn: (message: string) => void,
): Promise<
	| { readonly resolved: string; readonly resolvedRoot: string }
	| { readonly outcome: 'missing' | 'unreadable' }
> {
	let resolvedRoot: string;
	let resolved: string;
	try {
		resolvedRoot = cachedRoot ?? (await realpath(root));
		resolved = await realpath(requested);
	} catch (error) {
		// The root's own absence is this case too: nothing has ever been archived here.
		if (codeOf(error) === 'ENOENT') {
			return { outcome: 'missing' };
		}
		warn(unreadableWarning(requested, error));
		return { outcome: 'unreadable' };
	}
	if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
		// A link inside the root pointing out of it. `unreadable` rather than `missing`, because
		// something *is* there — this host will not serve it through this route.
		warn(escapedWarning(requested, resolved));
		return { outcome: 'unreadable' };
	}
	return { resolved, resolvedRoot };
}

/**
 * An open handle on `resolved` and the size of the inode behind it, or the outcome instead.
 *
 * **`stat` before `open`, deliberately**: opening a FIFO for reading blocks until a writer
 * arrives, so a pipe an operator left in the tree would park the request rather than be refused by
 * it. A directory would not block, but one check covers both.
 *
 * The size comes from the `fstat` of the handle rather than from that `stat`, which named a path:
 * they are the same file on every ordinary host, and a `content-length` that is a byte wrong is a
 * hung response.
 *
 * Residual race, stated rather than left unsaid: something that can swap this path between the two
 * calls already has write access to the archive root as the daemon's own user. `list_archive` has
 * the identical exposure between its own `realpath` and `readdir`, and it is out of the threat
 * model.
 *
 * `requested` is what a warning names rather than `resolved` — that is the path the caller
 * addressed, and on a host whose root is itself a symlink it is the more useful of the two.
 */
async function openRegularFile(
	requested: string,
	resolved: string,
	warn: (message: string) => void,
): Promise<
	| { readonly handle: FileHandle; readonly sizeBytes: number }
	| { readonly outcome: 'missing' | 'unreadable' }
> {
	let handle: FileHandle;
	try {
		if (!(await stat(resolved)).isFile()) {
			warn(notAFileWarning(requested));
			return { outcome: 'unreadable' };
		}
		handle = await open(resolved, 'r');
	} catch (error) {
		if (codeOf(error) === 'ENOENT') {
			return { outcome: 'missing' };
		}
		warn(unreadableWarning(requested, error));
		return { outcome: 'unreadable' };
	}

	try {
		const opened = await handle.stat();
		if (!opened.isFile()) {
			await handle.close();
			warn(notAFileWarning(requested));
			return { outcome: 'unreadable' };
		}
		return { handle, sizeBytes: opened.size };
	} catch (error) {
		await handle.close().catch(() => {});
		warn(unreadableWarning(requested, error));
		return { outcome: 'unreadable' };
	}
}

/**
 * What the browser is told this file is, from its extension and nothing else.
 *
 * Nothing here reads the file's own bytes to guess: sniffing a magic number would be a second
 * source of truth about a tree whose names this host wrote, and it would make the answer depend
 * on how much of the file had arrived.
 */
function contentTypeOf(name: string): string {
	return CONTENT_TYPES[extname(name).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * What the operator is told, on the host, about something this route could not read.
 *
 * Names the path and the errno, which is exactly what the answer may not carry: the wire says
 * only *unreadable*, and this is where the diagnosis lives instead (D19). `list_archive` warns
 * the same way for the same reason.
 *
 * The path goes through `JSON.stringify`, never plain interpolation: it ends in components a
 * caller supplied, and a newline in one of those would otherwise end this line and start a
 * fabricated one in the daemon's log.
 */
function unreadableWarning(path: string, error: unknown): string {
	const code = codeOf(error);
	return (
		`The artifact archive could not be read at ${JSON.stringify(path)}: ` +
		`${code ?? 'unknown error'}. ` +
		`The request was refused — no path or reason leaves this host.`
	);
}

/** The same, for something that is there and is not a regular file — a directory, a FIFO, a socket. */
function notAFileWarning(path: string): string {
	return (
		`The artifact archive was asked for ${JSON.stringify(path)}, which is not a regular file. ` +
		`The request was refused; nothing about it leaves this host.`
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
		`${JSON.stringify(resolved)} — outside the archive root. The request was refused; nothing ` +
		`about it leaves this host.`
	);
}

/** The errno of a filesystem failure, or `null` for anything that is not one. */
function codeOf(error: unknown): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : null;
}
