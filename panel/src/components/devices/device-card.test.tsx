import type { ListedDevice } from '@panel/devices/device-list.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/*
 * The card carries one control now (#122), and it reads the session for the identity it attributes
 * the call with. A card is not a screen, so this suite gives it a signed-in session and nothing
 * else — what the control *does* is `force-release-control.test.tsx`'s subject, and where the
 * answer is said is `devices.test.tsx`'s.
 */
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({
		state: {
			status: 'signed-in',
			identity: { identifier: 'karolina', displayName: 'Karolina Waldon' },
		},
		call: async () => ({ ok: false, refusal: 'unanswered' }),
	}),
}));

import { DeviceCard } from './device-card.js';

const RECEIVED_AT_MS = 1_000_000;

function device(overrides: Partial<ListedDevice> = {}): ListedDevice {
	return {
		serial: '39041FDJH00A7X',
		platform: 'android',
		model: 'Pixel 7 Pro',
		osVersion: '14',
		state: 'ready',
		heldBy: null,
		...overrides,
	};
}

/** The card as the grid renders it. Nothing here listens for the answer — see the note above. */
function card(subject: ListedDevice) {
	return render(
		<DeviceCard
			device={subject}
			onForceReleaseSettled={() => undefined}
			receivedAtMs={RECEIVED_AT_MS}
		/>,
	);
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
		card(device({ heldBy: LEASE }));

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
		card(device({ heldBy: LEASE }));

		expect(screen.getByText('2026-08-31T14:02:41.219Z')).toBeDefined();
	});

	// Required (D22, as amended #129), so every held card carries it — there is no gap to render.
	it('renders the test name on every held card', () => {
		card(device({ heldBy: { ...LEASE, testName: 'the checkout flow' } }));

		expect(screen.getByText('Test name')).toBeDefined();
		expect(screen.getByText('the checkout flow')).toBeDefined();
		expect(screen.queryByText('—')).toBeNull();
	});

	// §6: there is no `STATE` field. The card already says a device is held three times over.
	it('carries no state field', () => {
		card(device({ heldBy: LEASE }));

		expect(screen.queryByText('State')).toBeNull();
	});

	/*
	 * The panel's one operator action, and the card's only control (#122) — inside the lease panel
	 * and below `GRANTED`, so everything it would end is read before it is reached (§7).
	 */
	it('carries the force-release control, below the lease data it acts on', () => {
		const { container } = card(device({ heldBy: LEASE }));

		const controls = container.querySelectorAll('button');
		expect(controls).toHaveLength(1);
		const control = controls[0] as HTMLElement;
		expect(control.textContent).toBe('Force release');
		// After `GRANTED` in the document, which is what "below the lease data" means in markup.
		expect(control.compareDocumentPosition(screen.getByText('Granted'))).toBe(
			Node.DOCUMENT_POSITION_PRECEDING,
		);
	});
});

describe('a free device card', () => {
	it('says free, in green, and shows no lease', () => {
		const { container } = card(device());

		expect(screen.getByText('free')).toBeDefined();
		expect(screen.queryByText('Active lease')).toBeNull();
		expect(container.querySelectorAll('.bg-tertiary')).not.toHaveLength(0);
	});

	/*
	 * There is no lease to end, so there is nothing for a control to do — and an `unauthorized`
	 * device holds no lease either (#122, #123). The control is rendered inside the lease panel and
	 * nowhere else, which is what makes this structural rather than a check somebody has to keep.
	 */
	it('carries no control at all, held by nobody', () => {
		for (const state of ['ready', 'unauthorized', 'offline']) {
			const { container } = card(device({ state, heldBy: null }));
			expect(container.querySelectorAll('button')).toHaveLength(0);
		}
	});

	/*
	 * §5: the screen answers "what can I use right now", so the free device is the most legible
	 * thing on it — not the greyed-out one. An early version had this exactly backwards.
	 */
	it('is the card that is not dimmed', () => {
		const { container: free } = card(device());
		const { container: held } = card(device({ heldBy: LEASE }));

		expect((free.firstElementChild as HTMLElement).className).not.toContain('opacity-');
		expect((held.firstElementChild as HTMLElement).className).toContain('opacity-80');
	});

	// The header bar is identical held or free: a pale header lost the green LED almost all of its
	// contrast, so free is signalled by the LED and the body instead.
	it('shares the held card’s header bar', () => {
		const { container: free } = card(device());
		const { container: held } = card(device({ heldBy: LEASE }));

		const headerOf = (root: HTMLElement): string =>
			(root.querySelector('article > div') as HTMLElement).className;
		expect(headerOf(free)).toBe(headerOf(held));
	});
});

describe('the fields a device cannot always answer', () => {
	it('falls back to the serial when the host could not read a model', () => {
		card(device({ model: null }));

		// Twice: once identifying the device in the header, once as the `SERIAL` field.
		expect(screen.getAllByText('39041FDJH00A7X')).toHaveLength(2);
	});

	// A null version is a real answer, commonly a device on its authorization prompt — and the field
	// is one of the card's two fixed columns, so it says `unknown` rather than disappearing.
	it('says unknown for a version the device did not report', () => {
		card(device({ osVersion: null }));

		expect(screen.getByText('OS version')).toBeDefined();
		expect(screen.getByText('unknown')).toBeDefined();
	});

	/*
	 * The card's one positive availability claim, and the host has to be willing to honour it. A
	 * device the host reports as `unauthorized` holds no lease and is still refused `not-ready`
	 * (`src/daemon/lease-handlers.ts`), so saying `free` on it — in the green this screen reserves
	 * for a device to take — is the plausible-looking answer ai/RULES.md §2 forbids.
	 */
	it('does not call a device free when the host cannot lease it', () => {
		const { container } = card(device({ state: 'unauthorized', heldBy: null }));

		expect(screen.queryByText('free')).toBeNull();
		expect(container.querySelectorAll('.bg-tertiary')).toHaveLength(0);
		expect(container.querySelectorAll('.text-tertiary')).toHaveLength(0);
	});

	// Verbatim, for the reason `platform` is verbatim: a display table mapping the host's words onto
	// prettier ones is a branch on host vocabulary, and `rover list`'s `STATE` column prints these.
	it('says what the host reports instead, in the free panel’s place', () => {
		card(device({ state: 'offline', heldBy: null }));

		expect(screen.getByText('offline')).toBeDefined();
		expect(screen.getByText('Attached, but not available to lease.')).toBeDefined();
		expect(screen.queryByText('Active lease')).toBeNull();
	});

	/*
	 * A lease outlives the hardware going `offline` — it is the daemon's own bookkeeping, and who to
	 * go and ask is still the answer this card owes. Only an unheld device's state decides the body.
	 */
	it('still shows the lease on a held device that went not ready', () => {
		card(device({ state: 'offline', heldBy: LEASE }));

		expect(screen.getByText('Active lease')).toBeDefined();
		expect(screen.getByText('pr-127-review')).toBeDefined();
		expect(screen.queryByText('free')).toBeNull();
	});

	// `Android` is the platform and `14` is the version — never concatenated under one label.
	it('keeps platform and version as two fields', () => {
		card(device());

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
			const { container } = card(device({ heldBy: held }));
			expect(container.innerHTML).not.toContain('truncate');
			expect(container.innerHTML).not.toContain('text-ellipsis');
			expect(container.innerHTML).not.toContain('line-clamp');
		}
	});

	it('wraps the serial rather than clipping it', () => {
		card(device({ model: 'Pixel 7 Pro' }));

		expect(screen.getByText('39041FDJH00A7X').className).toContain('break-all');
	});
});
