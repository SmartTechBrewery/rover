import type { LeaseHolder, ListedDevice } from '@panel/devices/device-list.js';
import type { DeviceListState } from '@panel/devices/device-list-provider.js';
import { describe, expect, it } from 'vitest';
import { archiveIsBeingWritten } from './live-writes.js';

const HOLDER: LeaseHolder = {
	serial: 'R5CT30ABCDE',
	owner: 'issue-287',
	project: 'checkout-app',
	testName: 'login-flow',
	grantedAt: '2026-09-10T09:14:03.000Z',
	expiresInMs: 540_000,
};

function device(serial: string, heldBy: LeaseHolder | null = null): ListedDevice {
	return {
		serial,
		platform: 'android',
		model: 'Pixel 7',
		osVersion: '16',
		state: 'ready',
		heldBy,
	};
}

function ready(devices: readonly ListedDevice[], stale = false): DeviceListState {
	return { status: 'ready', devices, stale, staleReason: null, receivedAtMs: 1_757_000_000_000 };
}

describe('whether anything is being written into the archive', () => {
	// Nothing is known yet, and the mount has just read every drawn level: the clock's job starts
	// after that, so an unanswered device list is *not writing* and costs no interval.
	it('is false before the device list has answered', () => {
		expect(archiveIsBeingWritten({ status: 'loading' })).toBe(false);
	});

	// The screen is not even mounted in this state — `app.tsx` renders the unreachable page in
	// place of the router — and the idle cost is nothing either way.
	it('is false for a host nothing came back from', () => {
		expect(archiveIsBeingWritten({ status: 'unreachable' })).toBe(false);
	});

	it('is false while every device the host lists is free', () => {
		expect(archiveIsBeingWritten(ready([device('emulator-5554'), device('R5CT30ABCDE')]))).toBe(
			false,
		);
	});

	// A run directory is written while a lease is live and only then (`src/daemon/archive.ts`), so
	// one held device anywhere is the whole of the question.
	it('is true while one device is held, whichever it is', () => {
		expect(
			archiveIsBeingWritten(ready([device('emulator-5554'), device('R5CT30ABCDE', HOLDER)])),
		).toBe(true);
	});

	/*
	 * **Any live lease anywhere, and not the lease on the project this reader is browsing.** The
	 * lease carries both (D22), so narrowing was available and was rejected: the refresh re-reads
	 * what is drawn wholesale, and a reader in the project a lease is *not* in would otherwise get
	 * no refresh at all — the staleness this gate exists to end.
	 */
	it('is true for a lease on some other project than the one being read', () => {
		const elsewhere: LeaseHolder = { ...HOLDER, project: 'payments-web', testName: 'checkout' };
		expect(archiveIsBeingWritten(ready([device('R5CT30ABCDE', elsewhere)]))).toBe(true);
	});

	/*
	 * A `stale: true` answer opens the gate like any other (D6). `stale` is about the host's view of
	 * the **hardware** — it could not be re-derived from `adb devices` just now — and a lease is
	 * host state that has no view to be stale, so the leases such an answer names are named exactly.
	 */
	it('is true for a held device on a stale view of the hardware', () => {
		expect(archiveIsBeingWritten(ready([device('R5CT30ABCDE', HOLDER)], true))).toBe(true);
	});

	// And a stale view naming no lease is still *not writing*: staleness is not a reason to poll.
	it('is false for a stale view that names no lease', () => {
		expect(archiveIsBeingWritten(ready([device('R5CT30ABCDE')], true))).toBe(false);
	});

	// An empty host is the degenerate case of every device being free.
	it('is false for a host with no devices at all', () => {
		expect(archiveIsBeingWritten(ready([]))).toBe(false);
	});
});
