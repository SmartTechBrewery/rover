/**
 * The CLI's half of a verb call: rendering the two answers that are not a result, dropping
 * the payload out of the one that is, and picking the exit code for all three.
 *
 * **Rendering and exit codes only** (ai/ARCHITECTURE.md, "The adapters own translation
 * only"). Nothing here decides whether a verb should have run, what a failure means or what
 * to do next — the host decided all three and said so in words that already name the device.
 *
 * One module rather than a copy per command, because `failed` and `refused` are the same two
 * branches whatever was asked (`verbCallResultOf` in `src/ipc/verb-methods.ts` says so at
 * the schema level), and a second renderer is a second vocabulary an agent has to learn.
 */

import type { VerbCallRefusal, VerbCallResult } from '../../ipc/methods.js';
import type { RecordVideoResult } from '../../verbs/record.js';
import type { Artifact } from '../../verbs/result.js';
import { EXIT_FAILED, EXIT_OK } from './exit.js';
import * as out from './output.js';

/** An answer that carries a result — the branch an artifact can be on. */
export type VerbCallOk = Extract<VerbCallResult, { outcome: 'ok' }>;

/**
 * The host's own sentence for an answer that carries no result, on one line.
 *
 * Escaped through {@link out.escapeControlCharacters} the way `acquire`'s `renderRefusal`
 * is, and for the same reason: a verb failure quotes text off the device and strings the
 * caller supplied back into its message, and human mode is the only mode where a newline in
 * one can forge a line of its own.
 *
 * The `kind` and the `reason` are printed beside the message rather than instead of it: the
 * message says what happened, the discriminator is what an agent branches on, and printing
 * only the prose puts the second one out of a terminal's reach.
 */
export function renderVerbAnswer(answer: VerbCallRefusal): string {
	return answer.outcome === 'failed'
		? `Failed (${answer.failure.kind}): ${out.escapeControlCharacters(answer.failure.message)}`
		: `Refused (${answer.reason}): ${out.escapeControlCharacters(answer.message)}`;
}

/**
 * 0 for a verb that ran and answered, 1 for both other branches.
 *
 * A refusal and a failure share an exit code deliberately, exactly as a refused `acquire`
 * does: the host answered, and the operation did not succeed. The `--json` document is where
 * the two are told apart, because that is where a caller who needs the difference is
 * reading.
 */
export function exitCodeFor(answer: VerbCallResult): number {
	return answer.outcome === 'ok' ? EXIT_OK : EXIT_FAILED;
}

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
 * Every `ok` result this renderer may be handed — the common shape, plus the one verb whose
 * answer carries a **second** set of artifacts.
 *
 * Written as a union rather than reached for with a cast so the `in` check below narrows
 * instead of asserting: when a third verb extends `ActionResult` with bytes of its own, adding
 * it here is what makes the compiler point at {@link describeWithoutBytes} rather than letting
 * the new field arrive on stdout unnoticed.
 */
type RenderableResult = VerbCallOk['result'] | RecordVideoResult;

/** One artifact as the `--json` document describes it: what it is and how big, never bytes. */
function withoutBytes(artifact: Artifact): { mediaType: string; byteLength: number } {
	return { mediaType: artifact.mediaType, byteLength: artifact.byteLength };
}

/**
 * The `ok` answer with every base64 payload dropped and everything else — the media type, the
 * byte length, the device, the after-state — left exactly where the host put it.
 *
 * **A rendering decision the CLI owns; the protocol's shape is untouched.** By the time this
 * runs the bytes are on disk and the document carries the path to them, so echoing several
 * megabytes of base64 onto stdout would undo the one thing writing the file was for — in the
 * mode most likely to be piped into a parser. The two fields kept are named rather than
 * deleted around, so a field added to `ArtifactSchema` later has to be considered here
 * instead of silently arriving on stdout.
 *
 * **`record_video`'s frames go through the same treatment**, because they are the same kind of
 * payload on the same answer: at the byte budget they are 1.5 MiB of PNG that base64-encodes
 * to 2 MiB, and the mode that must not carry the recording must not carry them either. They
 * are *described* rather than deleted — the array stays, one `{ mediaType, byteLength }` per
 * frame — so the document still says how many were extracted and how large each one is. A
 * `--json` caller cannot read the frames from the CLI at all today (writing them to disk is
 * R14's follow-up), and a silently absent field would be indistinguishable from a host that
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
