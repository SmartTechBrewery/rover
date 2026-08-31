import type { ListedDevice } from '@panel/devices/device-list.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeviceCard } from './device-card.js';

const RECEIVED_AT_MS = 1_000_000;

function device(overrides: Partial<ListedDevice> = {}): ListedDevice {
	return {
		serial: '39041FDJH00A7X',
		platform: 'android',
		model: 'Pixel 7 Pro',
		osVersion: '14',
		heldBy: null,
		...overrides,
	};
}

const LEASE: NonNullable<ListedDevice['heldBy']> = {
	serial: '39041FDJH00A7X',
	owner: 'pr-127-review',
	project: 'checkout-app',
	testName: 'home screen flow',
	grantedAt: '2026-08-31T14:02:41.219Z',
	expiresInMs: 542_318,
};

describe('a held device card', () => {
	it('says who holds it, for what, and since when', () => {
		render(<DeviceCard device={device({ heldBy: LEASE })} receivedAtMs={RECEIVED_AT_MS} />);

		expect(screen.getByText('Active lease')).toBeDefined();
		expect(screen.getByText('Test name')).toBeDefined();
		expect(screen.getByText('home screen flow')).toBeDefined();
		expect(screen.getByText('pr-127-review')).toBeDefined();
		expect(screen.getByText('checkout-app')).toBeDefined();
	});

	/*
	 * The whole instant, with its `Z`. It is the host's clock, so the panel renders it as given and
	 * never truncates it to `14:02 UTC` as the design's mock data does — and never differences it
	 * against this machine's own `Date.now()` (D17).
	 */
	it('renders the grant instant exactly as the host sent it', () => {
		render(<DeviceCard device={device({ heldBy: LEASE })} receivedAtMs={RECEIVED_AT_MS} />);

		expect(screen.getByText('2026-08-31T14:02:41.219Z')).toBeDefined();
	});

	// Optional and often absent (D22): no empty label and no `—`, so the panel starts with `OWNER`.
	it('omits the test name entirely when the lease has none', () => {
		render(
			<DeviceCard
				device={device({ heldBy: { ...LEASE, testName: null } })}
				receivedAtMs={RECEIVED_AT_MS}
			/>,
		);

		expect(screen.queryByText('Test name')).toBeNull();
		expect(screen.getByText('pr-127-review')).toBeDefined();
		expect(screen.queryByText('—')).toBeNull();
	});

	// §6: there is no `STATE` field. The card already says a device is held three times over.
	it('carries no state field and no control', () => {
		const { container } = render(
			<DeviceCard device={device({ heldBy: LEASE })} receivedAtMs={RECEIVED_AT_MS} />,
		);

		expect(screen.queryByText('State')).toBeNull();
		expect(container.querySelectorAll('button')).toHaveLength(0);
	});
});

describe('a free device card', () => {
	it('says free, in green, and shows no lease', () => {
		const { container } = render(<DeviceCard device={device()} receivedAtMs={RECEIVED_AT_MS} />);

		expect(screen.getByText('free')).toBeDefined();
		expect(screen.queryByText('Active lease')).toBeNull();
		expect(container.querySelectorAll('.bg-tertiary')).not.toHaveLength(0);
	});

	/*
	 * §5: the screen answers "what can I use right now", so the free device is the most legible
	 * thing on it — not the greyed-out one. An early version had this exactly backwards.
	 */
	it('is the card that is not dimmed', () => {
		const { container: free } = render(
			<DeviceCard device={device()} receivedAtMs={RECEIVED_AT_MS} />,
		);
		const { container: held } = render(
			<DeviceCard device={device({ heldBy: LEASE })} receivedAtMs={RECEIVED_AT_MS} />,
		);

		expect((free.firstElementChild as HTMLElement).className).not.toContain('opacity-');
		expect((held.firstElementChild as HTMLElement).className).toContain('opacity-80');
	});

	// The header bar is identical held or free: a pale header lost the green LED almost all of its
	// contrast, so free is signalled by the LED and the body instead.
	it('shares the held card’s header bar', () => {
		const { container: free } = render(
			<DeviceCard device={device()} receivedAtMs={RECEIVED_AT_MS} />,
		);
		const { container: held } = render(
			<DeviceCard device={device({ heldBy: LEASE })} receivedAtMs={RECEIVED_AT_MS} />,
		);

		const headerOf = (root: HTMLElement): string =>
			(root.querySelector('article > div') as HTMLElement).className;
		expect(headerOf(free)).toBe(headerOf(held));
	});
});

describe('the fields a device cannot always answer', () => {
	it('falls back to the serial when the host could not read a model', () => {
		render(<DeviceCard device={device({ model: null })} receivedAtMs={RECEIVED_AT_MS} />);

		// Twice: once identifying the device in the header, once as the `SERIAL` field.
		expect(screen.getAllByText('39041FDJH00A7X')).toHaveLength(2);
	});

	// A null version is a real answer, commonly a device on its authorization prompt — and the field
	// is one of the card's two fixed columns, so it says `unknown` rather than disappearing.
	it('says unknown for a version the device did not report', () => {
		render(<DeviceCard device={device({ osVersion: null })} receivedAtMs={RECEIVED_AT_MS} />);

		expect(screen.getByText('OS version')).toBeDefined();
		expect(screen.getByText('unknown')).toBeDefined();
	});

	// `Android` is the platform and `14` is the version — never concatenated under one label.
	it('keeps platform and version as two fields', () => {
		render(<DeviceCard device={device()} receivedAtMs={RECEIVED_AT_MS} />);

		expect(screen.getByText('Platform')).toBeDefined();
		expect(screen.getByText('android')).toBeDefined();
		expect(screen.getByText('OS version')).toBeDefined();
		expect(screen.getByText('14')).toBeDefined();
	});
});

/*
 * §5 and §6: serials, timestamps and hashes are never truncated or ellipsised. The serial is the
 * device's identity and the longest string on the card; it wraps instead.
 */
describe('nothing on the card is truncated', () => {
	it('carries no truncation class in either state', () => {
		for (const held of [null, LEASE]) {
			const { container } = render(
				<DeviceCard device={device({ heldBy: held })} receivedAtMs={RECEIVED_AT_MS} />,
			);
			expect(container.innerHTML).not.toContain('truncate');
			expect(container.innerHTML).not.toContain('text-ellipsis');
			expect(container.innerHTML).not.toContain('line-clamp');
		}
	});

	it('wraps the serial rather than clipping it', () => {
		render(<DeviceCard device={device({ model: 'Pixel 7 Pro' })} receivedAtMs={RECEIVED_AT_MS} />);

		expect(screen.getByText('39041FDJH00A7X').className).toContain('break-all');
	});
});
