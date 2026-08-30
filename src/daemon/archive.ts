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
 * **Nothing here prunes.** Retention — a TTL, a size cap, who runs it — is explicitly out of
 * scope (PROJECT.md §9.4). This tree grows without bound, on purpose and for now.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LogRead } from '../core/device.js';
import type { LeaseId } from '../core/ids.js';
import type { ActionResult, Artifact } from '../verbs/result.js';
import { leaseArchiveDirectory } from './archive-path.js';
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
	 */
	record(lease: Lease, result: ArchivableResult): Promise<void>;
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
		async record(lease: Lease, result: ArchivableResult): Promise<void> {
			// Every number this call needs, before the first await. A write still in flight when
			// the lease ends therefore cannot recreate an entry `forget` has already dropped.
			const files = plan(result, (kind) => next(lease, kind));
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
 * things nobody asked to keep.
 */
function plan(result: ArchivableResult, take: (kind: keyof Counters) => number): PlannedFile[] {
	switch (result.verb) {
		case 'screenshot': {
			if (!result.artifact) return [];
			const n = sequence(take('screenshots'));
			return [
				{
					path: join('screenshots', `${n}_${result.verb}${extensionFor(result.artifact)}`),
					bytes: decode(result.artifact),
				},
			];
		}

		case 'record_video': {
			if (!result.artifact) return [];
			const n = sequence(take('recordings'));
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
			const n = sequence(take('logs'));
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

/** `device_info.json` — a static copy of what the result already carries (D14). */
async function writeDeviceInfo(directory: string, result: ArchivableResult): Promise<void> {
	try {
		await writeFile(
			join(directory, 'device_info.json'),
			`${JSON.stringify(result.device, null, 2)}\n`,
			{
				flag: 'wx',
			},
		);
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
