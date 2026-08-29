/**
 * Test data factories — sensible defaults + `Partial<T>` overrides, mirroring Swarm's
 * `tests/helpers/factories.ts` (ai/TESTING.md "Test data"). Prefer these over
 * hand-constructing the same fixture inline in every test.
 *
 * Objects with a schema are returned *parsed*, so a test holds the same branded shape
 * production code does; tests exercising invalid input build raw objects directly.
 *
 * The ids here are invented (`test-platform`) rather than borrowed from any real
 * backend — a fixture that names one would put a platform name in shared test code and
 * quietly bless the branching this layer exists to prevent.
 */

import { vi } from 'vitest';
import type { DeviceBackendRegistration } from '@/backends/manifest.js';
import {
	type Capabilities,
	type CapabilityManifest,
	CapabilityManifestSchema,
} from '@/core/capabilities.js';
import {
	type Device,
	type DeviceBackend,
	type DeviceInfo,
	DeviceInfoSchema,
	DeviceSchema,
	type DeviceWatch,
	type DeviceWatcher,
	type ScreenElement,
	ScreenElementSchema,
} from '@/core/device.js';
import { parseDeviceSerial, parseLeaseId } from '@/core/ids.js';
import { LEASE_TTL_MS, type Lease } from '@/daemon/leases.js';
import type { VerbContext } from '@/verbs/context.js';

export function createMockCapabilities(overrides: Partial<Capabilities> = {}): Capabilities {
	return {
		canReadScreen: true,
		canInput: true,
		canControlNetwork: true,
		...overrides,
	};
}

export function createMockDevice(overrides: Partial<Device> = {}): Device {
	return DeviceSchema.parse({
		serial: 'test-serial-1',
		platform: 'test-platform',
		model: 'Test Model',
		state: 'ready',
		attachment: 'this-host',
		...overrides,
	});
}

/**
 * A lease record as the store holds it — an id, a serial and the three caller-supplied
 * attribution strings (D16, D22).
 *
 * `expiresAtMs` is a host-local instant a full TTL out, because that is what the record
 * carries; what crosses the wire is the remaining duration (D17). Note that this builds a
 * record, it does not put one in a store — a test that needs a *held* device acquires it.
 */
export function createMockLease(overrides: Partial<Lease> = {}): Lease {
	return {
		id: parseLeaseId('test-lease-1'),
		serial: parseDeviceSerial('test-serial-1'),
		owner: 'issue-112',
		project: 'test-project',
		testName: null,
		expiresAtMs: Date.now() + LEASE_TTL_MS,
		...overrides,
	};
}

/**
 * The `device_info` answer for a device with a 3× density — the scale a dp value is
 * only ever derived from (D14). `widthDp`/`heightDp` are the exact quotients the
 * contract asks for, not rounded ones.
 */
export function createMockDeviceInfo(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
	return DeviceInfoSchema.parse({
		serial: 'test-serial-1',
		platform: 'test-platform',
		model: 'Test Model',
		screen: {
			widthPx: 1080,
			heightPx: 2400,
			density: 480,
			densityScale: 3,
			widthDp: 360,
			heightDp: 800,
		},
		osVersion: '1.0',
		osApiLevel: 1,
		...overrides,
	});
}

/**
 * One element of a screen read. `text` and `label` stay separate — an element carrying one
 * and not the other is the case a target resolver has to get right, so a factory that
 * filled both by default would hide it.
 *
 * `id` is taken as a plain string and branded on the way through, because a screen fixture
 * names several elements at once and `parseElementId` around each of them would be all a
 * reader saw.
 */
export function createMockScreenElement(
	overrides: Partial<Omit<ScreenElement, 'id'>> & { readonly id?: string } = {},
): ScreenElement {
	return ScreenElementSchema.parse({
		id: 'test-element-1',
		text: 'Save',
		label: null,
		bounds: { x: 10, y: 20, width: 100, height: 40 },
		...overrides,
	});
}

export function createMockCapabilityManifest(
	overrides: Partial<CapabilityManifest> = {},
): CapabilityManifest {
	return CapabilityManifestSchema.parse({
		platform: 'test-platform',
		label: 'Test',
		capabilities: createMockCapabilities(),
		...overrides,
	});
}

/**
 * A backend answering every method, including the capability-gated ones. Mocks carry
 * their real call signature so `mock.calls[0][0]` typechecks (ai/TESTING.md).
 */
export function createMockDeviceBackend(overrides: Partial<DeviceBackend> = {}): DeviceBackend {
	return {
		listDevices: vi.fn<DeviceBackend['listDevices']>(async () => [createMockDevice()]),
		watchDevices: vi.fn<DeviceBackend['watchDevices']>((watcher) => {
			watcher.onDevices([createMockDevice()]);
			return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
		}),
		describeDevice: vi.fn<DeviceBackend['describeDevice']>(async () => createMockDevice()),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async () => createMockDeviceInfo()),
		installApp: vi.fn<DeviceBackend['installApp']>(async () => {}),
		launchApp: vi.fn<DeviceBackend['launchApp']>(async () => {}),
		stopApp: vi.fn<DeviceBackend['stopApp']>(async () => {}),
		clearAppData: vi.fn<DeviceBackend['clearAppData']>(async () => {}),
		screenshot: vi.fn<DeviceBackend['screenshot']>(async () => new Uint8Array([1, 2, 3])),
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => []),
		tap: vi.fn<NonNullable<DeviceBackend['tap']>>(async () => {}),
		swipe: vi.fn<NonNullable<DeviceBackend['swipe']>>(async () => {}),
		typeText: vi.fn<NonNullable<DeviceBackend['typeText']>>(async () => {}),
		pressKey: vi.fn<NonNullable<DeviceBackend['pressKey']>>(async () => {}),
		setAirplaneMode: vi.fn<NonNullable<DeviceBackend['setAirplaneMode']>>(async () => {}),
		setWifiEnabled: vi.fn<NonNullable<DeviceBackend['setWifiEnabled']>>(async () => {}),
		...overrides,
	};
}

/**
 * The same surface as {@link createMockDeviceBackend}, built from plain async functions
 * with real bodies — the fixture the conformance harness
 * (`tests/helpers/backend-conformance.ts`) can actually read.
 *
 * A mock-built backend is invisible to every scan in that harness: `String(vi.fn(…))`
 * returns Vitest's wrapper source rather than the implementation, so a suite that used
 * {@link createMockDeviceBackend} as its "conforming" fixture would be proving nothing.
 * For the same reason no body here may be empty or return a bare empty literal — that is
 * precisely what the harness flags as a silent stub (ai/RULES.md §2).
 */
export function createConformingDeviceBackend(
	overrides: Partial<DeviceBackend> = {},
): DeviceBackend {
	const performed: string[] = [];

	return {
		async listDevices() {
			performed.push('listDevices');
			return [createMockDevice()];
		},
		// A real body, and one that delivers the first snapshot the contract promises: an
		// empty one — or a bare `{}` for a handle — is exactly what `isEmptyAnswerSource`
		// flags, and rightly, since it is what a backend that never implemented this looks
		// like.
		watchDevices(watcher: DeviceWatcher): DeviceWatch {
			performed.push('watchDevices');
			watcher.onDevices([createMockDevice()]);
			return {
				async stop() {
					performed.push('stopWatch');
				},
			};
		},
		async describeDevice(serial) {
			performed.push(`describeDevice ${serial}`);
			return createMockDevice({ serial });
		},
		async deviceInfo(serial) {
			performed.push(`deviceInfo ${serial}`);
			return createMockDeviceInfo({ serial });
		},
		async installApp(serial, packagePath) {
			performed.push(`installApp ${serial} ${packagePath}`);
		},
		async launchApp(serial, appId) {
			performed.push(`launchApp ${serial} ${appId}`);
		},
		async stopApp(serial, appId) {
			performed.push(`stopApp ${serial} ${appId}`);
		},
		async clearAppData(serial, appId) {
			performed.push(`clearAppData ${serial} ${appId}`);
		},
		async screenshot(serial) {
			performed.push(`screenshot ${serial}`);
			return new Uint8Array([1, 2, 3]);
		},
		async readScreen(serial) {
			performed.push(`readScreen ${serial}`);
			return [
				ScreenElementSchema.parse({
					id: `${serial}-root`,
					text: 'Root',
					label: null,
					bounds: { x: 0, y: 0, width: 100, height: 200 },
				}),
			];
		},
		async tap(serial, at) {
			performed.push(`tap ${serial} ${at.x},${at.y}`);
		},
		async swipe(serial, from, to, durationMs) {
			performed.push(`swipe ${serial} ${from.x},${from.y} ${to.x},${to.y} ${durationMs}`);
		},
		async typeText(serial, text) {
			performed.push(`typeText ${serial} ${text}`);
		},
		async pressKey(serial, key) {
			performed.push(`pressKey ${serial} ${key}`);
		},
		async setAirplaneMode(serial, enabled) {
			performed.push(`setAirplaneMode ${serial} ${enabled}`);
		},
		async setWifiEnabled(serial, enabled) {
			performed.push(`setWifiEnabled ${serial} ${enabled}`);
		},
		...overrides,
	};
}

export function createMockRegistration(
	overrides: Partial<DeviceBackendRegistration> = {},
): DeviceBackendRegistration {
	return {
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: createMockCapabilities(),
		},
		backend: createMockDeviceBackend(),
		...overrides,
	};
}

/**
 * What a verb is handed — the device, the backend that can act on it, and the manifest the
 * verb layer consults before it dispatches anything.
 *
 * A plain value here for the same reason it is one in production: the caller constructs it
 * (`src/daemon/verb-handlers.ts` does), and the verb layer never resolves a device itself.
 */
export function createMockVerbContext(overrides: Partial<VerbContext> = {}): VerbContext {
	return {
		serial: parseDeviceSerial('test-serial-1'),
		backend: createMockDeviceBackend(),
		manifest: createMockCapabilityManifest(),
		...overrides,
	};
}
