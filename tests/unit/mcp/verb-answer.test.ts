/**
 * The three branches of a verb answer, mapped to a tool result — `src/mcp/_shared/verb-answer.ts`
 * on its own, without a host in front of it.
 *
 * The suites beside this one drive the same mapping over a real daemon, which is where the
 * wiring is proved; what is worth asserting in isolation is what those cannot show cheaply: that
 * the whole document travels, that both non-`ok` branches are errors, and that a verb whose
 * answer carries a field beyond an `ActionResult` keeps it.
 */

import { describe, expect, it } from 'vitest';
import { parseDeviceSerial, parsePlatformId } from '@/core/ids.js';
import { verbToolResult } from '@/mcp/_shared/verb-answer.js';
import { ReadLogsResultSchema } from '@/verbs/logs.js';
import { type ActionResult, ActionResultSchema } from '@/verbs/result.js';
import { createMockDeviceInfo, createMockLogRead } from '../../helpers/factories.js';

const SERIAL = parseDeviceSerial('attached-1');

function anActionResult(verb: string): ActionResult {
	return ActionResultSchema.parse({
		verb,
		device: createMockDeviceInfo({ serial: SERIAL }),
		target: null,
		after: { kind: 'screen', elements: [] },
		artifact: null,
	});
}

/** The tool result's text blocks, joined — what a model reads. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === 'text')
		.map((block) => block.text ?? '')
		.join('\n');
}

describe('an answer that carries a result', () => {
	it('travels whole, as the host wrote it, in both halves of the tool result', () => {
		const answer = { outcome: 'ok', result: anActionResult('tap') } as const;

		const mapped = verbToolResult(answer);

		expect(mapped.isError).toBeUndefined();
		// `outcome`, the device, the target and the after-state all reach the agent where the host
		// put them: this layer owns translation only, and the after-state is how an agent knows
		// the action landed (D12(c)).
		expect(mapped.structuredContent).toEqual({ ...answer });
		expect(JSON.parse(textOf(mapped))).toMatchObject({
			outcome: 'ok',
			result: { verb: 'tap', device: { serial: SERIAL } },
		});
	});

	it('keeps a verb’s own extra field, because the mapping is generic in the payload', () => {
		const logs = createMockLogRead();
		const answer = {
			outcome: 'ok',
			result: ReadLogsResultSchema.parse({ ...anActionResult('read_logs'), logs }),
		} as const;

		const mapped = verbToolResult(answer);

		// `read_logs` is the row that would lose something to a mapping typed on `ActionResult`
		// alone — and losing it silently is exactly the failure mode.
		expect(mapped.structuredContent).toMatchObject({ result: { logs } });
	});
});

describe('an answer that carries no result', () => {
	it('makes a failure an error, leading with the host’s sentence and keeping the kind', () => {
		const failure = {
			kind: 'missing-capability',
			capability: 'canReadScreen',
			serial: SERIAL,
			platform: parsePlatformId('test-platform'),
			backendLabel: 'Test',
			message: "Device 'attached-1' cannot do 'canReadScreen'",
		} as const;

		const mapped = verbToolResult({ outcome: 'failed', failure });

		expect(mapped.isError).toBe(true);
		// The message first, so the reason is the first thing read; the structured failure
		// underneath it, so an agent can branch on `kind` rather than parse the line back apart.
		expect(textOf(mapped).startsWith(failure.message)).toBe(true);
		expect(mapped.structuredContent).toMatchObject({
			outcome: 'failed',
			failure: { kind: 'missing-capability', capability: 'canReadScreen' },
		});
	});

	it('makes a refusal an error the same way, carrying its reason', () => {
		const message = 'That lease id is not live on this host';

		const mapped = verbToolResult({ outcome: 'refused', reason: 'no-lease', message });

		// One vocabulary for both: not getting what you asked for must never read as having got
		// it, whichever of the two happened.
		expect(mapped.isError).toBe(true);
		expect(textOf(mapped).startsWith(message)).toBe(true);
		expect(mapped.structuredContent).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
	});
});
