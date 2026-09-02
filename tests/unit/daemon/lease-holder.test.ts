/**
 * The one projection from a stored lease to the holder a stranger is shown, against an
 * injected clock.
 *
 * The store is built here rather than hand-rolling a `Lease`: the claim this file makes is
 * about a record the store *renewed*, and a literal written by the test could satisfy it
 * without the renewal path ever running.
 */

import { describe, expect, it } from 'vitest';
import { parseDeviceSerial } from '@/core/ids.js';
import { toLeaseHolder } from '@/daemon/lease-holder.js';
import { createLeaseStore, LEASE_TTL_MS, type LeaseStore } from '@/daemon/leases.js';
import { LeaseHolderSchema } from '@/ipc/methods.js';
import { createMockSlot } from '../../helpers/factories.js';

const serial = parseDeviceSerial('device-a');

/**
 * Deliberately not a round multiple of the TTL, so a `grantedAt` accidentally derived from
 * `expiresAtMs - ttlMs` lands on a different instant instead of coincidentally matching.
 */
const GRANT_INSTANT_MS = 1_772_000_123_456;

/** A store whose clock the test moves by hand — the shape `leases.test.ts` uses. */
function createClockedStore(): { store: LeaseStore; at: (instant: number) => void } {
	let nowMs = GRANT_INSTANT_MS;
	return {
		store: createLeaseStore({ ttlMs: LEASE_TTL_MS, now: () => nowMs }),
		at: (instant: number) => {
			nowMs = instant;
		},
	};
}

function grant(store: LeaseStore, optional: { testDescription?: string; groupId?: string } = {}) {
	const outcome = store.acquire({
		serial,
		owner: 'pr-127-review',
		project: 'rover',
		testName: 'checkout flow',
		...optional,
		slot: createMockSlot(),
	});
	if (!outcome.granted) throw new Error('expected a granted lease');
	return outcome.lease;
}

describe('the holder a stranger is shown', () => {
	it('keeps the grant time still while a renewal moves the expiry (D8)', () => {
		const fiveMinutesMs = 5 * 60 * 1_000;
		const { store, at } = createClockedStore();
		const lease = grant(store);

		// Five minutes in, with nothing having touched the lease: it has run down by exactly
		// that much.
		at(GRANT_INSTANT_MS + fiveMinutesMs);
		const runDown = toLeaseHolder(lease, store);
		const renewed = store.use(lease.id);
		if (renewed === null) throw new Error('expected the lease to still be live');
		const afterRenewal = toLeaseHolder(renewed, store);

		// The headline criterion: the renewal put those five minutes back, and the grant time
		// did not move. Neither field is derivable from the other — which is the whole reason
		// `grantedAt` is on the wire.
		expect(runDown.expiresInMs).toBe(LEASE_TTL_MS - fiveMinutesMs);
		expect(afterRenewal.expiresInMs).toBe(LEASE_TTL_MS);
		expect(afterRenewal.grantedAt).toBe(runDown.grantedAt);
		expect(Date.parse(afterRenewal.grantedAt)).toBe(GRANT_INSTANT_MS);
	});

	it('reports the instant the lease was granted, not the one it expires at', () => {
		const { store } = createClockedStore();

		const holder = toLeaseHolder(grant(store), store);

		// A projection derived from `expiresAtMs` minus the TTL would pass the renewal test
		// above only by accident; this one fails it outright.
		expect(Date.parse(holder.grantedAt)).toBe(GRANT_INSTANT_MS);
		expect(holder.grantedAt.endsWith('Z')).toBe(true);
	});

	it('survives JSON as the shape the schema accepts', () => {
		const { store } = createClockedStore();
		const holder = toLeaseHolder(grant(store), store);

		// The criterion as a fact rather than a claim, and it exercises the `.datetime()`
		// refinement against a real `toISOString()` rather than a literal a test chose.
		const roundTripped = LeaseHolderSchema.parse(JSON.parse(JSON.stringify(holder)));

		expect(roundTripped).toEqual(holder);
	});

	it('discloses the attribution and nothing that is a credential or host state', () => {
		const { store } = createClockedStore();

		const holder = toLeaseHolder(grant(store), store);

		// D20 structurally: no `leaseId`, which ends a lease, and no `slot` or `expiresAtMs`,
		// which are the host's own (R18, D17). A field added to the projection without a
		// decision fails here.
		expect(Object.keys(holder).sort()).toEqual([
			'expiresInMs',
			'grantedAt',
			'owner',
			'project',
			'serial',
			'testName',
		]);
	});

	/*
	 * The optional string, projected as given (D22, as amended #148) — and **absent as an absent
	 * key**, which is what the assertion above is worth making about: a lease with no description
	 * discloses nothing standing in for one, and a lease with one discloses exactly it.
	 */
	it('projects the description a lease carries, and no key at all for a lease without one', () => {
		const { store } = createClockedStore();
		const described = toLeaseHolder(
			grant(store, { testDescription: 'Checks the app bar keeps its top space.' }),
			store,
		);

		expect(described.testDescription).toBe('Checks the app bar keeps its top space.');
		expect(Object.keys(described)).toContain('testDescription');
	});

	it('discloses no description key for a lease that supplied none', () => {
		const { store } = createClockedStore();

		const holder = toLeaseHolder(grant(store), store);

		expect('testDescription' in holder).toBe(false);
		expect(JSON.stringify(holder)).not.toContain('testDescription');
	});

	/*
	 * The group, on identical terms (D22, as amended #150). It is projected **here** rather than at
	 * either caller for this module's whole reason: a refusal names the holder and so does a
	 * listing, and the two must not disagree about whether the device is held by one half of a
	 * comparison. It authorizes nothing — knowing which investigation holds a device is not a way
	 * to join it — which is why disclosing it to a stranger is a decision this suite can make.
	 */
	it('projects the group a lease carries, and no key at all for a lease without one', () => {
		// Two stores rather than two acquires: one device is one lease (D7), so the second grant
		// on one store would be refused rather than granted.
		const withGroup = createClockedStore().store;
		const without = createClockedStore().store;

		const grouped = toLeaseHolder(grant(withGroup, { groupId: 'app-bar-top-space' }), withGroup);
		const ungrouped = toLeaseHolder(grant(without), without);

		expect(grouped.groupId).toBe('app-bar-top-space');
		expect('groupId' in ungrouped).toBe(false);
		expect(JSON.stringify(ungrouped)).not.toContain('groupId');
	});
});
