import type { ProjectRegistration } from '@panel/projects/project-list.js';
import { render, screen } from '@testing-library/react';
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

	// A registration has no status, so there is nothing for an LED, a dot or a glyph to mean.
	it('puts nothing on the right of the strip', () => {
		const { container } = render(<ProjectCard project={CHECKOUT_WEB} />);

		expect(container.querySelectorAll('svg')).toHaveLength(0);
		expect(container.querySelectorAll('[class*="justify-between"]')).toHaveLength(0);
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

	// Which of the four causes it was is deliberately not on the wire (D19), so a code here would
	// dress a refusal up as a diagnosis. §5's no-red rule holds too.
	it('carries no error code, no path and no retry', () => {
		const { container } = render(<ProjectCard project={NOT_READABLE} />);

		expect(container.innerHTML).not.toContain('error');
		// Not a path, an errno or a filename: the diagnosis stays in the host's own warning.
		expect(container.textContent).not.toContain('/');
		expect(container.textContent).not.toContain('.json');
		expect(container.querySelectorAll('button')).toHaveLength(0);
	});
});

/*
 * D31: a hook file names programs the host spawns, so writing one is a different privilege in kind
 * and waits on the role model D27 defers. Not even a disabled control, which would promise a
 * permission tier that does not exist.
 */
describe('the card, on either arm', () => {
	it('carries no control at all, and is not a link', () => {
		for (const project of [CHECKOUT_WEB, declaresNothing(), NOT_READABLE]) {
			const { container, unmount } = render(<ProjectCard project={project} />);

			expect(container.querySelectorAll('button')).toHaveLength(0);
			expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);
			expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
			expect(container.querySelectorAll('a')).toHaveLength(0);
			expect(container.querySelectorAll('[disabled]')).toHaveLength(0);
			unmount();
		}
	});
});
