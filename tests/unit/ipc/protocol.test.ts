import { describe, expect, it } from 'vitest';
import { StatusParamsSchema, StatusResultSchema } from '@/ipc/methods.js';
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

describe('IpcRequestError', () => {
	it('carries the code, so a caller branches on it rather than on the message', () => {
		const error = new IpcRequestError('unknown_method', 'No such method');

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('IpcRequestError');
		expect(error.code).toBe('unknown_method');
	});
});
