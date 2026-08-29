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
import { type Device, type DeviceBackend, DeviceSchema } from '@/core/device.js';

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
		describeDevice: vi.fn<DeviceBackend['describeDevice']>(async () => createMockDevice()),
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
