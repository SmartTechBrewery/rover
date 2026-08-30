import { describe, expect, it } from 'vitest';
import {
	AppVerbParamsSchema,
	LongPressParamsSchema,
	MAX_LOG_ENTRIES,
	MAX_VERB_TIMEOUT_MS,
	ReadLogsParamsSchema,
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

/**
 * The three app rows' params, at the boundary rather than at the backend.
 *
 * One schema serves all three, so this is one `describe` rather than three near-copies —
 * and the reverse-DNS shape is checked *here* so a malformed id is `invalid_params` a caller
 * can read, instead of an `InvalidIdError` thrown deep inside a backend building a
 * device-side command line out of it.
 */
describe('app verb params schemas', () => {
	it('parses a well-formed call and brands the app id', () => {
		const parsed = AppVerbParamsSchema.parse({
			leaseId: 'lease-1',
			appId: 'com.android.settings',
		});

		expect(parsed.appId).toBe('com.android.settings');
		expect(parsed.leaseId).toBe('lease-1');
	});

	it('takes a two-segment id, which is the shortest reverse-DNS name there is', () => {
		expect(
			AppVerbParamsSchema.safeParse({ leaseId: 'lease-1', appId: 'com.example' }).success,
		).toBe(true);
	});

	it.each([
		['a name with no domain in it', 'notreversedns'],
		['an empty id', ''],
		['a leading dot', '.leading'],
		['a trailing dot', 'com.example.'],
		['a segment starting with a digit', 'com.1example'],
		// Not a blocklist of metacharacters — the shape simply does not admit one, which is what
		// keeps an id from becoming a second command on the device (`src/core/ids.ts`).
		['a shell command riding along', 'com.example; rm -rf /'],
	])('rejects %s', (_label, appId) => {
		expect(AppVerbParamsSchema.safeParse({ leaseId: 'lease-1', appId }).success).toBe(false);
	});

	it.each([
		['a serial beside the lease id', { serial: 'emulator-5554' }],
		['a package path this row does not install', { packagePath: '/tmp/app.apk' }],
		['a wait timeout on a verb that does not wait', { timeoutMs: 1_000 }],
	])('rejects %s rather than silently stripping it', (_label, extra) => {
		// The serial case is the load-bearing one: the lease id is the credential and the host
		// derives the device from it (D20), so a serial accepted here would let the holder of one
		// lease drive another device.
		expect(
			AppVerbParamsSchema.safeParse({
				leaseId: 'lease-1',
				appId: 'com.android.settings',
				...extra,
			}).success,
		).toBe(false);
	});

	it('needs both the lease id and the app id', () => {
		expect(AppVerbParamsSchema.safeParse({ leaseId: 'lease-1' }).success).toBe(false);
		expect(AppVerbParamsSchema.safeParse({ appId: 'com.android.settings' }).success).toBe(false);
	});
});

/**
 * The one row whose call carries a bound rather than a target.
 *
 * `maxEntries` is **absent by default on purpose**: the verb owns the default
 * (`src/verbs/logs.ts`), and a params schema that defaulted it here would be a second place
 * that number is decided — which is how two callers end up reading different amounts of a
 * device's log while both believe they asked for the same thing.
 */
describe('read_logs params schema', () => {
	it('parses a call that names only the lease, leaving the bound to the verb', () => {
		const parsed = ReadLogsParamsSchema.parse({ leaseId: 'lease-1' });

		expect(parsed.leaseId).toBe('lease-1');
		expect(parsed.maxEntries).toBeUndefined();
	});

	it('takes a bound a caller did ask for', () => {
		expect(ReadLogsParamsSchema.parse({ leaseId: 'lease-1', maxEntries: 50 }).maxEntries).toBe(50);
		expect(ReadLogsParamsSchema.parse({ leaseId: 'lease-1', maxEntries: MAX_LOG_ENTRIES })).toEqual(
			{ leaseId: 'lease-1', maxEntries: MAX_LOG_ENTRIES },
		);
	});

	it.each([
		// Zero entries is a read that answers nothing — a caller asking for it means something
		// else, and being told so beats being handed an empty log.
		['no entries at all', 0],
		['a negative bound', -1],
		['a fraction of an entry', 1.5],
		// The host reads, parses and encodes this many entries on a peer's behalf, so the
		// ceiling is allocation hygiene rather than taste.
		['more than the host will read', MAX_LOG_ENTRIES + 1],
	])('rejects %s', (_label, maxEntries) => {
		expect(ReadLogsParamsSchema.safeParse({ leaseId: 'lease-1', maxEntries }).success).toBe(false);
	});

	it.each([
		['a serial beside the lease id', { serial: 'emulator-5554' }],
		// The two knobs this row deliberately does not have: a follow is a wait with no
		// condition and a stream over IPC, and neither arrives as a silently ignored key.
		['a request to follow the log', { follow: true }],
		['a tag filter', { tag: 'AndroidRuntime' }],
	])('rejects %s rather than silently stripping it', (_label, extra) => {
		expect(ReadLogsParamsSchema.safeParse({ leaseId: 'lease-1', ...extra }).success).toBe(false);
	});

	it('needs the lease id, which is the credential', () => {
		expect(ReadLogsParamsSchema.safeParse({ maxEntries: 10 }).success).toBe(false);
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
