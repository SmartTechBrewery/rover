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
import { capabilityMethod, type VerbContext } from '@/verbs/context.js';
import { performAction } from '@/verbs/perform.js';
import {
	type ActionResult,
	ActionResultSchema,
	AfterStateSchema,
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
