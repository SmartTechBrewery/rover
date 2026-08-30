/**
 * The two environment verbs, over a backend that records what it was asked to do.
 *
 * Three things are asserted here that a correct-looking result cannot show. **Which backend
 * method each verb reached, and with which boolean** — two verbs of identical shape over two
 * methods of identical signature is exactly the family a copy-paste gets wrong, and a
 * `set_wifi` that toggled airplane mode answers indistinguishably from one that worked.
 * **Order** — no screen is read before the action, because a radio is not something on the
 * screen, and the after-state is captured after it (D12(c)). And **the capability**, which is
 * the one thing this family has that the app verbs do not: an undeclared `canControlNetwork`
 * has to be a loud failure raised before anything is dispatched (D11), not a toggle that
 * reported success.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '@/core/capabilities.js';
import type { DeviceBackend } from '@/core/device.js';
import { MissingCapabilityError } from '@/core/errors.js';
import type { VerbContext } from '@/verbs/context.js';
import { setAirplaneMode, setWifi } from '@/verbs/environment.js';
import type { ActionResult } from '@/verbs/result.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

const save = createMockScreenElement({ id: 'save', text: 'Save' });

type RadioMethod = 'setAirplaneMode' | 'setWifiEnabled';

interface Recording {
	readonly calls: string[];
	readonly radios: Array<{ method: RadioMethod; enabled: boolean }>;
	readonly context: VerbContext;
}

/** A context whose backend records every call on one shared log, in order. */
function recording(options: { capabilities?: Capabilities } = {}): Recording {
	const calls: string[] = [];
	const radios: Array<{ method: RadioMethod; enabled: boolean }> = [];

	const record = (method: RadioMethod) => async (_serial: unknown, enabled: boolean) => {
		calls.push(method);
		radios.push({ method, enabled });
	};

	const backend = createMockDeviceBackend({
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
			calls.push('readScreen');
			return [save];
		}),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async (serial) => {
			calls.push('deviceInfo');
			return createMockDeviceInfo({ serial });
		}),
		setAirplaneMode: vi.fn<NonNullable<DeviceBackend['setAirplaneMode']>>(
			record('setAirplaneMode'),
		),
		setWifiEnabled: vi.fn<NonNullable<DeviceBackend['setWifiEnabled']>>(record('setWifiEnabled')),
	});

	const context = createMockVerbContext({
		backend,
		manifest: createMockCapabilityManifest({
			capabilities: options.capabilities ?? createMockCapabilities(),
		}),
	});

	return { calls, radios, context };
}

/**
 * Each verb, the name it answers with, and the backend method it must reach — the table the
 * copy-paste this family invites would get wrong.
 */
const ENVIRONMENT_VERBS: ReadonlyArray<
	[string, RadioMethod, (context: VerbContext, enabled: boolean) => Promise<ActionResult>]
> = [
	['set_airplane_mode', 'setAirplaneMode', setAirplaneMode],
	['set_wifi', 'setWifiEnabled', setWifi],
];

describe('every environment verb reaches its own backend method', () => {
	it.each(
		ENVIRONMENT_VERBS.flatMap(([verb, method, run]) =>
			[true, false].map((enabled) => [verb, method, run, enabled] as const),
		),
	)('%s calls %s once, with the serial and %s', async (_verb, method, run, enabled) => {
		const { radios, context } = recording();

		await run(context, enabled);

		expect(radios).toEqual([{ method, enabled }]);
		// The serial the *context* names, never one the verb invented or was handed separately,
		// and the boolean unaltered — the two commands underneath disagree about the words for
		// it, and this layer is what keeps that the backend's problem alone.
		expect(context.backend[method]).toHaveBeenCalledWith(context.serial, enabled);
	});

	it.each(
		ENVIRONMENT_VERBS,
	)('%s touches the other radio not at all', async (_verb, method, run) => {
		const { context } = recording();

		await run(context, true);

		const other: RadioMethod = method === 'setAirplaneMode' ? 'setWifiEnabled' : 'setAirplaneMode';
		expect(context.backend[other]).not.toHaveBeenCalled();
	});
});

describe('every environment verb is on the spine, and addresses no element', () => {
	it.each(
		ENVIRONMENT_VERBS,
	)('%s names itself and resolves no target', async (verb, _method, run) => {
		const { context } = recording();

		const result = await run(context, true);

		expect(result.verb).toBe(verb);
		// A radio is not something on the screen, so there is nothing to report. `null` is a
		// fact about the verb rather than a resolution that failed.
		expect(result.target).toBeNull();
	});

	it.each(ENVIRONMENT_VERBS)('%s reads no screen before it acts', async (_verb, method, run) => {
		const { calls, context } = recording();

		await run(context, false);

		// The only `readScreen` is the after-state, and it comes after the action — D12(c) as an
		// ordering assertion. A read before it would mean someone had given this family a target.
		expect(calls).toEqual([method, 'readScreen', 'deviceInfo']);
	});

	it.each(
		ENVIRONMENT_VERBS,
	)('%s answers a screenless device with the capability, not an empty screen', async (_verb, _method, run) => {
		const { context } = recording({
			capabilities: createMockCapabilities({ canReadScreen: false }),
		});

		const result = await run(context, true);

		// The after-state is evidence the device was still there and answering; it is never a
		// reading of the radio, and on a backend that cannot read a screen it says which
		// capability would have.
		expect(result.after).toMatchObject({ kind: 'unavailable', capability: 'canReadScreen' });
	});
});

describe('a backend that does not declare canControlNetwork is refused before dispatch', () => {
	it.each(
		ENVIRONMENT_VERBS,
	)('%s fails loudly, naming the capability, the device and the backend (D11)', async (_verb, method, run) => {
		const { calls, context } = recording({
			capabilities: createMockCapabilities({ canControlNetwork: false }),
		});

		const thrown = await run(context, true).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(MissingCapabilityError);
		expect((thrown as MissingCapabilityError).message).toContain('canControlNetwork');
		expect((thrown as MissingCapabilityError).message).toContain(context.serial);
		expect((thrown as MissingCapabilityError).message).toContain('Test');
		// Nothing was dispatched at all — not the toggle, and not even the screen read that
		// would have gone into an answer this call never gets.
		expect(context.backend[method]).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});
});

describe('a device that refuses is not yet an answer', () => {
	/**
	 * Pins today's behaviour rather than blessing it, exactly as `./app.test.ts` does: a
	 * backend that rejects propagates out of the verb, so the daemon turns it into
	 * `internal_error` ("the host broke") rather than a `VerbFailure`. That is a pre-existing,
	 * repo-wide gap shared by every verb family, not something this one introduced.
	 */
	it.each(
		ENVIRONMENT_VERBS,
	)('%s lets a backend rejection through unchanged', async (_verb, method, run) => {
		const { context } = recording();
		vi.mocked(
			context.backend[method] as NonNullable<DeviceBackend['setWifiEnabled']>,
		).mockRejectedValueOnce(new Error("Device 'test-serial-1' refused the change"));

		await expect(run(context, false)).rejects.toThrow('refused the change');
		// And nothing was reported about the device: no result exists to carry an after-state.
		expect(context.backend.readScreen).not.toHaveBeenCalled();
	});
});
