/**
 * The client half of D19's artifact contract, **shared by both adapters**.
 *
 * A verb runs on the host and its bytes arrive base64-encoded, because a host-local path
 * either names nothing on this machine or names something else entirely
 * (`src/verbs/result.ts`, `ArtifactSchema`). What is left is the other end of that wire, and
 * it is the same at both ends: decode, check what decoded against what the host said it
 * encoded, write it **here**, and say what the answer carries without repeating the bytes.
 *
 * **One module rather than one per client**, which is the whole reason this file exists
 * outside `src/cli/`. `src/cli/_shared/artifact.ts` had all of it when the CLI was the only
 * client that had ever decoded an artifact; the MCP server is the second, and it cannot
 * import from `src/cli/` at all — that tree prints through `console.log`, which on a stdio
 * transport corrupts a frame (`tests/unit/mcp/stdout.test.ts`). Two copies of the length
 * check is one copy free to be true in one client and forgotten in the other, and the failure
 * it catches — a short file that announces nothing — is invisible to whoever is holding it.
 *
 * **Nothing here branches on which host answered.** A capture from the daemon on this machine
 * and one from a host across the network arrive as the same field of the same schema, so they
 * go through the same functions and land on the same kind of local path — which is what makes
 * "every path returned to the agent exists on the agent's machine" a property of this module
 * rather than of every command and every tool remembering to agree.
 *
 * What stays with each adapter is what each adapter alone owns: the CLI's `--out` resolution,
 * its rendering and its exit codes (`src/cli/_shared/`), and the MCP server's artifact
 * directory and content blocks (`src/mcp/_shared/artifact.ts`).
 */

import { writeFile } from 'node:fs/promises';
import type { VerbCallResult } from '../ipc/methods.js';
import type { RecordVideoResult } from '../verbs/record.js';
import type { Artifact } from '../verbs/result.js';

/** An answer that carries a result — the branch an artifact can be on. */
export type VerbCallOk = Extract<VerbCallResult, { outcome: 'ok' }>;

/**
 * The bytes an `ok` answer from a verb declared to produce them must carry.
 *
 * `ActionResult.artifact` is required-and-nullable for every verb, because nearly all of
 * them produce nothing (`src/verbs/result.ts`). For `screenshot` and `record_video` a null
 * there is not an empty capture — it is a host that answered `ok` without doing the one
 * thing the verb exists for — so it is said out loud rather than written to disk as a
 * zero-byte file the caller would open and puzzle over.
 */
export function requireArtifact(result: VerbCallOk['result'], verb: string): Artifact {
	if (result.artifact === null) {
		throw new Error(
			`The host answered '${verb}' with no bytes at all. That is a host bug rather than an ` +
				`empty capture: this verb's whole answer is its artifact, so there is nothing to ` +
				`write. Nothing was written.`,
		);
	}
	return result.artifact;
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
 * so the CLI's dispatcher answers exit 1 and the MCP server's `guarded` answers `isError`.
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
 * Every `ok` result a client may be asked to describe — the common shape, plus the one verb
 * whose answer carries a **second** set of artifacts.
 *
 * Written as a union rather than reached for with a cast so the `in` check below narrows
 * instead of asserting: when a third verb extends `ActionResult` with bytes of its own, adding
 * it here is what makes the compiler point at {@link describeWithoutBytes} rather than letting
 * the new field arrive on stdout, or in a tool's structured answer, unnoticed.
 */
type RenderableResult = VerbCallOk['result'] | RecordVideoResult;

/** One artifact as a document describes it: what it is and how big, never bytes. */
function withoutBytes(artifact: Artifact): { mediaType: string; byteLength: number } {
	return { mediaType: artifact.mediaType, byteLength: artifact.byteLength };
}

/**
 * The `ok` answer with every base64 payload dropped and everything else — the media type, the
 * byte length, the device, the after-state — left exactly where the host put it.
 *
 * **A rendering decision the clients own; the protocol's shape is untouched.** By the time
 * this runs the bytes have gone where that client sends them — a file for `rover screenshot
 * --json`, an inline image block for the `screenshot` tool — so repeating several megabytes of
 * base64 in the document beside them would undo the one thing that was for, in the form most
 * likely to be piped into a parser or read by a model. The two fields kept are named rather
 * than deleted around, so a field added to `ArtifactSchema` later has to be considered here
 * instead of silently arriving in both clients' output.
 *
 * **`record_video`'s frames go through the same treatment**, because they are the same kind of
 * payload on the same answer: at the byte budget they are 1.5 MiB of PNG that base64-encodes
 * to 2 MiB. They are *described* rather than deleted — the array stays, one
 * `{ mediaType, byteLength }` per frame — so the document still says how many were extracted
 * and how large each one is, and a silently absent field is never confused with a host that
 * extracted nothing.
 */
export function describeWithoutBytes(answer: VerbCallOk): object {
	return { ...answer, result: describeResultWithoutBytes(answer.result) };
}

/**
 * The result half of {@link describeWithoutBytes}, taken as a parameter of the union type so
 * the `in` check below is a narrowing rather than a widening of `ActionResult`.
 */
function describeResultWithoutBytes(result: RenderableResult): object {
	const { artifact } = result;
	return {
		...result,
		artifact: artifact === null ? null : withoutBytes(artifact),
		...('frames' in result ? { frames: result.frames.map(withoutBytes) } : {}),
	};
}
