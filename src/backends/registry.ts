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
import type {
	DeviceBackendRegistration,
	HostTooling,
	RegisteredDeviceBackend,
} from './manifest.js';

const registry: RegisteredDeviceBackend[] = [];
const byPlatform = new Map<string, RegisteredDeviceBackend>();

export function registerDeviceBackend(registration: DeviceBackendRegistration): void {
	const manifest = CapabilityManifestSchema.parse(registration.manifest);
	if (byPlatform.has(manifest.platform)) {
		throw new Error(
			`Device backend '${manifest.platform}' already registered — duplicate platform ids are not allowed`,
		);
	}
	const registered: RegisteredDeviceBackend = {
		manifest,
		backend: registration.backend,
		// Spread rather than assigned, so a registration without a teardown stores no key at all
		// instead of an explicit `undefined` — `stopBackendHostProcesses` below reads the absence
		// as "this backend keeps no host process", and the two spellings must not differ.
		...(registration.stopHostProcesses
			? { stopHostProcesses: registration.stopHostProcesses }
			: {}),
		...(registration.hostTooling ? { hostTooling: registration.hostTooling } : {}),
	};
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
 * End every registered backend's host processes, bounded by the caller and never rejecting.
 *
 * The counterpart to {@link DeviceBackendRegistration.stopHostProcesses}, and the only caller of
 * it: the daemon's shutdown (`src/daemon/listen.ts`), once, after the watches are gone and the
 * restorations have settled. Most backends register no teardown and are skipped — Android is one
 * — so on a host with no simulator this is a walk over a list that does nothing.
 *
 * `allSettled`, and this never rejects, for `DeviceInventory.stop()`'s reason: it is called on the
 * way down, one backend failing to let go of its children is not a reason to abandon the others,
 * and a shutdown step that throws would leave the socket file behind a rejected `close()`. What a
 * failure costs is said out loud, naming the platform, because a process left running on this host
 * is something an operator can only act on if they are told about it.
 *
 * The list is a parameter for the same reason `DeviceInventoryOptions.backends` is: the default is
 * the registry, so adding a backend edits no shared code, and a suite can hand in its own.
 */
export async function stopBackendHostProcesses(
	backends: readonly RegisteredDeviceBackend[] = listDeviceBackends(),
	warn: (message: string) => void = console.warn,
): Promise<void> {
	const teardowns = backends.flatMap((entry) =>
		entry.stopHostProcesses ? [[entry.manifest.platform, entry.stopHostProcesses] as const] : [],
	);
	const outcomes = await Promise.allSettled(teardowns.map(([, stop]) => stop()));
	for (const [index, outcome] of outcomes.entries()) {
		if (outcome.status === 'rejected') {
			const platform = teardowns[index]?.[0];
			warn(
				`The host processes of device backend '${platform}' did not stop cleanly: ` +
					`${message(outcome.reason)}. Something it started may still be running.`,
			);
		}
	}
}

/**
 * What every registered backend says about the programs it needs on **this** host.
 *
 * The read half of {@link DeviceBackendRegistration.hostTooling}, and the daemon's whole answer to
 * `list_host_tooling` (`src/daemon/tooling-handlers.ts`). Each status is tagged with the platform
 * that reported it, here rather than in the backend, so no backend can mislabel another's row and
 * a provider stays a list of programs rather than a list of programs plus its own name.
 *
 * **Never rejects, for `stopBackendHostProcesses`' reason turned the other way up**: a `doctor`
 * that dies because one backend's search threw tells an operator nothing about the other backend,
 * and the missing row is the one they came for. A provider that throws contributes a row saying so
 * — a report is not a place to be silent about a failure (ai/RULES.md §6).
 *
 * The list is a parameter, again so a suite can hand in its own and adding a backend edits nothing
 * here.
 */
export async function describeHostTooling(
	backends: readonly RegisteredDeviceBackend[] = listDeviceBackends(),
): Promise<HostTooling[]> {
	const providers = backends.flatMap((entry) =>
		entry.hostTooling ? [[entry.manifest.platform, entry.hostTooling] as const] : [],
	);
	const outcomes = await Promise.allSettled(providers.map(([, tooling]) => tooling.describe()));

	return outcomes.flatMap((outcome, index) => {
		const platform = providers[index]?.[0];
		if (platform === undefined) return [];
		if (outcome.status === 'rejected') {
			return [
				{
					platform,
					tool: `(${platform})`,
					found: null,
					detail: `This backend could not say what it needs: ${message(outcome.reason)}`,
					installable: false,
				},
			];
		}
		return outcome.value.map((status) => ({ platform, ...status }));
	});
}

/**
 * Install one of those programs, through the backend that offered it.
 *
 * The write half, and the only one with a side effect. It resolves the tool **by asking the
 * providers**, never by a table here: which programs exist is the backends' knowledge, and a
 * lookup written here would be a second place to add a row (ai/RULES.md §2).
 *
 * Throws when nothing offers that name — including when a backend knows the program but declared
 * it uninstallable, which is the honest answer for `adb` and for Xcode: Rover fetches its own
 * second-order tooling and never a platform SDK.
 */
export async function installHostTool(
	tool: string,
	backends: readonly RegisteredDeviceBackend[] = listDeviceBackends(),
): Promise<HostTooling> {
	for (const entry of backends) {
		const provider = entry.hostTooling;
		if (provider?.install === undefined) continue;
		const offered = await provider.describe();
		if (!offered.some((status) => status.tool === tool && status.installable)) continue;
		return { platform: entry.manifest.platform, ...(await provider.install(tool)) };
	}
	throw new UninstallableToolError(tool);
}

/** No registered backend offers to install a program by that name. */
export class UninstallableToolError extends Error {
	constructor(readonly tool: string) {
		super(
			`No registered device backend can install '${tool}' on this host. ` +
				'Ask for one this host reported as installable.',
		);
		this.name = 'UninstallableToolError';
	}
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Test-only helper. Production code MUST NOT call this. Clears the registry between
 * tests so registrations from one test don't leak into the next.
 */
export function _resetDeviceBackendRegistryForTesting(): void {
	registry.length = 0;
	byPlatform.clear();
}
