/**
 * deviceBackendRegistry — the process-singleton registry of device backends.
 *
 * Backends register themselves at module-load time from their own `index.ts`, pulled in
 * by the barrel (`./index.ts`); shared code looks them up by platform id instead of
 * naming a concrete backend. This is the "adding a backend must not require editing
 * shared code" invariant from ai/RULES.md §2 — a backend joins with its own folder plus
 * one import line in the barrel, and nothing else in the repo changes.
 *
 * Mirrors Swarm's `src/integrations/pm/registry.ts` (D15), with one deliberate
 * divergence: Swarm keys its registry on a closed union of provider ids declared in
 * shared code. Rover cannot — a closed list would name every platform outside
 * `src/backends/`, which is the one thing this layer must not do. So the key space is
 * open, the key type is a branded string, and a lookup miss is `null`.
 *
 * `registerDeviceBackend()` **parses** the manifest rather than storing it as given:
 * that is what makes the schema the source of truth rather than decoration
 * (ai/CODING_STANDARDS.md), and it turns a malformed manifest into a module-load failure
 * instead of a surprise at the first verb call.
 *
 * Duplicate platform ids throw — that is how a backend folder cloned from a sibling and
 * not renamed gets caught at startup rather than silently shadowing the original.
 */

import { CapabilityManifestSchema } from '../core/capabilities.js';
import type { PlatformId } from '../core/ids.js';
import type { DeviceBackendRegistration, RegisteredDeviceBackend } from './manifest.js';

const registry: RegisteredDeviceBackend[] = [];
const byPlatform = new Map<string, RegisteredDeviceBackend>();

export function registerDeviceBackend(registration: DeviceBackendRegistration): void {
	const manifest = CapabilityManifestSchema.parse(registration.manifest);
	if (byPlatform.has(manifest.platform)) {
		throw new Error(
			`Device backend '${manifest.platform}' already registered — duplicate platform ids are not allowed`,
		);
	}
	const registered: RegisteredDeviceBackend = { manifest, backend: registration.backend };
	registry.push(registered);
	byPlatform.set(manifest.platform, registered);
}

/** Look up a registered backend by platform id, or `null` when none is registered. */
export function getDeviceBackend(platform: PlatformId): RegisteredDeviceBackend | null {
	return byPlatform.get(platform) ?? null;
}

/**
 * Resolve a backend that must be there, throwing when it is not.
 *
 * A miss here is a wiring bug, not a runtime condition (ai/CODING_STANDARDS.md "Error
 * handling"): the caller already holds a platform id that came from a device the host
 * enumerated, so either the barrel is missing that backend's import line or the module
 * failed to load. The message says so, because "not registered" on its own sends the
 * reader looking at the device instead of at the barrel.
 */
export function requireDeviceBackend(platform: PlatformId): RegisteredDeviceBackend {
	const registered = getDeviceBackend(platform);
	if (!registered) {
		const known = listDeviceBackends().map((entry) => entry.manifest.platform);
		throw new Error(
			`Device backend '${platform}' is not registered — is its import line present in ` +
				`src/backends/index.ts, and did that module load? ` +
				(known.length ? `Registered: ${known.join(', ')}` : 'No backends are registered.'),
		);
	}
	return registered;
}

/**
 * Every registered backend.
 *
 * The entry point for the conformance suite (ai/TESTING.md) and, later, for whatever
 * answers `list_devices` — which must be reachable by something that is not an agent
 * (ai/RULES.md §1), so it lives here rather than inside the MCP layer.
 */
export function listDeviceBackends(): readonly RegisteredDeviceBackend[] {
	// Return a shallow clone so callers can't splice the source array.
	return registry.slice();
}

/**
 * Test-only helper. Production code MUST NOT call this. Clears the registry between
 * tests so registrations from one test don't leak into the next.
 */
export function _resetDeviceBackendRegistryForTesting(): void {
	registry.length = 0;
	byPlatform.clear();
}
