/**
 * The three branches of a verb call's answer, as one tool result.
 *
 * `verbCallResultOf` (`src/ipc/verb-methods.ts`) says at the schema level that only the `ok`
 * branch varies between verbs: `failed` and `refused` are the same two shapes whatever was
 * asked. So this is one mapping rather than a copy per tool, and an agent driving sixteen of
 * them reads one refusal vocabulary instead of sixteen. `src/cli/_shared/verb.ts` is the same
 * three branches rendered for a human reader.
 *
 * **Nothing here decides anything the host already decided** (ai/ARCHITECTURE.md, "The
 * adapters own translation only"). Whether the verb should have run, what a failure means and
 * what to do next were all settled on the host, in words that already name the device — a
 * second opinion living in a client is how two answers start disagreeing (D16).
 *
 * **A failure and a refusal are both `isError`.** Not getting what you asked for must never
 * read as having got it: a `missing-capability` answer is the case D11 exists for, and it
 * reaches the agent as an error carrying the capability, the serial, the platform and the
 * backend's label — never as a plausible-looking empty result.
 *
 * Generic in the `ok` payload so a verb whose answer carries more than an `ActionResult`
 * (`read_logs`) travels through untouched: the whole document goes to the agent as the host
 * wrote it, and there is nothing here to widen when a verb grows a field.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VerbCallResultOf } from '../../ipc/methods.js';
import type { ActionResult } from '../../verbs/result.js';
import { toolAnswer, toolRefusal } from './answer.js';

/**
 * One verb call's answer as what the tool returns.
 *
 * The `ok` branch travels **whole** — `outcome`, the device, the resolved target and the
 * after-state all reach the agent where the host put them, because the after-state is how an
 * agent knows the action landed (D12(c)) and a client that summarised it would be dropping the
 * one field the verb exists to report.
 *
 * Both other branches lead with the host's own sentence and carry their document underneath
 * it, so an agent that wants to act rather than print can branch on `failure.kind` or on
 * `reason` without parsing the line back apart.
 */
export function verbToolResult<Result extends ActionResult>(
	answer: VerbCallResultOf<Result>,
): CallToolResult {
	return answer.outcome === 'ok'
		? toolAnswer(answer)
		: toolRefusal(answer.outcome === 'failed' ? answer.failure.message : answer.message, answer);
}
