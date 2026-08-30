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
import { WaitTimeoutError } from '@/core/errors.js';
import { parseAppId } from '@/core/ids.js';
import {
	AppVerbParamsSchema,
	DeviceInfoParamsSchema,
	LongPressParamsSchema,
	ReadScreenParamsSchema,
	ScreenshotParamsSchema,
	ScrollParamsSchema,
	SwipeParamsSchema,
	TapParamsSchema,
	VerbCallResultSchema,
} from '@/ipc/verb-methods.js';
import { launchApp } from '@/verbs/app.js';
import { capabilityMethod, type VerbContext } from '@/verbs/context.js';
import { toVerbFailure } from '@/verbs/failure.js';
import { scroll, tap } from '@/verbs/input.js';
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

	it('round-trips an app verb result, which addresses a package rather than a screen', async () => {
		const context = contextShowingSave();

		const launched = await launchApp(context, parseAppId('com.android.settings'));

		expect(ActionResultSchema.parse(roundTrip(launched))).toEqual(launched);
		// A branded app id is a plain string on the wire, and the target is `null` because this
		// verb addressed no element — `null` survives the trip where an absent key would not.
		expect(launched.target).toBeNull();
		expect(unserializableParts(launched)).toEqual([]);
	});

	it('round-trips a read verb result, whose answer is the state rather than an action', async () => {
		const context = contextShowingSave();

		const read = await readScreen(context);
		const info = await deviceInfo(context);

		expect(ActionResultSchema.parse(roundTrip(read))).toEqual(read);
		expect(ActionResultSchema.parse(roundTrip(info))).toEqual(info);
		// The elements a read verb answers with are the one payload here that is a list of
		// rectangles rather than a scalar, and a branded element id is a plain string on the
		// wire.
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

	it('round-trips the refused branch and re-parses it equal', () => {
		const answer = {
			outcome: 'refused',
			reason: 'no-lease',
			message: 'That lease id is not live on this host',
		} as const;

		expect(VerbCallResultSchema.parse(roundTrip(answer))).toEqual(answer);
		expect(unserializableParts(answer)).toEqual([]);
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
		// One row for the three app verbs, because one schema serves all three.
		['launch_app', AppVerbParamsSchema, { leaseId: 'lease-1', appId: 'com.android.settings' }],
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
