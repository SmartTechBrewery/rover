/**
 * Turning a host's answer into what a tool call returns.
 *
 * The host's own document travels **verbatim**, twice: as a pretty-printed JSON `text` block,
 * which is what a model actually reads, and as `structuredContent`, which is what a program on
 * the other side parses. Nothing here summarises, reshapes or drops a field — this layer owns
 * translation only (ai/ARCHITECTURE.md, "The adapters own translation only"), and a client that
 * decided which parts of a refusal were worth showing would be the second opinion D16 exists to
 * prevent.
 *
 * No `outputSchema` is declared with these, deliberately. The SDK validates
 * `structuredContent` against a schema converted from a result schema's *output* type, and the
 * result schemas are full of branded transforms whose output type is not expressible as JSON
 * Schema. The document is already parsed against the real schema by `createIpcClient` before it
 * ever reaches here.
 *
 * **stdout belongs to the protocol.** The stdio transport writes its frames there, so nothing
 * under `src/mcp/` may import `src/cli/_shared/output.ts` — it prints through `console.log`, and
 * one stray line would corrupt a frame rather than appear anywhere a human sees.
 * `tests/unit/mcp/stdout.test.ts` holds that as a source scan, because silent corruption is the
 * wrong failure mode to leave to a convention.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** The host's answer as data. `JSON.stringify` escapes control characters itself. */
function asJson(document: object): string {
	return JSON.stringify(document, null, 2);
}

/** A structured answer travels as an object, which is what every `IPC_METHODS` result is. */
function asRecord(document: object): Record<string, unknown> {
	return { ...document };
}

/** The host answered, and the answer is the answer. */
export function toolAnswer(document: object): CallToolResult {
	return {
		content: [{ type: 'text', text: asJson(document) }],
		structuredContent: asRecord(document),
	};
}

/**
 * The host answered "no", as data — a busy device, a lease that ended.
 *
 * `isError` so an agent cannot read a refusal as a success, and `message` leads the text so the
 * reason is the first thing read rather than a field somewhere inside the document. The
 * document still travels whole underneath it: a refused acquire carries `heldBy`, and who holds
 * the device and for how much longer is what makes the refusal actionable.
 */
export function toolRefusal(message: string, document: object): CallToolResult {
	return {
		content: [{ type: 'text', text: `${message}\n\n${asJson(document)}` }],
		structuredContent: asRecord(document),
		isError: true,
	};
}

/**
 * Nothing came back at all — an unreachable host, a request the host rejected, a connection
 * that died mid-call. There is no document to carry, so the sentence is the whole answer.
 */
export function toolFailure(message: string): CallToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Run a tool's body, and turn anything it throws into a {@link toolFailure} naming the tool.
 *
 * The SDK already converts an uncaught throw into an error result; doing it here is what lets
 * the message carry the tool's own name, so an agent driving four of them is told *which* call
 * could not reach the host rather than being handed a bare `connect ENOENT`.
 */
export async function guarded(
	tool: string,
	run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
	try {
		return await run();
	} catch (error) {
		return toolFailure(`${tool} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
