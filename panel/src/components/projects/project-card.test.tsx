import { BADGE_SHAPE, BADGE_TYPE } from '@panel/components/archive/header-badge.js';
import type { ProjectRegistration } from '@panel/projects/project-list.js';
import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/*
 * The session the strip's one control reads — the identity it attributes a delete with, and the
 * two reads its confirmation makes as it opens. Mocked rather than provided, because what this
 * file is about is the card: `delete-project-control.test.tsx` owns what the control does with an
 * answer, and `delete-project-dialog.test.tsx` owns what the confirmation says.
 */
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({
		state: {
			status: 'signed-in',
			identity: { identifier: 'karolina', displayName: 'Karolina Waldon' },
		},
		call: async (method: string): Promise<HostAnswer<RpcEnvelope>> => ({
			ok: true,
			value: {
				type: 'result',
				result:
					method === 'measure_archive'
						? { outcome: 'measured', bytes: 412_306, truncated: false }
						: { outcome: 'listed', tests: [] },
			},
		}),
	}),
}));

import { ProjectCard } from './project-card.js';

/**
 * One card, with the delete's outcome going nowhere: this file asserts the row, and the screen is
 * where a settled outcome is said (`routes/projects.tsx`).
 */
function card(project: ProjectRegistration) {
	return render(<ProjectCard onDeleteSettled={() => undefined} project={project} />);
}

/** A registration that asks the host to do nothing — the common, correct case (D13). */
function declaresNothing(
	overrides: Partial<Extract<ProjectRegistration, { kind: 'registered' }>> = {},
): ProjectRegistration {
	return {
		kind: 'registered',
		project: 'rover-sandbox',
		apps: [],
		hasInstall: false,
		services: [],
		hasTeardown: false,
		...overrides,
	};
}

const CHECKOUT_WEB = declaresNothing({
	project: 'checkout-web',
	apps: ['com.example.checkout', 'com.example.checkout.debug'],
	hasInstall: true,
	services: ['mock-payments', 'api'],
	hasTeardown: true,
});

const NOT_READABLE: ProjectRegistration = { kind: 'unreadable', project: 'legacy-kiosk' };

describe('the header strip, on both arms', () => {
	// `checkout-web` on its own reads as a title, and it is not — it is the hook file's own name
	// and the exact string a lease carries as its `project` (D22, `docs/DESIGN.md` §10).
	it('labels the identifier `PROJECT` whichever arm it is', () => {
		for (const project of [CHECKOUT_WEB, NOT_READABLE]) {
			const { unmount } = card(project);

			expect(screen.getByText('Project')).toBeDefined();
			expect(screen.getByText(project.project)).toBeDefined();
			unmount();
		}
	});

	it('wraps a long identifier rather than truncating it', () => {
		const long = 'a-very-long-project-identifier-nobody-would-shorten-by-hand';
		card(declaresNothing({ project: long }));

		const identifier = screen.getByText(long);
		expect(identifier.className).toContain('break-words');
		expect(identifier.className).not.toContain('truncate');
		expect(identifier.className).not.toContain('text-ellipsis');
	});

	/*
	 * A registration has no status, so what is on the right of the strip is the one control and
	 * nothing standing for a state: no LED, no dot, and the only glyph is the control's own trash.
	 *
	 * `ml-auto` rather than `justify-between`, so the label and the identifier stay a pair reading
	 * left to right and the control is what is pushed away from them.
	 */
	it('puts the one control on the right of the strip, and no status', () => {
		const { container } = card(CHECKOUT_WEB);

		const strip = container.querySelector('article > div');
		expect(strip?.className).not.toContain('justify-between');
		expect(strip?.querySelector('button')?.className).toContain('ml-auto');
		// One glyph, and it belongs to the control: nothing here is an LED or a status dot.
		expect(container.querySelectorAll('svg')).toHaveLength(1);
		expect(container.querySelector('svg')?.closest('button')).not.toBeNull();
	});

	// The design's markup layers one in the header strip; the texture is confined to the
	// navigation chrome (§5), which `app-shell.test.tsx` already asserts for the whole of `<main>`.
	it('carries no scanline', () => {
		const { container } = card(CHECKOUT_WEB);

		expect(container.querySelectorAll('.scanline')).toHaveLength(0);
	});
});

describe('a registration the host read', () => {
	it('draws the four declared fields and nothing else', () => {
		const { container } = card(CHECKOUT_WEB);

		const labels = Array.from(container.querySelectorAll('dt')).map((dt) => dt.textContent);
		expect(labels).toEqual(['Apps', 'Services', 'Install', 'Teardown']);
	});

	it('puts one identifier per line, in the order the host answered', () => {
		const { container } = card(CHECKOUT_WEB);

		const values = Array.from(container.querySelectorAll('dd')).map((dd) =>
			Array.from(dd.querySelectorAll('span')).map((span) => span.textContent),
		);
		expect(values[0]).toEqual(['com.example.checkout', 'com.example.checkout.debug']);
		// Deliberately not alphabetical: this is the order the host starts them in, and its reverse
		// is the order it stops them in (§10).
		expect(values[1]).toEqual(['mock-payments', 'api']);
	});

	it('answers `declared` for an install and a teardown that are there', () => {
		card(CHECKOUT_WEB);

		expect(screen.getAllByText('declared')).toHaveLength(2);
	});

	/*
	 * §10's rule, and the one a first pass gets wrong: a project that asks the host to do nothing
	 * is the common, correct case, so a card of four `none declared`s is *finished* rather than
	 * empty, faded, unloaded or pending.
	 */
	it('draws a project that declares nothing as a complete answer, not as missing data', () => {
		const { container } = card(declaresNothing());

		expect(screen.getAllByText('none declared')).toHaveLength(4);
		expect(container.innerHTML).not.toContain('opacity-');
		expect(container.innerHTML).not.toContain('animate');
		expect(container.innerHTML).not.toContain('italic');
		expect(container.textContent).not.toContain('Configuration not readable');
	});

	// The gutter separates the cells; a rule under one of them reads as a line across the card.
	it('carries no rule between the fields', () => {
		const { container } = card(CHECKOUT_WEB);

		for (const cell of container.querySelectorAll('dl > div')) {
			expect(cell.className).not.toContain('border');
		}
	});
});

describe('a registration the host cannot read', () => {
	it('says so, and says it is not the same as declaring nothing', () => {
		card(NOT_READABLE);

		expect(screen.getByText('Configuration not readable')).toBeDefined();
		expect(screen.getByText(/the file is there and the host cannot read it/)).toBeDefined();
	});

	// §10 forbids a slab across a full-width card, which is why this is not `QuietBanner`.
	it('draws the chip at its own width, left-aligned', () => {
		card(NOT_READABLE);

		const chip = screen.getByText('Configuration not readable');
		expect(chip.className).toContain('self-start');
		expect(chip.className).not.toContain('w-full');
	});

	/*
	 * The two arms of `ProjectRegistrationSchema`, and the pair D6 forbids rendering alike. Built
	 * like `archive.test.tsx`'s *the two states with nothing to browse*: neither one's copy may
	 * appear in the other.
	 */
	it('shares no copy with a project that declares nothing', () => {
		const { unmount } = card(declaresNothing());
		const nothing = document.body.textContent ?? '';
		unmount();

		card(NOT_READABLE);
		const unreadable = document.body.textContent ?? '';

		expect(nothing).toContain('none declared');
		expect(nothing).not.toContain('Configuration not readable');
		expect(nothing).not.toContain('the file is there and the host cannot read it');
		expect(unreadable).toContain('Configuration not readable');
		expect(unreadable).not.toContain('none declared');
	});

	/*
	 * Which of the four causes it was is deliberately not on the wire (D19), so a code here would
	 * dress a refusal up as a diagnosis.
	 *
	 * **Asserted over the words rather than the markup**, which is a narrowing: `innerHTML` carried
	 * this until the strip's `Delete project` brought `text-error` with it, and that class is the
	 * accent on a destructive control rather than anything this state says. What the rule was always
	 * about is what the reader is told — no code, no path, no errno, nothing to press for a retry.
	 */
	it('carries no error code, no path and no retry', () => {
		const { container } = card(NOT_READABLE);

		const words = container.textContent ?? '';
		expect(words.toLowerCase()).not.toContain('error');
		// Not a path, an errno or a filename: the diagnosis stays in the host's own warning.
		expect(words).not.toContain('/');
		expect(words).not.toContain('.json');
		// Nothing to press for a retry: the card's one button is the strip's, and it is the header's
		// on both arms rather than anything this state added.
		const buttons = [...container.querySelectorAll('button')];
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.textContent).toBe('Delete project');
	});
});

/*
 * The card's one control is the strip's `Delete project`, and everything else about the old rule
 * stands: no `Add`, no `Edit`, no overflow menu, no form control, and the card is not a link.
 */
describe('the card, on either arm', () => {
	it('carries the one control and nothing else, and is not a link', () => {
		for (const project of [CHECKOUT_WEB, declaresNothing(), NOT_READABLE]) {
			const { container, unmount } = card(project);

			expect(container.querySelectorAll('button')).toHaveLength(1);
			expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);
			expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
			expect(container.querySelectorAll('a')).toHaveLength(0);
			expect(container.querySelectorAll('[disabled]')).toHaveLength(0);
			unmount();
		}
	});
});

/*
 * `Delete project` — the affordance, **and its action** (#273). This block's framing is rewritten
 * in place rather than replaced: it said the control claimed no privilege, so what was asserted was
 * the shape and the *absence* of behaviour, since D31 refused the write on every transport. D31 was
 * amended for the write that is a *removal* (D42), so what is asserted here now is that the shape
 * is unchanged and that pressing it **asks** — the answer's own handling belongs to
 * `delete-project-control.test.tsx` and the confirmation's words to
 * `delete-project-dialog.test.tsx`.
 */
describe('the `Delete project` control', () => {
	// The header strip is identical on both arms, which is what makes an unreadable registration
	// draw as a project whose configuration will not parse rather than as a different kind of thing.
	it('is on both arms, named for the project it is about', () => {
		for (const project of [CHECKOUT_WEB, NOT_READABLE]) {
			const { unmount } = card(project);

			const control = screen.getByRole('button', { name: `Delete project ${project.project}` });
			// The words are the same on every card; the accessible name is what tells them apart.
			expect(control.textContent).toBe('Delete project');
			unmount();
		}
	});

	it('carries the trash glyph, hidden from a screen reader that already has the words', () => {
		card(CHECKOUT_WEB);

		const glyph = screen.getByRole('button').querySelector('svg');
		expect(glyph).not.toBeNull();
		expect(glyph?.getAttribute('aria-hidden')).toBe('true');
	});

	/*
	 * **The badge treatment, not a new one**: the shape and the type come from `header-badge.tsx`,
	 * so a pill in a strip cannot drift from the Archive header's by a border width. Asserted as
	 * the constants rather than as their letters, which is what makes this a claim about sharing.
	 */
	it('takes the header badge’s own shape and type', () => {
		card(CHECKOUT_WEB);

		const { className } = screen.getByRole('button');
		for (const shared of [...BADGE_SHAPE.split(' '), ...BADGE_TYPE.split(' ')]) {
			expect(className).toContain(shared);
		}
	});

	/*
	 * The accent is Analog Horizon's own red on the glyph and the words, and **never a fill**: §5's
	 * *destructive actions are recessive* is what keeps the identifier the loudest thing on the card.
	 * The frame stays neutral until the pointer is on it.
	 */
	it('accents in `error` without filling with it', () => {
		card(CHECKOUT_WEB);

		const { className } = screen.getByRole('button');
		expect(className).toContain('text-error');
		expect(className).toContain('hover:border-error');
		expect(className).toContain('border-outline-variant');
		expect(className).not.toContain('bg-error');
	});

	/*
	 * **Pressed, it asks** — and it is not `disabled`, which §10 records as the one form of this
	 * control that would have promised a permission tier nobody has. What it opens is a
	 * confirmation over the working panel, mounted outside this card's own tree, and nothing is
	 * asked of the host about the project until that confirmation is answered.
	 */
	it('opens a confirmation when pressed, and is not disabled', async () => {
		const { container } = card(CHECKOUT_WEB);

		const control = screen.getByRole('button');
		expect(control.getAttribute('type')).toBe('button');
		expect(control.hasAttribute('disabled')).toBe(false);

		fireEvent.click(control);
		await act(async () => undefined);

		const dialog = screen.getByRole('dialog');
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		// The card is not where it is mounted, and the card itself has not changed.
		expect(container.contains(dialog)).toBe(false);
		expect(container.querySelectorAll('button')).toHaveLength(1);
	});

	/*
	 * The strip is identical on both arms, so the control is pressable on both — a registration the
	 * host cannot read is exactly the one an operator is most likely to want gone, and the delete is
	 * keyed on an identifier the host answered rather than on anything inside the file.
	 */
	it('asks on a registration the host cannot read, too', async () => {
		card(NOT_READABLE);

		fireEvent.click(screen.getByRole('button', { name: 'Delete project legacy-kiosk' }));
		await act(async () => undefined);

		// The identifier is on the card and again in the dialog, which is the point of both.
		expect(screen.getByRole('dialog').textContent).toContain('legacy-kiosk');
		expect(screen.getAllByText('legacy-kiosk')).toHaveLength(2);
	});
});
