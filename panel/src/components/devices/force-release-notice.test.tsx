import type { ListedDevice } from '@panel/devices/device-list.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeviceCard } from './device-card.js';
import { ForceReleaseNotice, type SettledForceRelease } from './force-release-notice.js';

/**
 * What a settled force-release says above the grid (`docs/DESIGN.md` §7).
 *
 * The three outcomes have their own tests through the screen (`routes/devices.test.tsx`); what this
 * file is for is the one claim the line must not make on its own authority. **Ending a lease says
 * nothing about the hardware**: the daemon releases a held lease before it ever looks at the device
 * (`src/daemon/lease-handlers.ts`), so a `released` answer arrives for a device in any state — and
 * on a device the host reports as anything but `ready` it would refuse the next `acquire`
 * `not-ready`. The card stopped calling that device free in #123; this line must not start.
 */

const LEASE: NonNullable<ListedDevice['heldBy']> = {
	serial: 'emulator-5554',
	owner: 'issue-113',
	project: 'rover',
	testName: 'the devices grid',
	grantedAt: '2026-08-31T14:02:41.219Z',
	expiresInMs: 542_318,
};

function device(over: Partial<ListedDevice> = {}): ListedDevice {
	return {
		serial: 'emulator-5554',
		platform: 'android',
		model: 'sdk_gphone64_arm64',
		osVersion: '16',
		state: 'ready',
		heldBy: LEASE,
		...over,
	};
}

function said(settled: SettledForceRelease): string {
	const { container } = render(
		<ForceReleaseNotice onDismiss={() => undefined} settled={settled} />,
	);
	return container.textContent ?? '';
}

const RELEASED = { outcome: 'released', heldBy: LEASE } as const;
const NOT_HELD = { outcome: 'refused', reason: 'not-held' } as const;

describe('a device the host still reports ready', () => {
	// The claim is honest here and is worth making: the card is about to say `free` too, and the
	// operator's next move is to take the device.
	it('says the lease ended and that the device is free', () => {
		const line = said({ answer: RELEASED, device: device() });

		expect(line).toContain('The lease issue-113 held on sdk_gphone64_arm64 (emulator-5554)');
		expect(line).toContain('for rover has ended');
		expect(line).toContain('The device is free.');
	});

	it('says a lease that had already ended left it free either way', () => {
		const line = said({ answer: NOT_HELD, device: device() });

		expect(line).toContain('had already ended on its own');
		expect(line).toContain('The device is free either way.');
	});
});

/**
 * The same two answers about a device the host would refuse a lease on. Both still say exactly what
 * settled — the lease ended, or there was nothing to release — and neither adds a word about
 * availability.
 */
describe('a device the host would refuse a lease on', () => {
	it.each([
		['offline', 'offline'],
		['unauthorized', 'unauthorized'],
		// A state this panel has never heard of gets the quieter line too, which is the safe
		// direction to be wrong in: an unknown state never earns the claim.
		['a state this panel has never heard of', 'recovery'],
	])('does not call it free after the lease ended (%s)', (_case, state) => {
		const line = said({ answer: RELEASED, device: device({ state }) });

		expect(line).toContain('The lease issue-113 held on sdk_gphone64_arm64 (emulator-5554)');
		expect(line).toContain('for rover has ended');
		expect(line).not.toContain('free');
	});

	it('does not call it free when the lease had already ended on its own', () => {
		const line = said({ answer: NOT_HELD, device: device({ state: 'offline' }) });

		expect(line).toContain('had already ended on its own');
		expect(line).toContain('nothing to release on sdk_gphone64_arm64 (emulator-5554)');
		expect(line).not.toContain('free');
	});

	/*
	 * The line and the card are on the screen together — the notice sits above the grid the poll
	 * refreshes, so both describe the same device within one frame of each other. This is the
	 * assertion that keeps them from disagreeing: whatever the card says about the hardware, the
	 * line above it must not contradict.
	 */
	it('does not contradict the card the poll then renders for the same device', () => {
		const offline = device({ state: 'offline' });
		const line = said({ answer: RELEASED, device: offline });

		// What the poll brings back the instant the lease ends: the same device, now held by
		// nobody, still `offline`.
		render(
			<DeviceCard
				device={{ ...offline, heldBy: null }}
				onForceReleaseSettled={vi.fn()}
				receivedAtMs={Date.now()}
			/>,
		);

		expect(screen.getByText('Attached, but not available to lease.')).toBeDefined();
		expect(line).not.toContain('free');
	});
});

/**
 * The device that is not on this host any more (`gone`, `not-attached`). It never carried the
 * availability clause — there is no card left for it to contradict — and it must not grow one.
 */
describe('a device that is not on this host any more', () => {
	it.each([
		['gone'],
		['not-attached'],
	])('says it is not listed, and nothing about what could be leased (%s)', (reason) => {
		const line = said({
			answer: { outcome: 'refused', reason: reason as 'gone' | 'not-attached' },
			device: device({ state: 'offline', heldBy: null }),
		});

		expect(line).toContain('is no longer attached to this host');
		expect(line).toContain('It is no longer listed.');
		expect(line).not.toContain('free');
	});
});

// The serial is the device's identity and the model may be absent, exactly as on the card (§6).
describe('the device the line names', () => {
	it('falls back to the serial alone when the host reports no model', () => {
		const line = said({ answer: RELEASED, device: device({ model: null }) });

		expect(line).toContain('held on emulator-5554 for rover');
	});
});
