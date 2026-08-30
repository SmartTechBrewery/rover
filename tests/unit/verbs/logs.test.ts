/**
 * `read_logs` over a backend that records what it was asked for.
 *
 * Three things are asserted here that a correct-looking result cannot show. **What the verb
 * asked the device for** — a bound the caller never sent must be the verb's own default and
 * not a number a backend picked. **Order** — the log is read before the after-state is
 * captured, because a post-state read first would be describing the screen before the thing
 * being investigated. And **that the payload survives the spine**: `performAction` answers
 * with an `ActionResult`, so a `logs` field silently lost on the way out would leave a
 * result that parses, reads as success, and says nothing about the device's log.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeviceBackend, LogEntry } from '@/core/device.js';
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from '@/ipc/framing.js';
import { MAX_LOG_ENTRIES } from '@/ipc/verb-methods.js';
import {
	DEFAULT_MAX_LOG_ENTRIES,
	MAX_LOG_BYTES,
	ReadLogsResultSchema,
	readLogs,
} from '@/verbs/logs.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockLogEntry,
	createMockLogRead,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

const save = createMockScreenElement({ id: 'save', text: 'Save' });
const crash = createMockLogEntry({
	level: 'error',
	tag: 'CrashReporter',
	message: 'the app that was on screen is gone',
});

interface Recording {
	readonly calls: string[];
	readonly bounds: number[];
	readonly context: ReturnType<typeof createMockVerbContext>;
}

/** A context whose backend records every call on one shared log, in order. */
function recording(logs = createMockLogRead({ entries: [crash] })): Recording {
	const calls: string[] = [];
	const bounds: number[] = [];

	const backend = createMockDeviceBackend({
		readLogs: vi.fn<DeviceBackend['readLogs']>(async (_serial, options) => {
			calls.push('readLogs');
			bounds.push(options.maxEntries);
			return logs;
		}),
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
			calls.push('readScreen');
			return [save];
		}),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async (serial) => {
			calls.push('deviceInfo');
			return createMockDeviceInfo({ serial });
		}),
	});

	return { calls, bounds, context: createMockVerbContext({ backend }) };
}

describe('read_logs', () => {
	it('answers with the entries the device gave, on top of what every verb answers with', async () => {
		const { context } = recording();

		const result = await readLogs(context);

		expect(result).toMatchObject({
			verb: 'read_logs',
			// A log read addresses no element, so there was no screen read to resolve one and
			// nothing on it to report — `null` is a fact about the verb (D12(a)).
			target: null,
			device: { serial: context.serial },
			after: { kind: 'screen' },
			logs: { entries: [crash], truncated: false },
		});
		expect(() => ReadLogsResultSchema.parse(result)).not.toThrow();
	});

	it('reads the device it was handed, with the verb’s own bound', async () => {
		const { context, bounds } = recording();

		await readLogs(context);

		expect(bounds).toEqual([DEFAULT_MAX_LOG_ENTRIES]);
		const readLogsMock = vi.mocked(context.backend.readLogs);
		expect(readLogsMock.mock.calls[0][0]).toBe(context.serial);
	});

	it('passes a caller’s bound straight through', async () => {
		const { context, bounds } = recording();

		await readLogs(context, { maxEntries: 7 });

		expect(bounds).toEqual([7]);
	});

	/**
	 * The log first, the screen after. Reversed, the "state after the action" (D12(c)) would
	 * be the state before the read — and for this verb in particular the screen is the thing
	 * the log is being consulted *because of*.
	 */
	it('reads the log before it captures the screen after it', async () => {
		const { context, calls } = recording();

		await readLogs(context);

		expect(calls).toEqual(['readLogs', 'readScreen', 'deviceInfo']);
	});

	/**
	 * `truncated` is the difference between a short read and a quiet device, and it is the
	 * backend's answer rather than something the verb decides — so it has to survive the trip
	 * through the spine unchanged.
	 */
	it('carries the truncation flag through rather than deciding it', async () => {
		const { context } = recording(createMockLogRead({ entries: [crash], truncated: true }));

		const result = await readLogs(context);

		expect(result.logs.truncated).toBe(true);
	});

	/**
	 * A device with nothing in its buffer answers with no entries, and that is a result, not a
	 * failure — `truncated: false` beside it is what says so.
	 */
	it('answers an empty log as an empty read', async () => {
		const { context } = recording(createMockLogRead({ entries: [] }));

		const result = await readLogs(context);

		expect(result.logs).toEqual({ entries: [], truncated: false });
	});

	/**
	 * `requires: []` is the honest answer for a verb built on a required interface method, so
	 * a device that cannot read its screen still reads its log — it just cannot say what was
	 * on screen afterwards, which is the `unavailable` after-state every verb shares.
	 */
	it('runs on a backend that cannot read a screen, and says so in the after-state', async () => {
		const { context } = recording();
		const screenless = createMockVerbContext({
			backend: context.backend,
			manifest: createMockCapabilityManifest({
				capabilities: createMockCapabilities({ canReadScreen: false }),
			}),
		});

		const result = await readLogs(screenless);

		expect(result.logs.entries).toEqual([crash]);
		expect(result.after).toMatchObject({ kind: 'unavailable', capability: 'canReadScreen' });
	});

	// A device that could not be read is not a device with an empty log, and the difference
	// has to reach the caller: the read rejects rather than answering nothing.
	it('lets a failed read surface rather than answering an empty log', async () => {
		const context = createMockVerbContext({
			backend: createMockDeviceBackend({
				readLogs: vi.fn<DeviceBackend['readLogs']>(async () => {
					throw new Error('device offline');
				}),
			}),
		});

		await expect(readLogs(context)).rejects.toThrow('device offline');
	});
});

/**
 * The bound that is not on entries.
 *
 * `MAX_LOG_ENTRIES` counts entries and an entry has no fixed size, so the entry bound alone
 * cannot keep an answer inside one frame. It has to, and the failure if it does not is not
 * one the caller can read: `MAX_FRAME_BYTES` is enforced on the *receiving* side, so an
 * over-sized response is `malformed_frame` on the client's decoder, every other in-flight
 * request on that connection failed with it, and the connection destroyed (PROJECT.md §6).
 *
 * These build the worst legal answer — the schema's own entry ceiling, at messages logcat
 * would actually emit — and encode it the way the daemon does.
 */
describe('a log answer is bounded in bytes, not only in entries', () => {
	/** A message the size of one logcat entry's payload — an HTTP body, a JSON response. */
	function fat(index: number): LogEntry {
		return createMockLogEntry({ tag: 'Http', message: `${index}:${'x'.repeat(2_048)}` });
	}

	/**
	 * A constant derived from another constant by hand is one the other is free to drift
	 * away from, so the relationship is asserted rather than commented — the same way
	 * `MAX_ARTIFACT_BYTES` is.
	 */
	it('keeps MAX_LOG_BYTES inside the frame cap with room for the rest of the result', () => {
		expect(MAX_LOG_BYTES).toBeLessThan(MAX_FRAME_BYTES);
		expect(MAX_LOG_BYTES * 2).toBeLessThanOrEqual(MAX_FRAME_BYTES);
	});

	it('encodes an answer at the entry ceiling into a frame the decoder accepts', async () => {
		const entries = Array.from({ length: MAX_LOG_ENTRIES }, (_, index) => fat(index));
		const context = createMockVerbContext({
			backend: createMockDeviceBackend({
				readLogs: vi.fn<DeviceBackend['readLogs']>(async () =>
					createMockLogRead({ entries, truncated: true }),
				),
			}),
		});

		const answer = await readLogs(context, { maxEntries: MAX_LOG_ENTRIES });
		const frame = encodeFrame({ protocolVersion: 1, id: 1, outcome: 'ok', result: answer });

		expect(Buffer.byteLength(frame, 'utf8')).toBeLessThan(MAX_FRAME_BYTES);
		expect(() => new FrameDecoder().push(frame)).not.toThrow();
	});

	/**
	 * Dropped, not refused, and never silently: a log read already has the word for a
	 * partial answer, and the entries kept are the newest — the end the read was asked from.
	 */
	it('drops the oldest entries to fit and says the answer was truncated', async () => {
		const entries = Array.from({ length: MAX_LOG_ENTRIES }, (_, index) => fat(index));
		const context = createMockVerbContext({
			backend: createMockDeviceBackend({
				readLogs: vi.fn<DeviceBackend['readLogs']>(async () =>
					createMockLogRead({ entries, truncated: false }),
				),
			}),
		});

		const answer = await readLogs(context, { maxEntries: MAX_LOG_ENTRIES });

		expect(answer.logs.entries.length).toBeLessThan(entries.length);
		expect(answer.logs.truncated).toBe(true);
		// The newest survived; the oldest are the ones that went.
		expect(answer.logs.entries.at(-1)).toEqual(entries.at(-1));
		expect(answer.logs.entries[0]).not.toEqual(entries[0]);
	});

	/** A read that fits is handed back untouched — no flag the device did not earn. */
	it('leaves a read that fits alone, flag included', async () => {
		const { context } = recording();

		const answer = await readLogs(context);

		expect(answer.logs).toEqual({ entries: [crash], truncated: false });
	});
});
