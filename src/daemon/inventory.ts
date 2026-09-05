/**
 * The daemon's device inventory — what this host has seen, and the one place that
 * refuses to answer from it.
 *
 * **The inventory is a cache and the platform is the truth** (D6). It holds nothing it
 * cannot re-derive: every device in it arrived from a backend's own change stream, and
 * losing the process loses nothing but a subscription. That is deliberate, because the
 * daemon introduces a failure mode the file-based predecessor never had — its own stale
 * state — and the only durable answer to a cache that may be wrong is to not trust it
 * where being wrong costs something. {@link DeviceInventory.verifyForGrant} is that
 * line: it is the primitive the lease layer calls at grant time, and it never reads what
 * is stored here.
 *
 * **A device that is not physically attached to this host never enters it** (D18). Every
 * platform this targets has a network transport, so hardware belonging to another machine
 * can show up in this host's enumeration looking exactly like a local one. Admitting it
 * would put a device this host does not control into the pool it lends from — one that can
 * vanish mid-lease, or already be in use by whatever process attached it.
 */

import type { RegisteredDeviceBackend } from '../backends/manifest.js';
import { listDeviceBackends } from '../backends/registry.js';
import type { Device, DeviceWatch, InterruptionCause, StaleReason } from '../core/device.js';
import { DeviceVanishedError, ForeignDeviceError } from '../core/errors.js';
import type { DeviceSerial, PlatformId } from '../core/ids.js';

/** What the host last saw, and whether that view is still live. */
export interface DeviceSnapshot {
	readonly devices: Device[];
	/**
	 * The list below is **not known to be current**. Three things set it, and a client that
	 * cares only needs to know the one thing they have in common: a backend's view was
	 * interrupted and has not been re-established; a backend has been subscribed to but has
	 * not delivered its first set yet; or the inventory is not running at all (never started,
	 * or already stopped).
	 *
	 * Not "no devices": the devices below are what was last seen, and they are still the best
	 * answer available. An *empty* list with this set is the important case — it says the host
	 * has no view, which a client cannot tell from a host with genuinely nothing attached
	 * unless somebody says so.
	 */
	readonly stale: boolean;
	/**
	 * Why the view above is not current, **when a backend named a cause that will not clear
	 * on its own** (#168) — and `null` otherwise, which is the transient interruption D6 and
	 * R35 already settled and every other reason `stale` is set.
	 *
	 * This is additive: `stale` still means exactly what it meant, and a client that reads
	 * only `stale` keeps behaving as it did. What it buys is the case where nothing self-heals
	 * — a host missing the program a backend drives retries forever and fails the same way —
	 * so a surface can say what is actually wrong instead of repeating "check back shortly"
	 * about a machine that needs somebody to install something.
	 *
	 * **One cause, even when two backends are blind.** `stale` is already an OR across every
	 * subscription, and a caller acting on this needs one actionable sentence rather than an
	 * inventory of them. The first backend that named a cause is the one reported; it names
	 * its own platform, so a second one going the same way is still findable from the host's
	 * own warnings.
	 */
	readonly staleReason: StaleReason | null;
}

export interface DeviceInventory {
	/** Subscribe to every registered backend. Idempotent — a second call is a no-op. */
	start(): void;
	/** Drop every subscription, leaving no child process behind. Safe to call twice. */
	stop(): Promise<void>;
	/** What the host last saw. **Never authoritative** — see this module's header. */
	snapshot(): DeviceSnapshot;
	/**
	 * Re-verify one device against its backend and answer with what the backend says
	 * *now*. Throws {@link DeviceVanishedError} or {@link ForeignDeviceError} rather than
	 * answering wrongly.
	 */
	verifyForGrant(serial: DeviceSerial): Promise<Device>;
}

export interface DeviceInventoryOptions {
	/**
	 * The backends to watch. Defaults to the registry rather than a named backend, so adding
	 * one edits no shared code (ai/RULES.md §2). The registry is re-read on every
	 * {@link DeviceInventory.verifyForGrant} and read **once** by {@link DeviceInventory.start},
	 * so a backend has to be registered before the daemon binds to be watched — which the
	 * intended wiring gives for free, the barrel being a top-level import evaluated before
	 * `startDaemon` runs. Nothing here re-scans for a backend that registers later.
	 */
	readonly backends?: readonly RegisteredDeviceBackend[];
	/** Where the D18 refusal goes. Injected so a test can read it. */
	readonly warn?: (message: string) => void;
}

/** One backend's subscription: its handle, what it last reported, and whether it is live. */
interface Subscription {
	/**
	 * Which platform this subscription is of. Carried on the entry rather than read back out
	 * of the map's key, because {@link DeviceSnapshot.staleReason} publishes it and the key
	 * is a plain string — the registry's key space is open (`../backends/registry.ts`), so
	 * the branded value has to be kept rather than re-parsed.
	 */
	readonly platform: PlatformId;
	/**
	 * Assigned *after* `watchDevices` returns, and undefined until then. The contract has a
	 * backend deliver the full current set "once on subscription" (`DeviceWatcher.onDevices`),
	 * and a backend that already knows it does so synchronously — before the call it was made
	 * from has returned a handle to store. So the entry exists first and the handle lands in
	 * it second; the other way round drops every backend's first snapshot on the floor.
	 */
	watch?: DeviceWatch;
	devices: Device[];
	/**
	 * A frame has arrived at least once. Distinct from `interrupted: false`: between
	 * `watchDevices` returning and the backend's first `onDevices`, this host has no view of
	 * that platform at all, and reporting that window as a live empty list would assert
	 * "nothing is attached" about devices nobody has looked at yet.
	 */
	live: boolean;
	interrupted: boolean;
	/**
	 * What the backend said about the interruption beyond its message, or `null` when it said
	 * nothing — see {@link DeviceSnapshot.staleReason}. Cleared by the next frame along with
	 * `interrupted`, because a view that came back was never permanent after all.
	 */
	cause: InterruptionCause | null;
}

export function createDeviceInventory(options: DeviceInventoryOptions = {}): DeviceInventory {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const resolveBackends = (): readonly RegisteredDeviceBackend[] =>
		options.backends ?? listDeviceBackends();

	// Keyed by platform so one backend's snapshot never clears another's: each stream
	// re-emits its own complete set, and nothing about it describes any other platform.
	const subscriptions = new Map<string, Subscription>();
	// One warning per serial, not one per frame. A change stream re-emits the whole list on
	// every change (PROJECT.md §6), so a per-frame warning would fill the log from a single
	// device that is simply attached elsewhere and staying there.
	const warnedSerials = new Set<string>();
	let watching = false;

	const admit = (platform: string, devices: Device[]): void => {
		const subscription = subscriptions.get(platform);
		if (!subscription) {
			// The watch was stopped while a frame was in flight. Nothing to update.
			return;
		}
		subscription.devices = devices.filter((device) => admits(device, warn, warnedSerials));
		subscription.live = true;
		subscription.interrupted = false;
		subscription.cause = null;
	};

	return {
		start(): void {
			if (watching) {
				return;
			}
			watching = true;
			for (const { manifest, backend } of resolveBackends()) {
				const platform = manifest.platform;
				const subscription: Subscription = {
					platform,
					devices: [],
					live: false,
					interrupted: false,
					cause: null,
				};
				subscriptions.set(platform, subscription);
				subscription.watch = backend.watchDevices({
					onDevices: (devices) => admit(platform, devices),
					onInterrupted: (_reason, cause) => {
						// The last snapshot is kept on purpose. Clearing it would say every device
						// went away at the moment the host lost the ability to know anything, which
						// for a lease layer means releasing devices that never moved; presenting it
						// silently would sell a dead view as a live one. So: keep it, and say so.
						//
						// The message is deliberately dropped and the classification is not (#168):
						// `reason` is written for whoever reads the host's own log, and a client
						// rendering one backend's sentence would be branching on a string. `cause`
						// is the half that was designed to cross the wire.
						markInterrupted(subscriptions.get(platform), cause);
					},
				});
			}
		},

		async stop(): Promise<void> {
			watching = false;
			const handles = [...subscriptions.entries()].flatMap(([platform, subscription]) =>
				subscription.watch ? [[platform, subscription.watch] as const] : [],
			);
			subscriptions.clear();
			warnedSerials.clear();

			// `allSettled`, and this never rejects: the daemon calls it on the way down, and one
			// backend failing to close is not a reason to abandon the others or to leave the
			// socket file on disk behind a rejected `close()` — a stray address nothing serves
			// is the stale state D6 is about. The failure is said out loud instead of thrown.
			const outcomes = await Promise.allSettled(handles.map(([, watch]) => watch.stop()));
			for (const [index, outcome] of outcomes.entries()) {
				if (outcome.status === 'rejected') {
					const platform = handles[index]?.[0];
					warn(
						`The device watch for '${platform}' did not stop cleanly: ` +
							`${message(outcome.reason)}. Something it started may still be running.`,
					);
				}
			}
		},

		snapshot(): DeviceSnapshot {
			const devices: Device[] = [];
			// Not watching is itself a reason the view is not current, and it covers both ends of
			// the lifecycle: before `start()`, and from the first line of `stop()` — which clears
			// the subscriptions while the socket is still being served — until the process goes.
			// Reading the cleared map as "zero backends, nothing interrupted" would answer the
			// whole shutdown window with an authoritative empty list.
			let stale = !watching;
			let staleReason: StaleReason | null = null;
			for (const subscription of subscriptions.values()) {
				devices.push(...subscription.devices);
				// A backend that has never delivered a frame is as unknown as one that was cut off.
				stale ||= !subscription.live || subscription.interrupted;
				// The first backend that named one wins — see `staleReason` on the snapshot. A
				// stopped inventory never reaches here at all: `stop()` clears the subscriptions,
				// so the shutdown window is stale for its own reason and blames no backend for it.
				if (staleReason === null && subscription.cause !== null) {
					staleReason = { ...subscription.cause, platform: subscription.platform };
				}
			}
			// A *running* inventory over an empty registry is the one honest empty answer: there is
			// no backend to have a view, so there is nothing this host has failed to hear.
			return { devices, stale, staleReason };
		},

		async verifyForGrant(serial: DeviceSerial): Promise<Device> {
			// The cache is deliberately not consulted, and this is the single rule this module
			// exists to enforce (D6). It reads like a missed optimisation and is not one: a
			// device that vanished, went offline or was reached over the network since the last
			// frame is indistinguishable from one that did not until the backend is asked, and
			// a lease granted on a wrong answer is the failure the whole daemon exists to
			// prevent.
			for (const { backend } of resolveBackends()) {
				const device = await backend.describeDevice(serial);
				if (!device) {
					continue;
				}
				if (device.attachment !== 'this-host') {
					throw new ForeignDeviceError(serial);
				}
				return device;
			}
			throw new DeviceVanishedError(serial);
		},
	};
}

function markInterrupted(
	subscription: Subscription | undefined,
	cause: InterruptionCause | null,
): void {
	if (subscription) {
		subscription.interrupted = true;
		subscription.cause = cause;
	}
}

/**
 * Whether a device may enter the inventory, warning once about each one that may not.
 *
 * The refusal is loud because a silent one is indistinguishable from the device not being
 * attached at all, and an operator who can plainly see the device in their own tooling has
 * no way to tell the two apart unless somebody says so (D18).
 */
function admits(device: Device, warn: (message: string) => void, warned: Set<string>): boolean {
	if (device.attachment === 'this-host') {
		return true;
	}
	if (!warned.has(device.serial)) {
		warned.add(device.serial);
		warn(
			`Device '${device.serial}' is not physically attached to this host — it is only ` +
				`reachable over a network transport, so it is not taken into the inventory and ` +
				`is never leased (D18).`,
		);
	}
	return false;
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
