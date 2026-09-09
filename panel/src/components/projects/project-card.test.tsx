import { BADGE_SHAPE, BADGE_TYPE } from '@panel/components/archive/header-badge.js';
import type { ProjectRegistration } from '@panel/projects/project-list.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectCard } from './project-card.js';

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
			const { unmount } = render(<ProjectCard project={project} />);

			expect(screen.getByText('Project')).toBeDefined();
			expect(screen.getByText(project.project)).toBeDefined();
			unmount();
		}
	});

	it('wraps a long identifier rather than truncating it', () => {
		const long = 'a-very-long-project-identifier-nobody-would-shorten-by-hand';
		render(<ProjectCard project={declaresNothing({ project: long })} />);

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
		const { container } = render(<ProjectCard project={CHECKOUT_WEB} />);

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
		const { container } = render(<ProjectCard project={CHECKOUT_WEB} />);

		expect(container.querySelectorAll('.scanline')).toHaveLength(0);
	});
});

describe('a registration the host read', () => {
	it('draws the four declared fields and nothing else', () => {
		const { container } = render(<ProjectCard project={CHECKOUT_WEB} />);

		const labels = Array.from(container.querySelectorAll('dt')).map((dt) => dt.textContent);
		expect(labels).toEqual(['Apps', 'Services', 'Install', 'Teardown']);
	});

	it('puts one identifier per line, in the order the host answered', () => {
		const { container } = render(<ProjectCard project={CHECKOUT_WEB} />);

		const values = Array.from(container.querySelectorAll('dd')).map((dd) =>
			Array.from(dd.querySelectorAll('span')).map((span) => span.textContent),
		);
		expect(values[0]).toEqual(['com.example.checkout', 'com.example.checkout.debug']);
		// Deliberately not alphabetical: this is the order the host starts them in, and its reverse
		// is the order it stops them in (§10).
		expect(values[1]).toEqual(['mock-payments', 'api']);
	});

	it('answers `declared` for an install and a teardown that are there', () => {
		render(<ProjectCard project={CHECKOUT_WEB} />);

		expect(screen.getAllByText('declared')).toHaveLength(2);
	});

	/*
	 * §10's rule, and the one a first pass gets wrong: a project that asks the host to do nothing
	 * is the common, correct case, so a card of four `none declared`s is *finished* rather than
	 * empty, faded, unloaded or pending.
	 */
	it('draws a project that declares nothing as a complete answer, not as missing data', () => {
		const { container } = render(<ProjectCard project={declaresNothing()} />);

		expect(screen.getAllByText('none declared')).toHaveLength(4);
		expect(container.innerHTML).not.toContain('opacity-');
		expect(container.innerHTML).not.toContain('animate');
		expect(container.innerHTML).not.toContain('italic');
		expect(container.textContent).not.toContain('Configuration not readable');
	});

	// The gutter separates the cells; a rule under one of them reads as a line across the card.
	it('carries no rule between the fields', () => {
		const { container } = render(<ProjectCard project={CHECKOUT_WEB} />);

		for (const cell of container.querySelectorAll('dl > div')) {
			expect(cell.className).not.toContain('border');
		}
	});
});

describe('a registration the host cannot read', () => {
	it('says so, and says it is not the same as declaring nothing', () => {
		render(<ProjectCard project={NOT_READABLE} />);

		expect(screen.getByText('Configuration not readable')).toBeDefined();
		expect(screen.getByText(/the file is there and the host cannot read it/)).toBeDefined();
	});

	// §10 forbids a slab across a full-width card, which is why this is not `QuietBanner`.
	it('draws the chip at its own width, left-aligned', () => {
		render(<ProjectCard project={NOT_READABLE} />);

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
		const { unmount } = render(<ProjectCard project={declaresNothing()} />);
		const nothing = document.body.textContent ?? '';
		unmount();

		render(<ProjectCard project={NOT_READABLE} />);
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
		const { container } = render(<ProjectCard project={NOT_READABLE} />);

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
			const { container, unmount } = render(<ProjectCard project={project} />);

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
 * `Delete project` — the affordance, deliberately ahead of the action it names. Deleting a
 * registration means the host removing a file that names programs it spawns, which D31 refuses on
 * every transport and which waits on the role model D27 defers; this control claims none of that,
 * so what is asserted here is the shape and the *absence* of behaviour.
 */
describe('the `Delete project` control', () => {
	// The header strip is identical on both arms, which is what makes an unreadable registration
	// draw as a project whose configuration will not parse rather than as a different kind of thing.
	it('is on both arms, named for the project it is about', () => {
		for (const project of [CHECKOUT_WEB, NOT_READABLE]) {
			const { unmount } = render(<ProjectCard project={project} />);

			const control = screen.getByRole('button', { name: `Delete project ${project.project}` });
			// The words are the same on every card; the accessible name is what tells them apart.
			expect(control.textContent).toBe('Delete project');
			unmount();
		}
	});

	it('carries the trash glyph, hidden from a screen reader that already has the words', () => {
		render(<ProjectCard project={CHECKOUT_WEB} />);

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
		render(<ProjectCard project={CHECKOUT_WEB} />);

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
		render(<ProjectCard project={CHECKOUT_WEB} />);

		const { className } = screen.getByRole('button');
		expect(className).toContain('text-error');
		expect(className).toContain('hover:border-error');
		expect(className).toContain('border-outline-variant');
		expect(className).not.toContain('bg-error');
	});

	/*
	 * **Nothing is wired**, and this is the assertion that says so: pressed, it does not throw, does
	 * not navigate and has no handler to run. A control that quietly grew one would promise a
	 * privilege D31 refuses — so the promise is asserted absent rather than left to a reading of the
	 * component.
	 */
	it('does nothing when pressed, and is not disabled either', () => {
		render(<ProjectCard project={CHECKOUT_WEB} />);

		const control = screen.getByRole('button');
		expect(control.getAttribute('type')).toBe('button');
		expect(control.hasAttribute('disabled')).toBe(false);
		expect(control.getAttribute('onclick')).toBeNull();

		const before = document.body.innerHTML;
		fireEvent.click(control);

		// Nothing changed, because there is nothing behind it yet.
		expect(document.body.innerHTML).toBe(before);
	});
});
