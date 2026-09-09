import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeleteProjectNotice, type SettledDeleteProject } from './delete-project-notice.js';

/**
 * The line above the list, and the sentences it is made of.
 *
 * `projects.test.tsx` drives this through the whole chain and owns *no two outcomes share a
 * phrase*; what is here is the wording arithmetic that chain reaches only one combination of — the
 * halves a `partial` names when more than one stayed, the singular of a kept test, and the bytes
 * that must read as `0 B` rather than go missing.
 */

const REPORT = {
	registration: 'removed',
	archive: 'removed',
	keptTests: 'removed',
	freedBytes: 7_723_471,
	keptTestsRemoved: 3,
} as const;

function said(answer: SettledDeleteProject['answer'], project = 'checkout-web'): string {
	const { container, unmount } = render(
		<DeleteProjectNotice onDismiss={() => undefined} settled={{ answer, project }} />,
	);
	const line = container.querySelector('section p')?.textContent ?? '';
	unmount();
	return line;
}

describe('a delete that went', () => {
	// What it came to rather than that it worked — the bytes, and the count D35's amendment exists
	// to make sayable.
	it('says the bytes freed and how many kept tests went', () => {
		expect(said({ outcome: 'deleted', ...REPORT })).toBe(
			'checkout-web is gone: the registration and everything the archive held for it, with 7.4 MB back. 3 tests marked Keep went with it.',
		);
	});

	// The singular is not cosmetic: one kept test is the common case, and `1 tests marked Keep`
	// makes a reader wonder what else the line is guessing at.
	it('says one kept test as one', () => {
		expect(said({ outcome: 'deleted', ...REPORT, keptTestsRemoved: 1 })).toContain(
			'One test marked Keep went with it.',
		);
	});

	// No kept test draws no clause at all: absent is absent, rather than a sentence about zero.
	it('says nothing about kept tests when none went', () => {
		const line = said({ outcome: 'deleted', ...REPORT, keptTestsRemoved: 0 });

		expect(line).not.toContain('Keep');
		expect(line).toContain('7.4 MB back');
	});

	/*
	 * **`0 B` is said rather than dropped.** A registration with nothing filed under it freed
	 * nothing, and saying so keeps the line a report rather than a congratulation — the badges'
	 * absent-rather-than-`0` rule is about a set that is there, and this is about what a delete
	 * did.
	 */
	it('says `0 B` for a delete that freed nothing', () => {
		expect(
			said({
				outcome: 'deleted',
				...REPORT,
				archive: 'absent',
				keptTests: 'absent',
				freedBytes: 0,
				keptTestsRemoved: 0,
			}),
		).toContain('0 B back');
	});
});

describe('a delete that left something behind', () => {
	it('names the one half that stayed', () => {
		expect(said({ outcome: 'partial', ...REPORT, archive: 'failed' })).toContain(
			'part of its archive is still there',
		);
	});

	/*
	 * More than one, joined and each named: *which* half is what makes *look at this host's log*
	 * actionable, so a `partial` that named only the first would be the thinner sentence. Asserted
	 * as the **whole** sentence rather than the substring, because the substring is exactly what
	 * let *the rest went* sit unread on the tail of a delete that removed nothing.
	 */
	it('names every half that stayed, in the order the host removes them', () => {
		expect(
			said({
				outcome: 'partial',
				...REPORT,
				registration: 'failed',
				archive: 'failed',
				keptTests: 'failed',
				freedBytes: 0,
				keptTestsRemoved: 0,
			}),
		).toBe(
			"Nothing of checkout-web could be removed: its registration is still there, part of its archive is still there, its Keep flags are still set. This host's log says what stopped it.",
		);
	});

	/*
	 * **A `partial` where no half went is a delete that removed nothing**, and the host answers it
	 * whenever all three halves fail — a read-only `~/.rover` is enough, and the `partial` arm has
	 * no floor on how many went (`src/daemon/delete-project.ts`). So no removal is claimed and no
	 * figure is stated: `freedBytes` is `0` there, and `0 B back` beside *the rest went* would say a
	 * removal happened where the host's own audit line says `NOT removed` three times.
	 */
	it('claims no removal and no bytes when no half went', () => {
		const line = said({
			outcome: 'partial',
			...REPORT,
			registration: 'failed',
			archive: 'failed',
			keptTests: 'failed',
			freedBytes: 0,
			keptTestsRemoved: 0,
		});

		expect(line).not.toContain('The rest went');
		expect(line).not.toContain('0 B');
		expect(line).toContain('Nothing of checkout-web could be removed');
	});

	/*
	 * An `absent` half is not a removal either — there was nothing of it to take — so a `partial`
	 * whose only non-`failed` halves were never there is still a delete that removed nothing.
	 */
	it('claims no removal when the halves that did not fail were never there', () => {
		const line = said({
			outcome: 'partial',
			...REPORT,
			registration: 'absent',
			archive: 'failed',
			keptTests: 'absent',
			freedBytes: 0,
			keptTestsRemoved: 0,
		});

		expect(line).not.toContain('The rest went');
		expect(line).toContain(
			'Nothing of checkout-web could be removed: part of its archive is still there',
		);
	});

	// It reports no *less* than a `deleted`: the fields say what did go, so the failure is the
	// fuller sentence rather than the thinner one.
	it('still says what did go, and where to look', () => {
		const line = said({ outcome: 'partial', ...REPORT, keptTests: 'failed' });

		expect(line).toContain('The rest went, with 7.4 MB back.');
		expect(line).toContain("This host's log says what stopped it.");
	});

	/*
	 * And the mixed case keeps the removal clause, the bytes and the kept count, so the fix above
	 * did not make a `partial` that *did* remove something report less than a `deleted` does. The
	 * combination is the fixture's own third entry — the archive half stayed, the other two went, so
	 * `0 B` came back and the kept count is one the host really would send.
	 */
	it('still says what went, in bytes and in kept tests, for a partial that removed something', () => {
		expect(
			said({
				outcome: 'partial',
				registration: 'removed',
				archive: 'failed',
				keptTests: 'removed',
				freedBytes: 0,
				keptTestsRemoved: 1,
			}),
		).toBe(
			"Some of checkout-web could not be removed: part of its archive is still there. The rest went, with 0 B back. One test marked Keep went with it. This host's log says what stopped it.",
		);
	});
});

describe('the two answers where nothing was deleted', () => {
	/*
	 * **`not-registered` is not a delete of zero bytes.** The news is that there was nothing of this
	 * project on the host — including that the list a reader was looking at was already out of date.
	 */
	it('says there was no registration, and that the list was stale', () => {
		const line = said({ outcome: 'not-registered' });

		expect(line).toContain('There was no registration for checkout-web');
		expect(line).toContain('nothing was deleted');
		expect(line).toContain('read again');
		expect(line).not.toContain('0 B');
	});

	// Nothing at all was touched, which the sentence says so that *refused* is not read as *partly
	// done* — and the next move is named, because it is the operator's.
	it('says a live lease touched nothing, and what to do about it', () => {
		const line = said({ outcome: 'refused', reason: 'lease-live' });

		expect(line).toContain('nothing was touched');
		expect(line).toContain('force-release');
		expect(line).not.toContain('deleted');
	});
});

describe('the region itself', () => {
	// It exists before its text does, or it is announced unreliably — `Profile`'s sign-out line
	// settled that already.
	it('is a polite live region even with nothing to say', () => {
		const { container } = render(
			<DeleteProjectNotice onDismiss={() => undefined} settled={undefined} />,
		);

		const region = container.querySelector('[aria-live="polite"]');
		expect(region).not.toBeNull();
		expect(region?.textContent).toBe('');
		expect(container.querySelectorAll('button')).toHaveLength(0);
	});

	// Ordinary text, no colour of alarm and no icon of alarm: the panel did what was asked, or says
	// what there was to do instead (§5).
	it('carries no colour of alarm and no glyph', () => {
		const { container } = render(
			<DeleteProjectNotice
				onDismiss={() => undefined}
				settled={{ answer: { outcome: 'refused', reason: 'lease-live' }, project: 'checkout-web' }}
			/>,
		);

		expect(container.innerHTML).not.toContain('error');
		expect(container.querySelectorAll('svg')).toHaveLength(0);
	});

	// It stays until dismissed (§7), so the dismiss control is the whole of how it goes.
	it('is dismissed by its own control, which is labelled by what it does to this line', () => {
		const onDismiss = vi.fn();
		render(
			<DeleteProjectNotice
				onDismiss={onDismiss}
				settled={{ answer: { outcome: 'not-registered' }, project: 'checkout-web' }}
			/>,
		);

		fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
