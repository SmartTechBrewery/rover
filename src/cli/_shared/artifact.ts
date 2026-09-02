/**
 * The CLI's half of D19's artifact contract: where `--out` points, and what one verb answer
 * that carries bytes prints, writes and exits with.
 *
 * **The bytes themselves are `src/client/artifact.ts`'s** — decoding them, checking what
 * decoded against what the host said it encoded, and writing the file. That module is shared
 * with the MCP server, so the check cannot be true in one client and forgotten in the other;
 * this one is the part only a CLI has, which is a destination the caller typed, a line for a
 * human and an exit code.
 *
 * **Nothing here branches on `--host`.** A capture from the daemon on this machine and one
 * from a host across the network arrive as the same field of the same schema, so they go
 * through the same functions and land on the same kind of local path — which is what makes
 * "every path returned to the agent exists on the agent's machine" a property of these
 * modules rather than of two commands remembering to agree.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { describeWithoutBytes, requireArtifact, writeArtifact } from '../../client/artifact.js';
import type { VerbCallResult } from '../../ipc/methods.js';
import type { Artifact } from '../../verbs/result.js';
import { UsageError } from './flags.js';
import * as out from './output.js';
import { exitCodeFor, renderVerbAnswer } from './verb.js';

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
	/**
	 * What the caller labelled this artifact for the **host's** archive, when it labelled it
	 * (D22, as amended #150).
	 *
	 * It reaches this module for one reason and does exactly one thing: `--json` carries it, so a
	 * script that filed a before shot and an after shot has both halves of what it asked for in
	 * one document. It is deliberately **not** on the human line, which reports the local file and
	 * is about this machine, and it is deliberately not read off the answer — no answer carries
	 * one, because a label names a copy no client is ever handed (D19).
	 */
	readonly label?: string;
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
	const { host, verb, answer, destination, json, label } = delivery;
	// Absent stays absent in the document too — no key rather than a null, which is what the
	// wire means by a label nobody supplied.
	const labelled = label === undefined ? {} : { label };

	if (answer.outcome !== 'ok') {
		if (json) {
			// On the refusal branch as well as the success one, and that is the branch it matters
			// most on: `label-without-group` is the one refusal a label can cause, and a document
			// naming what was refused beside the host's own reason is what a script reads.
			out.printJson(host, { ...answer, ...labelled });
		} else {
			out.error(renderVerbAnswer(answer));
		}
		return exitCodeFor(answer);
	}

	const artifact = requireArtifact(answer.result, verb);
	const artifactPath = await writeArtifact(artifact, destination);

	if (json) {
		out.printJson(host, { ...describeWithoutBytes(answer), ...labelled, artifactPath });
	} else {
		out.info(renderWritten(artifact, artifactPath));
	}
	return exitCodeFor(answer);
}
