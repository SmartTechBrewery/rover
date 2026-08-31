/**
 * **A long-but-normal call is never reported as a hang.**
 *
 * `MAX_VERB_TIMEOUT_MS` is five minutes and `DEFAULT_REQUEST_TIMEOUT_MS` is thirty seconds, so
 * the two waits and the three gestures that take a `durationMs` can be asked for more time than
 * the client gives them. Left at the default, such a call surfaces as a client-side timeout —
 * no answer, no name, and the host still working and about to say exactly what happened. So each
 * of those rows derives its own request timeout from the knob the call carries, exactly as
 * `rover record` does (`src/cli/commands/record.ts`).
 *
 * That deadline is invisible in an answer, which is why this is the one suite in
 * `tests/unit/mcp/` that does **not** use a real socket: it replaces `connectToHost` and reads
 * the request options the tool actually passed. A five-minute wait cannot be proved by waiting
 * for one, and the promise being tested is about a number, not about a device. Everything else
 * in the module graph stays real, including the params schemas the SDK validates against — so a
 * knob the schema would refuse cannot reach the assertion either.
 *
 * The second half matters as much as the first: the verb's own default is **imported** to size
 * the timeout and never put on the request, so the verb's default stays the only default there
 * is (`ReadLogsParamsSchema` and `RecordVideoParamsSchema` record the same rule for their knobs).
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MS, type IpcRequestOptions } from '@/ipc/client.js';
import { MAX_VERB_TIMEOUT_MS } from '@/ipc/methods.js';
import { INSTALL_HOOK_TIMEOUT_MS } from '@/verbs/files.js';
import { LONG_PRESS_DURATION_MS, SCROLL_DURATION_MS, SWIPE_DURATION_MS } from '@/verbs/input.js';
import {
	DEFAULT_RECORDING_MS,
	FRAME_EXTRACTION_TIMEOUT_MS,
	MAX_RECORDING_MS,
} from '@/verbs/record.js';
import { DEFAULT_WAIT_TIMEOUT_MS } from '@/verbs/wait-for.js';
import { callTool, connectMcpAgent } from '../../helpers/mcp-agent.js';

/** Every request the tools made, in order — the method, the params and the options. */
const { requests } = vi.hoisted(() => ({
	requests: [] as Array<{
		method: string;
		params: Record<string, unknown>;
		options: IpcRequestOptions | undefined;
	}>,
}));

vi.mock('@/daemon/host.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/daemon/host.js')>()),
	connectToHost: async () => ({
		request: async (
			method: string,
			params: Record<string, unknown>,
			options: IpcRequestOptions | undefined,
		) => {
			requests.push({ method, params, options });
			// Shaped like an `ok` answer, so this suite stays about the request rather than about
			// the reply. The real client is what parses one. It carries no artifact deliberately:
			// the request has already been recorded by the time the two byte-carrying tools look
			// at the answer, and a reply with bytes on it would have `record_video` write a file
			// into the operator's own artifact directory from a suite that has no temp one.
			return { outcome: 'ok', result: { verb: method, artifact: null } };
		},
		close: async () => {},
	}),
}));

const LEASE = { leaseId: 'test-lease-1' };
const TARGET = { by: 'text', text: 'Save' } as const;

const clients: Client[] = [];

async function connectAgent(): Promise<Client> {
	const client = await connectMcpAgent('local');
	clients.push(client);
	return client;
}

/** The one request a single tool call made, or a failed test. */
async function requestFrom(tool: string, args: Record<string, unknown>) {
	requests.length = 0;
	const agent = await connectAgent();
	const result = await callTool(agent, tool, { ...LEASE, ...args });
	const [only] = requests;
	if (!only) {
		throw new Error(`'${tool}' made no request: ${JSON.stringify(result.content)}`);
	}
	return only;
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	requests.length = 0;
});

/** One row per verb that can be asked to take longer than the client's own default. */
const WAITING_VERBS = [
	{ tool: 'wait_for', knob: 'timeoutMs', verbDefaultMs: DEFAULT_WAIT_TIMEOUT_MS, args: {} },
	{
		tool: 'wait_until_gone',
		knob: 'timeoutMs',
		verbDefaultMs: DEFAULT_WAIT_TIMEOUT_MS,
		args: {},
	},
	{
		tool: 'long_press',
		knob: 'durationMs',
		verbDefaultMs: LONG_PRESS_DURATION_MS,
		args: { target: TARGET },
	},
	{
		tool: 'swipe',
		knob: 'durationMs',
		verbDefaultMs: SWIPE_DURATION_MS,
		args: { from: TARGET, to: { by: 'point', at: { x: 10, y: 20 } } },
	},
	{
		tool: 'scroll',
		knob: 'durationMs',
		verbDefaultMs: SCROLL_DURATION_MS,
		args: { direction: 'down' },
	},
] as const;

/** The waits need a target and the gestures already carry theirs. */
function argsFor(row: (typeof WAITING_VERBS)[number], knobMs?: number): Record<string, unknown> {
	return {
		...(row.knob === 'timeoutMs' ? { target: TARGET } : {}),
		...row.args,
		...(knobMs === undefined ? {} : { [row.knob]: knobMs }),
	};
}

describe.each(WAITING_VERBS)('$tool, which can be asked to take a long time', (row) => {
	it('waits out the knob it was given, plus the ordinary round-trip budget', async () => {
		const asked = 120_000;

		const request = await requestFrom(row.tool, argsFor(row, asked));

		expect(request.options?.timeoutMs).toBe(asked + DEFAULT_REQUEST_TIMEOUT_MS);
		// The load-bearing inequality: this client's deadline sits *outside* the host's own, so
		// the answer always arrives as an answer.
		expect(request.options?.timeoutMs ?? 0).toBeGreaterThan(asked);
	});

	it('sizes the timeout from the verb’s own default and never sends one', async () => {
		const request = await requestFrom(row.tool, argsFor(row));

		expect(request.options?.timeoutMs).toBe(row.verbDefaultMs + DEFAULT_REQUEST_TIMEOUT_MS);
		// The whole point of the params schemas leaving the knob optional: a second default on
		// the wire is a second number free to disagree with the verb's own.
		expect(request.params).not.toHaveProperty(row.knob);
	});

	it('outlives even the longest wait the host allows', async () => {
		const request = await requestFrom(row.tool, argsFor(row, MAX_VERB_TIMEOUT_MS));

		// The host caps a verb at five minutes; a client that gave up first would turn the one
		// call most likely to be legitimately slow into a hang with no name on it.
		expect(request.options?.timeoutMs ?? 0).toBeGreaterThan(MAX_VERB_TIMEOUT_MS);
	});
});

describe('record_video, which records and then waits for the host to slice it', () => {
	it('waits out the recording, the host’s frame extraction and the round trip', async () => {
		const asked = 12_000;

		const request = await requestFrom('record_video', { durationMs: asked });

		// `rover record`'s three-term sum, term for term. Leaving the extraction out would put
		// this client's deadline *inside* the host's, so a slow decode would be reported here as
		// a nameless timeout while the host was about to say exactly what happened.
		expect(request.options?.timeoutMs).toBe(
			asked + FRAME_EXTRACTION_TIMEOUT_MS + DEFAULT_REQUEST_TIMEOUT_MS,
		);
	});

	it('sizes the timeout from the verb’s own default and never sends one', async () => {
		const request = await requestFrom('record_video', {});

		expect(request.options?.timeoutMs).toBe(
			DEFAULT_RECORDING_MS + FRAME_EXTRACTION_TIMEOUT_MS + DEFAULT_REQUEST_TIMEOUT_MS,
		);
		expect(request.params).not.toHaveProperty('durationMs');
	});

	it('outlives the longest recording the host will accept', async () => {
		const request = await requestFrom('record_video', { durationMs: MAX_RECORDING_MS });

		// The one call most likely to be legitimately slow, and the one it would be worst to
		// report as a hang: the bytes exist by then and the host is about to send them.
		expect(request.options?.timeoutMs ?? 0).toBeGreaterThan(
			MAX_RECORDING_MS + FRAME_EXTRACTION_TIMEOUT_MS,
		);
	});
});

describe('install_app, which runs a build on the host', () => {
	it('waits out the host’s whole install budget plus the round trip', async () => {
		const request = await requestFrom('install_app', {});

		// The one row with no knob: the caller does not size a project's install, the host does
		// (`INSTALL_HOOK_TIMEOUT_MS`), so both terms are imported and neither is a guess.
		expect(request.options?.timeoutMs).toBe(INSTALL_HOOK_TIMEOUT_MS + DEFAULT_REQUEST_TIMEOUT_MS);
		// The load-bearing inequality again: five minutes of compiling is not a hang, and this
		// client's deadline sits outside the host's rather than inside it.
		expect(request.options?.timeoutMs ?? 0).toBeGreaterThan(INSTALL_HOOK_TIMEOUT_MS);
	});

	it('sends the lease id and no payload — the tool has no way to carry one', async () => {
		const request = await requestFrom('install_app', {});

		// The declaration omits `packageBase64`, so the absence here is structural rather than a
		// handler remembering not to send one: this is the byte-less form, and the host reads the
		// missing key as "run what the project declared" (D13).
		expect(request.params).toEqual({ leaseId: 'test-lease-1' });
	});
});

describe('a verb that cannot outrun the default is left alone', () => {
	it.each([
		{ tool: 'tap', args: { target: TARGET } },
		{ tool: 'type_text', args: { text: 'hello' } },
		{ tool: 'press_key', args: { key: 'back' } },
		{ tool: 'read_screen', args: {} },
		{ tool: 'device_info', args: {} },
		{ tool: 'read_logs', args: {} },
		{ tool: 'launch_app', args: { appId: 'com.example.app' } },
		{ tool: 'set_wifi', args: { enabled: false } },
		{ tool: 'screenshot', args: {} },
	])('$tool passes no timeout, so the client’s own applies', async ({ tool, args }) => {
		const request = await requestFrom(tool, args);

		// Nothing invented for a call that returns when the device is done: a raised deadline
		// where none is needed is a number nobody can justify later.
		expect(request.options?.timeoutMs).toBeUndefined();
	});
});
