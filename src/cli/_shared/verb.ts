/**
 * The CLI's half of a verb call: rendering the two answers that are not a result, and picking
 * the exit code for all three.
 *
 * **Rendering and exit codes only** (ai/ARCHITECTURE.md, "The adapters own translation
 * only"). Nothing here decides whether a verb should have run, what a failure means or what
 * to do next — the host decided all three and said so in words that already name the device.
 *
 * One module rather than a copy per command, because `failed` and `refused` are the same two
 * branches whatever was asked (`verbCallResultOf` in `src/ipc/verb-methods.ts` says so at
 * the schema level), and a second renderer is a second vocabulary an agent has to learn.
 *
 * What a client does with an `ok` answer's **bytes** is not here at all: that half is
 * `src/client/artifact.ts`, shared with the MCP server, because the check it performs must
 * not be true in one client and forgotten in the other.
 */

import type { VerbCallRefusal, VerbCallResult } from '../../ipc/methods.js';
import { EXIT_FAILED, EXIT_OK } from './exit.js';
import * as out from './output.js';

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
