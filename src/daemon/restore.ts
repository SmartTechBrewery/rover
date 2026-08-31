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
 * **The project's services are stopped before its teardown hook.** A teardown is the project's
 * own cleanup and may well expect its services to be down already — and the reverse order would
 * have a teardown tidying up underneath processes that are still writing. They come after the
 * device's own steps for the same reason the teardown does: what runs on the host is what a
 * vanished device cannot stop us doing (D13, R17 phase 4).
 *
 * **And the lease's slot comes back only once all of that has finished**
 * ({@link DeviceRestorerOptions.onRestored}, R18). The teardown is what was told the slot's
 * ports, so the numbers are reclaimed at the tail of this chain rather than when the lease
 * record disappeared — same path, same clock, no second timer.
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
import type { Slot } from './slots.js';

/**
 * One helper service to stop, and the name to say it by.
 *
 * The name is carried beside the closure because a warning about a stop that failed is only
 * useful if it says *which* service — the same reason a refused grant names one
 * (`./project-services.ts`).
 */
export interface ProjectServiceStop {
	readonly name: string;
	readonly stop: () => Promise<void>;
}

/**
 * What one project asks to have undone when a lease on it ends: the applications it drove,
 * and whatever else it started.
 */
export interface ProjectRestoration {
	/** Stopped on the device, in the order given. Empty is a perfectly good answer. */
	readonly apps: readonly AppId[];
	/**
	 * The project's helper services, stopped on the **host** — one step each, in the order
	 * given, ahead of {@link ProjectRestoration.teardown} (D13, R17 phase 4).
	 *
	 * A list rather than one closure, because each stop is a step of its own: a failing stop is
	 * contained and named, and the ones after it still run. `./project-resolver.ts` puts them in
	 * the reverse of the order the grant started them in, so a service that came up after the
	 * one it depends on goes down before it.
	 *
	 * **Stopped unconditionally**, the way the applications are and the way both radios are set
	 * without being read first: this runs for every lease that ends, including one whose grant
	 * never got the services up, so a `stop` that finds nothing to stop is the ordinary case
	 * rather than a failure. Only what a project declares a `stop` for appears here.
	 *
	 * Each gets {@link TEARDOWN_TIMEOUT_MS} the teardown's way, so a project declaring the
	 * `MAX_PROJECT_SERVICES` maximum of slow stops can keep the next grant on that device
	 * waiting for that many bounds in a row (`./project-hooks.ts`). That is what keeps the
	 * maximum small, and why a `stop` should stop rather than wait for anything.
	 */
	readonly services?: readonly ProjectServiceStop[];
	/**
	 * The project's own teardown (D13) — temporary files, shared state, whatever the declared
	 * services do not cover. **Last**, so it runs with those services already stopped.
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
 *
 * **Every hook this module waits on gets it** — the teardown and each of the project's service
 * stops alike (R17 phase 4). One number rather than two, because the trade is identical: each is
 * foreign code the restoration cannot cancel, and each stands in front of a grant.
 */
export const TEARDOWN_TIMEOUT_MS = 10_000;

/**
 * How long a restoration waits for the ending lease's verb calls to unwind before it stops
 * waiting, says so, and restores anyway ({@link DeviceRestorerOptions.settleTraffic}).
 *
 * **A bound was missing here and the teardown's already existed**, which is the wrong way
 * round: this wait comes *first* in a restoration, and `acquire_device` waits on the whole
 * chain. Without it the wait is as long as whatever the ending lease was doing — a backend
 * round trip already issued to the device (`INSTALL_ADB_TIMEOUT_MS` is five minutes), or a host
 * process a revocation cannot reach at all. So a grant could be parked for minutes with no
 * bound of its own, long past the client's 30 s `DEFAULT_REQUEST_TIMEOUT_MS`: the caller gives
 * up, the daemon does not learn that, and the device is eventually granted to somebody who is
 * no longer there and held for a full `LEASE_TTL_MS`.
 *
 * **Ten seconds, matching {@link TEARDOWN_TIMEOUT_MS}, and the same trade.** What can still be
 * running when it expires is at most *one* backend round trip per call: the lease's end revoked
 * the backend before this was awaited, so a revoked verb issues nothing further — and
 * `install_app`'s host process is now cancelled rather than waited out (`./verb-traffic.ts`).
 * A restoration overlapping one round trip that was already in flight, reported out loud, beats
 * every later grant on the device queueing behind it silently.
 */
export const SETTLE_TIMEOUT_MS = 10_000;

/**
 * How the `project` string on a lease becomes something to tear down.
 *
 * **This is a seam, not a configuration surface.** What fills it is `./project-resolver.ts`,
 * over the per-project hook file of `./project-hooks.ts` (D13) — this module names the shape
 * and knows nothing about where hooks come from, which is what keeps the file reader and the
 * process runner out of a module `./lease-handlers.ts` imports. A restorer wired without one
 * resolves nothing, so the app and hook steps have nothing to do and say nothing.
 *
 * **Asynchronous, because resolving reads a file** — re-read at every use and never cached
 * (D6), so an edited hook file bites on the next lease that ends. Reading it synchronously
 * would block the daemon's event loop, for every other connection, while one lease is torn
 * down.
 *
 * **Given the serial** as well as the project, because a teardown that cannot name the device
 * it is undoing is the wrong shape to hand a hook, and this module has the serial in hand. And
 * **given the lease's slot** for the same reason (R18, `./slots.ts`): a teardown stopping the
 * helper services an install started has to be told the ports they were started on.
 *
 * `null` for a project nobody has described, which is the ordinary case rather than a failure
 * (ai/CODING_STANDARDS.md "Error handling").
 *
 * **A throw is tolerated and degrades to `null`.** The resolver reads a file, and a file can be
 * malformed. That must cost the project's own steps and nothing else: the device is still put
 * back — app steps aside, they are the part that needs the project — with a warning naming the
 * project and the reason. A resolver whose throw skipped the airplane-mode and wifi steps would
 * be one bad config file silently disabling restoration for every device that project ever
 * leases, which is the "only runs on the happy path" failure D9 exists to remove.
 */
export type ProjectResolver = (
	project: string,
	serial: DeviceSerial,
	slot: Slot,
) => Promise<ProjectRestoration | null>;

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
	 * Defaults to {@link SETTLE_TIMEOUT_MS}. A test seam in the spirit of
	 * {@link teardownTimeoutMs}, and not a configuration surface for the same reason.
	 */
	readonly settleTimeoutMs?: number;
	/**
	 * Resolve once nothing else is still driving the device — the ending lease's verb calls
	 * (`./verb-traffic.ts`, wired in `./listen.ts`).
	 *
	 * A restoration and a verb are two drivers of one device, and the verb is the one that was
	 * there first: stopping an app underneath a wait would answer that wait about a screen the
	 * teardown produced. The lease's end revokes the device from those calls before this is ever
	 * awaited, so a revoked verb issues no *further* backend call.
	 *
	 * That is not the same as the wait being short, and this used to say it was. What can still
	 * be outstanding is a round trip the backend already handed to the device — up to
	 * `INSTALL_ADB_TIMEOUT_MS`, five minutes, for the transfer rows — and, for a verb that awaits
	 * a host process rather than a backend, work the revocation never touched at all. So the
	 * wait is bounded here by {@link SETTLE_TIMEOUT_MS} the way the teardown is, and
	 * `install_app`'s install command is cancelled with the lease rather than waited out.
	 *
	 * Defaults to resolving immediately — a restorer wired without a verb surface has nothing
	 * to wait for, and nothing else in this module knows what a verb is.
	 */
	readonly settleTraffic?: (serial: DeviceSerial) => Promise<void>;
	/**
	 * Called once this lease's restoration has finished, whichever way the lease ended.
	 * `./listen.ts` fills it with the one thing that must happen *after* a teardown rather than
	 * with it: giving the lease's slot back to the pool (R18, `./slots.ts`).
	 *
	 * **Why last, and not at `onLeaseEnded`.** The teardown that is about to run was told the
	 * slot's ports, and it is the thing still using them. Freeing the numbers the instant the
	 * lease record disappeared would let the very next grant hand the same block to a new
	 * service while the previous lessee's `stop` was still on it — and the allocator hands out
	 * the lowest free index, so the freed slot is *the* next one out rather than an unlucky one.
	 * The teardown's own {@link TEARDOWN_TIMEOUT_MS} and {@link SETTLE_TIMEOUT_MS} already bound
	 * how long that can delay reclamation, and it is the same clock and the same path as the
	 * restoration itself — never a second timer with its own idea of what is dead (D6, D9).
	 *
	 * Contained the way a step is: a listener that throws is a warning, never a chain that
	 * rejects, because `settle` is awaited inside `acquire_device`. What is *not* covered is a
	 * lease whose restoration was never started at all — a listener earlier in the store's end
	 * hook that threw takes the ones after it with it — and that hazard is the existing one
	 * `archive.forget` already has rather than a new one.
	 */
	readonly onRestored?: (lease: Lease) => void;
}

export function createDeviceRestorer(options: DeviceRestorerOptions): DeviceRestorer {
	const { inventory } = options;
	const resolveProject: ProjectResolver = options.resolveProject ?? (() => Promise.resolve(null));
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const teardownTimeoutMs = options.teardownTimeoutMs ?? TEARDOWN_TIMEOUT_MS;
	const settleTimeoutMs = options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
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
		// After the steps and inside the chain, so what the teardown was told is not handed to
		// somebody else while it is still using it — see {@link DeviceRestorerOptions.onRestored}.
		// Announced even when a step failed: a restoration that went wrong is still a lease that
		// is over, and holding its slot back would leak ports for a device nobody is on.
		announceRestored(lease);
	};

	/** The listener, contained: it must not reject the chain `acquire_device` awaits. */
	const announceRestored = (lease: Lease): void => {
		try {
			options.onRestored?.(lease);
		} catch (error) {
			warn(
				`Restoring device '${lease.serial}': the after-restoration listener threw — ` +
					`${describe(error)}. The device was still restored; whatever that listener does ` +
					`may not have happened.`,
			);
		}
	};

	/**
	 * What the project asks to have undone, or `null` — for a project nobody has described,
	 * and equally for a resolver that threw. Contained like every step is, and for the same
	 * reason: the resolver reads a file, and a device left in airplane mode is far too high a
	 * price for a config file that would not parse.
	 */
	const describeProject = async (
		serial: DeviceSerial,
		project: string,
		slot: Slot,
	): Promise<ProjectRestoration | null> => {
		try {
			return await resolveProject(project, serial, slot);
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
		// the host on both ends. Bounded, because `acquire_device` waits on the whole chain —
		// see {@link DeviceRestorerOptions.settleTraffic}.
		await awaitSettled(serial);
		const project = await describeProject(serial, lease.project, lease.slot);
		const registered = await resolveDevice(serial, reason);

		if (registered && project) {
			for (const app of project.apps) {
				await step(serial, `stopping '${app}'`, () => registered.backend.stopApp(serial, app));
			}
		}
		if (registered) {
			await restoreNetwork(serial, registered);
		}
		for (const service of project?.services ?? []) {
			// Ahead of the teardown, and on this path whether or not the device could be resolved,
			// for the same reason the teardown is: a process on the host outlives the device that
			// went away, and a lease that ended is the last thing that was ever going to stop it.
			await step(serial, `stopping the '${service.name}' helper service`, () =>
				runHook(serial, `the '${service.name}' helper service's stop hook`, service.stop),
			);
		}
		if (project?.teardown) {
			// Runs even when the device could not be resolved: a project's teardown is the host's
			// own cleanup (D13) — helper services, temporary files — and a device that vanished is
			// the case where leaking those matters most.
			const teardown = project.teardown;
			await step(serial, 'the project teardown hook', () =>
				runHook(serial, 'the project teardown hook', teardown),
			);
		}
	};

	/**
	 * The ending lease's verb calls, bounded — {@link SETTLE_TIMEOUT_MS} says why there is a
	 * bound at all, and it is enforced the way the teardown's is because the shape is the same:
	 * nothing here can cancel what it is waiting for, so the bound is on the wait and the
	 * warning says exactly that.
	 */
	const awaitSettled = async (serial: DeviceSerial): Promise<void> => {
		if ((await raceTimeout(settleTraffic(serial), settleTimeoutMs)) === 'timed-out') {
			warn(
				`Restoring device '${serial}': a verb call from the lease that just ended had not ` +
					`unwound within ${settleTimeoutMs}ms. Restoring anyway, so the next grant is not ` +
					`held behind it; that call can issue no further device call, but one it had ` +
					`already issued may still be in flight.`,
			);
		}
	};

	/**
	 * One of the project's hooks, bounded. `step` contains a failure but not a duration, and
	 * every other step is a backend call that carries its own timeout — these are foreign code
	 * reached through {@link ProjectRestoration}, and `settle` is awaited by `acquire_device`,
	 * so a hook that never returns would hang every later grant on this device with nothing
	 * left to expire it.
	 *
	 * The hook is not cancelled, because nothing here can cancel it; the bound is on the wait,
	 * and the warning says so.
	 */
	const runHook = async (
		serial: DeviceSerial,
		what: string,
		hook: () => Promise<void>,
	): Promise<void> => {
		if ((await raceTimeout(hook(), teardownTimeoutMs)) === 'timed-out') {
			warn(
				`Restoring device '${serial}': ${what} did not finish within ` +
					`${teardownTimeoutMs}ms. The device is being handed on anyway; whatever the ` +
					`hook started may still be running.`,
			);
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

/**
 * Wait for `work`, but not past `timeoutMs` — the one shape both bounds in this module use.
 *
 * Neither of them can cancel what it is waiting for, so `'timed-out'` means "stopped waiting"
 * and never "stopped it"; each caller's warning is what says so. A rejection from `work` still
 * travels, because a step that failed is a different thing from one that ran long, and `step`
 * is what contains it.
 *
 * The timer is unreferenced and cleared: this exists to stop us waiting, never to keep a
 * process alive that is otherwise finished, and a ten-second handle per lease that ended would
 * outlive every restoration that came in under its bound.
 */
async function raceTimeout(
	work: Promise<unknown>,
	timeoutMs: number,
): Promise<'settled' | 'timed-out'> {
	let timer: NodeJS.Timeout | undefined;
	const expiry = new Promise<'timed-out'>((resolve) => {
		timer = setTimeout(() => resolve('timed-out'), timeoutMs);
		timer.unref();
	});

	try {
		return await Promise.race([work.then(() => 'settled' as const), expiry]);
	} finally {
		clearTimeout(timer);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
