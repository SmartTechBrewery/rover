/**
 * The one projection from a stored {@link Lease} to the {@link LeaseHolder} a stranger is
 * shown.
 *
 * It lives in its own module because "a holder disclosed to someone who is not the holder
 * never carries the lease id" is a D20 invariant with two callers — the refusal in
 * `lease-handlers.ts` and the listing in `list-devices.ts` — and an invariant with two copies
 * is an invariant that drifts. Anything that discloses a lease goes through here.
 *
 * `expiresInMs` is a duration rather than an instant for the reason `GrantedLeaseSchema`
 * records: the caller may be on another machine and shares no clock with the host (D17).
 *
 * `grantedAt` is the deliberate exception to that, and the one instant this module formats.
 * It is derived from `createdAtMs` and **never** from `expiresAtMs` minus the TTL, which
 * would move on every verb call (D8) and so report the lease's last activity as its start.
 * Formatting it here rather than at each caller is the reason this module exists at all: a
 * refusal and a listing cannot disagree about when a lease began.
 */

import type { LeaseHolder } from '../ipc/methods.js';
import type { Lease, LeaseStore } from './leases.js';

export function toLeaseHolder(lease: Lease, leases: LeaseStore): LeaseHolder {
	return {
		serial: lease.serial,
		owner: lease.owner,
		project: lease.project,
		testName: lease.testName,
		grantedAt: new Date(lease.createdAtMs).toISOString(),
		expiresInMs: leases.remainingMs(lease),
	};
}
