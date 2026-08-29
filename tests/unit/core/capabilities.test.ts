import { describe, expect, it } from 'vitest';
import {
	CAPABILITY_METHODS,
	CapabilitiesSchema,
	CapabilityManifestSchema,
	requireCapability,
	supportsCapability,
} from '@/core/capabilities.js';
import { MissingCapabilityError } from '@/core/errors.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { createMockCapabilities, createMockCapabilityManifest } from '../../helpers/factories.js';

const serial = parseDeviceSerial('test-serial-1');

describe('CapabilityManifestSchema', () => {
	it('accepts a well-formed manifest and brands the platform', () => {
		const manifest = CapabilityManifestSchema.parse({
			platform: 'test-platform',
			label: 'Test',
			capabilities: createMockCapabilities(),
		});

		// Branding is erased at runtime; the observable contract is the value passing through.
		expect(manifest.platform).toBe('test-platform');
		expect(manifest.capabilities.canReadScreen).toBe(true);
	});

	it.each([
		['an empty platform', { platform: '', label: 'Test' }],
		['a whitespace-only platform', { platform: '   ', label: 'Test' }],
		['an empty label', { platform: 'test-platform', label: '' }],
	])('rejects %s', (_name, overrides) => {
		expect(() =>
			CapabilityManifestSchema.parse({ ...overrides, capabilities: createMockCapabilities() }),
		).toThrow();
	});

	it('rejects an unknown capability flag rather than ignoring it', () => {
		expect(() =>
			CapabilityManifestSchema.parse({
				platform: 'test-platform',
				label: 'Test',
				capabilities: { ...createMockCapabilities(), canFly: true },
			}),
		).toThrow();
	});

	it('rejects a missing capability flag', () => {
		expect(() =>
			CapabilityManifestSchema.parse({
				platform: 'test-platform',
				label: 'Test',
				capabilities: { canReadScreen: true, canInput: true },
			}),
		).toThrow();
	});
});

describe('supportsCapability', () => {
	it('answers false without throwing for an undeclared capability', () => {
		const manifest = createMockCapabilityManifest({
			capabilities: createMockCapabilities({ canReadScreen: false }),
		});

		expect(supportsCapability(manifest, 'canReadScreen')).toBe(false);
		expect(supportsCapability(manifest, 'canInput')).toBe(true);
	});
});

describe('requireCapability', () => {
	it('passes for a declared capability', () => {
		expect(() =>
			requireCapability(createMockCapabilityManifest(), 'canReadScreen', serial),
		).not.toThrow();
	});

	it('throws MissingCapabilityError naming the capability, the device and the backend', () => {
		const manifest = createMockCapabilityManifest({
			label: 'Test Backend',
			capabilities: createMockCapabilities({ canReadScreen: false }),
		});

		try {
			requireCapability(manifest, 'canReadScreen', serial);
			expect.unreachable('requireCapability should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(MissingCapabilityError);
			const missing = error as MissingCapabilityError;
			expect(missing.capability).toBe('canReadScreen');
			expect(missing.serial).toBe(serial);
			expect(missing.platform).toBe(manifest.platform);
			expect(missing.backendLabel).toBe('Test Backend');
			expect(missing.message).toContain('canReadScreen');
			expect(missing.message).toContain('test-serial-1');
			expect(missing.message).toContain('Test Backend');
		}
	});
});

describe('CAPABILITY_METHODS', () => {
	it('gates at least one method for every capability the schema declares', () => {
		const flags = Object.keys(CapabilitiesSchema.shape).sort();

		expect(Object.keys(CAPABILITY_METHODS).sort()).toEqual(flags);
		for (const flag of flags) {
			expect(CAPABILITY_METHODS[flag as keyof typeof CAPABILITY_METHODS].length).toBeGreaterThan(0);
		}
	});

	it('never names the same method under two capabilities', () => {
		const methods = Object.values(CAPABILITY_METHODS).flat();

		expect(new Set(methods).size).toBe(methods.length);
	});
});
