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
 * three are stored exactly as given and read by nothing here: no trimming, no defaulting,
 * no meaning. `testName` is deliberately **not** unique — running the same named check
 * before and after a change is two leases with one name, which is the point rather than a
 * collision to reject.
 *
 * **The TTL is renewed by activity, not by a heartbeat** (D8). {@link LeaseStore.use} is
 * what every verb call goes through, and it pushes the expiry out; there is nothing for a
 * client to ping. An agent that pauses for eleven minutes to think keeps its device, and an
 * agent that died five minutes ago loses it without anyone noticing the death.
 *
 * **Expiry is lazy and there is no timer.** Every read drops a record whose instant has
 * passed before answering, so "expired" is computed from the record rather than raced
 * against a `setTimeout` that can disagree with it — a second piece of state that can go
 * stale independently is exactly what D6 is about. R9's restoration hangs off
 * `resolveLive`, the one place a lease is observed to have ended.
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
	/** Caller-supplied and optional; `null` when it was not given. Not unique (D22). */
	readonly testName: string | null;
	/**
	 * A host-local instant. **Never crosses the wire** (D17): a client shares no clock with
	 * the host, so what it is told is the remaining duration — see {@link LeaseStore.remainingMs}.
	 */
	readonly expiresAtMs: number;
}

/** What a caller asks for. The three strings arrive as given and are stored as given. */
export interface LeaseRequest {
	readonly serial: DeviceSerial;
	readonly owner: string;
	readonly project: string;
	readonly testName: string | null;
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
}

export interface LeaseStoreOptions {
	/** Defaults to {@link LEASE_TTL_MS}. Injected by tests, not a configuration surface. */
	readonly ttlMs?: number;
	/**
	 * Defaults to `Date.now`. Injected so a test can move time by hand — a real clock and a
	 * twenty-minute TTL cannot both be in the same unit test.
	 */
	readonly now?: () => number;
}

export function createLeaseStore(options: LeaseStoreOptions = {}): LeaseStore {
	const ttlMs = options.ttlMs ?? LEASE_TTL_MS;
	const now = options.now ?? Date.now;

	// Two maps kept in step: the id is the credential a caller presents, the serial is the
	// thing being made exclusive, and both are asked about on the hot path.
	const byId = new Map<LeaseId, Lease>();
	const bySerial = new Map<DeviceSerial, LeaseId>();

	/** Drop the record if its instant has passed. The single place a lease is observed to end. */
	const forget = (lease: Lease): void => {
		byId.delete(lease.id);
		bySerial.delete(lease.serial);
	};

	const resolveLive = (id: LeaseId): Lease | null => {
		const lease = byId.get(id);
		if (!lease) {
			return null;
		}
		if (lease.expiresAtMs <= now()) {
			forget(lease);
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

			const lease: Lease = {
				// Opaque. PROJECT.md §10 gives the archive a `<timestamp>-<owner>-<hash>` shape for
				// this id, which turns a caller-supplied string into a path component; that
				// belongs with the archive that has to sanitise it (R25), not here.
				id: parseLeaseId(randomUUID()),
				serial: request.serial,
				owner: request.owner,
				project: request.project,
				testName: request.testName,
				expiresAtMs: now() + ttlMs,
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
			forget(lease);
			return true;
		},

		holderOf(serial: DeviceSerial): Lease | null {
			return resolveLiveBySerial(serial);
		},

		remainingMs(lease: Lease): number {
			return Math.max(0, lease.expiresAtMs - now());
		},
	};
}
