import { describe, expect, it } from 'vitest';
import {
	LongPressParamsSchema,
	MAX_VERB_TIMEOUT_MS,
	ScrollParamsSchema,
	StatusParamsSchema,
	StatusResultSchema,
	SwipeParamsSchema,
	TapParamsSchema,
} from '@/ipc/methods.js';
import {
	IpcRequestError,
	PROTOCOL_VERSION,
	RequestEnvelopeSchema,
	ResponseSchema,
} from '@/ipc/protocol.js';

describe('request envelope', () => {
	it('parses a well-formed request', () => {
		const parsed = RequestEnvelopeSchema.parse({
			protocolVersion: PROTOCOL_VERSION,
			id: 'req-1',
			method: 'status',
			params: {},
		});

		expect(parsed).toEqual({
			protocolVersion: PROTOCOL_VERSION,
			id: 'req-1',
			method: 'status',
			params: {},
		});
	});

	it.each([
		['a missing id', { protocolVersion: 1, method: 'status', params: {} }],
		['an empty id', { protocolVersion: 1, id: '', method: 'status', params: {} }],
		['a non-string method', { protocolVersion: 1, id: 'a', method: 7, params: {} }],
		['an empty method', { protocolVersion: 1, id: 'a', method: '', params: {} }],
		[
			'a method past the length bound',
			{ protocolVersion: 1, id: 'a', method: 'z'.repeat(129), params: {} },
		],
		['an id past the length bound', { protocolVersion: 1, id: 'a'.repeat(129), method: 'status' }],
		['a missing version', { id: 'a', method: 'status', params: {} }],
	])('rejects %s', (_label, frame) => {
		expect(RequestEnvelopeSchema.safeParse(frame).success).toBe(false);
	});

	it('accepts any integer version, so a mismatch is reportable rather than malformed', () => {
		// The version check is a separate step in the server: parsing has to get far enough
		// to say "unsupported version" instead of "unreadable frame".
		expect(
			RequestEnvelopeSchema.safeParse({
				protocolVersion: 99,
				id: 'a',
				method: 'status',
				params: {},
			}).success,
		).toBe(true);
	});

	/**
	 * The canary of D17. This test exists to fail the day someone adds a socket path, a peer
	 * uid, a hostname or a timestamp to the wire: every one of them assumes the client shares
	 * a filesystem, a user or a clock with the host, and a client on another machine shares
	 * none of the three. If a field genuinely has to be added, that is a protocol decision —
	 * change this list deliberately, with the reasoning, not as a side effect.
	 */
	it('carries exactly four fields, and no path, uid or timestamp', () => {
		expect(Object.keys(RequestEnvelopeSchema.shape)).toEqual([
			'protocolVersion',
			'id',
			'method',
			'params',
		]);
	});

	it('strips an unknown field, so a smuggled path can never reach a handler', () => {
		const parsed = RequestEnvelopeSchema.parse({
			protocolVersion: PROTOCOL_VERSION,
			id: 'req-1',
			method: 'status',
			params: {},
			socketPath: '/tmp/rover.sock',
		});

		expect(parsed).not.toHaveProperty('socketPath');
	});
});

describe('response union', () => {
	it('discriminates a result from an error', () => {
		const result = ResponseSchema.parse({
			type: 'result',
			protocolVersion: PROTOCOL_VERSION,
			id: 'req-1',
			result: { anything: true },
		});
		const failure = ResponseSchema.parse({
			type: 'error',
			protocolVersion: PROTOCOL_VERSION,
			id: 'req-1',
			error: { code: 'unknown_method', message: 'nope' },
		});

		expect(result.type).toBe('result');
		expect(failure.type).toBe('error');
	});

	it('allows a null id only on the error variant', () => {
		expect(
			ResponseSchema.safeParse({
				type: 'error',
				protocolVersion: PROTOCOL_VERSION,
				id: null,
				error: { code: 'malformed_frame', message: 'bad' },
			}).success,
		).toBe(true);

		expect(
			ResponseSchema.safeParse({
				type: 'result',
				protocolVersion: PROTOCOL_VERSION,
				id: null,
				result: {},
			}).success,
		).toBe(false);
	});

	it('rejects an unknown error code and an empty message', () => {
		const base = { type: 'error', protocolVersion: PROTOCOL_VERSION, id: 'a' };

		expect(
			ResponseSchema.safeParse({ ...base, error: { code: 'kaboom', message: 'x' } }).success,
		).toBe(false);
		expect(
			ResponseSchema.safeParse({ ...base, error: { code: 'internal_error', message: '' } }).success,
		).toBe(false);
	});
});

describe('status method schemas', () => {
	it('rejects an unexpected param, rather than ignoring it', () => {
		expect(StatusParamsSchema.safeParse({ unexpected: 1 }).success).toBe(false);
	});

	it('accepts a well-formed result', () => {
		expect(
			StatusResultSchema.parse({ protocolVersion: PROTOCOL_VERSION, pid: 42, uptimeMs: 0 }),
		).toEqual({ protocolVersion: PROTOCOL_VERSION, pid: 42, uptimeMs: 0 });
	});

	it.each([
		['a negative uptime', { protocolVersion: PROTOCOL_VERSION, pid: 42, uptimeMs: -1 }],
		['a zero pid', { protocolVersion: PROTOCOL_VERSION, pid: 0, uptimeMs: 1 }],
		['a wrong protocol version', { protocolVersion: 2, pid: 42, uptimeMs: 1 }],
	])('rejects %s', (_label, result) => {
		expect(StatusResultSchema.safeParse(result).success).toBe(false);
	});

	it('reports a duration, not an instant, so no clock is shared with the caller', () => {
		expect(Object.keys(StatusResultSchema.shape)).toEqual(['protocolVersion', 'pid', 'uptimeMs']);
	});
});

/**
 * The gesture rows' params, at the boundary rather than at the verb.
 *
 * What is asserted here is mostly what they **refuse**, because every one of those refusals is
 * otherwise a silent answer: a wait knob on a verb that does not wait, a direction nobody
 * implements, or a target field that would quietly match everything on the screen.
 */
describe('gesture verb params schemas', () => {
	it('takes a coordinate for a tap, which the waits cannot be asked for', () => {
		expect(
			TapParamsSchema.parse({ leaseId: 'lease-1', target: { by: 'point', at: { x: 1, y: 2 } } })
				.target.by,
		).toBe('point');
	});

	it.each([
		['a wait timeout on a verb that does not wait', { timeoutMs: 1_000 }],
		['a poll interval on a verb that does not poll', { pollIntervalMs: 100 }],
		['a typo for the target', { targets: { by: 'text', text: 'Save' } }],
	])('rejects %s', (_label, extra) => {
		expect(
			TapParamsSchema.safeParse({
				leaseId: 'lease-1',
				target: { by: 'text', text: 'Save' },
				...extra,
			}).success,
		).toBe(false);
	});

	it('bounds a gesture duration the way a wait is bounded, and allows a flick', () => {
		const call = { leaseId: 'lease-1', target: { by: 'text', text: 'Save' } };

		expect(LongPressParamsSchema.safeParse({ ...call, durationMs: 0 }).success).toBe(true);
		expect(LongPressParamsSchema.safeParse({ ...call, durationMs: -1 }).success).toBe(false);
		expect(
			LongPressParamsSchema.safeParse({ ...call, durationMs: MAX_VERB_TIMEOUT_MS + 1 }).success,
		).toBe(false);
	});

	it('needs both ends of a swipe, and takes one target for neither', () => {
		const from = { by: 'text', text: 'Save' } as const;

		expect(SwipeParamsSchema.safeParse({ leaseId: 'lease-1', from, to: from }).success).toBe(true);
		expect(SwipeParamsSchema.safeParse({ leaseId: 'lease-1', from }).success).toBe(false);
		expect(SwipeParamsSchema.safeParse({ leaseId: 'lease-1', target: from }).success).toBe(false);
	});

	it('scrolls in one of four directions and in no other', () => {
		expect(ScrollParamsSchema.safeParse({ leaseId: 'lease-1', direction: 'down' }).success).toBe(
			true,
		);
		expect(
			ScrollParamsSchema.safeParse({ leaseId: 'lease-1', direction: 'sideways' }).success,
		).toBe(false);
		expect(ScrollParamsSchema.safeParse({ leaseId: 'lease-1' }).success).toBe(false);
	});

	it('refuses a coordinate as the region a scroll happens in', () => {
		// A point has no extent, so it cannot say how far a scroll may travel — the type says so
		// and this is the boundary saying the same thing to a caller that ignored it.
		expect(
			ScrollParamsSchema.safeParse({
				leaseId: 'lease-1',
				direction: 'down',
				target: { by: 'point', at: { x: 1, y: 2 } },
			}).success,
		).toBe(false);
	});
});

describe('IpcRequestError', () => {
	it('carries the code, so a caller branches on it rather than on the message', () => {
		const error = new IpcRequestError('unknown_method', 'No such method');

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('IpcRequestError');
		expect(error.code).toBe('unknown_method');
	});
});
