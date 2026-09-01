/**
 * The lease store — who holds which device, and until when.
 *
 * **A lease is per device, not per machine** (D7). The predecessor was a lease file, so it
 * could only ever take the whole rig: one holder for every device attached to it, and a
 * second agent blocked by hardware it was never going to touch. Here the unit is the
 * serial, and two devices are two independent leases that know nothing about each other.
 *
 * **Three caller-supplied strings, none of them inspected** (D16, D22). `owner` attributes
 * the lease — `issue-112`, `pr-127-review`, later a run identity — and is never derived
 * from a process, a connection or whoever authenticated (D20). `project` and `testName`
 * exist so the artifact archive has somewhere to file the results (PROJECT.md §10). All
 * three are **required**: a lease always names who it is for, which project it belongs to and
 * what it is checking, so the archive's tree never branches on whether a field was supplied
 * (D22, as amended #129). All three are stored exactly as given and read by nothing here: no
 * trimming, no defaulting, no meaning. `testName` is deliberately **not** unique — running the
 * same named check before and after a change is two leases with one name, which is the point
 * rather than a collision to reject.
 *
 * **The TTL is renewed by activity, not by a heartbeat** (D8). {@link LeaseStore.use} is
 * what every verb call goes through, and it pushes the expiry out; there is nothing for a
 * client to ping. An agent that pauses for eleven minutes to think keeps its device, and an
 * agent that died five minutes ago loses it without anyone noticing the death.
 *
 * **Expiry is defined by the record, and the sweep only looks.** Every read drops a record
 * whose instant has passed before answering, so "expired" is computed from `expiresAtMs`
 * rather than raced against a `setTimeout` that can disagree with it — a second piece of
 * state that can go stale independently is exactly what D6 is about. {@link LeaseStore.sweep}
 * does not change that: it re-reads every record so an expiry is *observed* even when nobody
 * asks, which is what the daemon's restoration (D9) needs and what a purely lazy store cannot
 * give it. A sweep that never ran would only ever delay the observation, never alter it.
 *
 * **{@link LeaseStoreOptions.onLeaseEnded} fires from `forget`, the one place a lease ends.**
 * `release` and the expiry branch of `resolveLive` both funnel through it, so "restoration runs
 * on release and on expiry alike" (D9) holds by construction rather than by two call sites
 * somebody has to remember.
 *
 * **{@link LeaseStore.acquire} is synchronous, and that is the whole of the exclusivity
 * guarantee.** The predecessor let four concurrent callers through because its check and
 * its write were separated by work that could be interleaved. Nothing in this module may
 * `await`, and no caller may put an `await` between resolving the holder and inserting its
 * own record — see the comment on the function.
 */

import { randomUUID } from 'node:crypto';
import type { DeviceSerial, LeaseId } from '../core/ids.js';
import { parseLeaseId } from '../core/ids.js';
import type { Slot } from './slots.js';

/**
 * Twenty minutes (D8). Long enough that an agent thinking between calls never loses its
 * device, short enough that a dead one does not hold hardware for a working day.
 */
export const LEASE_TTL_MS = 20 * 60 * 1_000;

/** One granted lease. Held by id, attributed by strings this module never reads. */
export interface Lease {
	readonly id: LeaseId;
	readonly serial: DeviceSerial;
	/** Caller-supplied attribution. Never derived, never validated beyond being a string. */
	readonly owner: string;
	/** Caller-supplied. Names the archive's top-level partition (D22, PROJECT.md §10). */
	readonly project: string;
	/** Caller-supplied and **required** — see the module header. Not unique (D22). */
	readonly testName: string;
	/**
	 * When this lease was granted. The one host-local instant that *does* reach a client —
	 * `./lease-holder.ts` renders it as a UTC string on `LeaseHolderSchema`, because a
	 * stranger cannot derive it from the remaining duration: {@link LeaseStore.use} moves the
	 * expiry on every call and never moves this.
	 *
	 * It is also what the artifact archive names this lease's directory after
	 * (`./archive-path.ts`), and for the same reason: a directory named from the expiry would
	 * move with the lease's last activity rather than sit where the run started.
	 */
	readonly createdAtMs: number;
	/**
	 * A host-local instant. **Never crosses the wire** (D17): a client shares no clock with
	 * the host, so what it is told is the remaining duration — see {@link LeaseStore.remainingMs}.
	 */
	readonly expiresAtMs: number;
	/**
	 * This lease's numbered position on the host, and the ports its hooks may use
	 * (`./slots.ts`, R18). Host state that **never crosses the wire**, for
	 * {@link Lease.expiresAtMs}'s reason and one more: a client neither binds these ports nor
	 * runs anything that would.
	 *
	 * Carried and never read here, exactly like {@link Lease.owner} and {@link Lease.project}.
	 * The caller allocates it inside the same straight-line section it acquires in — see
	 * `./lease-handlers.ts` — and whoever allocated it gives it back once this lease's
	 * restoration has finished (`./listen.ts`, `DeviceRestorerOptions.onRestored`).
	 */
	readonly slot: Slot;
}

/** What a caller asks for. The three strings arrive as given and are stored as given. */
export interface LeaseRequest {
	readonly serial: DeviceSerial;
	readonly owner: string;
	readonly project: string;
	readonly testName: string;
	/** Allocated by the caller, stored as given, interpreted by nothing here — see {@link Lease.slot}. */
	readonly slot: Slot;
}

/**
 * The answer to an acquire: the new lease, or the live one standing in its way.
 *
 * A refusal is **data, not an error**. "That device is held by `pr-127-review` for another
 * eleven minutes" is an answer a caller acts on, not a host that broke
 * (ai/CODING_STANDARDS.md "Error handling").
 */
export type AcquireOutcome =
	| { readonly granted: true; readonly lease: Lease }
	| { readonly granted: false; readonly heldBy: Lease };

export interface LeaseStore {
	/**
	 * Grant the device to this caller, or refuse with whoever holds it.
	 *
	 * **Synchronous by contract** — see this module's header. Adding an `await` here, or
	 * awaiting between a `holderOf` and this call, reintroduces the exact defect this store
	 * was written to remove.
	 */
	acquire(request: LeaseRequest): AcquireOutcome;
	/**
	 * Resolve a live lease **and push its expiry out by the TTL** (D8). This is the renewal:
	 * every verb call resolves its lease through here, and that is the only thing that keeps
	 * a lease alive. `null` when the id is unknown or its lease has expired.
	 */
	use(id: LeaseId): Lease | null;
	/** End a lease. Answers whether there was a live one to end. */
	release(id: LeaseId): boolean;
	/** The live lease on a device, or `null`. Does **not** renew — this is a question. */
	holderOf(serial: DeviceSerial): Lease | null;
	/**
	 * How long this lease has left, by the store's own clock. The wire carries this rather
	 * than {@link Lease.expiresAtMs} (D17). Never negative.
	 */
	remainingMs(lease: Lease): number;
	/**
	 * Re-read every record, so a lease that expired is **observed** — and
	 * {@link LeaseStoreOptions.onLeaseEnded} fired for it — without anyone having asked a
	 * question about it. An agent that died mid-lease asks nothing further, and the device it
	 * was holding would otherwise sit un-restored until the next caller happened along.
	 *
	 * Synchronous, and it decides nothing: expiry is still `expiresAtMs` on the record. The
	 * daemon calls this on an interval; the interval's length changes when an expiry is
	 * noticed, never whether it is one.
	 */
	sweep(): void;
}

/** Why a lease ended — the two paths D9 requires restoration on. */
export type LeaseEndReason = 'released' | 'expired';

export interface LeaseStoreOptions {
	/** Defaults to {@link LEASE_TTL_MS}. Injected by tests, not a configuration surface. */
	readonly ttlMs?: number;
	/**
	 * Defaults to `Date.now`. Injected so a test can move time by hand — a real clock and a
	 * twenty-minute TTL cannot both be in the same unit test.
	 */
	readonly now?: () => number;
	/**
	 * Called once for every lease that ends, whichever way it ended (D9). The daemon hangs
	 * device restoration off this; nothing here reads the lease afterwards.
	 *
	 * **Synchronous, fire-and-forget, and never allowed to throw into this module.** It is
	 * invoked from `forget`, which `resolveLive` reaches from inside
	 * {@link LeaseStore.acquire} — and `acquire` being straight-line synchronous is the
	 * entirety of R8's exclusivity guarantee. A callback that returned a promise would put an
	 * `await` in the middle of it, and one that threw would abort a grant halfway through. So
	 * the return value is `void` and the call is wrapped: a listener that throws is reported
	 * through {@link LeaseStoreOptions.warn} and the lease still ends.
	 */
	readonly onLeaseEnded?: (lease: Lease, reason: LeaseEndReason) => void;
	/** Where a throwing {@link onLeaseEnded} is reported. Injected so a test can read it. */
	readonly warn?: (message: string) => void;
}

export function createLeaseStore(options: LeaseStoreOptions = {}): LeaseStore {
	const ttlMs = options.ttlMs ?? LEASE_TTL_MS;
	const now = options.now ?? Date.now;
	const warn = options.warn ?? ((message: string) => console.warn(message));

	// Two maps kept in step: the id is the credential a caller presents, the serial is the
	// thing being made exclusive, and both are asked about on the hot path.
	const byId = new Map<LeaseId, Lease>();
	const bySerial = new Map<DeviceSerial, LeaseId>();

	/** Drop the record and say so. The single place a lease is observed to end (D9). */
	const forget = (lease: Lease, reason: LeaseEndReason): void => {
		byId.delete(lease.id);
		bySerial.delete(lease.serial);
		try {
			options.onLeaseEnded?.(lease, reason);
		} catch (error) {
			// Swallowed on purpose, and it is not defensive habit: this runs inside `acquire`,
			// which must reach its `set` calls without a foreign throw diverting it. A listener
			// that failed is a device that may not have been restored — worth saying loudly, and
			// not worth wedging a device for a full TTL over.
			warn(
				`A lease-ended listener threw for device '${lease.serial}' (${reason}): ` +
					`${message(error)}. The lease ended regardless; whatever that listener does may ` +
					`not have happened.`,
			);
		}
	};

	const resolveLive = (id: LeaseId): Lease | null => {
		const lease = byId.get(id);
		if (!lease) {
			return null;
		}
		if (lease.expiresAtMs <= now()) {
			forget(lease, 'expired');
			return null;
		}
		return lease;
	};

	const resolveLiveBySerial = (serial: DeviceSerial): Lease | null => {
		const id = bySerial.get(serial);
		return id ? resolveLive(id) : null;
	};

	return {
		acquire(request: LeaseRequest): AcquireOutcome {
			// From here to the `set` calls below there is no `await`, no promise and no callback:
			// this function runs to completion before any other caller can observe the maps, and
			// that is the entirety of "five concurrent clients, exactly one winner".
			const heldBy = resolveLiveBySerial(request.serial);
			if (heldBy) {
				return { granted: false, heldBy };
			}

			const granted = now();
			const lease: Lease = {
				// Opaque, and never a path component: the archive derives its directory name from
				// this lease rather than from this id — `<timestamp>-<owner>-<hash>`, the hash over
				// the id — and does its own sanitising of the caller's strings (`./archive-path.ts`).
				id: parseLeaseId(randomUUID()),
				serial: request.serial,
				owner: request.owner,
				project: request.project,
				testName: request.testName,
				slot: request.slot,
				createdAtMs: granted,
				expiresAtMs: granted + ttlMs,
			};
			byId.set(lease.id, lease);
			bySerial.set(lease.serial, lease.id);
			return { granted: true, lease };
		},

		use(id: LeaseId): Lease | null {
			const lease = resolveLive(id);
			if (!lease) {
				return null;
			}
			// The renewal itself (D8). A new record rather than a mutation, so nothing that is
			// already holding a `Lease` sees its expiry change under it.
			const renewed: Lease = { ...lease, expiresAtMs: now() + ttlMs };
			byId.set(renewed.id, renewed);
			bySerial.set(renewed.serial, renewed.id);
			return renewed;
		},

		release(id: LeaseId): boolean {
			const lease = resolveLive(id);
			if (!lease) {
				return false;
			}
			forget(lease, 'released');
			return true;
		},

		holderOf(serial: DeviceSerial): Lease | null {
			return resolveLiveBySerial(serial);
		},

		remainingMs(lease: Lease): number {
			return Math.max(0, lease.expiresAtMs - now());
		},

		sweep(): void {
			// Over a snapshot, because resolving an expired record deletes it from the map being
			// iterated. `resolveLive` rather than a bare instant comparison, so there is exactly
			// one definition of "expired" in this module.
			for (const id of [...byId.keys()]) {
				resolveLive(id);
			}
		},
	};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
