import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RemoveNotice, type SettledRemoveGroup, type SettledRemoveTest } from './remove-notice.js';

/**
 * The line above the content area, and the sentences it is made of.
 *
 * **Four answers that must not collapse into one** (D43, `docs/DESIGN.md` §9), plus the fifth
 * piece of news the host's `partial` arm carries — a delete that removed nothing — which is what
 * the pairing rule below holds apart from the other four. `archive.test.tsx` drives the whole chain
 * and owns *the notice survives the card it was about*; the wording arithmetic is here.
 */

const REPORT = {
	archive: 'removed',
	keptTests: 'removed',
	freedBytes: 4_180_532,
	keptTestsRemoved: 1,
} as const;

function said(answer: SettledRemoveTest['answer'], testName = 'login-flow'): string {
	const { container, unmount } = render(
		<RemoveNotice onDismiss={() => undefined} settled={{ scope: 'test', answer, testName }} />,
	);
	const line = container.querySelector('section p')?.textContent ?? '';
	unmount();
	return line;
}

/** The same, for a **group's** settled delete — the second scope this region reports (#277). */
function saidOfGroup(answer: SettledRemoveGroup['answer'], groupId = 'app-bar-top-space'): string {
	const { container, unmount } = render(
		<RemoveNotice onDismiss={() => undefined} settled={{ scope: 'group', answer, groupId }} />,
	);
	const line = container.querySelector('section p')?.textContent ?? '';
	unmount();
	return line;
}

/** The group's own report, at the two figures its line is built on. */
const GROUP_REPORT = {
	archive: 'removed',
	keptTests: 'removed',
	freedBytes: 8_451_208,
	keptTestsRemoved: 1,
	runsRemoved: 7,
} as const;

/** The five pieces of news a **group's** line can carry, in the host's own order. */
const GROUP_OUTCOMES = [
	['deleted', { outcome: 'deleted', ...GROUP_REPORT }],
	['not-found', { outcome: 'not-found' }],
	[
		'partial',
		{
			outcome: 'partial',
			archive: 'failed',
			keptTests: 'removed',
			freedBytes: 90_114,
			keptTestsRemoved: 2,
			runsRemoved: 2,
		},
	],
	/*
	 * A `partial` that took **no** run is a fifth piece of news for the test line's reason, and it
	 * is the ordinary shape of a walk that was cut short before it reached anything.
	 */
	[
		'a partial where no run went',
		{
			outcome: 'partial',
			archive: 'failed',
			keptTests: 'absent',
			freedBytes: 0,
			keptTestsRemoved: 0,
			runsRemoved: 0,
		},
	],
	['refused', { outcome: 'refused', reason: 'lease-live' }],
] as const satisfies readonly (readonly [string, SettledRemoveGroup['answer']])[];

/** The five pieces of news this line can carry, in the order the host's own union puts them. */
const OUTCOMES = [
	['deleted', { outcome: 'deleted', ...REPORT }],
	['not-found', { outcome: 'not-found' }],
	[
		'partial',
		{
			outcome: 'partial',
			archive: 'removed',
			keptTests: 'failed',
			freedBytes: 4_180_532,
			keptTestsRemoved: 0,
		},
	],
	/*
	 * The `partial` in which **neither** half went is a fifth piece of news, not a sixth outcome:
	 * the host answers `partial` the moment either half fails and puts no floor on how many went,
	 * so a delete that removed nothing arrives on this arm and must not borrow the sentence that
	 * says *the rest went*.
	 */
	[
		'a partial where nothing went',
		{
			outcome: 'partial',
			archive: 'failed',
			keptTests: 'failed',
			freedBytes: 0,
			keptTestsRemoved: 0,
		},
	],
	['refused', { outcome: 'refused', reason: 'lease-live' }],
] as const satisfies readonly (readonly [string, SettledRemoveTest['answer']])[];

describe('a delete that went', () => {
	// What it came to rather than that it worked — the bytes, and the mark D35's amendment exists to
	// make sayable.
	it('says the bytes freed and that the Keep mark went with it', () => {
		expect(said({ outcome: 'deleted', ...REPORT })).toBe(
			'login-flow is gone: every run filed under it went, and 4.0 MB came back. Its Keep mark went too.',
		);
	});

	// No kept entry draws no clause at all: absent is absent, rather than a sentence about zero.
	it('says nothing about a Keep mark when there was none', () => {
		const line = said({ outcome: 'deleted', ...REPORT, keptTests: 'absent', keptTestsRemoved: 0 });

		expect(line).not.toContain('Keep');
		expect(line).toContain('4.0 MB came back');
	});

	/*
	 * **`0 B` is said rather than dropped.** A test whose runs held nothing freed nothing, and
	 * saying so keeps the line a report rather than a congratulation — the badges'
	 * absent-rather-than-`0` rule is about a set that is there, and this is about what a delete did.
	 */
	it('says `0 B` for a delete that freed nothing', () => {
		expect(
			said({
				outcome: 'deleted',
				archive: 'removed',
				keptTests: 'absent',
				freedBytes: 0,
				keptTestsRemoved: 0,
			}),
		).toContain('0 B came back');
	});
});

describe('a delete that left something behind', () => {
	it('names the one half that stayed', () => {
		expect(said({ outcome: 'partial', ...REPORT, keptTests: 'failed' })).toContain(
			'its Keep mark is still set',
		);
	});

	/*
	 * Both halves, joined and each named: *which* half is what makes *look at this host's log*
	 * actionable, so a `partial` that named only the first would be the thinner sentence. Asserted
	 * as the **whole** sentence rather than the substring, because the substring is exactly what
	 * would let *the rest went* sit unread on the tail of a delete that removed nothing.
	 */
	it('names every half that stayed, in the order the host removes them', () => {
		expect(
			said({
				outcome: 'partial',
				archive: 'failed',
				keptTests: 'failed',
				freedBytes: 0,
				keptTestsRemoved: 0,
			}),
		).toBe(
			"None of login-flow could be removed: some of its runs are still filed, its Keep mark is still set. This host's log says what stopped it.",
		);
	});

	/*
	 * **A `partial` where neither half went is a delete that removed nothing**, and the host answers
	 * it whenever both fail (`src/daemon/delete-archived-test.ts`). So no removal is claimed and no
	 * figure is stated: `freedBytes` is `0` there, and `0 B came back` beside *the rest went* would
	 * say a removal happened where the host's own audit line says `NOT removed` twice.
	 */
	it('claims no removal and no bytes when neither half went', () => {
		const line = said({
			outcome: 'partial',
			archive: 'failed',
			keptTests: 'failed',
			freedBytes: 0,
			keptTestsRemoved: 0,
		});

		expect(line).not.toContain('The rest went');
		expect(line).not.toContain('0 B');
		expect(line).toContain('None of login-flow could be removed');
	});

	/*
	 * An `absent` half is not a removal either — there was nothing of it to take — so a `partial`
	 * whose only non-`failed` half was never there is still a delete that removed nothing.
	 */
	it('claims no removal when the half that did not fail was never there', () => {
		const line = said({
			outcome: 'partial',
			archive: 'failed',
			keptTests: 'absent',
			freedBytes: 0,
			keptTestsRemoved: 0,
		});

		expect(line).not.toContain('The rest went');
		expect(line).toContain('None of login-flow could be removed: some of its runs are still filed');
	});

	// It reports no *less* than a `deleted`: the fields say what did go, so the failure is the
	// fuller sentence rather than the thinner one.
	it('still says what did go, and where to look', () => {
		const line = said({ outcome: 'partial', ...REPORT, keptTests: 'failed', keptTestsRemoved: 0 });

		expect(line).toContain('The rest went, and 4.0 MB came back.');
		expect(line).toContain("This host's log says what stopped it.");
	});
});

describe('the two answers where nothing was deleted', () => {
	/*
	 * **`not-found` is not a delete of zero bytes.** The news is that there was nothing of this test
	 * on the host — including that what the reader was looking at was already out of date, which is
	 * why the screen re-reads on this arm as well.
	 */
	it('says there was nothing at that address, and that the screen was stale', () => {
		const line = said({ outcome: 'not-found' });

		expect(line).toContain('There was nothing at that address for login-flow');
		expect(line).toContain('nothing was deleted');
		expect(line).toContain('read again');
		expect(line).not.toContain('0 B');
	});

	// Nothing at all was touched, which the sentence says so that *refused* is not read as *partly
	// done* — and the next move is named, because it is the operator's.
	it('says a live lease touched nothing, and what to do about it', () => {
		const line = said({ outcome: 'refused', reason: 'lease-live' });

		expect(line).toContain('nothing at all was touched');
		expect(line).toContain('force-release');
		expect(line).not.toContain('deleted');
	});
});

/**
 * The pairing rule (D6): five pieces of news, five sentences, and none of them a substring of
 * another — two lines that differ only by a clause would read as one piece of news with a footnote.
 */
describe('the five sentences', () => {
	it('shares no phrase between any two of them', () => {
		const lines = OUTCOMES.map(([, answer]) => said(answer));

		expect(lines).toHaveLength(5);
		expect(new Set(lines).size).toBe(5);
		for (const [at, one] of lines.entries()) {
			for (const [other, two] of lines.entries()) {
				if (at !== other) {
					expect(one).not.toContain(two);
				}
			}
		}
	});

	// The test's name is in every one of them, because the card it was about may no longer be there.
	it('names the test in all five, because its card may be gone', () => {
		for (const [, answer] of OUTCOMES) {
			expect(said(answer)).toContain('login-flow');
		}
	});
});

describe('the region itself', () => {
	// It exists before its text does, or it is announced unreliably — `Profile`'s sign-out line
	// settled that already.
	it('is a polite live region even with nothing to say', () => {
		const { container } = render(<RemoveNotice onDismiss={() => undefined} settled={undefined} />);

		const region = container.querySelector('[aria-live="polite"]');
		expect(region).not.toBeNull();
		expect(region?.textContent).toBe('');
		expect(container.querySelectorAll('button')).toHaveLength(0);
	});

	// Ordinary text, no colour of alarm and no icon of alarm: the panel did what was asked, or says
	// what there was to do instead (§5).
	it('carries no colour of alarm and no glyph', () => {
		const { container } = render(
			<RemoveNotice
				onDismiss={() => undefined}
				settled={{
					scope: 'test',
					answer: { outcome: 'refused', reason: 'lease-live' },
					testName: 'login-flow',
				}}
			/>,
		);

		expect(container.innerHTML).not.toContain('error');
		expect(container.querySelectorAll('svg')).toHaveLength(0);
	});

	// It stays until dismissed (§7, §9 — the screen does not poll), so the dismiss control is the
	// whole of how it goes.
	it('is dismissed by its own control, which is labelled by what it does to this line', () => {
		const onDismiss = vi.fn();
		render(
			<RemoveNotice
				onDismiss={onDismiss}
				settled={{ scope: 'test', answer: { outcome: 'not-found' }, testName: 'login-flow' }}
			/>,
		);

		fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});

/**
 * The **group's** five sentences (D43, R51 phase 3, #277).
 *
 * They are five and not four for the test line's reason, and they share no phrase with the test's —
 * which is the pairing rule (D6) applied across the two scopes rather than only within one: a group
 * and a test are different things to have deleted, and two lines that read alike would make the
 * screen's news ambiguous about which happened.
 */
describe("a group's settled delete", () => {
	/*
	 * **The run count leads**, because a group has no directory whose size stands for it — how many
	 * runs went is the figure nobody can recover afterwards. And what *stayed* is said, because that
	 * is D43's surgical reading confirmed after the fact rather than only promised before it.
	 */
	it('says how many runs went, what they freed, and that runs outside the group stayed', () => {
		const line = saidOfGroup({ outcome: 'deleted', ...GROUP_REPORT });

		expect(line).toContain('7 runs went');
		expect(line).toContain('8.1 MB');
		expect(line).toContain('Runs of the same tests that were not in it are still filed');
	});

	it('says the singular for a group of one run', () => {
		expect(
			saidOfGroup({ outcome: 'deleted', ...GROUP_REPORT, runsRemoved: 1, keptTestsRemoved: 0 }),
		).toContain('1 run went');
	});

	/*
	 * **The `Keep` clause is where the group's line carries what its dialog has no row for**: there
	 * is no group-level flag, and whether a test is emptied is not knowable until the runs have gone
	 * (D35 as amended).
	 */
	it.each([
		[0, null],
		[1, 'One test it emptied was marked Keep'],
		[2, '2 tests it emptied were marked Keep'],
	])('says what happened to the emptied tests’ Keep marks (%i)', (removed, said) => {
		const line = saidOfGroup({ outcome: 'deleted', ...GROUP_REPORT, keptTestsRemoved: removed });

		if (said === null) {
			expect(line).not.toContain('Keep');
		} else {
			expect(line).toContain(said);
		}
	});

	/*
	 * **`not-found` is not a delete of zero runs** and must never read as one: no run filed under the
	 * project named that group, so the news is that the screen had gone out of date.
	 */
	it('says nothing named the group rather than that nothing went', () => {
		const line = saidOfGroup({ outcome: 'not-found' });

		expect(line).toContain('No run filed under this project names');
		expect(line).toContain('gone out of date');
		expect(line).not.toContain('freeing');
	});

	/*
	 * **A `partial` says *ask again***, and that is this scope's own next move: the delete is a
	 * bounded walk, so part of the group may never have been reached.
	 */
	it('says how much went, that the rest may still be filed, and to ask again', () => {
		const line = saidOfGroup(GROUP_OUTCOMES[2][1]);

		expect(line).toContain('2 runs went');
		expect(line).toContain('The rest may still be filed');
		expect(line).toContain('ask again');
	});

	// And a `partial` that took no run says so in words of its own, rather than *the rest went*.
	it('says not one run could be taken when none was', () => {
		const line = saidOfGroup(GROUP_OUTCOMES[3][1]);

		expect(line).toContain('Not one run');
		expect(line).not.toContain('went');
		expect(line).not.toContain('0 B');
	});

	// A live lease on one of its runs, with nothing at all touched — said so that *refused* is not
	// read as *partly done*.
	it('says a lease is filing into one of its runs and nothing was touched', () => {
		const line = saidOfGroup({ outcome: 'refused', reason: 'lease-live' });

		expect(line).toContain("one of app-bar-top-space's runs");
		expect(line).toContain('nothing at all was touched');
		expect(line).toContain('force-release');
	});

	it('shares no phrase between any two of its five, and names the group in all of them', () => {
		const lines = GROUP_OUTCOMES.map(([, answer]) => saidOfGroup(answer));

		expect(new Set(lines).size).toBe(5);
		for (const [at, one] of lines.entries()) {
			for (const [other, two] of lines.entries()) {
				if (at !== other) {
					expect(one).not.toContain(two);
				}
			}
			expect(one).toContain('app-bar-top-space');
		}
	});

	/*
	 * **And no phrase with the test's five** (D6 across the two scopes): the screen draws one region,
	 * so a reader has to be able to tell from the sentence which of the two they just did.
	 */
	it('shares no sentence with the test’s five', () => {
		const groups = GROUP_OUTCOMES.map(([, answer]) => saidOfGroup(answer));
		const tests = OUTCOMES.map(([, answer]) => said(answer));

		for (const group of groups) {
			for (const test of tests) {
				expect(group).not.toBe(test);
			}
		}
	});
});
