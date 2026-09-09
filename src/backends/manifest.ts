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
import type { PlatformId } from '../core/ids.js';

/** What a backend's own `index.ts` passes to `registerDeviceBackend()`. */
export interface DeviceBackendRegistration {
	readonly manifest: CapabilityManifestInput;
	readonly backend: DeviceBackend;
	readonly stopHostProcesses?: HostProcessTeardown;
	readonly hostTooling?: HostToolingProvider;
}

/** What the registry stores and hands back: the same pair, with the manifest parsed. */
export interface RegisteredDeviceBackend {
	readonly manifest: CapabilityManifest;
	readonly backend: DeviceBackend;
	readonly stopHostProcesses?: HostProcessTeardown;
	readonly hostTooling?: HostToolingProvider;
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

/**
 * One external program this backend drives, as the **host** currently has it.
 *
 * A status, never a capability. `CapabilityManifest` says what the *platform* can do and is
 * deliberately independent of what this machine happens to have installed (D11) — which is why a
 * Mac with no `idb_companion` still declares `canReadScreen: true` and fails the verb by name.
 * This is the other half of that bargain: the same host, asked directly what it is missing, so an
 * operator learns it from `rover doctor` instead of from a verb three steps into a session.
 *
 * `found` is the resolved path when the host has it and `null` when it does not, and `detail` is
 * the one line a person acts on — for a missing program, whatever its own search said, because
 * that message already names every place that was looked.
 */
export interface HostToolStatus {
	/** The program, named the way an operator would name it: `adb`, `simctl`, `idb_companion`. */
	readonly tool: string;
	/** Where this host found it, or `null` when it has none. */
	readonly found: string | null;
	/** One line for a person — where it came from, or what is missing and what to do. */
	readonly detail: string;
	/** Whether {@link HostToolingProvider.install} can get this one. */
	readonly installable: boolean;
}

/**
 * What a backend answers about the programs it needs on this host, and the ones it can fetch.
 *
 * **Optional, and on the registration rather than on `DeviceBackend`**, for
 * {@link HostProcessTeardown}'s reason: every method of that interface is a question about a
 * device, and this is a question about the machine. A backend that needs nothing installed
 * registers none and costs nothing.
 *
 * **Adding a backend still edits no shared code** (ai/RULES.md §2). The daemon asks the registry,
 * the registry asks whoever registered a provider, and neither knows which programs exist — so a
 * third backend's tooling arrives with the backend, in its own folder, and `rover doctor` starts
 * reporting it with nothing here changed.
 *
 * `describe` must never install anything and must never spawn a companion — it is called on a
 * plain report. `install` is the only side effect in this file, is called only when an operator
 * asked for it by name, and must be idempotent: a tool already present is a success that says so,
 * not an error and not a second download.
 */
export interface HostToolingProvider {
	describe(): Promise<readonly HostToolStatus[]>;
	install?(tool: string): Promise<HostToolStatus>;
}

/**
 * One {@link HostToolStatus} with the platform that reported it.
 *
 * The registry tags each row on the way out (`./registry.ts`), so a provider answers about
 * programs and never about itself — and two backends that both need one program each still
 * produce rows a reader can tell apart.
 */
export type HostTooling = HostToolStatus & { readonly platform: PlatformId };
