/**
 * Opening **one** file out of a directory tree, contained under that tree's root — the discipline,
 * once, for every tree this host serves bytes out of (D19, D24, D29; `PROJECT.md` §10).
 *
 * **This module exists because there is now more than one such tree, and there may only ever be
 * one containment rule.** It was `./archive-file.ts`'s private machinery until the HTTP listener
 * learned to serve `panel/dist` beside the artifact archive (R52, #293); the alternative was a
 * second resolve-and-compare written against a second root, differently bounded, and the second
 * one is always the one that turns out to have been wrong. So the archive's byte route and the
 * panel bundle are two callers of this, differing in their root, their extension table and the
 * noun a warning calls them by — and in nothing that decides whether a path escapes.
 *
 * **Containment is two rules, not one.** The caller's own address schema keeps any *string* from
 * escaping — its enforcement is the caller's, since the caller owns the address's shape and where
 * a refusal has to be worded — and the resolved path is compared against the resolved root before
 * anything is read, because a symlink escapes the root without a single refused character. A link
 * pointing back *inside* the root stays served: this is containment, not a ban on links. Every
 * operation after the resolve uses the resolved path, so there is no second resolution to race.
 *
 * **It opens a file; it does not serve one.** No status code, no header and no HTTP type is named
 * here — `./http-listen.ts` owns the wire and this module owns the disk, which is what keeps the
 * listener free of filesystem and path logic and keeps every caller testable without a socket. The
 * one thing it does decide is the content type, because that is a fact about the *file* — its
 * extension — rather than about the transport, and the table is the caller's so that two trees
 * whose names mean different things cannot be forced onto one vocabulary.
 *
 * **`missing` and `unreadable` are `list_archive`'s own words**, kept here because the archive was
 * this module's first caller and one outcome vocabulary across every read is worth more than a
 * noun per tree. The distinction is the load-bearing one: *nothing is there* versus *something is
 * there and this host will not serve it through this route*. A directory, a socket or a FIFO
 * addressed as a file is therefore `unreadable` and never a `200` with empty bytes — which is
 * also, for the panel bundle, the whole of "no directory listing".
 *
 * **No path and no errno leaves this host.** The result carries neither — there is no field one
 * would fit in — and the diagnosis goes to the host's own log instead (D19). Every path in a
 * warning goes through `JSON.stringify`, because a component may legally carry a `\n` or an ESC
 * and a record another line can be forged into is not a record; `./lease-handlers.ts` renders the
 * D28 audit line the same way for the same reason.
 */

import type { FileHandle } from 'node:fs/promises';
import { open, realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import type { Readable } from 'node:stream';

/** How a warning about this tree names it — the two nouns, and the only thing wording-shaped here. */
export interface ContainedTreeNames {
	/** The subject of a warning's first sentence: `The artifact archive`, `The web panel bundle`. */
	readonly subject: string;
	/** What an escape is said to be outside of: `the archive root`, `the panel bundle root`. */
	readonly root: string;
}

export interface ContainedFileReaderOptions {
	/** The tree's root. Resolved on the first request that finds it, then cached. */
	readonly root: string;
	/**
	 * Extension (lower-cased, with its dot) to content type. **The caller's**, deliberately: the
	 * archive's table is gated against what the panel can draw (`tests/unit/panel/
	 * artifact-bodies.test.ts`), and a bundle's `.js` has no business clearing that gate.
	 */
	readonly contentTypes: Readonly<Record<string, string>>;
	/**
	 * What a file this host cannot name is served as. Defaults to `application/octet-stream` —
	 * the honest "this host does not know what this is", and never a refusal: refusing it would
	 * make a file the tree honestly holds un-fetchable.
	 */
	readonly defaultContentType?: string;
	/** See {@link ContainedTreeNames}. */
	readonly names: ContainedTreeNames;
	/**
	 * Where a file the host will not read is reported. Defaults to `console.warn`; injected by
	 * tests. This is the **only** place the reason and the path are said, for the reason the
	 * module header gives.
	 */
	readonly warn?: (message: string) => void;
}

/** One byte range, both ends inclusive, as an HTTP `Range` names them. */
export interface ContainedByteRange {
	readonly start: number;
	readonly end: number;
}

export interface OpenedContainedFile {
	/** From the `fstat` of the handle actually opened, never from a `stat` of the name. */
	readonly sizeBytes: number;
	/** From the extension. See the module header for why an unknown one is not a refusal. */
	readonly contentType: string;
	/**
	 * `range`'s bytes, or the whole file. Releases the handle when the stream ends, errors or is
	 * destroyed, so a peer that hangs up mid-recording does not leak a descriptor.
	 */
	stream(range?: ContainedByteRange): Readable;
	/** Release the handle without reading it — the path that opened one and then answered. */
	close(): Promise<void>;
}

export type ContainedFileResult =
	| { readonly outcome: 'opened'; readonly file: OpenedContainedFile }
	| { readonly outcome: 'missing' }
	| { readonly outcome: 'unreadable' };

export interface ContainedFileReader {
	/**
	 * One file, addressed by already-validated path components.
	 *
	 * The caller owns the address's shape, because the caller is where an address arrives from a
	 * peer and where a refusal has to be worded. This module still resolves and compares, which is
	 * the half a schema cannot give.
	 */
	open(path: readonly string[]): Promise<ContainedFileResult>;
}

/** What a file this host cannot name is served as. Honest, and never a refusal. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export function createContainedFileReader(
	options: ContainedFileReaderOptions,
): ContainedFileReader {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const fallbackContentType = options.defaultContentType ?? DEFAULT_CONTENT_TYPE;
	const { names } = options;
	// Resolved on the first request that finds it rather than in this constructor, which is
	// synchronous and runs on a host whose archive root does not exist until something is
	// archived; cached on success, so it is one `realpath` per daemon and not one per request.
	// `./list-archive.ts` caches its own for the same reason — deliberately not shared, because
	// sharing it would mean one of those modules owning another's lifecycle.
	let resolvedRoot: string | null = null;

	return {
		async open(path: readonly string[]): Promise<ContainedFileResult> {
			// The caller's schema keeps every component from being `.`, `..` or a separator, so this
			// join cannot escape as a string. A symlink can, which is what `contain` is for.
			const requested = join(options.root, ...path);

			const contained = await contain(options.root, requested, resolvedRoot, names, warn);
			if ('outcome' in contained) {
				return contained;
			}
			// Cached here rather than inside `contain`, which takes it as a value: one `realpath` of
			// the root per daemon, and a failed request does not poison the cache.
			resolvedRoot = contained.resolvedRoot;

			const handle = await openRegularFile(requested, contained.resolved, names, warn);
			if (!('handle' in handle)) {
				return handle;
			}

			return {
				outcome: 'opened',
				file: {
					sizeBytes: handle.sizeBytes,
					// From the **addressed** name rather than the resolved one, so the type is a
					// function of the address a caller was answered with. The two differ only through
					// a symlink, which `list_archive` reports as `other` and so never addresses as a
					// file — and a link named `.png` over an `.mp4` would then be served as the thing
					// nobody asked for.
					contentType:
						options.contentTypes[extname(path[path.length - 1] ?? '').toLowerCase()] ??
						fallbackContentType,
					stream(range?: ContainedByteRange): Readable {
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
	names: ContainedTreeNames,
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
		// The root's own absence is this case too: nothing has ever been archived here, or nothing
		// has ever been built here.
		if (codeOf(error) === 'ENOENT') {
			return { outcome: 'missing' };
		}
		warn(unreadableWarning(names, requested, error));
		return { outcome: 'unreadable' };
	}
	if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
		// A link inside the root pointing out of it. `unreadable` rather than `missing`, because
		// something *is* there — this host will not serve it through this route.
		warn(escapedWarning(names, requested, resolved));
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
 * calls already has write access to the tree as the daemon's own user. `list_archive` has the
 * identical exposure between its own `realpath` and `readdir`, and it is out of the threat model.
 *
 * `requested` is what a warning names rather than `resolved` — that is the path the caller
 * addressed, and on a host whose root is itself a symlink it is the more useful of the two.
 */
async function openRegularFile(
	requested: string,
	resolved: string,
	names: ContainedTreeNames,
	warn: (message: string) => void,
): Promise<
	| { readonly handle: FileHandle; readonly sizeBytes: number }
	| { readonly outcome: 'missing' | 'unreadable' }
> {
	let handle: FileHandle;
	try {
		if (!(await stat(resolved)).isFile()) {
			warn(notAFileWarning(names, requested));
			return { outcome: 'unreadable' };
		}
		handle = await open(resolved, 'r');
	} catch (error) {
		if (codeOf(error) === 'ENOENT') {
			return { outcome: 'missing' };
		}
		warn(unreadableWarning(names, requested, error));
		return { outcome: 'unreadable' };
	}

	try {
		const opened = await handle.stat();
		if (!opened.isFile()) {
			await handle.close();
			warn(notAFileWarning(names, requested));
			return { outcome: 'unreadable' };
		}
		return { handle, sizeBytes: opened.size };
	} catch (error) {
		await handle.close().catch(() => {});
		warn(unreadableWarning(names, requested, error));
		return { outcome: 'unreadable' };
	}
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
function unreadableWarning(names: ContainedTreeNames, path: string, error: unknown): string {
	const code = codeOf(error);
	return (
		`${names.subject} could not be read at ${JSON.stringify(path)}: ` +
		`${code ?? 'unknown error'}. ` +
		`The request was refused — no path or reason leaves this host.`
	);
}

/** The same, for something that is there and is not a regular file — a directory, a FIFO, a socket. */
function notAFileWarning(names: ContainedTreeNames, path: string): string {
	return (
		`${names.subject} was asked for ${JSON.stringify(path)}, which is not a regular file. ` +
		`The request was refused; nothing about it leaves this host.`
	);
}

/**
 * What the operator is told when a request resolved out of the tree's root.
 *
 * Both paths are stringified for the reason {@link unreadableWarning} gives, and the target is
 * named because it is the only useful thing to know here: a link inside the root is something a
 * host process put there, so the operator has to see where it goes to decide whether it is theirs.
 */
function escapedWarning(names: ContainedTreeNames, requested: string, resolved: string): string {
	return (
		`${names.subject} was asked for ${JSON.stringify(requested)}, which resolves to ` +
		`${JSON.stringify(resolved)} — outside ${names.root}. The request was refused; nothing ` +
		`about it leaves this host.`
	);
}

/** The errno of a filesystem failure, or `null` for anything that is not one. */
function codeOf(error: unknown): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : null;
}
