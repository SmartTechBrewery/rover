/**
 * The durable artifact archive — the second, host-local effect of a verb call that produced
 * bytes (D23, PROJECT.md §10; backlog row R25).
 *
 * **Additive, never substitutive.** A screenshot, a recording and a log read still come back
 * to the client as bytes in the answer, and nothing here changes that (D19, R24). What this
 * adds is a copy on the host's own disk, filed so that two runs of the same named check at
 * two different times sit next to each other and can be compared by listing a directory
 * (D24). The archive path is never put on an answer, and nothing here can put one there:
 * `src/ipc/server.ts` parses every handler's return value against the row's `.strict()`
 * result schema, so a path smuggled onto a result would be rejected as `invalid_result`
 * before it reached a client.
 *
 * **It lives in the daemon rather than in `src/verbs/`, for `./frames.ts`'s reason.**
 * `src/ipc/verb-methods.ts` imports the verb schemas, so `src/verbs/` is in every client's
 * module graph, and host filesystem writes under it would be host behaviour inside a CLI
 * (D19, `tests/unit/no-backend-in-a-client.test.ts`). Unlike the frame extractor this needs
 * no seam in the verb layer at all: the daemon already holds the lease and the finished
 * result together, so no verb signature, verb option or result schema changes to carry it.
 *
 * **{@link ArtifactArchive.record} never throws, and that is a property of the module rather
 * than a habit.** A full disk, an unwritable root or a permission error is a host problem
 * that has nothing to do with what the device just did; turning a successful verb call into
 * a failure over it would make the archive substitutive, which is exactly what D23 says it
 * is not. So a write that cannot happen is warned about on the host, naming the path and the
 * reason, and the verb's answer goes back untouched.
 *
 * **Sequence numbers are allocated synchronously, before any await.** Nothing stops a holder
 * firing two verbs down one connection (`./verb-traffic.ts`), so two concurrent screenshots
 * must not both compute `001`. The counters are per lease and per kind, held in memory: a
 * lease dies with the host (D6), so a lease directory can never be reopened by a later daemon
 * and an in-memory counter is complete for that lease's whole life.
 *
 * **Three files here are about the lease rather than about the bytes** — `device_info.json`
 * (D14), `test_description.json` (D22 as amended #148) and `group_id.json` (D22 as amended #150)
 * — and all three are written on exactly the same terms: once, `wx`, never rewritten, and beside
 * the *first* artifact the lease produced rather than at grant time. Nothing indexes any of them,
 * and a lease that produced no bytes files none.
 *
 * **This is where a grouping outlives the leases that made it** (D22, as amended #150), and it is
 * split across those two halves on purpose. A lease's `groupId` spans leases and so cannot be a
 * filename: it is filed as `group_id.json` in the run, and *which runs share a group* is then a
 * walk, which is the query the tree is already shaped to serve (D24, R38). An artifact's `label`
 * belongs to one file and is written **into that file's name**, beside the sequence number
 * (`001_before_screenshot.png`), so *which artifacts are the same thing* is answered by listing a
 * directory. **Neither branches the tree's shape**: `leaseArchiveDirectory` is always four levels
 * whether or not either was supplied (`./archive-path.ts`, #129), so nothing walking this tree
 * has to know that this feature exists.
 *
 * **Nothing here prunes.** Retention — a TTL, a size cap, who runs it — is explicitly out of
 * scope (PROJECT.md §9.4). This tree grows without bound, on purpose and for now.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LogRead } from '../core/device.js';
import type { LeaseId } from '../core/ids.js';
import type { ActionResult, Artifact } from '../verbs/result.js';
import { leaseArchiveDirectory, pathSegment } from './archive-path.js';
import type { Lease } from './leases.js';

/**
 * What a verb answered with, as much of it as the archive reads.
 *
 * `ActionResult` plus the two payloads the extended result schemas add — `read_logs`' log
 * and `record_video`'s frames (`src/verbs/logs.ts`, `src/verbs/record.ts`). Both optional
 * here rather than required, because this one type stands in for every verb's answer and
 * most of them carry neither.
 */
export type ArchivableResult = ActionResult & {
	readonly logs?: LogRead;
	readonly frames?: readonly Artifact[];
};

export interface ArtifactArchive {
	/**
	 * Write whatever this result contributes to the archive.
	 *
	 * **Never throws and never alters the result.** A verb that produced no bytes writes
	 * nothing at all — not even a directory — so a lease that only ever tapped leaves no
	 * empty scaffolding behind.
	 *
	 * `label` is the caller's own name for *this* artifact, off the call rather than off the
	 * lease (`ArtifactLabelSchema`), and it reaches here without any verb having seen it — the
	 * daemon holds the lease and the finished result together, which is why the archive still
	 * needs no seam in the verb layer. Absent for a call that carried none, and by the time it
	 * gets here it is only ever present on a lease that has a `groupId`: the pairing is refused
	 * upstream (`./verb-handlers.ts`), so nothing below has to decide what an ungrouped label
	 * would mean.
	 */
	record(lease: Lease, result: ArchivableResult, label?: string): Promise<void>;
	/**
	 * The lease ended: drop its sequence counters, so the daemon does not grow with the
	 * number of leases it has ever granted.
	 *
	 * Synchronous and never throws — it hangs off the lease store's end hook, which requires
	 * both (`./leases.ts`).
	 */
	forget(lease: Lease): void;
}

export interface ArtifactArchiveOptions {
	/** The root every path is built under — `./archive-path.ts`'s `resolveArtifactsRoot`. */
	readonly root: string;
	/** Where an impossible write is reported. Defaults to `console.warn`; injected by tests. */
	readonly warn?: (message: string) => void;
}

/** The three directories one lease-device pair can have, and the counter each one keeps. */
interface Counters {
	screenshots: number;
	recordings: number;
	logs: number;
}

/** How wide a per-kind sequence number is rendered, and how wide a frame's index is. */
const SEQUENCE_DIGITS = 3;
const FRAME_DIGITS = 4;

/**
 * What a media type is called on disk.
 *
 * The two the verbs actually produce, plus an honest fallback: bytes nothing recognised get
 * `.bin` rather than an extension guessed from the verb that made them, the same way
 * `mediaTypeOf` answers `application/octet-stream` instead of inventing a label
 * (`src/verbs/result.ts`).
 */
const EXTENSIONS: Record<string, string> = {
	'image/png': '.png',
	'video/mp4': '.mp4',
};

export function createArtifactArchive(options: ArtifactArchiveOptions): ArtifactArchive {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const counters = new Map<LeaseId, Counters>();

	/** The next number for one kind, taken and kept. Synchronous by contract — see the header. */
	function next(lease: Lease, kind: keyof Counters): number {
		const held = counters.get(lease.id) ?? { screenshots: 0, recordings: 0, logs: 0 };
		held[kind] += 1;
		counters.set(lease.id, held);
		return held[kind];
	}

	return {
		async record(lease: Lease, result: ArchivableResult, label?: string): Promise<void> {
			// Every number this call needs, before the first await. A write still in flight when
			// the lease ends therefore cannot recreate an entry `forget` has already dropped.
			const files = plan(result, (kind) => next(lease, kind), label);
			if (files.length === 0) {
				return;
			}

			const directory = leaseArchiveDirectory(options.root, lease);
			try {
				await mkdir(directory, { recursive: true });
				// Once per lease-device pair (D14), and there is exactly one device per lease (D7).
				// `wx` rather than a flag in memory: the file either is not there and gets written,
				// or is there and is already the same snapshot, which is stateless and self-healing
				// across a write that failed half way.
				await writeDeviceInfo(directory, result);
				// The lease's own description, on exactly the same terms and in the same place —
				// see {@link writeTestDescription}. A lease that supplied none writes no file.
				await writeTestDescription(directory, lease);
				// And the group it belongs to, on those same terms again — see {@link writeGroupId}.
				await writeGroupId(directory, lease);
				for (const file of files) {
					const path = join(directory, file.path);
					// One `mkdir` per file rather than one per kind: a recording's frames sit in a
					// directory of their own, and this is cheaper than knowing which files need one.
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, file.bytes);
				}
			} catch (error) {
				// The verb succeeded; only the copy of it did not. Said loudly, and no further.
				warn(
					`The artifact archive could not write under '${directory}': ${messageOf(error)}. ` +
						`The '${result.verb}' call answered normally — only the host-side copy is missing.`,
				);
			}
		},

		forget(lease: Lease): void {
			counters.delete(lease.id);
		},
	};
}

/** One file the archive owes, as a path relative to the lease-device directory. */
interface PlannedFile {
	readonly path: string;
	readonly bytes: Uint8Array;
}

/**
 * What this result contributes — the one place that knows the layout (PROJECT.md §10).
 *
 * A verb this does not name contributes nothing, deliberately: the row covers screenshots,
 * recordings and log pulls, and archiving a tap's after-state would fill the tree with
 * things nobody asked to keep. **Those three are exactly the calls that take a `label`**
 * (`src/ipc/verb-methods.ts`), and the correspondence is not a coincidence: a label names a
 * thing that was filed, so a call this switch drops has nothing to label.
 *
 * `label` is prefixed by {@link labelled} in every branch, so an artifact's name is
 * `<sequence>_<label>_…` rather than the label being appended or replacing anything. The
 * sequence still leads — it is what says *order* — and the label sits next to it because that
 * is where a listing puts the two facts side by side.
 */
function plan(
	result: ArchivableResult,
	take: (kind: keyof Counters) => number,
	label?: string,
): PlannedFile[] {
	switch (result.verb) {
		case 'screenshot': {
			if (!result.artifact) return [];
			const n = labelled(sequence(take('screenshots')), label);
			return [
				{
					path: join('screenshots', `${n}_${result.verb}${extensionFor(result.artifact)}`),
					bytes: decode(result.artifact),
				},
			];
		}

		case 'record_video': {
			if (!result.artifact) return [];
			const n = labelled(sequence(take('recordings')), label);
			// The frames go in a sibling of the recording they were cut from, named after it, so
			// the pair stays obvious in a listing rather than needing an index to relate them.
			const frames = (result.frames ?? []).map((frame, index) => ({
				path: join(
					'recordings',
					`${n}_frames`,
					`${String(index + 1).padStart(FRAME_DIGITS, '0')}${extensionFor(frame)}`,
				),
				bytes: decode(frame),
			}));
			return [
				{
					path: join('recordings', `${n}${extensionFor(result.artifact)}`),
					bytes: decode(result.artifact),
				},
				...frames,
			];
		}

		case 'read_logs': {
			if (!result.logs) return [];
			const n = labelled(sequence(take('logs')), label);
			return [
				{
					path: join('logs', `${n}_${result.verb}.txt`),
					bytes: Buffer.from(renderLogs(result.logs), 'utf8'),
				},
			];
		}

		default:
			return [];
	}
}

/**
 * The sequence number with the call's label after it — `001` becomes `001_before` — or the
 * sequence number exactly as it was for a call that carried none.
 *
 * **Through {@link pathSegment} like every other caller string that becomes part of a path**, so
 * a label carrying a separator, a leading dot or anything outside `[A-Za-z0-9._-]` is one
 * component and not an escape, and two labels that sanitise alike land on two names rather than
 * one (the collision hash). It is the one place a label is looked at, and it is looked at for its
 * *shape* and never for what it says (D22).
 *
 * **Absent adds nothing at all** — not an empty segment, not a placeholder — so an unlabelled
 * screenshot is still `001_screenshot.png` and the tree of a caller who never used this feature
 * is byte for byte the tree it was before (#129's lesson, applied to a file name).
 */
function labelled(ordinal: string, label: string | undefined): string {
	return label === undefined ? ordinal : `${ordinal}_${pathSegment(label)}`;
}

/** `device_info.json` — a static copy of what the result already carries (D14). */
async function writeDeviceInfo(directory: string, result: ArchivableResult): Promise<void> {
	await writeOnce(
		join(directory, 'device_info.json'),
		`${JSON.stringify(result.device, null, 2)}\n`,
	);
}

/**
 * `test_description.json` — the lease's own account of what this run was about, filed so it
 * outlives the lease (D22 as amended #148, PROJECT.md §10).
 *
 * **`device_info.json` is the precedent and this follows it exactly**: written once with
 * `flag: 'wx'`, never rewritten, and a failure warned about by the caller rather than turned into
 * a failed verb — the archive is additive, never substitutive (D23).
 *
 * **A lease that produced no bytes files nothing**, description included. This is called from
 * `record`, which returns before any directory exists when a verb contributed no files, so the
 * description lands beside the first artifact and not before it. Nothing creates a run directory
 * at grant time: a lease that only ever tapped would otherwise leave the one piece of empty
 * scaffolding the tree has never had (PROJECT.md §10), and it would be created by a *grant* rather
 * than by a verb, which is a second writer into the archive.
 *
 * **Inside the `<serial>` directory rather than beside it, and that is the one deliberate
 * departure from what the field describes.** The description belongs to the lease, so the run
 * level would read better — but `list_archive` publishes a run's `<serial>` to the Archive screen
 * as the run directory's `onlyChild`, which is `null` for a directory holding anything other than
 * exactly one entry (`./list-archive.ts`, `docs/DESIGN.md` §9). A second entry at the run level
 * would therefore blank `SERIAL`, the run's device card and its `CONTENTS` listing for every run
 * that has a description, and the alternative is changing what `onlyChild` means — which is the
 * archive's read shape, out of scope here. One lease is one device (D7), so the `<serial>`
 * directory is the lease-device pair's and is one-to-one with the lease anyway.
 */
async function writeTestDescription(directory: string, lease: Lease): Promise<void> {
	if (lease.testDescription === undefined) {
		return;
	}
	// The wire's own key, so the file is the shape a client already reads (D26) rather than a
	// second spelling of it. A JSON object rather than the bare sentence: a file that can grow a
	// key is one a later field does not need a second file for.
	await writeOnce(
		join(directory, 'test_description.json'),
		`${JSON.stringify({ testDescription: lease.testDescription }, null, 2)}\n`,
	);
}

/**
 * `group_id.json` — which investigation this run belongs to, filed so the grouping outlives every
 * lease in it (D22 as amended #150, PROJECT.md §10).
 *
 * **`test_description.json`'s terms exactly**, and `device_info.json`'s before it: written once
 * with `flag: 'wx'`, never rewritten, beside the first artifact the lease produced, inside the
 * `<serial>` directory rather than beside it — see {@link writeTestDescription} for why that last
 * one is not a matter of taste. A lease with no group writes no file, and a lease that produced no
 * bytes writes nothing at all.
 *
 * **A file rather than a directory level, and that is the decision this whole feature turns on.**
 * A `<group>/` level above `<project>/` would make "what else is in this group" free — and would
 * break *always four levels*, which `run-identity.ts`, `list_archive` and the panel's three levels
 * all count on, and which #129 removed the last branch from. So the group is filed as contents and
 * *which runs share it* is a walk at request time, which is the same trade R38's `search_archive`
 * already makes and the one D24's no-index half asks for.
 *
 * **This is not an index and nothing here builds one.** Nothing joins two runs, counts a group's
 * members or checks that a second ever arrives; the host writes down what the lease claimed and a
 * reader does the rest.
 */
async function writeGroupId(directory: string, lease: Lease): Promise<void> {
	if (lease.groupId === undefined) {
		return;
	}
	// The wire's own key again (D26), so a reader parses one spelling of this field wherever it
	// meets it — on a grant, on a holder, or here weeks after the lease ended.
	await writeOnce(
		join(directory, 'group_id.json'),
		`${JSON.stringify({ groupId: lease.groupId }, null, 2)}\n`,
	);
}

/**
 * One file written the first time and never again — `wx`, with an existing file left exactly as
 * it is.
 *
 * A flag in memory would say the same thing less well: this is stateless, and self-healing across
 * a write that failed half way. Every other error is thrown to `record`'s own handler, which warns
 * and lets the verb's answer through untouched.
 */
async function writeOnce(path: string, contents: string): Promise<void> {
	try {
		await writeFile(path, contents, { flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
	}
}

/**
 * One log read as one text file, oldest entry first — the order the device reported them in
 * (`LogReadSchema`).
 *
 * The truncation line is a comment at the top rather than a silently shorter file, for the
 * reason `LogRead.truncated` exists at all: "here are two hundred lines" means something
 * different when there were two hundred and one.
 */
function renderLogs(logs: LogRead): string {
	const lines = logs.truncated
		? ['# older entries were dropped — the device had more than this read asked for']
		: [];
	for (const entry of logs.entries) {
		const pid = entry.pid === null ? '' : `(${entry.pid})`;
		lines.push(
			`${entry.timestamp} ${entry.level.toUpperCase()}/${entry.tag}${pid}: ${entry.message}`,
		);
	}
	return `${lines.join('\n')}\n`;
}

/**
 * The bytes back out of the answer's base64 — deliberately the client's copy rather than a
 * second capture, so the archived file is byte for byte what the agent received and the two
 * can never disagree about what was on the screen.
 */
function decode(artifact: Artifact): Uint8Array {
	return Buffer.from(artifact.base64, 'base64');
}

function extensionFor(artifact: Artifact): string {
	return EXTENSIONS[artifact.mediaType] ?? '.bin';
}

function sequence(value: number): string {
	return String(value).padStart(SEQUENCE_DIGITS, '0');
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
