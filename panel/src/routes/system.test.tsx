import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* `devices.test.tsx`'s shape: this module builds a route at import, so the router is stubbed. */
vi.mock('@tanstack/react-router', () => ({
	Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
	createRoute: (options: unknown) => ({ options }),
	createRootRoute: (options: unknown) => ({ options }),
	Outlet: () => null,
	useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
		select({ location: { pathname: '/system' } }),
}));

/**
 * The host, for the one question this screen asks (#260): `measure_archive` over the whole archive.
 *
 * Every call is logged with its method as well as its params, because *this destination makes one
 * round trip and it is that one* is half of what is worth asserting — a settings screen that
 * quietly listed the archive to add it up would pass every assertion about the badge's words.
 */
const { host, HANGS } = vi.hoisted(() => ({
	/** What the host answers with when a case needs the request to be still out. */
	HANGS: '__hangs__',
	host: {
		asked: [] as unknown[],
		measure: undefined as unknown,
	},
}));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({
		state: { status: 'signed-in', identity: { identifier: 'karolina', displayName: 'Karolina' } },
		call: async (method: string, params: unknown) => {
			host.asked.push({ method, params });
			if (host.measure === HANGS) {
				return await new Promise(() => undefined);
			}
			return { ok: true, value: { type: 'result', result: host.measure } };
		},
	}),
}));

import { sizeSentence } from '@panel/archive/size-sentence.js';
import { BADGE_FRAME } from '@panel/components/archive/header-badge.js';
import { DEFAULT_DISK_BUDGET_MB, DEFAULT_MAX_AGE_DAYS } from '@panel/system/retention-settings.js';
import { SystemScreen } from './system.js';

/**
 * The settings destination (`docs/DESIGN.md` §3, §13) — **`System`, and not a fifth nav item.**
 *
 * §3 settles four destinations and says that `System` stands in for settings; this screen fills the
 * placeholder that promised exactly that. What is asserted below is the two settings, their
 * defaults, the archive total in the card's strip (#260), and the two things this screen must not
 * do while no host method **writes** either number: offer a control that appears to save, or claim
 * a deadline it cannot know. The host does enforce these two bounds now — from its own environment,
 * by `rover sweep` (#238), after every lease ends (#245) and at local midnight and daemon start
 * (#246) — which is why the copy asserted here no longer says nothing sweeps the archive.
 */

/** 7.7 MB, which is the figure §9's own table of badge sentences uses. */
const BYTES = 8_074_035;
const MEASURED = { outcome: 'measured', bytes: BYTES, truncated: false };

const disk = () => screen.getByLabelText('Disk space for test data') as HTMLInputElement;
const days = () => screen.getByLabelText('Delete tests after') as HTMLInputElement;

const cardOf = (container: HTMLElement) => container.querySelector('section') as HTMLElement;
const stripOf = (container: HTMLElement) => cardOf(container).firstElementChild as HTMLElement;
/** The badge in that strip, or `null` where the strip holds nothing but its own title. */
const badgeOf = (container: HTMLElement) => stripOf(container).querySelector('div');

/**
 * The screen, with the measurement it asks for settled before anything is asserted.
 *
 * One microtask turn is enough: this destination asks one question and asks it on mount, unlike the
 * Archive screen's chain of levels.
 */
async function showing(measure: unknown = MEASURED) {
	host.measure = measure;
	const rendered = render(<SystemScreen />);
	await act(async () => undefined);
	return rendered;
}

beforeEach(() => {
	host.asked = [];
	host.measure = MEASURED;
});

describe('the System screen', () => {
	it('shows both settings, with their units and their defaults', async () => {
		await showing();

		expect(disk().value).toBe(String(DEFAULT_DISK_BUDGET_MB));
		expect(days().value).toBe(String(DEFAULT_MAX_AGE_DAYS));
		// The unit is beside the field rather than in the value, so it is on screen but not typed.
		expect(screen.getByText('MB')).toBeDefined();
		expect(screen.getByText('days')).toBeDefined();
	});

	/*
	 * **The fields are editable and hold digits only.** Enforced on the way in, so the field cannot
	 * hold `1.5` or a pasted `12 MB` at all — `retention-settings.test.ts` covers the rule, and this
	 * covers that the screen is wired to it.
	 */
	it('takes a new number, and only digits', async () => {
		await showing();

		fireEvent.change(disk(), { target: { value: '512' } });
		expect(disk().value).toBe('512');

		fireEvent.change(days(), { target: { value: '1.5' } });
		expect(days().value).toBe('15');
	});

	/*
	 * **No control that appears to save.** Nothing on the host takes either number, so a `Save`
	 * would be the first thing on this screen to lie — the objection §11 already makes to a button
	 * on a destination that is not built. The two fields are the only interactive elements here.
	 */
	it('offers nothing to press', async () => {
		const { container } = await showing();

		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.querySelectorAll('a')).toHaveLength(0);
		expect(container.querySelectorAll('input')).toHaveLength(2);
	});

	/*
	 * **It says where the numbers stand, in words and without alarm.** Nothing here saves them and
	 * the host reads its own; that is not a fault, so it is ordinary quiet text — no `role="alert"`,
	 * no error colour, no spinner (§7).
	 *
	 * **And it must not claim the host has no retention mechanism**, which is what this asserted
	 * until #238 and is now false twice over: the host enforces both bounds, and since #246 it does
	 * so on its own clock rather than only when asked. The negative assertion is deliberate — the
	 * old sentence is exactly the kind that survives a feature landing, because nothing else on the
	 * screen changes when it does.
	 */
	it('says plainly that nothing here saves the numbers, and claims no more than that', async () => {
		const { container } = await showing();

		expect(screen.getByText(/not saved anywhere/)).toBeDefined();
		expect(screen.getByText(/The host reads its own/)).toBeDefined();
		expect(container.textContent).not.toContain('no retention mechanism');
		expect(container.textContent).not.toContain('nothing on this host is sweeping');
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('animate-');
		expect(container.innerHTML).not.toContain('text-error');
	});

	/*
	 * **The pair is one rule with two bounds**, said once under both fields — and the `Keep` tick is
	 * named here because it is the exemption from both, which is the one thing a reader cannot work
	 * out from this screen alone.
	 */
	it('says which bound acts, and that a kept test is exempt from both', async () => {
		await showing();

		expect(screen.getByText(/reached first is the one that acts/)).toBeDefined();
		expect(screen.getByText(/is exempt from both/)).toBeDefined();
	});

	/*
	 * **An unfinished field says what is missing, and is not dressed as an error.** A cleared field
	 * is how a number is replaced; `error` is this palette's critical step and nothing has gone
	 * wrong (§5).
	 */
	it('asks for a whole number when a field is cleared, without colouring it', async () => {
		const { container } = await showing();

		fireEvent.change(disk(), { target: { value: '' } });

		expect(screen.getByText('Enter a whole number of MB above zero.')).toBeDefined();
		expect(container.innerHTML).not.toContain('text-error');
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
	});

	/*
	 * **The arrangement, which is a decision rather than a default.** The title is in the card's
	 * header strip the way every other card on this panel wears its own; the two notes say what the
	 * card is for and so are read *before* the numbers they are about; and a subtle rule separates
	 * what the card says from what it lets you set.
	 */
	it('puts its title in a strip, then the notes, then a rule, then the fields', async () => {
		const { container } = await showing();

		const strip = stripOf(container);
		expect(strip.querySelector('h2')?.textContent).toBe('Archive settings');
		expect(strip.className).toContain('bg-surface-container-high');

		// The order inside the body: two notes, the rule, then the grid holding both fields.
		const body = cardOf(container).children[1] as HTMLElement;
		const shape = [...body.children].map((child) => child.tagName);
		expect(shape).toEqual(['P', 'P', 'HR', 'DIV']);
		expect(body.querySelectorAll('div input')).toHaveLength(2);
	});

	/*
	 * **And no number of days is claimed anywhere.** The archive's own popover cannot say *in 14
	 * days* because the panel has no window to print (§9); this screen is where the window is
	 * *typed*, so the only digits on it are the two the reader can see in the fields.
	 */
	it('no longer says it is not built', async () => {
		const { container } = await showing();

		expect(container.textContent).not.toContain('Not built yet');
	});
});

/**
 * **What the archive already takes** (#260, R49, `docs/DESIGN.md` §13).
 *
 * §13 kept a *no current usage figure* row whose stated condition was an answer carrying the size;
 * `measure_archive` is that answer (#259), so the card that bounds the archive now says what it
 * holds. What is asserted here is the four things that entry's other half still forbids and the
 * three honesty rules the Archive screen's own badge already keeps.
 */
describe("the Archive settings card's archive total", () => {
	/*
	 * **In the strip, at the right end opposite the title** — the device card's anatomy, and where
	 * the Archive's own cards put the `Keep` tick (§9). It is the last thing in the strip and the
	 * strip is what pushes the two apart, so a badge that appeared beside the disk field — read as
	 * that field's value — would fail this rather than merely look different.
	 */
	it('draws the total in the header strip, opposite the title', async () => {
		const { container } = await showing();

		const strip = stripOf(container);
		expect(strip.lastElementChild).toBe(badgeOf(container));
		expect(strip.firstElementChild?.tagName).toBe('H2');
		expect(strip.className).toContain('justify-between');
	});

	/*
	 * **The same pill as the Archive header's badges, out of the same component.** Asserted against
	 * `BADGE_FRAME` itself rather than against a copy of its classes: a second class string for the
	 * same furniture is how the two screens start disagreeing about what a badge looks like, and a
	 * test that repeated the string would not notice.
	 */
	it('wears the header badge pill and not a second one', async () => {
		const { container } = await showing();

		expect(badgeOf(container)?.className).toContain(BADGE_FRAME);
	});

	/*
	 * **One fact, one sentence, one module.** The Archive screen says exactly this at its own root,
	 * over the same walk of the same directory, so the words come from `size-sentence.ts` rather
	 * than being written a second time here. The literal is asserted beside the call so that
	 * changing the wording in that module cannot silently change what this screen says.
	 */
	it("says it in the Archive root's own words", async () => {
		const { container } = await showing();

		expect(badgeOf(container)?.textContent).toBe('All tests take 7.7 MB on disk');
		expect(badgeOf(container)?.textContent).toBe(
			sizeSentence('archive', { status: 'measured', bytes: BYTES, truncated: false }),
		);
	});

	/*
	 * **One question, and it is the whole archive's.** Nothing on this screen lists the archive and
	 * nothing adds levels up in the browser: a total assembled here would grow as the host filed
	 * runs and be wrong at every point before the last (R49).
	 */
	it('asks the host once, for the whole archive', async () => {
		await showing();

		expect(host.asked).toEqual([{ method: 'measure_archive', params: { path: [] } }]);
	});

	/*
	 * **The unit steps by itself, and the field's does not follow it.** `formatBytes` is 1024-based
	 * and moves to `GB` above 1024 MB; the setting stays an integer count of megabytes because the
	 * host is handed a number rather than a unit to parse. Two units on one card is the trade §13
	 * takes, so it is asserted rather than tolerated.
	 */
	it('steps to GB while the field beside it stays a whole number of MB', async () => {
		const { container } = await showing({
			outcome: 'measured',
			bytes: 1_503_238_553,
			truncated: false,
		});

		expect(badgeOf(container)?.textContent).toBe('All tests take 1.4 GB on disk');
		expect(disk().value).toBe(String(DEFAULT_DISK_BUDGET_MB));
	});

	/*
	 * **It never compares itself against the field.** No `X of Y`, no percentage, no *over budget*
	 * word or colour: the number in that field is a draft nobody has saved, so a comparison would
	 * present a typed-in figure as the budget the sweep enforces. The sweep's own over-budget case
	 * is the sweep's, and it says so in the host's log (#238).
	 */
	it('states one number and compares it to nothing', async () => {
		const { container } = await showing();

		const said = badgeOf(container)?.textContent ?? '';
		expect(said).not.toMatch(/\bof\b/);
		expect(said).not.toContain('%');
		expect(said).not.toContain(String(DEFAULT_DISK_BUDGET_MB));
		expect(container.textContent?.toLowerCase()).not.toContain('over budget');
		expect(container.innerHTML).not.toContain('text-error');
	});

	/*
	 * **Absent rather than invented, while the host has not answered.** No placeholder figure, no
	 * `0`, no `—` — §9's *nothing is invented* rule, and the reason the first pass at the Archive's
	 * own badge was reverted rather than shipped.
	 */
	it('draws nothing at all while the answer is still out', async () => {
		const { container } = await showing(HANGS);

		expect(badgeOf(container)).toBeNull();
		expect(container.textContent).not.toContain('on disk');
		expect(container.textContent).not.toContain('—');
	});

	/*
	 * **And nothing rather than `0 B` where nothing is filed.** `0 B` is a true claim about an empty
	 * directory, and *there is nothing at this address* is not that claim (D6).
	 */
	it('draws nothing rather than a zero where nothing is filed', async () => {
		const { container } = await showing({ outcome: 'missing' });

		expect(badgeOf(container)).toBeNull();
		expect(container.textContent).not.toContain('0 B');
	});

	/*
	 * **A bounded walk renders a lower bound and never a plain figure** — #259's rule, unchanged by
	 * this screen reading it.
	 */
	it('says at least where the walk was cut short', async () => {
		const { container } = await showing({ outcome: 'measured', bytes: BYTES, truncated: true });

		expect(badgeOf(container)?.textContent).toBe('All tests take at least 7.7 MB on disk');
	});

	/*
	 * **An unmeasurable size gets its own sentence, never `unknown` in the value slot** — which
	 * would produce *All tests take unknown on disk*, a sentence with a hole in it.
	 */
	it('says which fact is missing where the host could not measure', async () => {
		const { container } = await showing({ outcome: 'unreadable' });

		expect(badgeOf(container)?.textContent).toBe(
			'The host could not measure what all tests take on disk',
		);
		expect(container.textContent).not.toContain('unknown');
	});
});
