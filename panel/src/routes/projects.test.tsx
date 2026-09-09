import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * `archive.test.tsx`'s shape: a `Link` is a plain anchor, and `createRoute` is here because this
 * module builds one at import — as does `__root.tsx`, which it hangs off.
 */
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		children,
		...rest
	}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
	createRoute: (options: unknown) => ({ options }),
	createRootRoute: (options: unknown) => ({ options }),
	Outlet: () => null,
	useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
		select({ location: { pathname: '/projects' } }),
}));

/**
 * The host, driven through the real `useRegisteredProjects` and the real delete rather than a stub
 * of either, because half of what this screen does is ask once and never again — and the other half
 * is asking a second time on exactly one trigger.
 */
const { host } = vi.hoisted(() => ({
	host: {
		/** Every `call` this screen made, method and params. */
		calls: [] as unknown[][],
		/** What `list_projects` answers. Wrapped as a result envelope by default. */
		answer: { outcome: 'listed', projects: [] } as unknown,
		/** What the **second and later** `list_projects` answers, when a test scripts a re-read. */
		later: undefined as unknown,
		/** Answer the raw `HostAnswer` instead of wrapping — for a refusal or an error envelope. */
		raw: undefined as unknown,
		/** Accepts the request and never answers it — the state before the first answer. */
		hangs: false,
		/** What `delete_project` answers, and the raw form for a request that reached nothing. */
		deleted: { outcome: 'not-registered' } as unknown,
		deletedRaw: undefined as unknown,
		/** The two reads the confirmation makes as it opens (#259, #234) — never new methods. */
		size: { outcome: 'measured', bytes: 7_723_471, truncated: false } as unknown,
		kept: { outcome: 'listed', tests: [] } as unknown,
	},
}));
/*
 * The four methods this screen can reach, each answering out of `host`, and **the re-read is the
 * only one that depends on how often it has been asked**: the second `list_projects` answers
 * `host.later` when a test scripted one, which is what makes *the list is the host's second answer*
 * assertable rather than claimed.
 */
const { answerOf } = vi.hoisted(() => ({
	answerOf: (method: string, state: typeof host): unknown => {
		if (method === 'delete_project') {
			return state.deletedRaw ?? { ok: true, value: { type: 'result', result: state.deleted } };
		}
		if (method === 'measure_archive') {
			return { ok: true, value: { type: 'result', result: state.size } };
		}
		if (method === 'list_kept_tests') {
			return { ok: true, value: { type: 'result', result: state.kept } };
		}
		const asked = state.calls.filter(([called]) => called === 'list_projects').length;
		const value = asked > 1 && state.later !== undefined ? state.later : state.answer;
		return state.raw ?? { ok: true, value: { type: 'result', result: value } };
	},
}));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({
		state: {
			status: 'signed-in',
			identity: { identifier: 'karolina', displayName: 'Karolina Waldon' },
		},
		call: async (method: string, params: unknown) => {
			host.calls.push([method, params]);
			if (host.hangs) {
				return await new Promise(() => undefined);
			}
			return answerOf(method, host);
		},
	}),
}));

import { ProjectsScreen } from './projects.js';

function registered(project: string, overrides: Record<string, unknown> = {}) {
	return {
		kind: 'registered',
		project,
		apps: [],
		hasInstall: false,
		services: [],
		hasTeardown: false,
		...overrides,
	};
}

const CHECKOUT_WEB = registered('checkout-web', {
	apps: ['com.example.checkout', 'com.example.checkout.debug'],
	hasInstall: true,
	services: ['mock-payments', 'api'],
	hasTeardown: true,
});
const NOT_READABLE = { kind: 'unreadable', project: 'legacy-kiosk' };
const DECLARES_NOTHING = registered('rover-sandbox');

/**
 * The completion test's own root, and it is the host's own capture: one good registration, one
 * that declares nothing at all, and one whose hook file will not parse — with the broken one **in
 * the middle**, where the host's code-unit order puts it.
 */
const THREE = { outcome: 'listed', projects: [CHECKOUT_WEB, NOT_READABLE, DECLARES_NOTHING] };

async function showing(answer: unknown) {
	host.answer = answer;
	const rendered = render(<ProjectsScreen />);
	await act(async () => undefined);
	return rendered;
}

beforeEach(() => {
	host.calls = [];
	host.later = undefined;
	host.raw = undefined;
	host.hangs = false;
	host.deleted = { outcome: 'not-registered' };
	host.deletedRaw = undefined;
	host.size = { outcome: 'measured', bytes: 7_723_471, truncated: false };
	host.kept = { outcome: 'listed', tests: [] };
});

/** Every `list_projects` this screen has made — the re-read's own counter. */
function listReads(): number {
	return host.calls.filter(([method]) => method === 'list_projects').length;
}

/** The identifiers of the cards on screen, in the order they are drawn. */
function listed(container: HTMLElement): (string | null)[] {
	return Array.from(container.querySelectorAll('article')).map(
		(card) => card.querySelector('div > span:nth-of-type(2)')?.textContent ?? null,
	);
}

/**
 * Press one card's control, confirm, and let the answer land.
 *
 * The whole chain rather than a stub of any of it: the control's `actor`, the dialog's two reads,
 * `delete_project` itself, the outcome line and the re-read are one behaviour, and the parts of it
 * that could be got wrong are all in the joins.
 */
async function deleteFromTheCard(project: string): Promise<void> {
	fireEvent.click(screen.getByRole('button', { name: `Delete project ${project}` }));
	await act(async () => undefined);
	fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
	await act(async () => undefined);
}

/**
 * **The acceptance criteria's completion test, verbatim.** Against a projects root holding one good
 * registration, one that declares nothing at all, and one whose hook file will not parse, the
 * screen draws three cards a reader can tell apart.
 */
describe('what is registered on this host', () => {
	it('draws one card per registration, each one identifiable', async () => {
		const { container } = await showing(THREE);

		expect(container.querySelectorAll('article')).toHaveLength(3);
		expect(screen.getByText('checkout-web')).toBeDefined();
		expect(screen.getByText('legacy-kiosk')).toBeDefined();
		expect(screen.getByText('rover-sandbox')).toBeDefined();
	});

	// The list is the cards' one parent, so it is reached through a card rather than by class —
	// `devices.test.tsx`'s trick. It takes no measure of its own, so it ends where the header
	// above it ends (§4, #240).
	it('lets the list take the content box, so it ends where the header does', async () => {
		const { container } = await showing(THREE);

		const list = container.querySelector('article')?.parentElement as HTMLElement;
		expect(list.className).toContain('gap-(--gutter)');
		expect(list.className).not.toMatch(/\bmax-w-/);
	});

	it('carries the identifier, the apps, the services and both hooks for a full registration', async () => {
		await showing(THREE);

		expect(screen.getByText('com.example.checkout')).toBeDefined();
		expect(screen.getByText('com.example.checkout.debug')).toBeDefined();
		expect(screen.getByText('mock-payments')).toBeDefined();
		expect(screen.getByText('api')).toBeDefined();
		expect(screen.getAllByText('declared')).toHaveLength(2);
	});

	it('says where you are and describes the screen', async () => {
		await showing(THREE);

		expect(document.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toBe('Projects');
		expect(screen.getByText('Projects registered on this host.')).toBeDefined();
	});

	/*
	 * **The card order is the host's own** — code-unit ascending, from `src/daemon/list-projects.ts`
	 * — so a registration that will not parse sorts among the others. The panel does not re-sort,
	 * and `list_projects` takes no parameter, so there is no other ordering to ask for.
	 */
	it('keeps the host’s order, with the broken registration in the middle and not last', async () => {
		const { container } = await showing(THREE);

		// The identifier is the strip's second span — `last-child` until `Delete project` joined it
		// on the right, which is a fact about the control's position rather than about the order.
		const identifiers = Array.from(container.querySelectorAll('article')).map(
			(card) => card.querySelector('div > span:nth-of-type(2)')?.textContent,
		);
		expect(identifiers).toEqual(['checkout-web', 'legacy-kiosk', 'rover-sandbox']);
		expect(identifiers.at(-1)).not.toBe('legacy-kiosk');
	});

	/*
	 * **D6 on the card**, built like `archive.test.tsx`'s *the two states with nothing to browse*:
	 * a project that asks the host to do nothing is the common, correct case, and a registration
	 * the host cannot read must never render as one.
	 */
	it('does not let the two arms of a registration say the same thing', async () => {
		const { container } = await showing(THREE);
		const [, broken, nothing] = Array.from(container.querySelectorAll('article'));

		expect(nothing?.textContent).toContain('none declared');
		expect(nothing?.textContent).not.toContain('Configuration not readable');
		expect(broken?.textContent).toContain('Configuration not readable');
		expect(broken?.textContent).toContain('the file is there and the host cannot read it');
		expect(broken?.textContent).not.toContain('none declared');
	});

	// The five fields are everything the host answers, and `env` values and host paths are
	// structurally absent from the wire (D19) — so a sixth cannot appear without changing it first.
	it('draws exactly the five fields and no sixth', async () => {
		const { container } = await showing(THREE);
		const card = container.querySelector('article');

		expect(card?.querySelector('span')?.textContent).toBe('Project');
		expect(Array.from(card?.querySelectorAll('dt') ?? []).map((dt) => dt.textContent)).toEqual([
			'Apps',
			'Services',
			'Install',
			'Teardown',
		]);
		expect(container.textContent).not.toContain('cwd');
		expect(container.textContent).not.toContain('env');
		expect(container.textContent).not.toContain('npm');
	});
});

describe('the badge', () => {
	// It counts every registration the host answered, an unreadable one included: the file is
	// there, so it is a registration, and leaving it out would disagree with the cards below.
	it('counts every registration, the one that will not parse included', async () => {
		await showing(THREE);

		expect(screen.getByText('3 registered')).toBeDefined();
	});

	// `registered` does not pluralise, so there is no singular branch to get wrong.
	it('reads the same for one registration as for three', async () => {
		await showing({ outcome: 'listed', projects: [DECLARES_NOTHING] });

		expect(screen.getByText('1 registered')).toBeDefined();
	});

	/*
	 * Absent rather than `0 registered`, which would describe a set — `archive.tsx`'s rule and §7's
	 * for the held/free counter.
	 */
	it('goes rather than reading zero', async () => {
		for (const answer of [
			{ outcome: 'listed', projects: [] },
			{ outcome: 'missing' },
			{ outcome: 'unreadable' },
		]) {
			const { container, unmount } = await showing(answer);

			expect(container.textContent).not.toMatch(/\d+ registered/);
			unmount();
		}
	});
});

describe('nothing registered', () => {
	it('says what would change it, with no card and no badge', async () => {
		const { container } = await showing({ outcome: 'listed', projects: [] });

		expect(screen.getByText('No projects registered')).toBeDefined();
		expect(screen.getByText(/in its own directory on this host/)).toBeDefined();
		expect(container.querySelectorAll('article')).toHaveLength(0);
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	// §10's deliberate fold: a root that is not there is the ordinary state of a host whose
	// operator has not done a thing yet, and a reader has the same next step either way.
	it('says exactly the same for a root that is not there at all', async () => {
		const { container: empty, unmount } = await showing({ outcome: 'listed', projects: [] });
		const listedText = empty.textContent;
		unmount();

		const { container: missing } = await showing({ outcome: 'missing' });

		expect(missing.textContent).toBe(listedText);
	});

	it("takes §7's quiet panel rather than the banner's surface", async () => {
		const { container } = await showing({ outcome: 'listed', projects: [] });

		expect(container.querySelector('section > div')?.className).toContain(
			'bg-surface-container-lowest',
		);
	});
});

describe('the projects root cannot be read', () => {
	it('says so, and that it is not the same as nothing being registered', async () => {
		const { container } = await showing({ outcome: 'unreadable' });

		expect(screen.getByText('PROJECTS ROOT NOT READABLE')).toBeDefined();
		expect(screen.getByText(/registrations may well be here/)).toBeDefined();
		expect(container.querySelectorAll('article')).toHaveLength(0);
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	it("takes the banner's surface rather than the quiet panel's", async () => {
		const { container } = await showing({ outcome: 'unreadable' });

		expect(container.querySelector('section')?.className).toContain('bg-surface-variant');
	});

	/*
	 * The fold `device-list-provider.tsx` and `archive-levels.ts` both make: a daemon that answered
	 * something this panel cannot read has told it as much as one that answered nothing.
	 */
	it('says the same for an answer the panel cannot parse', async () => {
		await showing({ outcome: 'partially listed' });

		expect(screen.getByText('PROJECTS ROOT NOT READABLE')).toBeDefined();
	});

	it('says the same for a request nothing answered', async () => {
		host.raw = { ok: false, refusal: 'unanswered' };
		await showing({ outcome: 'listed', projects: [] });

		expect(screen.getByText('PROJECTS ROOT NOT READABLE')).toBeDefined();
	});
});

/**
 * **D6 at the root**, the pair `stale` draws on the device list and the Archive draws at its own
 * root: *nothing registered* and *the root cannot be read* must never render alike.
 */
describe('the two states with nothing to list', () => {
	it('do not say the same thing', async () => {
		const { unmount } = await showing({ outcome: 'listed', projects: [] });
		const empty = document.body.textContent ?? '';
		unmount();

		await showing({ outcome: 'unreadable' });
		const unreadable = document.body.textContent ?? '';

		expect(empty).toContain('No projects registered');
		expect(empty).not.toContain('PROJECTS ROOT NOT READABLE');
		expect(empty).not.toContain('registrations may well be here');
		expect(unreadable).toContain('PROJECTS ROOT NOT READABLE');
		expect(unreadable).not.toContain('No projects registered');
	});
});

describe('before the host has answered', () => {
	it('says it is reading, in one line and with no spinner', () => {
		host.hangs = true;
		const { container } = render(<ProjectsScreen />);

		expect(screen.getByText('Reading what is registered on this host.')).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
		expect(container.querySelectorAll('article')).toHaveLength(0);
		// It is not an empty projects root and must not read as one.
		expect(container.textContent).not.toContain('No projects registered');
	});
});

describe('what this screen asks the host, and what it never does', () => {
	/*
	 * One request, and only one — which pins the StrictMode guard, that the params are empty, and
	 * that nothing polls. `list_projects` takes no parameter at all, so there is no filter, no sort
	 * and no page for a control to set.
	 */
	it('asks `list_projects` once, with nothing in it', async () => {
		await showing(THREE);

		expect(host.calls).toEqual([['list_projects', {}]]);
	});

	/*
	 * **The screen asks one thing until it is asked to delete something** — this comment is
	 * rewritten in place, not replaced (#273). It said *still nothing on this screen writes*, which
	 * was true while the card's `Delete project` was wired to nothing. It is not true now: D31 was
	 * amended for the write that is a *removal* (D42), and the control asks.
	 *
	 * What is unchanged is everything the assertion below actually pins: **navigating to this screen
	 * asks `list_projects` and nothing else**, in every state, so nothing here polls and nothing
	 * writes on its own. A write happens only after an operator has pressed a control and confirmed
	 * a dialog, which the suites below drive.
	 *
	 * What the card carries is one control per registration and no other — no `Add`, no `Edit`, no
	 * overflow menu, no form control — and the cards are not links. A state with nothing to list
	 * carries nothing to press at all: there is no registration for a control to be about.
	 */
	it('asks the host one thing and writes nothing, in every state', async () => {
		for (const [answer, controls] of [
			[THREE, 3],
			[{ outcome: 'listed', projects: [] }, 0],
			[{ outcome: 'missing' }, 0],
			[{ outcome: 'unreadable' }, 0],
		] as const) {
			// Per iteration, not per test: the one-request claim below is about this render.
			host.calls = [];
			const { container, unmount } = await showing(answer);

			expect(container.querySelectorAll('button')).toHaveLength(controls);
			expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);
			expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
			expect(container.querySelectorAll('[disabled]')).toHaveLength(0);
			// The breadcrumb's one segment is where you are, so it is not a link either (§3).
			expect(container.querySelectorAll('a')).toHaveLength(0);
			expect(host.calls).toEqual([['list_projects', {}]]);
			unmount();
		}
	});

	// No refresh control and no retry: a registration changes when a person edits a file on the
	// host, and this screen makes no claim to see that happen (§10).
	it('offers no refresh and no retry anywhere', async () => {
		for (const answer of [THREE, { outcome: 'unreadable' }]) {
			const { container, unmount } = await showing(answer);

			expect(container.textContent?.toLowerCase()).not.toContain('refresh');
			expect(container.textContent?.toLowerCase()).not.toContain('retry');
			unmount();
		}
	});

	// The texture is confined to the navigation chrome (§5), which `app-shell.test.tsx` asserts for
	// the whole of `<main>`; the design's markup layers one in the badge and in every card header.
	it('carries no scanline inside the content', async () => {
		const { container } = await showing(THREE);

		expect(container.querySelectorAll('.scanline')).toHaveLength(0);
	});

	it('carries no looping animation in any state', async () => {
		for (const answer of [THREE, { outcome: 'listed', projects: [] }, { outcome: 'unreadable' }]) {
			const { container, unmount } = await showing(answer);

			expect(container.innerHTML).not.toContain('animate');
			unmount();
		}
	});
});

/**
 * **The four outcomes, said above the list, and no two of them alike** (D42, `docs/DESIGN.md` §7
 * and §10).
 *
 * This is the D6 pairing assertion this file already makes between its two empty states, applied to
 * the one action on the screen: four different pieces of news and four different next moves, so a
 * sentence that appeared in two of them would be one of them saying the wrong thing.
 */
describe('what a delete settles, said above the list', () => {
	const OUTCOMES = [
		[
			'deleted',
			{
				outcome: 'deleted',
				registration: 'removed',
				archive: 'removed',
				keptTests: 'removed',
				freedBytes: 7_723_471,
				keptTestsRemoved: 3,
			},
		],
		['not-registered', { outcome: 'not-registered' }],
		[
			'partial',
			{
				outcome: 'partial',
				registration: 'removed',
				archive: 'failed',
				keptTests: 'absent',
				freedBytes: 0,
				keptTestsRemoved: 0,
			},
		],
		['refused', { outcome: 'refused', reason: 'lease-live' }],
	] as const;

	/** The line above the list, or `''` when there is nothing to say. */
	function noticed(): string {
		return document.querySelector('div[aria-live="polite"] section p')?.textContent ?? '';
	}

	it.each(OUTCOMES)('says its own sentence for %s', async (_outcome, result) => {
		host.deleted = result;
		await showing(THREE);

		await deleteFromTheCard('checkout-web');

		// The identifier is in the line, because the card it was about may no longer be there.
		expect(noticed()).toContain('checkout-web');
		expect(noticed().length).toBeGreaterThan(0);
	});

	it('shares no phrase between any two of them', async () => {
		const said: string[] = [];
		for (const [, result] of OUTCOMES) {
			host.calls = [];
			host.deleted = result;
			const { unmount } = await showing(THREE);
			await deleteFromTheCard('checkout-web');
			said.push(noticed());
			unmount();
		}

		expect(said).toHaveLength(4);
		expect(new Set(said).size).toBe(4);
		// No sentence is a substring of another either, which is the sharper form of the same rule:
		// two lines that differ only by a clause would read as one piece of news with a footnote.
		for (const [at, one] of said.entries()) {
			for (const [other, two] of said.entries()) {
				if (at !== other) {
					expect(one).not.toContain(two);
				}
			}
		}
	});

	// A `deleted` says what it came to rather than that it worked, and the kept count is the number
	// D35's amendment exists to make sayable.
	it('says what a delete came to, in bytes and in kept tests', async () => {
		host.deleted = {
			outcome: 'deleted',
			registration: 'removed',
			archive: 'removed',
			keptTests: 'removed',
			freedBytes: 7_723_471,
			keptTestsRemoved: 3,
		};
		await showing(THREE);

		await deleteFromTheCard('checkout-web');

		expect(noticed()).toContain('7.4 MB');
		expect(noticed()).toContain('3 tests marked Keep');
	});

	// A `partial` names the half that stayed, because *look at this host’s log* is the next move
	// and which half is what makes it actionable.
	it('names the half a partial delete left behind', async () => {
		host.deleted = {
			outcome: 'partial',
			registration: 'removed',
			archive: 'failed',
			keptTests: 'absent',
			freedBytes: 0,
			keptTestsRemoved: 0,
		};
		await showing(THREE);

		await deleteFromTheCard('checkout-web');

		expect(noticed()).toContain('part of its archive is still there');
	});

	/*
	 * **It stays until dismissed**, rather than until something else replaces it (§7): this is the
	 * only place the panel explains why a confirmed action changed nothing, and the screen does not
	 * poll, so the dismiss control is the whole of how it goes.
	 */
	it('stays until it is dismissed, and carries no colour of alarm', async () => {
		host.deleted = { outcome: 'refused', reason: 'lease-live' };
		const { container } = await showing(THREE);
		await deleteFromTheCard('checkout-web');

		const region = container.querySelector('div[aria-live="polite"]');
		expect(region?.textContent).toContain('checkout-web');
		expect(region?.innerHTML).not.toContain('error');

		fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

		expect(noticed()).toBe('');
	});

	// Above the list rather than on a card: the card is gone from the next answer for two of the
	// four, and a line inside the branch that just emptied would go with it.
	it('lives above the list, and survives the list becoming empty', async () => {
		host.deleted = {
			outcome: 'deleted',
			registration: 'removed',
			archive: 'removed',
			keptTests: 'absent',
			freedBytes: 412_306,
			keptTestsRemoved: 0,
		};
		host.later = { outcome: 'listed', projects: [] };
		const { container } = await showing({ outcome: 'listed', projects: [CHECKOUT_WEB] });

		await deleteFromTheCard('checkout-web');

		expect(container.querySelectorAll('article')).toHaveLength(0);
		expect(screen.getByText('No projects registered')).toBeDefined();
		expect(noticed()).toContain('checkout-web');
	});
});

/**
 * **The screen re-reads rather than assuming** (§10) — the acceptance criterion this suite exists
 * for.
 *
 * The list after a settled delete is `list_projects`’ answer again, never the panel’s own edit of
 * what it had. The sharpest way to pin that is a second answer the panel could not have produced by
 * filtering the first.
 */
describe('the list after a settled delete', () => {
	it('is the host’s second answer, not a locally filtered first one', async () => {
		host.deleted = {
			outcome: 'deleted',
			registration: 'removed',
			archive: 'removed',
			keptTests: 'absent',
			freedBytes: 412_306,
			keptTestsRemoved: 0,
		};
		/*
		 * The host answers a list that still holds the deleted identifier and holds one the first
		 * answer never mentioned. Neither is something a filter of the first list could produce, so
		 * this assertion fails for any implementation that edits what it had.
		 */
		host.later = {
			outcome: 'listed',
			projects: [CHECKOUT_WEB, registered('newly-registered')],
		};
		const { container } = await showing(THREE);

		await deleteFromTheCard('rover-sandbox');

		expect(listReads()).toBe(2);
		expect(listed(container)).toEqual(['checkout-web', 'newly-registered']);
	});

	it.each([
		[
			'deleted',
			{
				outcome: 'deleted',
				registration: 'removed',
				archive: 'absent',
				keptTests: 'absent',
				freedBytes: 0,
				keptTestsRemoved: 0,
			},
		],
		['not-registered', { outcome: 'not-registered' }],
		[
			'partial',
			{
				outcome: 'partial',
				registration: 'failed',
				archive: 'removed',
				keptTests: 'absent',
				freedBytes: 412_306,
				keptTestsRemoved: 0,
			},
		],
	])('reads again on %s', async (_outcome, result) => {
		host.deleted = result;
		await showing(THREE);

		await deleteFromTheCard('checkout-web');

		expect(listReads()).toBe(2);
	});

	/*
	 * **A refusal does not re-read**, and that is not an inconsistency: a live lease means nothing
	 * at all was touched, so what is registered is exactly what the list already says and a second
	 * `list_projects` would ask the host a question whose answer the screen is holding.
	 */
	it('does not read again on a refusal, because nothing was touched', async () => {
		host.deleted = { outcome: 'refused', reason: 'lease-live' };
		const { container } = await showing(THREE);

		await deleteFromTheCard('checkout-web');

		expect(listReads()).toBe(1);
		expect(listed(container)).toEqual(['checkout-web', 'legacy-kiosk', 'rover-sandbox']);
	});

	/*
	 * A re-read that answers `unreadable` replaces the list, which is the host’s answer and correct
	 * — and the outcome line is still there to say what happened before it.
	 */
	it('lets the second answer be `unreadable`, and keeps the line above it', async () => {
		host.deleted = {
			outcome: 'deleted',
			registration: 'removed',
			archive: 'removed',
			keptTests: 'absent',
			freedBytes: 412_306,
			keptTestsRemoved: 0,
		};
		host.later = { outcome: 'unreadable' };
		const { container } = await showing(THREE);

		await deleteFromTheCard('checkout-web');

		expect(screen.getByText('PROJECTS ROOT NOT READABLE')).toBeDefined();
		expect(container.querySelectorAll('article')).toHaveLength(0);
		expect(container.querySelector('div[aria-live="polite"]')?.textContent).toContain(
			'checkout-web',
		);
	});
});

/**
 * **A request that reached nothing is not an outcome** (§7’s fourth case). Nothing was deleted, so
 * the dialog stays open with the control usable again, the list is untouched, and the panel reports
 * nothing above it.
 */
describe('the delete that reached nothing', () => {
	it.each([
		['a host that answered nothing at all', { ok: false, refusal: 'unanswered' }],
		[
			'an error envelope',
			{ ok: true, value: { type: 'error', error: { code: 'internal', message: 'no' } } },
		],
		[
			'a result the panel cannot read',
			{ ok: true, value: { type: 'result', result: { gone: 1 } } },
		],
	])('leaves the list untouched and says nothing above it, for %s', async (_case, raw) => {
		host.deletedRaw = raw;
		const { container } = await showing(THREE);

		await deleteFromTheCard('checkout-web');

		expect(listReads()).toBe(1);
		expect(listed(container)).toEqual(['checkout-web', 'legacy-kiosk', 'rover-sandbox']);
		expect(container.querySelector('div[aria-live="polite"]')?.textContent).toBe('');
		// It stays in the dialog, which stays open with the control usable again.
		expect(screen.getByRole('dialog').textContent).toContain('nothing was deleted');
		expect(
			screen.getByRole('button', { name: 'Delete project' }).getAttribute('disabled'),
		).toBeNull();
	});

	/*
	 * The host refused the session instead. `Session.call` has already fired the bounce and the
	 * router is coming down, so the screen says nothing at all — a line about a project would be
	 * the panel’s last word being the wrong one.
	 */
	it('says nothing and reads nothing again when the session itself was refused', async () => {
		host.deletedRaw = { ok: false, refusal: 'refused' };
		const { container } = await showing(THREE);

		await deleteFromTheCard('checkout-web');

		expect(listReads()).toBe(1);
		expect(container.querySelector('div[aria-live="polite"]')?.textContent).toBe('');
	});
});

/**
 * **No host read was added for the confirmation** (§10): the two numbers come off `measure_archive`
 * and `list_kept_tests`, both already on `PANEL_METHODS` for other screens, and the write is
 * attributed to the signed-in user (D20, D28).
 */
describe('what the confirmation asks the host', () => {
	it('asks only the two reads the panel already had, and only when it opens', async () => {
		await showing(THREE);
		expect(host.calls.map(([method]) => method)).toEqual(['list_projects']);

		fireEvent.click(screen.getByRole('button', { name: 'Delete project checkout-web' }));
		await act(async () => undefined);

		expect(host.calls.map(([method]) => method)).toEqual([
			'list_projects',
			'measure_archive',
			'list_kept_tests',
		]);
	});

	it('attributes the delete to the signed-in user and names the project by identifier', async () => {
		await showing(THREE);

		await deleteFromTheCard('legacy-kiosk');

		expect(host.calls).toContainEqual([
			'delete_project',
			{ project: 'legacy-kiosk', actor: 'karolina' },
		]);
	});
});
