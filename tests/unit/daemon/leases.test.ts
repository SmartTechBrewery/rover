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
import { createLeaseStore, LEASE_TTL_MS, type LeaseStore } from '@/daemon/leases.js';
import { createMockLease } from '../../helpers/factories.js';

const deviceA = parseDeviceSerial('device-a');
const deviceB = parseDeviceSerial('device-b');

/** A store whose clock the test moves by hand. `at` is the current host-local instant. */
function createClockedStore(ttlMs = LEASE_TTL_MS): {
	store: LeaseStore;
	at: (instant: number) => void;
	nowMs: () => number;
} {
	let nowMs = 1_000_000;
	return {
		store: createLeaseStore({ ttlMs, now: () => nowMs }),
		at: (instant: number) => {
			nowMs = instant;
		},
		nowMs: () => nowMs,
	};
}

function request(serial: DeviceSerial, owner: string, testName: string | null = null) {
	return { serial, owner, project: 'rover', testName };
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

describe('the three attribution strings', () => {
	it('stores every one of them byte for byte, however awkward', () => {
		const { store } = createClockedStore();
		const owner = '  issue-112 / pr-127  ';
		const project = '../../etc/passwd';
		const testName = 'ekran główny — before ✅';

		const outcome = store.acquire({ serial: deviceA, owner, project, testName });

		// Nothing is trimmed, sanitised or interpreted: these exist so the archive has a name
		// to file results under (D22), and the core never reads them.
		expect(outcome.granted).toBe(true);
		if (outcome.granted) {
			expect(outcome.lease.owner).toBe(owner);
			expect(outcome.lease.project).toBe(project);
			expect(outcome.lease.testName).toBe(testName);
		}
	});

	it('keeps an absent test name as null rather than inventing one', () => {
		const { store } = createClockedStore();

		const outcome = store.acquire(request(deviceA, 'issue-112'));

		expect(outcome.granted && outcome.lease.testName).toBeNull();
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
});
