/**
 * The one place a client turns an `ActionResult.artifact` into a file — the client half of
 * D19's artifact contract.
 *
 * The verb ran on the host and the bytes arrived base64-encoded, because a host-local path
 * either names nothing on this machine or names something else entirely
 * (`src/verbs/result.ts`, `ArtifactSchema`). What is left is the other end of that wire:
 * decode, check what decoded against what the host said it encoded, write it **here**, and
 * report the caller's own absolute path.
 *
 * **Nothing here branches on `--host`.** A capture from the daemon on this machine and one
 * from a host across the network arrive as the same field of the same schema, so they go
 * through the same two functions and land on the same kind of local path — which is what
 * makes "every path returned to the agent exists on the agent's machine" a property of this
 * module rather than of two commands remembering to agree.
 */

import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { VerbCallResult } from '../../ipc/methods.js';
import type { Artifact } from '../../verbs/result.js';
import { UsageError } from './flags.js';
import * as out from './output.js';
import { describeWithoutBytes, exitCodeFor, renderVerbAnswer, requireArtifact } from './verb.js';

/**
 * Where `--out` points, absolute, checked before anything is captured.
 *
 * **Before**, deliberately: a capture spends a round trip, a lease renewal and several
 * megabytes, and reporting a typo'd directory afterwards would spend all of it to say
 * something knowable up front. It is the reasoning `boundAttribution` (`./flags.ts`)
 * records for checking an attribution length client-side, applied to a path.
 *
 * Two shapes are refused, both as {@link UsageError} — exit 2 with the command's own usage,
 * because the caller asked wrong and no host was asked anything:
 *
 * - an existing **directory**, which `writeFile` would fail on with `EISDIR` at exit 1
 *   after the capture;
 * - a path whose **parent does not exist**, which would fail with `ENOENT` the same way.
 *   The parent is not created: `--out` names a file, and a client inventing directory trees
 *   on somebody's disk from a mistyped path is not the CLI's call.
 *
 * An existing *file* is accepted and overwritten — that is what a destination is.
 */
export async function resolveDestination(command: string, out: string): Promise<string> {
	const destination = path.resolve(out);

	const existing = await statOrNull(destination);
	if (existing?.isDirectory() === true) {
		throw new UsageError(
			`rover ${command}: --out '${destination}' is a directory — name the file to write, ` +
				`not the directory to write it in. There is no default filename on purpose: a name ` +
				`this CLI invented would be one nothing else can predict.`,
		);
	}

	const parent = path.dirname(destination);
	if ((await statOrNull(parent))?.isDirectory() !== true) {
		throw new UsageError(
			`rover ${command}: --out '${destination}' has no directory '${parent}' to write into. ` +
				`Create it first — a client does not build directory trees on your disk from a path ` +
				`it was handed.`,
		);
	}

	return destination;
}

/**
 * Decode `artifact`, check the length, write the bytes to `destination`, and answer with the
 * absolute path they are now at — on **this** machine.
 *
 * **The check precedes the write, and that ordering is the whole point.** `Buffer.from(…,
 * 'base64')` does not reject a mangled payload: it *drops* every character outside the
 * alphabet and decodes what is left, so a truncated or corrupted string becomes a shorter
 * file rather than an error. That is exactly the truncated artifact that does not announce
 * itself which D19's byte-length field exists to catch — `byteLength` is the length of what
 * the host encoded, so comparing it against what decoded here is the only end-to-end check
 * either side has, and this is the only place in the tree that performs it.
 *
 * A mismatch throws with both numbers and **writes nothing**: the destination is untouched,
 * so a failed transfer never leaves a short file where a whole one is expected. A plain
 * `Error` rather than a `UsageError` — the caller typed nothing wrong, the transfer failed —
 * so the dispatcher answers exit 1.
 */
export async function writeArtifact(artifact: Artifact, destination: string): Promise<string> {
	const bytes = Buffer.from(artifact.base64, 'base64');
	if (bytes.byteLength !== artifact.byteLength) {
		throw new Error(
			`The artifact did not survive the trip: the host encoded ${artifact.byteLength} bytes ` +
				`and ${bytes.byteLength} decoded here. Nothing was written to '${destination}' — a ` +
				`file this short would open as a damaged ${artifact.mediaType} rather than announce ` +
				`itself. Ask again.`,
		);
	}

	await writeFile(destination, bytes);
	return destination;
}

/**
 * One line a success prints, and the only place a written artifact is described.
 *
 * The media type is the host's string — sniffed off the bytes, but a `z.string().min(1)` on
 * the wire all the same — so it is escaped like any other echoed input. The path is the
 * caller's own and is left as typed, because it is meant to be pasted back.
 */
export function renderWritten(artifact: Artifact, destination: string): string {
	const mediaType = out.escapeControlCharacters(artifact.mediaType);
	return `Wrote ${artifact.byteLength} bytes of ${mediaType} to ${destination}`;
}

/** `stat`, or `null` for anything that is not there. Never throws for a missing path. */
async function statOrNull(target: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
	try {
		return await stat(target);
	} catch {
		return null;
	}
}

/** What {@link deliverArtifact} needs to turn one verb answer into a file and an exit code. */
export interface ArtifactDelivery {
	/** Which host answered — the one key `--json` adds, and never a branch in this module. */
	readonly host: string;
	/** The verb that was asked, named in the one failure only this client can detect. */
	readonly verb: string;
	/** The host's answer, whichever of the three branches it is. */
	readonly answer: VerbCallResult;
	/** Where the bytes go, already resolved by {@link resolveDestination}. */
	readonly destination: string;
	readonly json: boolean;
}

/**
 * One verb answer, rendered and — if it carries bytes — written. Answers the exit code.
 *
 * Shared by `screenshot` and `record` rather than written twice, because the invariant that
 * matters most here is an ordering: **the write is the last thing that happens, and only on
 * the `ok` branch.** An `artifact-too-large` failure, an `unfinished-recording` failure, a
 * refusal, and a decoded length that disagrees with the host's all return or throw before
 * `writeFile` is reached, so every one of them leaves `--out` exactly as it found it — no
 * file, rather than a short one. Two copies of that ordering is one copy that can drift.
 */
export async function deliverArtifact(delivery: ArtifactDelivery): Promise<number> {
	const { host, verb, answer, destination, json } = delivery;

	if (answer.outcome !== 'ok') {
		if (json) {
			out.printJson(host, answer);
		} else {
			out.error(renderVerbAnswer(answer));
		}
		return exitCodeFor(answer);
	}

	const artifact = requireArtifact(answer.result, verb);
	const artifactPath = await writeArtifact(artifact, destination);

	if (json) {
		out.printJson(host, { ...describeWithoutBytes(answer), artifactPath });
	} else {
		out.info(renderWritten(artifact, artifactPath));
	}
	return exitCodeFor(answer);
}
