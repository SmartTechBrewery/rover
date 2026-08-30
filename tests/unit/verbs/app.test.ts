/**
 * The three app-lifecycle verbs, over a backend that records what it was asked to do.
 *
 * Two things are asserted here that a correct-looking result cannot show. The first is
 * **which backend method each verb reached, and with what** — three verbs of identical shape
 * over three methods of identical signature is precisely the family a copy-paste gets wrong,
 * and a `stop_app` that force-stopped nothing because it called `launchApp` answers exactly
 * like one that worked. The second is **order**: no screen is read before the action, because
 * these verbs address a package rather than something on the screen, and the after-state is
 * captured after the action (D12(c)).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '@/core/capabilities.js';
import type { DeviceBackend } from '@/core/device.js';
import { type AppId, parseAppId } from '@/core/ids.js';
import { clearAppData, launchApp, stopApp } from '@/verbs/app.js';
import type { VerbContext } from '@/verbs/context.js';
import type { ActionResult } from '@/verbs/result.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

const SETTINGS = parseAppId('com.android.settings');
const save = createMockScreenElement({ id: 'save', text: 'Save' });

interface Recording {
	readonly calls: string[];
	readonly apps: Array<{ method: string; appId: string }>;
	readonly context: VerbContext;
}

/** A context whose backend records every call on one shared log, in order. */
function recording(options: { capabilities?: Capabilities } = {}): Recording {
	const calls: string[] = [];
	const apps: Array<{ method: string; appId: string }> = [];

	const record = (method: string) => async (_serial: unknown, appId: AppId) => {
		calls.push(method);
		apps.push({ method, appId });
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
		launchApp: vi.fn<DeviceBackend['launchApp']>(record('launchApp')),
		stopApp: vi.fn<DeviceBackend['stopApp']>(record('stopApp')),
		clearAppData: vi.fn<DeviceBackend['clearAppData']>(record('clearAppData')),
	});

	const context = createMockVerbContext({
		backend,
		manifest: createMockCapabilityManifest({
			capabilities: options.capabilities ?? createMockCapabilities(),
		}),
	});

	return { calls, apps, context };
}

/**
 * Each verb, the name it answers with, and the backend method it must reach — the table the
 * copy-paste this family invites would get wrong.
 */
const APP_VERBS: ReadonlyArray<
	[string, string, (context: VerbContext, appId: AppId) => Promise<ActionResult>]
> = [
	['launch_app', 'launchApp', launchApp],
	['stop_app', 'stopApp', stopApp],
	['clear_app_data', 'clearAppData', clearAppData],
];

describe('every app verb reaches its own backend method', () => {
	it.each(
		APP_VERBS,
	)('%s calls %s once, with the serial and the parsed app id', async (_verb, method, run) => {
		const { apps, context } = recording();

		await run(context, SETTINGS);

		expect(apps).toEqual([{ method, appId: SETTINGS }]);
		// The serial the *context* names, never one the verb invented or was handed separately.
		const backendMethod = context.backend[method as 'launchApp' | 'stopApp' | 'clearAppData'];
		expect(backendMethod).toHaveBeenCalledWith(context.serial, SETTINGS);
	});

	it.each(APP_VERBS)('%s touches neither of the other two', async (_verb, method, run) => {
		const { context } = recording();

		await run(context, SETTINGS);

		for (const other of ['launchApp', 'stopApp', 'clearAppData'] as const) {
			if (other !== method) {
				expect(context.backend[other]).not.toHaveBeenCalled();
			}
		}
	});
});

describe('every app verb is on the spine, and addresses no element', () => {
	it.each(APP_VERBS)('%s names itself and resolves no target', async (verb, _method, run) => {
		const { context } = recording();

		const result = await run(context, SETTINGS);

		expect(result.verb).toBe(verb);
		// An app id addresses a package, so there is nothing on the screen to report. `null` is
		// a fact about the verb rather than a resolution that failed.
		expect(result.target).toBeNull();
	});

	it.each(APP_VERBS)('%s reads no screen before it acts', async (_verb, method, run) => {
		const { calls, context } = recording();

		await run(context, SETTINGS);

		// The only `readScreen` is the after-state, and it comes after the action. A read before
		// it would mean someone had given this family a target, which would be the bug.
		expect(calls).toEqual([method, 'readScreen', 'deviceInfo']);
	});

	it.each(
		APP_VERBS,
	)('%s answers a screenless device with the capability, not an empty screen', async (_verb, _method, run) => {
		const { context } = recording({
			capabilities: createMockCapabilities({ canReadScreen: false }),
		});

		const result = await run(context, SETTINGS);

		expect(result.after).toMatchObject({ kind: 'unavailable', capability: 'canReadScreen' });
	});

	it.each(
		APP_VERBS,
	)('%s runs on a device that declares no capability at all', async (_verb, _method, run) => {
		// `requires: []` is the honest answer for a verb built only on required interface
		// methods: there is nothing to assert, so a backend that opted out of everything
		// optional still runs these three.
		const { context } = recording({
			capabilities: createMockCapabilities({
				canReadScreen: false,
				canInput: false,
				canControlNetwork: false,
			}),
		});

		await expect(run(context, SETTINGS)).resolves.toMatchObject({ target: null });
	});
});

describe('a device that refuses is not yet an answer', () => {
	/**
	 * Pins today's behaviour rather than blessing it. A backend that rejects — `launch_app` on
	 * a package the device does not have — propagates out of the verb, so the daemon turns it
	 * into `internal_error` ("the host broke") rather than a `VerbFailure`. That is a
	 * pre-existing, repo-wide gap shared by every verb family, not something this one
	 * introduced; fixing it means a typed error out of the backends plus a new
	 * `VerbFailureSchema` branch, which changes every family at once and is filed separately.
	 */
	it.each(
		APP_VERBS,
	)('%s lets a backend rejection through unchanged', async (_verb, method, run) => {
		const { context } = recording();
		const failing = context.backend[method as 'launchApp' | 'stopApp' | 'clearAppData'];
		vi.mocked(failing).mockRejectedValueOnce(
			new Error(`Device 'test-serial-1' has no package '${SETTINGS}'`),
		);

		await expect(run(context, SETTINGS)).rejects.toThrow(SETTINGS);
		// And nothing was reported about the device: no result exists to carry an after-state.
		expect(context.backend.readScreen).not.toHaveBeenCalled();
	});
});
