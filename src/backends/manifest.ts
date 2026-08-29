/**
 * The registration record — what a backend hands the registry.
 *
 * Two things get called "the manifest" and they are split here on purpose. The
 * *capability manifest* (`src/core/capabilities.ts`) is pure declarative data and is a
 * Zod schema, because it crosses a boundary. The *registration* below pairs that data
 * with the backend instance, and stays a plain TypeScript type, because a class instance
 * is not a parseable value.
 *
 * The backend is a shared instance rather than a `create…(config)` factory, for the same
 * reason Swarm's SCM manifests hold one: a backend is stateless and takes the serial it
 * acts on per call, so there is nothing per-device to construct.
 */

import type { CapabilityManifest, CapabilityManifestInput } from '../core/capabilities.js';
import type { DeviceBackend } from '../core/device.js';

/** What a backend's own `index.ts` passes to `registerDeviceBackend()`. */
export interface DeviceBackendRegistration {
	readonly manifest: CapabilityManifestInput;
	readonly backend: DeviceBackend;
}

/** What the registry stores and hands back: the same pair, with the manifest parsed. */
export interface RegisteredDeviceBackend {
	readonly manifest: CapabilityManifest;
	readonly backend: DeviceBackend;
}
