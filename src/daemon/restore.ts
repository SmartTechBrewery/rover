/**
 * Putting a device back the way it was found — the daemon's job, never the caller's (D9).
 *
 * **The caller is not asked and cannot opt out.** The predecessor asked callers, in a
 * comment, to restore state before releasing; nobody ever checked and nobody ever did
 * (ai/RULES.md §2). So this hangs off the lease store's `onLeaseEnded` hook rather than off
 * `release_device`, which means it runs on the expiry path too — the path where there is by
 * definition no caller left to ask.
 *
 * **A failing step never stops the ones after it.** A teardown that aborts at the first error
 * is the "only runs on the happy path" failure in a new costume: the app is left running
 * because the network step threw, and the next lessee inherits it. Every step is contained,
 * says what failed, and lets the next one run.
 *
 * **One device restores at a time, and a grant waits for it.** {@link DeviceRestorer.restore}
 * appends to a per-serial promise chain and returns immediately — the lease has ended, and
 * the answer to the caller must not wait on hardware. {@link DeviceRestorer.settle} is the
 * other half: `acquire_device` awaits it, so a device is never handed to a new lessee while
 * the previous lessee's state is still being undone. {@link DeviceRestorer.settleAll} is the
 * same wait for the shutdown path, where a restoration that is abandoned is never retried —
 * a lease dies with the host (D6), so nothing afterwards is left to notice it was owed.
 *
 * **And it waits for the ending lease's verbs before it starts.** A teardown is device I/O
 * like any other, so it queues behind whatever the lease that just ended still has in flight
 * (`./verb-traffic.ts`, {@link DeviceRestorerOptions.settleTraffic}) rather than driving the
 * device alongside it. `acquire_device` inherits that wait through {@link DeviceRestorer.settle}.
 *
 * **The step order is the finding, not a preference** (PROJECT.md §6, verified 2026-08-29):
 * the airplane-mode step can move wifi underneath it in a direction no caller can predict,
 * while the wifi step never moves airplane mode. So both are set explicitly and **wifi is set
 * last**. Setting a resting state unconditionally is deliberate too — both primitives are
 * idempotent and silent about it, so a read first would buy nothing.
 */

import type { RegisteredDeviceBackend } from '../backends/manifest.js';
import { requireDeviceBackend } from '../backends/registry.js';
import { supportsCapability } from '../core/capabilities.js';
import type { DeviceBackend } from '../core/device.js';
import type { AppId, DeviceSerial } from '../core/ids.js';
import type { DeviceInventory } from './inventory.js';
import type { Lease, LeaseEndReason } from './leases.js';

/**
 * What one project asks to have undone when a lease on it ends: the applications it drove,
 * and whatever else it started.
 */
export interface ProjectRestoration {
	/** Stopped on the device, in the order given. Empty is a perfectly good answer. */
	readonly apps: readonly AppId[];
	/**
	 * The project's own teardown (D13) — helper services, temporary files, its own state.
	 *
	 * **It must bound itself, and it is bounded here anyway.** `acquire_device` awaits
	 * {@link DeviceRestorer.settle} before granting, so a hook that waits forever on a helper
	 * service that never exits would hang every later grant for that device with no lease id
	 * and no TTL to fall back on — unlike a wedged lease, nothing would expire it. Every other
	 * step is a backend call carrying its own timeout; this one is foreign code, so it gets
	 * {@link TEARDOWN_TIMEOUT_MS} and a warning rather than the benefit of the doubt.
	 */
	readonly teardown?: () => Promise<void>;
}

/**
 * How long the project's teardown hook may take before the restoration stops waiting for it
 * and says so.
 *
 * The same trade the daemon's shutdown makes for the device watches: a leak reported out loud
 * beats a wait that never ends (`listen.ts`, `WATCH_STOP_TIMEOUT_MS`). Generous enough that a
 * hook stopping a helper service normally is never reported as a hang. The hook is not
 * cancelled — nothing here can cancel it — so it may still be running when this returns; what
 * the bound protects is the grant queued behind it.
 */
const TEARDOWN_TIMEOUT_MS = 10_000;

/**
 * How the `project` string on a lease becomes something to tear down.
 *
 * **This is a seam, not a configuration surface.** No configuration source exists yet: the
 * per-project schema, the file format and the loader are R17 (PROJECT.md §9.3), which is
 * blocked on this row precisely so it has something to plug into. Until it lands the default
 * resolves nothing, so the app and hook steps have nothing to do and say nothing — a hook
 * that does not fire yet, not one that is broken.
 *
 * `null` for a project nobody has described, which is the ordinary case rather than a failure
 * (ai/CODING_STANDARDS.md "Error handling").
 *
 * **A throw is tolerated and degrades to `null`.** R17's resolver will read a file, and a file
 * can be missing or malformed. That must cost the project's own steps and nothing else: the
 * device is still put back — app steps aside, they are the part that needs the project — with
 * a warning naming the project and the reason. A resolver whose throw skipped the airplane-mode
 * and wifi steps would be one bad config file silently disabling restoration for every device
 * that project ever leases, which is the "only runs on the happy path" failure D9 exists to
 * remove.
 */
export type ProjectResolver = (project: string) => ProjectRestoration | null;

export interface DeviceRestorer {
	/**
	 * Restore the device this lease held. Returns immediately and **never rejects** — it is
	 * called from inside the lease store, where a throw would abort a grant.
	 */
	restore(lease: Lease, reason: LeaseEndReason): void;
	/**
	 * Resolve once nothing is being restored on `serial`. `acquire_device` awaits this before
	 * granting, so no lessee ever receives a device mid-restore.
	 */
	settle(serial: DeviceSerial): Promise<void>;
	/**
	 * Resolve once nothing is being restored on **any** device. The daemon's `close()` awaits
	 * this, bounded: a restoration has no second chance, because a lease dies with the host
	 * (D6) and after a restart there is no expired holder left for anything to notice.
	 *
	 * A snapshot of what is in flight when it is called, deliberately — a restoration queued
	 * afterwards belongs to a lease that ended after the daemon was asked to stop, and waiting
	 * for a set that can still grow is the unbounded shutdown wait `listen.ts` refuses.
	 */
	settleAll(): Promise<void>;
}

export interface DeviceRestorerOptions {
	/**
	 * Where a serial is resolved to a device. The same re-verification a grant does (D6) —
	 * the platform is asked what is there now, rather than the cache being read.
	 */
	readonly inventory: DeviceInventory;
	/** Defaults to resolving nothing — see {@link ProjectResolver}. */
	readonly resolveProject?: ProjectResolver;
	/** Where every contained failure goes. Injected so a test can read it. */
	readonly warn?: (message: string) => void;
	/**
	 * Defaults to {@link TEARDOWN_TIMEOUT_MS}. A test seam in the spirit of
	 * `LeaseStoreOptions.ttlMs`, not a configuration surface — a real ten-second bound and a
	 * unit test cannot both be in the same run.
	 */
	readonly teardownTimeoutMs?: number;
	/**
	 * Resolve once nothing else is still driving the device — the ending lease's verb calls
	 * (`./verb-traffic.ts`, wired in `./listen.ts`).
	 *
	 * A restoration and a verb are two drivers of one device, and the verb is the one that was
	 * there first: stopping an app underneath a wait would answer that wait about a screen the
	 * teardown produced. The lease's end revokes the device from those calls before this is
	 * ever awaited, so the wait is one backend call long, not a verb timeout long.
	 *
	 * Defaults to resolving immediately — a restorer wired without a verb surface has nothing
	 * to wait for, and nothing else in this module knows what a verb is.
	 */
	readonly settleTraffic?: (serial: DeviceSerial) => Promise<void>;
}

export function createDeviceRestorer(options: DeviceRestorerOptions): DeviceRestorer {
	const { inventory } = options;
	const resolveProject: ProjectResolver = options.resolveProject ?? (() => null);
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const teardownTimeoutMs = options.teardownTimeoutMs ?? TEARDOWN_TIMEOUT_MS;
	const settleTraffic: (serial: DeviceSerial) => Promise<void> =
		options.settleTraffic ?? (() => Promise.resolve());

	// One chain per device, holding the restoration currently in flight and everything queued
	// behind it. Two restorations of one device cannot interleave, and `settle` has a single
	// promise to await. An entry is deleted once it is the settled tail, so this does not grow
	// with the number of leases the host has ever granted.
	const chains = new Map<DeviceSerial, Promise<void>>();

	/** Run one step, contained: a failure is reported and the next step still runs. */
	const step = async (
		serial: DeviceSerial,
		what: string,
		run: () => Promise<void>,
	): Promise<void> => {
		try {
			await run();
		} catch (error) {
			warn(
				`Restoring device '${serial}': ${what} failed — ${describe(error)}. The remaining ` +
					`restoration steps still ran.`,
			);
		}
	};

	const restoreNetwork = async (
		serial: DeviceSerial,
		{ manifest, backend }: RegisteredDeviceBackend,
	): Promise<void> => {
		if (!supportsCapability(manifest, 'canControlNetwork')) {
			// One warning, and not an error: a backend that honestly opts out is complete, not
			// broken (D11), and a teardown is not a verb an agent called — there is nobody to
			// hand a `MissingCapabilityError` to. The device is still left with its app stopped
			// and its project torn down.
			warn(
				`Restoring device '${serial}': the ${manifest.label} backend does not declare ` +
					`'canControlNetwork', so the airplane-mode and wifi steps are skipped. Whatever ` +
					`the lease left the radios in stays that way.`,
			);
			return;
		}

		// Airplane mode first and wifi last — PROJECT.md §6, and see this module's header.
		await step(serial, 'turning airplane mode off', () =>
			required(backend, 'setAirplaneMode', manifest.label)(serial, false),
		);
		await step(serial, 'turning wifi back on', () =>
			required(backend, 'setWifiEnabled', manifest.label)(serial, true),
		);
	};

	/**
	 * The whole restoration, and the guarantee that it never rejects.
	 *
	 * Every step is contained, and so is resolving the project, so nothing below is expected to
	 * reach this catch — it is the backstop for the bookkeeping between the steps rather than
	 * for any one of them. It matters because `settle` is awaited inside `acquire_device`: a
	 * chain that rejected would turn the next grant into an `internal_error` about a device
	 * that is perfectly fine.
	 */
	const run = async (lease: Lease, reason: LeaseEndReason): Promise<void> => {
		try {
			await runSteps(lease, reason);
		} catch (error) {
			warn(
				`Restoring device '${lease.serial}' after a lease ${reason} failed outside any one ` +
					`step — ${describe(error)}. The device may not have been restored.`,
			);
		}
	};

	/**
	 * What the project asks to have undone, or `null` — for a project nobody has described,
	 * and equally for a resolver that threw. Contained like every step is, and for the same
	 * reason: this is R17's code, it will read a file, and a device left in airplane mode is
	 * far too high a price for a config file that would not parse.
	 */
	const describeProject = (serial: DeviceSerial, project: string): ProjectRestoration | null => {
		try {
			return resolveProject(project);
		} catch (error) {
			warn(
				`Restoring device '${serial}': working out what project '${project}' asks to have ` +
					`undone failed — ${describe(error)}. Its apps and teardown hook are skipped; the ` +
					`device's own restoration still ran.`,
			);
			return null;
		}
	};

	const runSteps = async (lease: Lease, reason: LeaseEndReason): Promise<void> => {
		const serial = lease.serial;
		// Before anything is undone: the lease that just ended may still have a verb unwinding
		// against this device, and a teardown running beside it is the two-drivers failure with
		// the host on both ends. See {@link DeviceRestorerOptions.settleTraffic}.
		await settleTraffic(serial);
		const project = describeProject(serial, lease.project);
		const registered = await resolveDevice(serial, reason);

		if (registered && project) {
			for (const app of project.apps) {
				await step(serial, `stopping '${app}'`, () => registered.backend.stopApp(serial, app));
			}
		}
		if (registered) {
			await restoreNetwork(serial, registered);
		}
		if (project?.teardown) {
			// Runs even when the device could not be resolved: a project's teardown is the host's
			// own cleanup (D13) — helper services, temporary files — and a device that vanished is
			// the case where leaking those matters most.
			const teardown = project.teardown;
			await step(serial, 'the project teardown hook', () => runTeardown(serial, teardown));
		}
	};

	/**
	 * The project's teardown hook, bounded. `step` contains a failure but not a duration, and
	 * every other step is a backend call that carries its own timeout — this one is foreign
	 * code reached through {@link ProjectRestoration.teardown}, and `settle` is awaited by
	 * `acquire_device`, so a hook that never returns would hang every later grant on this
	 * device with nothing left to expire it.
	 *
	 * The hook is not cancelled, because nothing here can cancel it; the bound is on the wait,
	 * and the warning says so.
	 */
	const runTeardown = async (
		serial: DeviceSerial,
		teardown: () => Promise<void>,
	): Promise<void> => {
		let timer: NodeJS.Timeout | undefined;
		const expiry = new Promise<'timed-out'>((resolve) => {
			timer = setTimeout(() => resolve('timed-out'), teardownTimeoutMs);
			// Unreferenced: this exists to stop us waiting, never to keep a process alive that is
			// otherwise finished.
			timer.unref();
		});

		try {
			if ((await Promise.race([teardown(), expiry])) === 'timed-out') {
				warn(
					`Restoring device '${serial}': the project teardown hook did not finish within ` +
						`${teardownTimeoutMs}ms. The device is being handed on anyway; whatever the ` +
						`hook started may still be running.`,
				);
			}
		} finally {
			clearTimeout(timer);
		}
	};

	/**
	 * The device and the backend that owns it, or `null` with a warning when neither can be
	 * had. A device that vanished mid-lease has nothing to drive and is already a named case
	 * (`DeviceVanishedError`); this is not the place to chase it.
	 */
	const resolveDevice = async (
		serial: DeviceSerial,
		reason: LeaseEndReason,
	): Promise<RegisteredDeviceBackend | null> => {
		try {
			const device = await inventory.verifyForGrant(serial);
			// The same two steps a grant takes, in the same order and through the same functions
			// (`lease-handlers.ts`). A second way for a platform id to become a backend would be a
			// second way for the two to disagree about which one is holding the device.
			return requireDeviceBackend(device.platform);
		} catch (error) {
			warn(
				`Restoring device '${serial}' after a lease ${reason}: the device could not be ` +
					`reached — ${describe(error)}. Nothing on the device was restored.`,
			);
			return null;
		}
	};

	return {
		restore(lease: Lease, reason: LeaseEndReason): void {
			const serial = lease.serial;
			// `run` never rejects, so the chain cannot either: a queued restoration is never
			// skipped because the one before it went wrong, and `settle` never rejects into a
			// grant.
			const queued = (chains.get(serial) ?? Promise.resolve()).then(() => run(lease, reason));
			const settled = queued.finally(() => {
				// Only the tail clears the entry: an earlier link finishing while another is queued
				// behind it must leave `settle` something to await.
				if (chains.get(serial) === settled) {
					chains.delete(serial);
				}
			});
			chains.set(serial, settled);
		},

		settle(serial: DeviceSerial): Promise<void> {
			return chains.get(serial) ?? Promise.resolve();
		},

		async settleAll(): Promise<void> {
			// Each entry is that device's tail, so this covers everything queued as well as
			// everything in flight. Snapshotted before the await for the reason on the interface:
			// awaiting a set that can still grow is an unbounded shutdown wait.
			await Promise.all([...chains.values()]);
		},
	};
}

/**
 * A capability-gated method the manifest promised. Missing here is a wiring bug the
 * conformance suite exists to catch (ai/TESTING.md), so it throws — into the step's own
 * containment, which turns it into a warning rather than a lost restoration.
 */
function required<Method extends 'setAirplaneMode' | 'setWifiEnabled'>(
	backend: DeviceBackend,
	method: Method,
	label: string,
): NonNullable<DeviceBackend[Method]> {
	const implementation = backend[method];
	if (!implementation) {
		throw new Error(
			`the ${label} backend declares 'canControlNetwork' but implements no '${method}'`,
		);
	}
	return implementation.bind(backend) as NonNullable<DeviceBackend[Method]>;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
