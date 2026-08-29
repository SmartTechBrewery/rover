/**
 * The backend conformance gate — one run per **registered** manifest, mirroring Swarm's
 * provider-conformance suites (ai/TESTING.md "Backend conformance").
 *
 * It lands **before** the first backend on purpose (PROJECT.md §9.3, row R3 ahead of
 * R5). A gate written after the backend it is supposed to gate never gated the one thing
 * it was built for, and the failure it prevents — a manifest declaring a capability
 * nothing dispatches, or a method answering `[]` because the real work was never written
 * — is invisible from the outside until an agent is told a device can do something it
 * cannot (D11, ai/RULES.md §2).
 *
 * Which is also why the checks themselves live in `tests/helpers/backend-conformance.ts`
 * and are proved out against synthetic backends in `conformance-harness.test.ts`: the
 * registry is empty today, so the loop below has nothing to run over, and assertions
 * written inline here would be green and meaningless until R5.
 */

import { describe, expect, it } from 'vitest';
// Importing the barrel is what a real runtime surface does; it triggers every backend's
// side-effect registration. Vitest isolates module state per test file, so this is
// unaffected by the registry resets in registry.test.ts and the harness suite.
import '@/backends/index.js';
import { listDeviceBackends } from '@/backends/registry.js';
import type {
	CAPABILITY_METHODS,
	CapabilityGatedMethod,
	CapabilityId,
} from '@/core/capabilities.js';
import {
	type AssertNever,
	checkDeclaredCapabilitiesDispatch,
	checkManifestMetadata,
	checkNoStubbedMethods,
	checkRequiredMethods,
	checkUniquePlatformIds,
	type REQUIRED_BACKEND_METHODS,
	type RequiredBackendMethod,
} from '../../helpers/backend-conformance.js';

const registered = listDeviceBackends();

describe('device backend conformance', () => {
	/**
	 * A tripwire, not the driver: the per-manifest suites below are driven by
	 * `listDeviceBackends()`, so a new backend inherits every assertion with no edit
	 * here. This one line exists so the phase that lands the first backend has to
	 * acknowledge the gate deliberately — like `barrel.test.ts`'s twin assertion, its
	 * failure is the signal that a backend joined, not a regression.
	 */
	it('runs over every registered manifest', () => {
		expect(registered.map((entry) => entry.manifest.platform)).toEqual([]);
	});

	it('lists every required contract method', () => {
		const allMethodsAreListed: AssertNever<
			Exclude<RequiredBackendMethod, (typeof REQUIRED_BACKEND_METHODS)[number]>
		> = undefined as never;
		expect(allMethodsAreListed).toBeUndefined();
	});

	// The mirror of the guard above, on the optional half of the contract. An optional
	// method named by no capability is one the verb layer can never reach — nothing would
	// ever declare it — and one this suite would never scan for a stub.
	it('gates every optional contract method behind a capability', () => {
		const allMethodsAreGated: AssertNever<
			Exclude<CapabilityGatedMethod, (typeof CAPABILITY_METHODS)[CapabilityId][number]>
		> = undefined as never;
		expect(allMethodsAreGated).toBeUndefined();
	});

	it('gives every backend a unique platform id', () => {
		expect(checkUniquePlatformIds(registered)).toEqual([]);
	});
});

for (const entry of registered) {
	describe(`device backend conformance: ${entry.manifest.platform}`, () => {
		it('declares the manifest metadata shared code reads', () => {
			expect(checkManifestMetadata(entry)).toEqual([]);
		});

		it('exposes every required contract method', () => {
			expect(checkRequiredMethods(entry)).toEqual([]);
		});

		it('dispatches every capability it declares', () => {
			expect(checkDeclaredCapabilitiesDispatch(entry)).toEqual([]);
		});

		it('implements every method rather than stubbing it', () => {
			expect(checkNoStubbedMethods(entry)).toEqual([]);
		});
	});
}
