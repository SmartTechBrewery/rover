/**
 * The gate every capability-gated method is reached through (D11).
 *
 * Two failures, and they are not the same failure: a backend that *says* it cannot do
 * something is a device limitation an agent acts on, while a backend that says it can and
 * then has no method is a wiring bug. The suite keeps them distinguishable, because
 * collapsing them is how "this phone cannot do that" starts reading as "Rover is broken".
 */

import { describe, expect, it } from 'vitest';
import { MissingCapabilityError } from '@/core/errors.js';
import { capabilityMethod } from '@/verbs/context.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockVerbContext,
} from '../../helpers/factories.js';

describe('capabilityMethod', () => {
	it('answers with the declared method, bound to the backend it came from', async () => {
		let boundTo: unknown;
		const backend = createMockDeviceBackend();
		backend.readScreen = function readScreen(this: unknown) {
			boundTo = this;
			return Promise.resolve([]);
		};
		const context = createMockVerbContext({ backend });

		await capabilityMethod(context, 'canReadScreen', 'readScreen')(context.serial);

		// A backend written as a class loses `this` the moment its method is fetched bare.
		expect(boundTo).toBe(backend);
	});

	it('throws MissingCapabilityError naming the capability, the device and the backend', () => {
		const context = createMockVerbContext({
			manifest: createMockCapabilityManifest({
				label: 'Screenless',
				capabilities: createMockCapabilities({ canReadScreen: false }),
			}),
		});

		let thrown: unknown;
		try {
			capabilityMethod(context, 'canReadScreen', 'readScreen');
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(MissingCapabilityError);
		const error = thrown as MissingCapabilityError;
		expect(error.capability).toBe('canReadScreen');
		expect(error.serial).toBe(context.serial);
		expect(error.message).toContain('test-serial-1');
		expect(error.message).toContain('Screenless');
		expect(error.message).toContain('canReadScreen');
	});

	it('never reaches the backend for an undeclared capability', () => {
		const backend = createMockDeviceBackend();
		const context = createMockVerbContext({
			backend,
			manifest: createMockCapabilityManifest({
				capabilities: createMockCapabilities({ canReadScreen: false }),
			}),
		});

		expect(() => capabilityMethod(context, 'canReadScreen', 'readScreen')).toThrow(
			MissingCapabilityError,
		);
		expect(backend.readScreen).not.toHaveBeenCalled();
	});

	it('throws a plain wiring error — not a capability error — when a declared method is absent', () => {
		const backend = createMockDeviceBackend();
		delete backend.tap;
		const context = createMockVerbContext({ backend });

		let thrown: unknown;
		try {
			capabilityMethod(context, 'canInput', 'tap');
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		// The conformance suite gates this at test time; at runtime it must not read as a
		// device that opted out, because it is the opposite — a manifest that overclaimed.
		expect(thrown).not.toBeInstanceOf(MissingCapabilityError);
		expect((thrown as Error).message).toContain("declares 'canInput' but has no 'tap' method");
	});
});
