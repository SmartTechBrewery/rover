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
 * **The containment and the open now live in `./contained-file.ts`, and this module is what points
 * them at the archive.** That paragraph is edited in place rather than deleted (`ai/RULES.md` §1):
 * it read *containment is two rules, not one* and spelled both out here, because for a while this
 * was the only tree the host served bytes out of. R52 (#293) made `panel/dist` a second one, and
 * the rule that a second tree must not get a second, differently-bounded copy of the resolve-and-
 * compare is exactly the rule this module was enforcing internally — so it was lifted rather than
 * copied. Both rules still hold and neither changed: the schema keeps any *string* from escaping,
 * and the resolved path is compared against the resolved root before anything is read, because a
 * symlink escapes the root without a single refused character. What stayed here is everything that
 * is about *the archive* — its root, its extension table, and the words its warnings use.
 *
 * **It opens a file; it does not serve one.** No status code, no header, no HTTP type is named
 * here — `./http-listen.ts` owns the wire and `./contained-file.ts` owns the disk, which is what
 * keeps the listener free of filesystem and path logic and keeps this module testable without a
 * socket. The one thing this layer decides is the content type, because that is a fact about the
 * *file* — its extension — rather than about the transport, and the alternative is a second
 * extension table beside `./archive.ts`'s.
 *
 * **`missing` and `unreadable` are `list_archive`'s own words**, so the archive has one outcome
 * vocabulary across both of its reads and a screen renders the pair the same way on either. The
 * distinction is the one that module is built around: *nothing is there* versus *something is
 * there and this host will not serve it through this route*. A directory, a socket or a FIFO
 * addressed as a file is therefore `unreadable` and never a `200` with empty bytes.
 *
 * **No path and no errno leaves this host.** The result carries neither — there is no field one
 * would fit in — and the diagnosis goes to the host's own log instead, exactly as
 * `list_archive` and `ArtifactArchive.record` warn (D19).
 *
 * **An unrecognised extension is served, not refused.** `application/octet-stream` is the honest
 * "this host does not know what this is"; refusing it would make a file the listing honestly
 * answered with un-fetchable, which is the trap `ArchivePathSegmentSchema`'s backslash rule
 * records from the other side.
 */

import {
	type ContainedByteRange,
	type ContainedFileReader,
	type ContainedFileResult,
	createContainedFileReader,
	type OpenedContainedFile,
} from './contained-file.js';

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

/**
 * The archive's names for the three shapes `./contained-file.ts` describes.
 *
 * Kept byte-for-byte what they were before the lift, because they are what the daemon's log says
 * and what four suites match on — `list-archive.ts`, `archive-size.ts` and
 * `measure-archive-groups.ts` word their own escape warnings the same way, and
 * `tests/helpers/daemon-socket.ts` filters sweep lines by not matching this opening.
 */
const ARCHIVE_NAMES = { subject: 'The artifact archive', root: 'the archive root' } as const;

/** One byte range, both ends inclusive, as an HTTP `Range` names them. */
export type ArchiveByteRange = ContainedByteRange;
export type OpenedArchiveFile = OpenedContainedFile;
export type ArchiveFileResult = ContainedFileResult;
/**
 * One file, addressed by the components a listing answered.
 *
 * `path` is **already-validated** components: the caller owns the address's shape, because the
 * caller is where an address arrives from a peer and where a refusal has to be worded.
 * `./contained-file.ts` still resolves and compares, which is the half a schema cannot give.
 */
export type ArchiveFileReader = ContainedFileReader;

/**
 * Extension to content type — `PROJECT.md` §10's tree exactly, plus `./archive.ts`'s own `.bin`
 * fallback for bytes nothing recognised.
 *
 * Keyed by extension rather than by media type, which is the opposite direction from
 * `EXTENSIONS` in `./archive.ts`: that one names a file it is about to write from a media type
 * the device gave it, and this one reads a name that already exists. Two small maps rather than
 * one inverted at runtime, because the writer's is not exhaustive over what the tree holds —
 * `.txt` and `.json` are written by other code paths entirely.
 *
 * **Exported for one cross-tree gate**, `tests/unit/panel/artifact-bodies.test.ts`: the web panel
 * decides which of its three preview bodies a file gets from the type this table hands out, and a
 * type added here that the panel cannot draw is a file the browser shows as *opaque* with nobody
 * noticing (#133). Nothing on the host reads it from outside this module.
 *
 * **The panel bundle's own table is not this one and must never be folded into it** (R52, #293):
 * `./panel-bundle.ts` serves `.html`, `.js` and `.css`, none of which this gate would let through —
 * and rightly, because they are types the archive's preview must never be handed.
 */
export const CONTENT_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.mp4': 'video/mp4',
	'.txt': 'text/plain; charset=utf-8',
	'.json': 'application/json',
};

export function createArchiveFileReader(options: ArchiveFileReaderOptions): ArchiveFileReader {
	return createContainedFileReader({
		root: options.root,
		contentTypes: CONTENT_TYPES,
		names: ARCHIVE_NAMES,
		...(options.warn === undefined ? {} : { warn: options.warn }),
	});
}
