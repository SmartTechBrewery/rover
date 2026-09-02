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
 *
 * `testDescription` is optional on both sides and is passed straight through, absence included
 * (D22, as amended #148). It is projected here rather than at either caller for this module's
 * whole reason: it is the sentence an operator reads before force-releasing a lease, and a field
 * a listing carried and a refusal did not would be missing exactly where the decision is made.
 */

import type { LeaseHolder } from '../ipc/methods.js';
import type { Lease, LeaseStore } from './leases.js';

export function toLeaseHolder(lease: Lease, leases: LeaseStore): LeaseHolder {
	return {
		serial: lease.serial,
		owner: lease.owner,
		project: lease.project,
		testName: lease.testName,
		// **The key itself is absent for a lease that has no description**, rather than present
		// holding `undefined`. `JSON.stringify` drops either, so the wire is the same — but this
		// projection is the one thing a stranger is shown, and what it discloses is asserted by its
		// own key set (`tests/unit/daemon/lease-holder.test.ts`, D20). Keeping that set exact is
		// what makes the assertion worth making.
		...(lease.testDescription === undefined ? {} : { testDescription: lease.testDescription }),
		grantedAt: new Date(lease.createdAtMs).toISOString(),
		expiresInMs: leases.remainingMs(lease),
	};
}
