/**
 * Every shape this layer produces has to survive the trip to another machine (D19, R21).
 *
 * A live handle, a byte buffer or a host-local path in a result is a bug that a local test
 * run never notices: `JSON.stringify` quietly turns a `Uint8Array` into an object of
 * numeric keys and drops a function entirely, so the value still "works" right up to the
 * point where the client is somewhere else. So the check is a round trip **plus** a walk
 * over the graph for the three shapes that survive one while meaning nothing on the far
 * side.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeviceBackend } from '@/core/device.js';
import { UnsupportedTextError, WaitTimeoutError } from '@/core/errors.js';
import { parseAppId } from '@/core/ids.js';
import {
	AppVerbParamsSchema,
	DeviceInfoParamsSchema,
	EnvironmentVerbParamsSchema,
	LongPressParamsSchema,
	PressKeyParamsSchema,
	ReadLogsCallResultSchema,
	ReadLogsParamsSchema,
	ReadScreenParamsSchema,
	ScreenshotParamsSchema,
	ScrollParamsSchema,
	SwipeParamsSchema,
	TapParamsSchema,
	TypeTextParamsSchema,
	VerbCallResultSchema,
} from '@/ipc/verb-methods.js';
import { launchApp } from '@/verbs/app.js';
import { capabilityMethod, type VerbContext } from '@/verbs/context.js';
import { toVerbFailure } from '@/verbs/failure.js';
import { pressKey, scroll, tap, typeText } from '@/verbs/input.js';
import { ReadLogsResultSchema, readLogs } from '@/verbs/logs.js';
import { performAction } from '@/verbs/perform.js';
import { deviceInfo, readScreen, screenshot } from '@/verbs/read.js';
import {
	type ActionResult,
	ActionResultSchema,
	AfterStateSchema,
	ArtifactSchema,
	ResolvedTargetSchema,
} from '@/verbs/result.js';
import { TargetSchema } from '@/verbs/target.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

const save = createMockScreenElement({ id: 'save', text: 'Save' });

function roundTrip<T>(value: T): unknown {
	return JSON.parse(JSON.stringify(value));
}

function contextShowingSave(): VerbContext {
	return createMockVerbContext({
		backend: createMockDeviceBackend({
			readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => [save]),
		}),
	});
}

async function fakeTapResult(context: VerbContext): Promise<ActionResult> {
	return performAction(context, {
		verb: 'fake_tap',
		requires: ['canInput'],
		target: { by: 'text', text: 'Save' },
		act: async (target) => {
			const tap = capabilityMethod(context, 'canInput', 'tap');
			await tap(context.serial, target?.point ?? { x: 0, y: 0 });
		},
	});
}

/** Everything in `value` that would not mean the same thing on the agent's machine. */
function unserializableParts(value: unknown, path = '$'): string[] {
	if (value === null || value === undefined) {
		return [];
	}
	if (typeof value === 'function') {
		return [`${path}: a function`];
	}
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		return [`${path}: raw bytes`];
	}
	if (typeof value === 'string') {
		return value.startsWith('/') ? [`${path}: a host-local path ('${value}')`] : [];
	}
	if (Array.isArray(value)) {
		return value.flatMap((entry, at) => unserializableParts(entry, `${path}[${at}]`));
	}
	if (typeof value === 'object') {
		return Object.entries(value).flatMap(([key, entry]) =>
			unserializableParts(entry, `${path}.${key}`),
		);
	}
	return [];
}

describe('the verb layer speaks only in plain data', () => {
	it('round-trips an ActionResult and re-parses it equal', async () => {
		const result = await fakeTapResult(contextShowingSave());

		expect(ActionResultSchema.parse(roundTrip(result))).toEqual(result);
	});

	it('carries no live handle, no bytes and no host-local path in an ActionResult', async () => {
		const result = await fakeTapResult(contextShowingSave());

		expect(unserializableParts(result)).toEqual([]);
	});

	it('round-trips the unavailable after-state, which is the branch a screenless device answers', async () => {
		const context = createMockVerbContext({
			manifest: createMockCapabilityManifest({
				capabilities: createMockCapabilities({ canReadScreen: false }),
			}),
		});

		const result = await performAction(context, {
			verb: 'fake_key_press',
			requires: ['canInput'],
			act: async () => {},
		});

		expect(ActionResultSchema.parse(roundTrip(result))).toEqual(result);
		expect(unserializableParts(result)).toEqual([]);
	});

	it.each([
		['a text target', { by: 'text', text: 'Save', exact: true, index: 1 }],
		['an element target', { by: 'element', id: 'save' }],
		['a point target', { by: 'point', at: { x: 1.5, y: 2.5 } }],
	])('round-trips %s', (_name, target) => {
		const parsed = TargetSchema.parse(target);

		expect(TargetSchema.parse(roundTrip(parsed))).toEqual(parsed);
	});

	it('rejects a target with an unknown field rather than matching everything on screen', () => {
		expect(() => TargetSchema.parse({ by: 'text', text: 'Save', exactly: true })).toThrow();
		expect(() => TargetSchema.parse({ by: 'point', at: { x: 1, y: 2 }, index: 0 })).toThrow();
	});

	it('round-trips a real gesture result, not only the spine driven by a fake action', async () => {
		const context = contextShowingSave();

		const tapped = await tap(context, { by: 'text', text: 'Save' });
		const scrolled = await scroll(context, 'down');

		expect(ActionResultSchema.parse(roundTrip(tapped))).toEqual(tapped);
		expect(ActionResultSchema.parse(roundTrip(scrolled))).toEqual(scrolled);
		expect(unserializableParts(tapped)).toEqual([]);
		// A scroll addresses no element unless it was given a region, and `null` survives the
		// trip where an absent key would not.
		expect(scrolled.target).toBeNull();
		expect(unserializableParts(scrolled)).toEqual([]);
	});

	it('round-trips the two input verbs that address no element, whose target is null', async () => {
		const context = contextShowingSave();

		const typed = await typeText(context, 'zażółć 🙂  %s');
		const pressed = await pressKey(context, 'home');

		expect(ActionResultSchema.parse(roundTrip(typed))).toEqual(typed);
		expect(ActionResultSchema.parse(roundTrip(pressed))).toEqual(pressed);
		// `null` survives the trip where an absent key would not, which is why these results
		// carry one rather than leaving `target` off.
		expect(typed.target).toBeNull();
		expect(pressed.target).toBeNull();
		expect(unserializableParts(typed)).toEqual([]);
		expect(unserializableParts(pressed)).toEqual([]);
	});

	it('round-trips an app verb result, which addresses a package rather than a screen', async () => {
		const context = contextShowingSave();

		const launched = await launchApp(context, parseAppId('com.android.settings'));

		expect(ActionResultSchema.parse(roundTrip(launched))).toEqual(launched);
		// A branded app id is a plain string on the wire, and the target is `null` because this
		// verb addressed no element — `null` survives the trip where an absent key would not.
		expect(launched.target).toBeNull();
		expect(unserializableParts(launched)).toEqual([]);
	});

	/**
	 * The one verb whose answer carries more than an `ActionResult`, and the only shape here
	 * that could smuggle something across the boundary in a field the common schema does not
	 * describe. A log entry's `timestamp` is the device's own **string** for exactly this
	 * reason: the client shares no clock with the device (D17), so there is no instant here
	 * to be misread on the far side.
	 */
	it('round-trips a read_logs result, payload and all', async () => {
		const context = contextShowingSave();

		const read = await readLogs(context, { maxEntries: 3 });

		expect(ReadLogsResultSchema.parse(roundTrip(read))).toEqual(read);
		expect(read.logs.entries.length).toBeGreaterThan(0);
		expect(unserializableParts(read)).toEqual([]);

		// The common half is an `ActionResult` field for field, which is what lets the verb
		// layer, the after-state and D14 stay one shape across every verb. The *schema* is
		// `.strict()`, so it rejects the extra key rather than dropping it — a client parses
		// with the row's own schema, and what the two share is the shape, not the parser.
		const { logs, ...common } = read;
		expect(ActionResultSchema.parse(roundTrip(common))).toEqual(common);
		expect(() => ActionResultSchema.parse(roundTrip(read))).toThrow();
		expect(logs.truncated).toBe(false);
	});

	it('round-trips read verb results, whose answers are state rather than an action', async () => {
		const context = contextShowingSave();
		const read = await readScreen(context);
		const info = await deviceInfo(context);

		expect(ActionResultSchema.parse(roundTrip(read))).toEqual(read);
		expect(ActionResultSchema.parse(roundTrip(info))).toEqual(info);
		expect(read.after).toMatchObject({ kind: 'screen', elements: [save] });
		expect(read.target).toBeNull();
		expect(info.target).toBeNull();
		expect(unserializableParts(read)).toEqual([]);
		expect(unserializableParts(info)).toEqual([]);
	});

	/**
	 * The guard this file exists for, on the one verb that has bytes to lose.
	 *
	 * A `Uint8Array` handed straight into a result would pass a local test and arrive at a
	 * client on another machine as an object of numeric keys; a host-local path would pass
	 * both and name the wrong file. The walk below rejects either, and the round trip proves
	 * the base64 form survives the trip the raw bytes would not have.
	 */
	it('round-trips a screenshot result, whose answer is bytes rather than a state', async () => {
		const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
		const context = createMockVerbContext({
			backend: createMockDeviceBackend({
				readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => [save]),
				screenshot: vi.fn<DeviceBackend['screenshot']>(async () => bytes),
			}),
		});

		const shot = await screenshot(context);

		expect(ActionResultSchema.parse(roundTrip(shot))).toEqual(shot);
		// No raw bytes, no function, and no string that looks like somewhere on this host.
		expect(unserializableParts(shot)).toEqual([]);
		// And the payload really made the trip: what comes back out of the JSON decodes to the
		// bytes that went in, rather than to an object of numeric keys.
		const parsed = ActionResultSchema.parse(roundTrip(shot));
		expect(parsed.artifact?.base64).toBe(Buffer.from(bytes).toString('base64'));
		expect(parsed.artifact?.byteLength).toBe(bytes.byteLength);
	});

	it('carries artifact: null on every verb that produced no bytes', async () => {
		const context = contextShowingSave();

		const tapped = await tap(context, { by: 'text', text: 'Save' });
		const read = await readScreen(context);

		// `null` rather than an absent key, for the reason `heldBy: null` is: `undefined` does
		// not survive JSON, so an optional field would make "no bytes" something every client
		// has to special-case instead of a value it can read.
		expect(tapped.artifact).toBeNull();
		expect(read.artifact).toBeNull();
		expect(roundTrip(read)).toMatchObject({ artifact: null });
	});

	it('rejects a result carrying raw bytes where the artifact belongs', () => {
		const good = ArtifactSchema.parse({ mediaType: 'image/png', base64: 'AQID', byteLength: 3 });

		expect(ArtifactSchema.parse(roundTrip(good))).toEqual(good);
		// The shape the whole artifact exists to keep out of a result — and the one a local
		// round trip would not have caught.
		expect(() =>
			ArtifactSchema.parse({ mediaType: 'image/png', bytes: new Uint8Array([1]), byteLength: 1 }),
		).toThrow();
		// And a path is not an artifact, whatever else is beside it (D19).
		expect(() =>
			ArtifactSchema.parse({
				mediaType: 'image/png',
				base64: 'AQID',
				byteLength: 3,
				path: '/tmp/rover/shot.png',
			}),
		).toThrow();
	});

	it('round-trips a resolved target and a screen after-state on their own', () => {
		const resolved = ResolvedTargetSchema.parse({
			source: 'screen',
			point: { x: 60, y: 40 },
			element: save,
		});
		const after = AfterStateSchema.parse({ kind: 'screen', elements: [save] });

		expect(ResolvedTargetSchema.parse(roundTrip(resolved))).toEqual(resolved);
		expect(AfterStateSchema.parse(roundTrip(after))).toEqual(after);
	});

	it('round-trips the failed after-state, which is the branch a read that rejected answers', async () => {
		let reads = 0;
		const context = createMockVerbContext({
			backend: createMockDeviceBackend({
				readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
					reads += 1;
					if (reads > 1) {
						throw new Error('device offline');
					}
					return [save];
				}),
			}),
		});

		const result = await fakeTapResult(context);

		expect(result.after.kind).toBe('failed');
		expect(ActionResultSchema.parse(roundTrip(result))).toEqual(result);
		expect(unserializableParts(result)).toEqual([]);
	});

	it('rejects an after-state naming a capability that does not exist', () => {
		expect(() =>
			AfterStateSchema.parse({ kind: 'unavailable', capability: 'canTeleport', message: 'no' }),
		).toThrow();
	});

	it('catches an unserializable value, so a green walk is not a vacuous one', () => {
		expect(unserializableParts({ bytes: new Uint8Array([1]) })).toEqual(['$.bytes: raw bytes']);
		expect(unserializableParts({ at: () => 1 })).toEqual(['$.at: a function']);
		expect(unserializableParts({ path: '/tmp/rover/shot.png' })).toEqual([
			"$.path: a host-local path ('/tmp/rover/shot.png')",
		]);
	});
});

/**
 * The same walk over the shape that actually crosses the socket (R21).
 *
 * `ActionResult` being plain data is necessary and not sufficient: what a client receives is
 * a `VerbCallResult`, and a host-local path or a byte buffer smuggled into a *failure* — the
 * branch nobody looks at twice — would cross the same boundary and fail the same way.
 */
describe('a verb call answers in plain data too', () => {
	it('round-trips the ok branch and re-parses it equal', async () => {
		const answer = { outcome: 'ok', result: await fakeTapResult(contextShowingSave()) } as const;

		expect(VerbCallResultSchema.parse(roundTrip(answer))).toEqual(answer);
		expect(unserializableParts(answer)).toEqual([]);
	});

	it('round-trips the failed branch and re-parses it equal', () => {
		const failure = toVerbFailure(
			new WaitTimeoutError("text containing 'Save'", 'an empty screen', 5_000, 21),
		);
		const answer = { outcome: 'failed', failure } as const;

		expect(VerbCallResultSchema.parse(roundTrip(answer))).toEqual(answer);
		expect(unserializableParts(answer)).toEqual([]);
	});

	it("round-trips a failure carrying a caller's own string, unchanged", () => {
		const failure = toVerbFailure(
			new UnsupportedTextError(
				createMockVerbContext().serial,
				'zażółć 🙂',
				['U+017C ("ż")', 'U+1F642 ("🙂")'],
				'only ASCII',
			),
		);
		const answer = { outcome: 'failed', failure } as const;

		// The text and the escapes both survive the trip: an agent reading this on another
		// machine has to be able to see which character to strip.
		expect(VerbCallResultSchema.parse(roundTrip(answer))).toEqual(answer);
		expect(unserializableParts(answer)).toEqual([]);
	});

	it('round-trips the refused branch and re-parses it equal', () => {
		const answer = {
			outcome: 'refused',
			reason: 'no-lease',
			message: 'That lease id is not live on this host',
		} as const;

		expect(VerbCallResultSchema.parse(roundTrip(answer))).toEqual(answer);
		expect(unserializableParts(answer)).toEqual([]);
	});

	it('round-trips the ok branch of the row that carries a payload', async () => {
		const answer = {
			outcome: 'ok',
			result: await readLogs(contextShowingSave()),
		} as const;

		expect(ReadLogsCallResultSchema.parse(roundTrip(answer))).toEqual(answer);
		expect(unserializableParts(answer)).toEqual([]);
	});

	/**
	 * The two branches that are not `ok` are the *same* schema for every row, which is what
	 * the factory in `src/ipc/verb-methods.ts` exists for: an agent learns one refusal
	 * vocabulary whatever it asked for.
	 */
	it('answers a refusal in the same words whichever row was called', () => {
		const refusal = {
			outcome: 'refused',
			reason: 'no-lease',
			message: 'That lease id is not live on this host',
		} as const;

		expect(ReadLogsCallResultSchema.parse(refusal)).toEqual(VerbCallResultSchema.parse(refusal));
	});

	// An `ActionResult` with no `logs` is not a `read_logs` answer, and the row's own schema is
	// what keeps a payload from going missing between the verb and the wire.
	it('rejects a read_logs answer that lost its payload', async () => {
		const result = await fakeTapResult(contextShowingSave());

		expect(() => ReadLogsCallResultSchema.parse({ outcome: 'ok', result })).toThrow();
	});

	it('rejects an answer whose outcome nobody produces', () => {
		expect(() => VerbCallResultSchema.parse({ outcome: 'maybe', result: null })).toThrow();
	});

	it.each([
		['tap', TapParamsSchema, { leaseId: 'lease-1', target: { by: 'point', at: { x: 1, y: 2 } } }],
		[
			'long_press',
			LongPressParamsSchema,
			{ leaseId: 'lease-1', target: { by: 'text', text: 'Save' }, durationMs: 800 },
		],
		[
			'swipe',
			SwipeParamsSchema,
			{
				leaseId: 'lease-1',
				from: { by: 'text', text: 'Save' },
				to: { by: 'point', at: { x: 3, y: 4 } },
			},
		],
		[
			'scroll',
			ScrollParamsSchema,
			{ leaseId: 'lease-1', direction: 'down', target: { by: 'element', id: 'list' } },
		],
		// Non-ASCII on purpose: JSON is where a string most plausibly stops being itself, and
		// this is the one verb whose whole contract is that it does not.
		['type_text', TypeTextParamsSchema, { leaseId: 'lease-1', text: 'zażółć 🙂  %s' }],
		['press_key', PressKeyParamsSchema, { leaseId: 'lease-1', key: 'home' }],
		// One row for the three app verbs, because one schema serves all three.
		['launch_app', AppVerbParamsSchema, { leaseId: 'lease-1', appId: 'com.android.settings' }],
		['read_logs', ReadLogsParamsSchema, { leaseId: 'lease-1', maxEntries: 50 }],
		// One row for both environment verbs, because one schema serves both — the call is a
		// lease id and a boolean whichever radio is being asked about.
		['set_wifi', EnvironmentVerbParamsSchema, { leaseId: 'lease-1', enabled: false }],
		// The three read rows carry the credential and nothing else: no target, no wait knob on
		// a verb that reads once and answers, and — for `screenshot` — no destination, because
		// a path on the host is the one thing its answer must never contain (D19).
		['read_screen', ReadScreenParamsSchema, { leaseId: 'lease-1' }],
		['device_info', DeviceInfoParamsSchema, { leaseId: 'lease-1' }],
		['screenshot', ScreenshotParamsSchema, { leaseId: 'lease-1' }],
	])('round-trips what a %s call carries', (_name, schema, params) => {
		const parsed = schema.parse(params);

		expect(schema.parse(roundTrip(parsed))).toEqual(parsed);
		expect(unserializableParts(parsed)).toEqual([]);
	});
});
