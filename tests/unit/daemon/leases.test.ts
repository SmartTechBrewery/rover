/**
 * The lease store on its own, against an injected clock.
 *
 * The clock is a mutable closure rather than vitest's fake timers on purpose: the daemon
 * suite runs real sockets and real child processes (ai/TESTING.md), and replacing the
 * process-wide timers to move a lease twenty minutes forward is a far larger tool than the
 * job needs. Nothing here waits — `nowMs` is set, and the next read sees the new instant.
 */

import { describe, expect, it } from 'vitest';
import { type DeviceSerial, parseDeviceSerial, parseLeaseId } from '@/core/ids.js';
import {
	createLeaseStore,
	LEASE_TTL_MS,
	type Lease,
	type LeaseEndReason,
	type LeaseStore,
	type LeaseStoreOptions,
} from '@/daemon/leases.js';
import { createMockLease, createMockSlot } from '../../helpers/factories.js';

const deviceA = parseDeviceSerial('device-a');
const deviceB = parseDeviceSerial('device-b');

/** A store whose clock the test moves by hand. `at` is the current host-local instant. */
function createClockedStore(
	ttlMs = LEASE_TTL_MS,
	extras: Omit<LeaseStoreOptions, 'ttlMs' | 'now'> = {},
): {
	store: LeaseStore;
	at: (instant: number) => void;
	nowMs: () => number;
} {
	let nowMs = 1_000_000;
	return {
		store: createLeaseStore({ ttlMs, now: () => nowMs, ...extras }),
		at: (instant: number) => {
			nowMs = instant;
		},
		nowMs: () => nowMs,
	};
}

/** A store that records every lease ending, plus whatever it had to warn about. */
function createObservedStore(ttlMs = LEASE_TTL_MS) {
	const ended: Array<{ lease: Lease; reason: LeaseEndReason }> = [];
	const warnings: string[] = [];
	const clocked = createClockedStore(ttlMs, {
		onLeaseEnded: (lease, reason) => ended.push({ lease, reason }),
		warn: (message) => warnings.push(message),
	});
	return { ...clocked, ended, warnings };
}

/**
 * The slot is caller-supplied here the way the strings are (R18): the store allocates
 * nothing and reads nothing out of it, so one stand-in serves every request that does not
 * care which block it got.
 */
function request(
	serial: DeviceSerial,
	owner: string,
	testName = 'checkout flow',
	slot = createMockSlot(),
) {
	return { serial, owner, project: 'rover', testName, slot };
}

describe('a lease is per device', () => {
	it('lets exactly one of five callers for one device through', () => {
		const { store } = createClockedStore();

		const outcomes = ['a', 'b', 'c', 'd', 'e'].map((owner) =>
			store.acquire(request(deviceA, owner)),
		);

		// The row's criterion at the store: the predecessor let four through because its check
		// and its write were separated by work that could interleave.
		const granted = outcomes.filter((outcome) => outcome.granted);
		expect(granted).toHaveLength(1);
		for (const outcome of outcomes.filter((o) => !o.granted)) {
			expect(outcome.granted).toBe(false);
			if (!outcome.granted) {
				expect(outcome.heldBy.owner).toBe('a');
			}
		}
	});

	it('grants two devices to two owners at once — it is not a mutex over the machine', () => {
		const { store } = createClockedStore();

		const first = store.acquire(request(deviceA, 'issue-112'));
		const second = store.acquire(request(deviceB, 'pr-127-review'));

		expect(first.granted).toBe(true);
		expect(second.granted).toBe(true);
		expect(store.holderOf(deviceA)?.owner).toBe('issue-112');
		expect(store.holderOf(deviceB)?.owner).toBe('pr-127-review');
	});

	it('answers holderOf with null for a device nobody holds', () => {
		const { store } = createClockedStore();

		expect(store.holderOf(deviceA)).toBeNull();
	});
});

describe('the five attribution strings', () => {
	it('stores every one of them byte for byte, however awkward', () => {
		const { store } = createClockedStore();
		const owner = '  issue-112 / pr-127  ';
		const project = '../../etc/passwd';
		const testName = 'ekran główny — before ✅';

		const outcome = store.acquire({
			serial: deviceA,
			owner,
			project,
			testName,
			slot: createMockSlot(),
		});

		// Nothing is trimmed, sanitised or interpreted: these exist so the archive has a name
		// to file results under (D22), and the core never reads them.
		expect(outcome.granted).toBe(true);
		if (outcome.granted) {
			expect(outcome.lease.owner).toBe(owner);
			expect(outcome.lease.project).toBe(project);
			expect(outcome.lease.testName).toBe(testName);
		}
	});

	/*
	 * The fourth string, and the one that may be absent (D22, as amended #148). Stored as given
	 * like the other three, read by nothing here — and **absent stored as absent**, because a store
	 * that defaulted it would put a sentence the caller never wrote into the archive.
	 */
	it('stores an optional description as given, and absence as absence', () => {
		const { store } = createClockedStore();
		const testDescription = '  Checks the app bar keeps its top space.\nAnd nothing else.  ';

		const described = store.acquire({
			serial: deviceA,
			owner: 'issue-112',
			project: 'rover',
			testName: 'home screen',
			testDescription,
			slot: createMockSlot(),
		});
		const undescribed = store.acquire(request(deviceB, 'issue-112'));

		expect(described.granted && described.lease.testDescription).toBe(testDescription);
		expect(undescribed.granted && undescribed.lease.testDescription).toBeUndefined();
	});

	/*
	 * The fifth string, and the only one that means anything **across** leases (D22, as amended
	 * #150). Stored as given and read by nothing here — in particular nothing joins two leases
	 * that share one, counts a group's members, or checks that a second member ever arrives.
	 */
	it('stores an optional group id as given, and absence as absence', () => {
		const { store } = createClockedStore();
		const groupId = '  app-bar/top space  ';

		const grouped = store.acquire({
			serial: deviceA,
			owner: 'issue-112',
			project: 'rover',
			testName: 'home screen',
			groupId,
			slot: createMockSlot(),
		});
		const ungrouped = store.acquire(request(deviceB, 'issue-112'));

		expect(grouped.granted && grouped.lease.groupId).toBe(groupId);
		expect(ungrouped.granted && ungrouped.lease.groupId).toBeUndefined();
	});

	// Nothing enforces arity, uniqueness or membership: two leases may share one group id, and
	// the store neither notices nor cares. That is the point rather than an omission.
	it('lets two live leases share one group id without noticing', () => {
		const { store } = createClockedStore();

		const before = store.acquire({ ...request(deviceA, 'issue-150'), groupId: 'app-bar' });
		const after = store.acquire({ ...request(deviceB, 'issue-150'), groupId: 'app-bar' });

		expect(before.granted && before.lease.groupId).toBe('app-bar');
		expect(after.granted && after.lease.groupId).toBe('app-bar');
	});

	it('carries the description through a renewal untouched', () => {
		const { store } = createClockedStore();
		const granted = store.acquire({
			...request(deviceA, 'issue-112'),
			testDescription: 'Checks the app bar keeps its top space.',
		});
		if (!granted.granted) throw new Error('the first acquire must be granted');

		// A renewal builds a new record (D8), so a field dropped there would vanish partway
		// through a lease — and the archive writes the description on the *first artifact*, which
		// is very often after the first renewal.
		expect(store.use(granted.lease.id)?.testDescription).toBe(
			'Checks the app bar keeps its top space.',
		);
	});

	// The same, for the same reason: the archive files `group_id.json` on the first artifact,
	// which is very often after a renewal has already rebuilt the record.
	it('carries the group id through a renewal untouched', () => {
		const { store } = createClockedStore();
		const granted = store.acquire({ ...request(deviceA, 'issue-150'), groupId: 'app-bar' });
		if (!granted.granted) throw new Error('the first acquire must be granted');

		expect(store.use(granted.lease.id)?.groupId).toBe('app-bar');
	});

	it('grants two leases carrying the same test name — it is not unique (D22)', () => {
		const { store } = createClockedStore();
		const name = 'home screen';

		const first = store.acquire(request(deviceA, 'issue-112', name));
		const second = store.acquire(request(deviceB, 'issue-112', name));

		// Running the same named check before and after a change is the expected shape, not a
		// collision to reject.
		expect(first.granted).toBe(true);
		expect(second.granted).toBe(true);
	});

	it('gives each lease its own id', () => {
		const { store } = createClockedStore();

		const first = store.acquire(request(deviceA, 'issue-112'));
		const second = store.acquire(request(deviceB, 'issue-112'));

		expect(first.granted && second.granted && first.lease.id).not.toBe(
			second.granted && second.lease.id,
		);
	});
});

describe('the TTL is twenty minutes, renewed by activity', () => {
	it('defaults to twenty minutes', () => {
		expect(LEASE_TTL_MS).toBe(20 * 60 * 1_000);

		const store = createLeaseStore({ now: () => 0 });
		const outcome = store.acquire(request(deviceA, 'issue-112'));

		expect(outcome.granted && outcome.lease.expiresAtMs).toBe(20 * 60 * 1_000);
	});

	it('reports the remaining duration rather than the instant', () => {
		const { store, at, nowMs } = createClockedStore();
		const outcome = store.acquire(request(deviceA, 'issue-112'));
		if (!outcome.granted) throw new Error('the first acquire must be granted');

		at(nowMs() + 5 * 60 * 1_000);

		// D17: the caller shares no clock with the host, so what crosses the wire is how long
		// is left, never when it ends.
		expect(store.remainingMs(outcome.lease)).toBe(LEASE_TTL_MS - 5 * 60 * 1_000);
	});

	it('pushes the expiry a full TTL out on every use, with no heartbeat anywhere', () => {
		const { store, at } = createClockedStore();
		const granted = store.acquire(request(deviceA, 'issue-112'));
		if (!granted.granted) throw new Error('the first acquire must be granted');
		const originalExpiry = granted.lease.expiresAtMs;

		// One millisecond before it would have gone: a call arriving here is what keeps it.
		at(originalExpiry - 1);
		const renewed = store.use(granted.lease.id);

		expect(renewed?.expiresAtMs).toBe(originalExpiry - 1 + LEASE_TTL_MS);

		// At the instant it *would* have expired, it is still live — the renewal, and the whole
		// of D8. An agent that pauses for eleven minutes to think keeps its device.
		at(originalExpiry);
		expect(store.holderOf(deviceA)?.owner).toBe('issue-112');
	});

	it('expires a lease nobody used, without a timer having fired', () => {
		const { store, at } = createClockedStore();
		const granted = store.acquire(request(deviceA, 'issue-112'));
		if (!granted.granted) throw new Error('the first acquire must be granted');

		at(granted.lease.expiresAtMs);

		// A dead agent issues no more calls and lets go on its own (D8).
		expect(store.use(granted.lease.id)).toBeNull();
		expect(store.holderOf(deviceA)).toBeNull();
		expect(store.remainingMs(granted.lease)).toBe(0);

		const next = store.acquire(request(deviceA, 'pr-127-review'));
		expect(next.granted).toBe(true);
	});

	it('does not renew on a question about the device', () => {
		const { store, at } = createClockedStore();
		const granted = store.acquire(request(deviceA, 'issue-112'));
		if (!granted.granted) throw new Error('the first acquire must be granted');

		at(granted.lease.expiresAtMs - 1);
		expect(store.holderOf(deviceA)).not.toBeNull();
		at(granted.lease.expiresAtMs);

		// `holderOf` is a read, and a read by a stranger must not extend somebody else's lease.
		expect(store.holderOf(deviceA)).toBeNull();
	});

	it('never reports a negative remaining duration', () => {
		const { store } = createClockedStore();

		// A record whose instant is already behind the store's clock — what a caller holding a
		// copy from before an expiry hands back. A negative duration on the wire would read as
		// a lease that ends in the past, which is not a thing a client can act on.
		expect(store.remainingMs(createMockLease({ expiresAtMs: 0 }))).toBe(0);
	});

	it('honours an injected TTL', () => {
		const { store, at } = createClockedStore(1_000);
		const granted = store.acquire(request(deviceA, 'issue-112'));
		if (!granted.granted) throw new Error('the first acquire must be granted');

		at(granted.lease.expiresAtMs);

		expect(store.holderOf(deviceA)).toBeNull();
	});
});

describe('release', () => {
	it('frees the device immediately', () => {
		const { store } = createClockedStore();
		const granted = store.acquire(request(deviceA, 'issue-112'));
		if (!granted.granted) throw new Error('the first acquire must be granted');

		expect(store.release(granted.lease.id)).toBe(true);

		expect(store.holderOf(deviceA)).toBeNull();
		expect(store.acquire(request(deviceA, 'pr-127-review')).granted).toBe(true);
	});

	it('answers false the second time, for an unknown id and for an expired one', () => {
		const { store, at } = createClockedStore();
		const granted = store.acquire(request(deviceA, 'issue-112'));
		if (!granted.granted) throw new Error('the first acquire must be granted');
		store.release(granted.lease.id);

		expect(store.release(granted.lease.id)).toBe(false);
		expect(store.release(parseLeaseId('never-issued'))).toBe(false);

		const other = store.acquire(request(deviceB, 'issue-112'));
		if (!other.granted) throw new Error('the second acquire must be granted');
		at(other.lease.expiresAtMs);
		expect(store.release(other.lease.id)).toBe(false);
	});

	it('leaves another device’s lease alone', () => {
		const { store } = createClockedStore();
		const first = store.acquire(request(deviceA, 'issue-112'));
		const second = store.acquire(request(deviceB, 'pr-127-review'));
		if (!first.granted || !second.granted) throw new Error('both acquires must be granted');

		store.release(first.lease.id);

		expect(store.holderOf(deviceB)?.id).toBe(second.lease.id);
		expect(store.use(second.lease.id)).not.toBeNull();
	});
});

describe('use', () => {
	it('answers null for an id that was never issued', () => {
		const { store } = createClockedStore();

		expect(store.use(parseLeaseId('never-issued'))).toBeNull();
	});

	it('answers the same lease it renewed, attribution and all', () => {
		const { store } = createClockedStore();
		const granted = store.acquire(request(deviceA, 'issue-112', 'home screen'));
		if (!granted.granted) throw new Error('the first acquire must be granted');

		const renewed = store.use(granted.lease.id);

		expect(renewed).toMatchObject({
			id: granted.lease.id,
			serial: deviceA,
			owner: 'issue-112',
			project: 'rover',
			testName: 'home screen',
		});
	});

	it('carries the lease’s slot through a renewal untouched', () => {
		const { store } = createClockedStore();
		const slot = createMockSlot({ index: 3, portBase: 26_024 });
		const granted = store.acquire(request(deviceA, 'issue-112', 'home screen', slot));
		if (!granted.granted) throw new Error('the first acquire must be granted');

		const renewed = store.use(granted.lease.id);

		// A renewal that dropped the slot would silently unport every later hook this lease
		// runs — the teardown included, which is where the reclamation hangs.
		expect(renewed?.slot).toEqual(slot);
		expect(store.holderOf(deviceA)?.slot).toEqual(slot);
	});
});

/**
 * The seam D9's restoration hangs off. What matters is not that a callback exists but that
 * **both** ways a lease can end reach it — `forget` is one function, so a future path that
 * ends a lease some third way is covered by construction rather than by whoever writes it
 * remembering.
 */
describe('the end hook', () => {
	it('fires once with released when a lease is handed back', () => {
		const { store, ended } = createObservedStore();
		const granted = store.acquire(request(deviceA, 'issue-112'));
		if (!granted.granted) throw new Error('the first acquire must be granted');

		store.release(granted.lease.id);

		expect(ended).toHaveLength(1);
		expect(ended[0]?.reason).toBe('released');
		expect(ended[0]?.lease.id).toBe(granted.lease.id);

		// The record is gone, so a second release has nothing to end and nothing to announce.
		store.release(granted.lease.id);
		expect(ended).toHaveLength(1);
	});

	it('fires once with expired when the instant passes, with nobody having released it', () => {
		const { store, at, ended } = createObservedStore();
		const granted = store.acquire(request(deviceA, 'issue-112'));
		if (!granted.granted) throw new Error('the first acquire must be granted');

		at(granted.lease.expiresAtMs);
		store.sweep();

		expect(ended).toEqual([{ lease: granted.lease, reason: 'expired' }]);

		// Every later read finds nothing to forget, so the expiry is announced once however
		// many times it is looked for.
		store.sweep();
		expect(store.holderOf(deviceA)).toBeNull();
		expect(store.use(granted.lease.id)).toBeNull();
		expect(ended).toHaveLength(1);
	});

	it('says nothing about a lease that is merely still running', () => {
		const { store, at, ended } = createObservedStore();
		const granted = store.acquire(request(deviceA, 'issue-112'));
		if (!granted.granted) throw new Error('the first acquire must be granted');

		at(granted.lease.expiresAtMs - 1);
		store.sweep();

		expect(ended).toEqual([]);
		expect(store.holderOf(deviceA)?.owner).toBe('issue-112');
	});

	it('sweeps every device, not merely the first one it finds expired', () => {
		const { store, at, ended } = createObservedStore();
		store.acquire(request(deviceA, 'issue-112'));
		store.acquire(request(deviceB, 'pr-127-review'));

		at(1_000_000 + LEASE_TTL_MS);
		store.sweep();

		expect(ended.map((entry) => entry.lease.serial).sort()).toEqual([deviceA, deviceB]);
	});

	it('keeps acquire exclusive when the hook throws, and says what threw', () => {
		const ended: LeaseEndReason[] = [];
		const warnings: string[] = [];
		let nowMs = 1_000_000;
		const store = createLeaseStore({
			ttlMs: LEASE_TTL_MS,
			now: () => nowMs,
			onLeaseEnded: (_lease, reason) => {
				ended.push(reason);
				throw new Error('the listener broke');
			},
			warn: (message) => warnings.push(message),
		});
		const granted = store.acquire(request(deviceA, 'issue-112'));
		if (!granted.granted) throw new Error('the first acquire must be granted');
		nowMs = granted.lease.expiresAtMs;

		// The expiry is observed from inside `acquire`, so a throw that escaped the hook would
		// abort the grant between resolving the holder and inserting the new record — which is
		// the store's one guarantee (R8). Five callers, one winner, still.
		const outcomes = ['a', 'b', 'c', 'd', 'e'].map((owner) =>
			store.acquire(request(deviceA, owner)),
		);

		expect(outcomes.filter((outcome) => outcome.granted)).toHaveLength(1);
		expect(ended).toEqual(['expired']);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('the listener broke');
		expect(warnings[0]).toContain(deviceA);
	});
});
