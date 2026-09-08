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
	readonly stopHostProcesses?: HostProcessTeardown;
}

/** What the registry stores and hands back: the same pair, with the manifest parsed. */
export interface RegisteredDeviceBackend {
	readonly manifest: CapabilityManifest;
	readonly backend: DeviceBackend;
	readonly stopHostProcesses?: HostProcessTeardown;
}

/**
 * End everything this backend started on **this host** that outlives a call.
 *
 * **Optional, and deliberately here rather than on `DeviceBackend`.** Every method of that
 * interface is a question about a device, and a backend that keeps no host process of its own has
 * nothing to answer here — Android's `adb` server is not this process's child and its recorder
 * dies with the call that started it, so `../android/index.ts` registers no teardown at all and
 * that is the honest shape for it. What made this necessary is a backend that supervises a
 * long-lived program per target: `ios-simulator` holds one `idb_companion` per simulator it has
 * read, started by a verb and kept alive on purpose so the next read pays a channel rather than a
 * spawn (`../ios-simulator/idb-client.ts`). Those are children of the daemon, and without a hook
 * the only route to releasing them is killing the daemon.
 *
 * Called **once**, on the daemon's way down, after the watches have stopped and the restorations
 * have settled (`src/daemon/listen.ts`) — never mid-lease, and never as a health measure. The
 * ordering is load-bearing: a companion is the transport a verb call rides, so ending one while
 * anything can still dispatch would both fail that call and start a replacement this shutdown has
 * already walked past.
 *
 * Must be idempotent, must not reject for a backend that started nothing, and must be bounded by
 * whatever it signals — the caller bounds it too, because a shutdown that cannot finish is worse
 * than a process reported as left behind (D6).
 */
export type HostProcessTeardown = () => Promise<void>;
