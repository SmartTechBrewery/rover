/**
 * The `measure_archive` handler and the walk it shares with the sweep — **how much disk one
 * archive address takes** (R49, `PROJECT.md` §10).
 *
 * **This is the archive's fourth read, and the first that answers a number.**
 * `./list-archive.ts` answers what is at a level, `./search-archive.ts` where a name appears and
 * `./list-archive-groups.ts` which runs belong together; this one answers *how much*, for the
 * badge the Archive screen draws beside a scope. It takes the same address vocabulary all three
 * already use — the components a previous answer returned, `[]` being the root.
 *
 * **The primitive is the sweep's own, moved here rather than copied.** {@link sizeOfTree} came out
 * of `./archive-sweep.ts` unchanged and the sweep still calls it, which is the whole reason this
 * module exists as a module: two measurements of one tree would eventually disagree about it, and
 * a badge that says one thing while the sweep's log says another is worse than no badge at all.
 * The only thing added to it is {@link TreeSize.complete}, so a walk that was cut short can say so
 * — the sweep ignores that flag and this handler is what it is for. **There are three callers
 * now** (#262): `./measure-archive-groups.ts` adds a matching run's whole run directory through it,
 * so a group's total, an address's total and the sweep's log are one primitive with one bound.
 *
 * **Every scope gets the full `MAX_ARCHIVE_PATH_DEPTH` below itself**, which is exactly the budget
 * the sweep gives a run today. That makes one guarantee and not two: the root scope and the
 * sweep's `totalBytesBefore` come out of one primitive, but they are not arithmetically the same
 * number — the sweep totals *run subtrees* while the root scope totals *the tree*, so a stray file
 * beside a project counts here and not there. One primitive is what the badge needs; an identical
 * figure is not something this method can honestly promise, and pretending otherwise would mean
 * under-reporting the disk the badge exists to report.
 *
 * **`truncated` means exactly one thing: at least one directory that exists was not fully
 * examined**, so the number is a lower bound. `search_archive`'s own sentence, because it is the
 * same fact. The depth bound sets it and so does a level the host could not read; an `ENOENT`
 * mid-walk does **not**, because a file removed between the `readdir` and the `stat` is the
 * ordinary case in a tree that is written to while it is read — the line `sizeOfTree` already drew
 * between what it warns about and what it passes over.
 *
 * **A size the host could not take is never a `0`.** `bytes: 0` is a true claim about an empty
 * directory, so an address whose own listing fails answers `unreadable` the way `list_archive`'s
 * does rather than a zero with a flag on it. That is what the explicit readability probe below is
 * for, and it is the one place this handler spends a syscall on something the walk would repeat.
 *
 * **No host path and no `errno` is on any answer, structurally rather than by habit.**
 * `MeasureArchiveResultSchema` has no field either would fit in — not even a `message` — so every
 * diagnosis is a warning *here*, where the path already belongs (D19). `src/ipc/server.ts` parses
 * every handler's return value against that `.strict()` schema, so a path smuggled onto a result
 * would be `invalid_result` on the host.
 *
 * **Containment is checked here, not only in the schema.** `ArchivePathSegmentSchema` keeps any
 * *string* from escaping the root; a symlink escapes it without `.`, `..` or a separator, and
 * `readdir` and `stat` both resolve the link in their own argument. So the resolved address is
 * compared against the resolved root before anything is read, exactly as `./list-archive.ts` does
 * and for its reason.
 *
 * **There is still no index, and nothing is cached between requests** (D6, D23, D24). The walk
 * *is* the measurement — no total kept warm, no catalogue, no memo of a previous answer — which is
 * what makes the depth bound and the flag necessary rather than optional. Reads are sequential,
 * `./search-archive.ts`'s stance for its reason.
 */

import type { Dirent, Stats } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
	type IpcHandlers,
	MAX_ARCHIVE_PATH_DEPTH,
	type MeasureArchiveParams,
	type MeasureArchiveResult,
} from '../ipc/methods.js';

/** What one walk measured, and whether it saw all of what it was asked about. */
export interface TreeSize {
	/** The bytes of every regular file the walk reached, following no link. */
	readonly bytes: number;
	/** False when the depth bound was reached, or a level below could not be read. */
	readonly complete: boolean;
}

export interface ArchiveSizeOptions {
	/** The archive root — `./archive-path.ts`'s `resolveArtifactsRoot`, resolved in `./main.ts`. */
	readonly root: string;
	/**
	 * Where something this measurement could not read is reported. Defaults to `console.warn`;
	 * injected by tests. This is the **only** place the reason and the path are said, for the
	 * reason the module header gives.
	 */
	readonly warn?: (message: string) => void;
}

export type MeasureArchiveHandler = Pick<IpcHandlers, 'measure_archive'>;

export function createArchiveSizeHandler(options: ArchiveSizeOptions): MeasureArchiveHandler {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	// Resolved on the first request that finds it rather than in this constructor, for
	// `./list-archive.ts`'s reason: the root does not exist on a host that has archived nothing.
	let resolvedRoot: string | null = null;

	return {
		async measure_archive(params: MeasureArchiveParams) {
			// The schema keeps every component from being `.`, `..` or a separator, so this join
			// cannot escape as a string. A symlink can, which is what the check below is for.
			const requested = join(options.root, ...params.path);

			let address: string;
			try {
				resolvedRoot ??= await realpath(options.root);
				address = await realpath(requested);
			} catch (error) {
				// The root's own absence is this case too: nothing has ever been archived here.
				if (codeOf(error) === 'ENOENT') {
					return { outcome: 'missing' as const };
				}
				warn(unmeasurableWarning(requested, error));
				return { outcome: 'unreadable' as const };
			}
			if (address !== resolvedRoot && !address.startsWith(resolvedRoot + sep)) {
				// A link inside the root pointing out of it. `unreadable` rather than `missing`,
				// because something *is* there — this host will not size it through this method.
				warn(escapedWarning(requested, address));
				return { outcome: 'unreadable' as const };
			}

			return measureResolved(address, requested, warn);
		},
	};
}

/**
 * One `stat` of an address already known to be inside the root, and the three things it can be.
 *
 * A **directory** is walked; a **regular file** answers the size this very `stat` took; anything
 * else — a socket, a device node, a FIFO — is `unreadable`, because there is no honest number for
 * one and a `0` would say it was empty.
 *
 * The file branch is here so the method is **total** over the one path vocabulary: without it a
 * file address falls into the walk's `ENOTDIR` and answers `0`, which is a claim about an empty
 * directory. The panel reads an artifact's own size off `list_archive`'s `sizeBytes`; this exists
 * for correctness, not because a screen asks for it.
 */
async function measureResolved(
	address: string,
	requested: string,
	warn: (message: string) => void,
): Promise<MeasureArchiveResult> {
	let stats: Stats;
	try {
		stats = await stat(address);
	} catch (error) {
		if (codeOf(error) === 'ENOENT') {
			return { outcome: 'missing' as const };
		}
		warn(unmeasurableWarning(requested, error));
		return { outcome: 'unreadable' as const };
	}

	if (stats.isDirectory()) {
		return measureDirectory(address, requested, warn);
	}
	if (stats.isFile()) {
		return { outcome: 'measured' as const, bytes: stats.size, truncated: false };
	}
	warn(unsizeableWarning(requested));
	return { outcome: 'unreadable' as const };
}

/**
 * One directory scope: the readability probe, then the walk.
 *
 * **The probe is the whole reason this is two calls and not one.** `stat` succeeds on a directory
 * the host may not open — it needs no permission on the directory itself, only on its parent — so
 * without it a mode `000` scope would walk to nothing and answer `0` bytes with a truncation flag,
 * which reads as *empty, roughly* rather than as *the host cannot say*. That is the one confusion
 * this method's three outcomes exist to prevent, and `./list-archive.ts` answers the very same
 * failure the very same way. What it costs is one directory read the walk immediately repeats,
 * against a recursive walk of everything below it; and the two calls cannot disagree about
 * containment, because both take the already-resolved address.
 *
 * A level *below* this one that cannot be read is not this case: it is a short total, and the
 * total says so.
 */
async function measureDirectory(
	address: string,
	requested: string,
	warn: (message: string) => void,
): Promise<MeasureArchiveResult> {
	try {
		await readdir(address);
	} catch (error) {
		warn(unmeasurableWarning(requested, error));
		return { outcome: 'unreadable' as const };
	}
	const measured = await sizeOfTree(address, MAX_ARCHIVE_PATH_DEPTH, warn);
	return { outcome: 'measured' as const, bytes: measured.bytes, truncated: !measured.complete };
}

/**
 * The bytes under one directory, files only, following no link — **the sweep's own walk**
 * (`./archive-sweep.ts`, which still calls this, as does `./measure-archive-groups.ts`) with one
 * flag added.
 *
 * `depth` is a floor under `MAX_ARCHIVE_PATH_DEPTH` and the archive's own tree never reaches it
 * (§10): a run's subtree is `<serial>/<kind>/<file>`. It is here so a hand-made loop of
 * directories under a run cannot make one walk go forever, which is the one failure a measurement
 * must not have. Reaching it is not an error and not a refusal — it is `complete: false`, and the
 * caller that cares says `truncated` because of it.
 *
 * Descends only into a dirent whose `isDirectory()` is true, which is `false` for a symlink under
 * `withFileTypes`: that is what keeps the walk inside the root with no `realpath` per level,
 * exactly as `./search-archive.ts` earns containment. A reader "fixing" that with a `stat` would
 * take containment with it — and would let a link decide what the **sweep** deletes.
 *
 * A level the host cannot read is one warning, contributes nothing and makes the answer
 * incomplete. An `ENOENT` is neither warned about nor counted against completeness: the archive is
 * written to while it is being read, which is what `./list-archive.ts` already says about its own
 * `stat`. For the sweep, an under-measured archive deletes *less* — the benign direction for a
 * budget — and it reads `.bytes` alone; for `measure_archive` the same shortfall is what
 * `truncated` is.
 */
export async function sizeOfTree(
	directory: string,
	depth: number,
	warn: (message: string) => void,
): Promise<TreeSize> {
	if (depth <= 0) {
		return { bytes: 0, complete: false };
	}
	let dirents: Dirent[];
	try {
		dirents = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (codeOf(error) === 'ENOENT') {
			return { bytes: 0, complete: true };
		}
		warn(unreadableWarning(directory, error));
		return { bytes: 0, complete: false };
	}

	let bytes = 0;
	let complete = true;
	for (const dirent of dirents) {
		const child = join(directory, dirent.name);
		if (dirent.isDirectory()) {
			const subtree = await sizeOfTree(child, depth - 1, warn);
			bytes += subtree.bytes;
			complete &&= subtree.complete;
		} else if (dirent.isFile()) {
			const file = await fileSizeOf(child, warn);
			bytes += file.bytes;
			complete &&= file.complete;
		}
		// Anything else — a symlink, a socket, a device node — contributes nothing and is not
		// followed. `readdir`'s dirent type answers that with no `stat` at all.
	}
	return { bytes, complete };
}

/**
 * One file's size, or nothing.
 *
 * A file removed between the `readdir` and the `stat` is ordinary here rather than exceptional —
 * the archive is written to while it is being read — so it costs neither a warning nor the
 * completeness flag. Any *other* failure does cost both: a directory that is readable but not
 * traversable (mode `400`) lists its children and refuses every `stat` under it, and that is a
 * short total which has to say it is short.
 */
async function fileSizeOf(path: string, warn: (message: string) => void): Promise<TreeSize> {
	try {
		return { bytes: (await stat(path)).size, complete: true };
	} catch (error) {
		if (codeOf(error) === 'ENOENT') {
			return { bytes: 0, complete: true };
		}
		warn(unreadableWarning(path, error));
		return { bytes: 0, complete: false };
	}
}

/**
 * What the operator is told, on the host, about a level {@link sizeOfTree} could not read.
 *
 * **Two callers share this line now** — the sweep's walk and the badge's — so it says what is true
 * of both and carries neither one's vocabulary. The sweep keeps its own wording for the levels it
 * reads itself (`./archive-sweep.ts`), which is also what `SWEEP_LOG_MARKERS` in
 * `tests/helpers/daemon-socket.ts` classifies a sweep's log line by; a line about a subtree is now
 * deliberately not one of those, because a measurement nobody swept for writes it too.
 *
 * The path goes through `JSON.stringify`, never plain interpolation: it ends in components that
 * may legally carry a newline, and the daemon's stderr is the host's only accountability trail
 * (`./list-archive.ts`'s header says why).
 */
function unreadableWarning(path: string, error: unknown): string {
	return (
		`The artifact archive could not be read at ${JSON.stringify(path)}: ` +
		`${codeOf(error) ?? 'unknown error'}. That subtree counted for nothing in the total.`
	);
}

/**
 * What the operator is told when the address a measurement was asked about could not be sized at
 * all — so the answer is `unreadable` and carries no path and no reason (D19).
 */
function unmeasurableWarning(path: string, error: unknown): string {
	return (
		`The artifact archive could not be measured at ${JSON.stringify(path)}: ` +
		`${codeOf(error) ?? 'unknown error'}. The answer says only that the host could not size ` +
		`it — no path or reason leaves this host.`
	);
}

/** The same, for an address that is there and is neither a directory nor a regular file. */
function unsizeableWarning(path: string): string {
	return (
		`The artifact archive was asked to measure ${JSON.stringify(path)}, which is neither a ` +
		`directory nor a regular file. There is no honest size for it, and a zero would say it ` +
		`was empty; the answer says only that the host could not size it.`
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
		`The artifact archive was asked to measure ${JSON.stringify(requested)}, which resolves ` +
		`to ${JSON.stringify(resolved)} — outside the archive root. The measurement refused it; ` +
		`nothing about it leaves this host.`
	);
}

/** The errno of a filesystem failure, or `null` for anything that is not one. */
function codeOf(error: unknown): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : null;
}
