import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * `devices.test.tsx`'s shape: a `Link` is a plain anchor and `createRoute` is here because this
 * module builds two at import. `useParams` is what puts the screen at a level — the path is the
 * whole of this screen's state, so one test is one address.
 */
const { at } = vi.hoisted(() => ({ at: { splat: undefined as string | undefined } }));
vi.mock('@tanstack/react-router', () => ({
	/*
	 * It keeps the one half of the real `Link` a row's click depends on (#198): the real one calls
	 * `preventDefault` and routes instead, so the anchor's `onClick` — the open set's toggle — runs
	 * without jsdom being asked to navigate. Nothing here moves `useParams`, so a click in this file
	 * toggles a branch and leaves the address where the test put it, which is what isolates the open
	 * set from the selection.
	 */
	Link: ({
		to,
		params,
		children,
		onClick,
		...rest
	}: {
		to: string;
		params?: { _splat?: string };
		children: ReactNode;
	} & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a
			href={`${to.replace('$', '')}${params?._splat ?? ''}`}
			onClick={(event) => {
				event.preventDefault();
				onClick?.(event);
			}}
			{...rest}
		>
			{children}
		</a>
	),
	createRoute: (options: unknown) => ({ options }),
	// `__root.tsx` builds one at import too, because this module imports the route it hangs off.
	createRootRoute: (options: unknown) => ({ options }),
	Outlet: () => null,
	useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
		select({ location: { pathname: '/archive' } }),
	useParams: () => ({ _splat: at.splat }),
}));

/**
 * The host, one answer per level. Driven through the real `useArchiveLevels` rather than a stub of
 * it, because half of what this screen does is decide which levels to ask for.
 */
const { host, HANGS } = vi.hoisted(() => ({
	/**
	 * One level's answer, when what the test needs is *no* answer for that level alone. The levels
	 * are independent round trips, so which one has come back is half of what this screen renders.
	 */
	HANGS: '__hangs__',
	host: {
		answers: new Map<string, unknown>(),
		asked: [] as unknown[],
		/** Every file the byte route was asked for — two per run since #148. */
		files: [] as unknown[],
		/** The archived file's own bytes, or the outcome the host answered instead. */
		file: { outcome: 'missing' } as unknown,
		/**
		 * One answer for one file name, when a test needs the run's two files answered differently
		 * — the device card's `device_info.json` and the identity card's `test_description.json`
		 * (#136, #148). Anything not named here falls back to {@link host.file}.
		 */
		fileByName: {} as Record<string, unknown>,
		/** Every artifact the byte route was asked for as bytes — the preview's own request (#133). */
		artifacts: [] as unknown[],
		/** What the byte route answers for an artifact, media type included. */
		artifact: { outcome: 'missing' } as unknown,
		/**
		 * One answer per artifact **file name**, for the comparison card — N panes each read their
		 * own address, and which pane drew what is half of what is worth asserting (#199). Anything
		 * not named here falls back to {@link host.artifact}.
		 */
		artifactByName: {} as Record<string, unknown>,
		/** Every text `search_archive` was asked about — one per settled text, never per keystroke. */
		searches: [] as unknown[],
		/** What the host answers a search with. */
		search: { outcome: 'searched', matches: [], truncated: false } as unknown,
		/**
		 * How many times `list_archive_groups` was asked (#181) — counted rather than logged,
		 * because it takes no parameter and what is worth asserting is *once, and only in the view
		 * that reads it*.
		 */
		groupings: 0,
		/** What the host answers the grouping walk with. */
		groups: { outcome: 'listed', groups: [], truncated: false } as unknown,
		/**
		 * A gate the grouping walk waits behind, so one case can watch this screen while the walk is
		 * still out and again once it answers — the deep-link case the comparison card has (#199).
		 */
		groupsGate: null as null | Promise<void>,
		/** Accepts every request and never answers it — the state before the first answer. */
		hangs: false,
	},
}));
vi.mock('@panel/session/session-provider.js', () => {
	/** One level's listing, logged as asked for. */
	const listing = async (path: readonly string[]) => {
		host.asked.push(path);
		if (host.hangs) {
			return await new Promise(() => undefined);
		}
		const answer = host.answers.get(JSON.stringify(path));
		if (answer === HANGS) {
			return await new Promise(() => undefined);
		}
		return answer === undefined
			? { ok: true, value: { type: 'result', result: { outcome: 'missing' } } }
			: { ok: true, value: { type: 'result', result: answer } };
	};
	/** One search of the whole archive, logged apart — see `call` below. */
	const search = async (text: string | undefined) => {
		host.searches.push(text);
		if (host.hangs) {
			return await new Promise(() => undefined);
		}
		return { ok: true, value: { type: 'result', result: host.search } };
	};
	/** The one grouping walk, counted apart for the same reason (#181). */
	const grouping = async () => {
		host.groupings += 1;
		if (host.hangs || host.groups === HANGS) {
			return await new Promise(() => undefined);
		}
		if (host.groupsGate !== null) {
			await host.groupsGate;
		}
		return { ok: true, value: { type: 'result', result: host.groups } };
	};

	return {
		useSession: () => ({
			/*
			 * Three methods now (#146, #181), so this reads `method` rather than assuming a listing:
			 * the tree card's field asks `search_archive` and the groups view asks
			 * `list_archive_groups`. *Searching issues no extra `list_archive`*, and *the groups
			 * view lists nothing above a run*, are assertable only because the three are logged
			 * apart.
			 */
			call: async (method: string, params: { path: readonly string[]; text?: string }) => {
				if (method === 'search_archive') {
					return await search(params.text);
				}
				if (method === 'list_archive_groups') {
					return await grouping();
				}
				return await listing(params.path);
			},
			readArtifactText: async (path: readonly string[]) => {
				host.files.push(path);
				if (host.hangs) {
					return await new Promise(() => undefined);
				}
				return { ok: true, value: host.fileByName[path.at(-1) ?? ''] ?? host.file };
			},
			readArtifactBytes: async (path: readonly string[]) => {
				host.artifacts.push(path);
				if (host.hangs) {
					return await new Promise(() => undefined);
				}
				return { ok: true, value: host.artifactByName[path.at(-1) ?? ''] ?? host.artifact };
			},
		}),
	};
});

import { SEARCH_DEBOUNCE_MS } from '@panel/archive/archive-search.js';
import { ArchiveScreen } from './archive.js';

function directory(name: string, childCount: number | null = 3, onlyChild: string | null = null) {
	return { kind: 'directory', name, childCount, onlyChild };
}

function listed(...entries: readonly unknown[]) {
	return { outcome: 'listed', entries };
}

const RUN = '20260830T170501Z-issue-112-9f1c2ab4';
/** The run filed the day before, and the one the host's own ascending order puts first. */
const OLDER = '20260829T142201Z-issue-112-4b0e7c15';

/** The archive every test below browses, unless it replaces a level. */
function archive(): Record<string, unknown> {
	return {
		'[]': listed(directory('checkout-app'), directory('payments-web')),
		'["checkout-app"]': listed(directory('login-flow', 42), directory('unlabeled', 1)),
		// The host's own order: ascending code-unit over names that lead with a UTC timestamp, so
		// oldest first (`src/daemon/list-archive.ts`). Both panes reverse it, and neither invents it.
		'["checkout-app","login-flow"]': listed(
			directory(OLDER, 1, 'emulator-5554'),
			directory(RUN, 1, 'R5CT30ABCDE'),
		),
		'["checkout-app","login-flow","20260830T170501Z-issue-112-9f1c2ab4","R5CT30ABCDE"]': listed(
			{ kind: 'file', name: 'device_info.json', sizeBytes: 80 },
			directory('screenshots', 3),
		),
	};
}

async function showing(splat: string | undefined, levels: Record<string, unknown> = archive()) {
	at.splat = splat;
	host.answers = new Map(Object.entries(levels));
	const rendered = render(<ArchiveScreen view="all" />);
	// The levels settle over as many microtask turns as there are levels to fetch, because each is
	// asked for only once the one above it has answered.
	for (let turn = 0; turn < 6; turn += 1) {
		await act(async () => undefined);
	}
	return rendered;
}

/** The testing group the archive above is arranged by, and a second one under the same project. */
const GROUP = 'app-bar-top-space';
const OTHER_GROUP = 'basket-total';
const SERIAL = 'R5CT30ABCDE';

/**
 * One run of a group, as the answer carries it — **and its labelled artifacts, when a case has
 * any** (#199). Every existing case passes none, so nothing above the comparison card changes.
 */
function groupRun(
	testName: string,
	run: string,
	serial = SERIAL,
	labels: Readonly<Record<string, string>> = {},
) {
	const path = ['checkout-app', testName, run, serial];
	return {
		path,
		artifacts: Object.entries(labels).map(([name, label]) => ({
			path: [...path, 'screenshots', name],
			label,
		})),
	};
}

/**
 * The grouping answer the cases below arrange — **over exactly the archive above**, so what is in
 * one view and not the other is a fact about the same host rather than about two fixtures.
 *
 * `payments-web` has no grouped run and `unlabeled` names no group, so neither may be drawn here;
 * both are still in the `All` view, which is what makes their absence an arrangement rather than a
 * disappearance.
 */
function groupings(): unknown {
	return {
		outcome: 'listed',
		truncated: false,
		groups: [
			{
				project: 'checkout-app',
				groupId: GROUP,
				// The host's own ascending order, oldest first — reversed by whoever draws it.
				runs: [groupRun('login-flow', OLDER, 'emulator-5554'), groupRun('login-flow', RUN)],
			},
			{ project: 'checkout-app', groupId: OTHER_GROUP, runs: [groupRun('basket', RUN)] },
		],
	};
}

/** The same, in the groups view — one splat on `/groups/$`, and one grouping answer. */
async function grouped(splat: string | undefined, levels: Record<string, unknown> = archive()) {
	at.splat = splat;
	host.answers = new Map(Object.entries(levels));
	const rendered = render(<ArchiveScreen view="groups" />);
	for (let turn = 0; turn < 6; turn += 1) {
		await act(async () => undefined);
	}
	return rendered;
}

/** The tree card's rows, in the order they are drawn — the one pane a level's arrangement is in. */
function treeRows(): readonly (string | null)[] {
	const tree = document.querySelector('aside');
	return [...(tree?.querySelectorAll('a') ?? [])].map((row) => row.textContent);
}

/** The contents card's rows, in the order they are drawn — the other pane the same level is in. */
function cardRows(container: HTMLElement): readonly (string | null)[] {
	const card = container.querySelector('div.xl\\:flex-row > section');
	return [...(card?.querySelectorAll('li') ?? [])].map((row) => row.textContent);
}

/**
 * Queries scoped to the **one card** beside the tree — a level's own listing, the run's column, the
 * preview, or the quiet line for an address nobody has answered for (#160).
 *
 * The tree reaches every address in the archive now (#159) and it and a card that lists a level name
 * the same entries, so a bare `getByText` for one of those names finds it twice. Only the tree's is
 * a `link` since #161 — the card's rows are read-only — and scoping is what says which pane a case
 * is about rather than relying on that.
 */
function besideTheTree(container: HTMLElement) {
	const card = container.querySelector('div.xl\\:flex-row > section');
	if (card === null) {
		throw new Error('no card is drawn beside the tree');
	}
	return within(card as HTMLElement);
}

/**
 * The content area — whatever the screen draws directly below its header.
 *
 * The header is chrome: the breadcrumb, the describing line, the badge, and the view toggle since
 * #165. A state's claim to offer *no control* is a claim about the content area, so the assertions
 * that check for one say so rather than counting every button on the screen.
 */
function contentArea(container: HTMLElement) {
	const content = container.querySelector('header + *');
	if (content === null) {
		throw new Error('the screen drew nothing below its header');
	}
	return content as HTMLElement;
}

beforeEach(() => {
	host.asked = [];
	host.files = [];
	host.artifacts = [];
	host.searches = [];
	host.search = { outcome: 'searched', matches: [], truncated: false };
	host.groupings = 0;
	host.groups = groupings();
	host.file = { outcome: 'missing' };
	host.fileByName = {};
	host.artifact = { outcome: 'missing' };
	host.artifactByName = {};
	host.groupsGate = null;
	host.hangs = false;
});

describe('each level', () => {
	it('describes itself, counts what it lists, and says where you are', async () => {
		await showing(undefined);

		expect(screen.getByText('Projects with runs filed on this host.')).toBeDefined();
		expect(screen.getByText('2 projects archived')).toBeDefined();
		// At the root the trail is one segment, and where you are is not a link (§3).
		expect(document.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toBe('Archive');
	});

	it('describes a project and counts its test names', async () => {
		await showing('checkout-app');

		expect(screen.getByText('Tests recorded under this project.')).toBeDefined();
		expect(screen.getByText('2 tests archived')).toBeDefined();
	});

	it('describes a test name and counts its runs, most recent first', async () => {
		await showing('checkout-app/login-flow');

		expect(screen.getByText('Runs filed under this test name, most recent first.')).toBeDefined();
		expect(screen.getByText('2 runs archived')).toBeDefined();
	});

	// The badge is the one number for whatever is selected, and a run is not a count of anything.
	it('describes a run and shows no badge at all', async () => {
		const { container } = await showing(`checkout-app/login-flow/${RUN}`);

		expect(
			screen.getByText('Everything this lease wrote; nothing is added once it ends.'),
		).toBeDefined();
		expect(container.textContent).not.toContain('archived');
		expect(screen.getByText('R5CT30ABCDE')).toBeDefined();
	});

	it('counts in the singular at one', async () => {
		await showing('checkout-app', { ...archive(), '["checkout-app"]': listed(directory('x', 1)) });

		expect(screen.getByText('1 test archived')).toBeDefined();
	});
});

/*
 * **The whole of *lazily, one `readdir` at a time*.** The levels asked for are the prefixes of the
 * selected path, plus the one the run's `<serial>` names — never a sibling, and never a walk.
 */
describe('what the screen asks the host for', () => {
	it('asks for the prefixes of the selected path and nothing else', async () => {
		await showing('checkout-app/login-flow');

		expect(host.asked).toEqual([[], ['checkout-app'], ['checkout-app', 'login-flow']]);
	});

	it('asks for the root alone at the root', async () => {
		await showing(undefined);

		expect(host.asked).toEqual([[]]);
	});

	// The serial is read off the level above rather than asked for, so a selected run costs four
	// requests and not five.
	it('asks for the run contents by the serial the level above named', async () => {
		await showing(`checkout-app/login-flow/${RUN}`);

		expect(host.asked).toEqual([
			[],
			['checkout-app'],
			['checkout-app', 'login-flow'],
			['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE'],
		]);
	});

	/*
	 * The one file the screen reads the contents of (#136). It is addressed inside the level the
	 * listing answered — never a path this screen composed — and it is one request, not a listing.
	 */
	it('reads the run own two files out of that same level, once each', async () => {
		await showing(`checkout-app/login-flow/${RUN}`);

		expect(host.files).toEqual([
			['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE', 'device_info.json'],
			['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE', 'test_description.json'],
		]);
	});

	// No serial, no address: a file is not fetched on a guess any more than a level is listed on one.
	it('reads no file at all for a run whose level above named no serial', async () => {
		await showing(`checkout-app/login-flow/${RUN}`, {
			...archive(),
			'["checkout-app","login-flow"]': listed(directory(RUN, 2, null)),
		});

		expect(host.files).toEqual([]);
	});

	it('reads no file at a level that is not a run', async () => {
		await showing('checkout-app/login-flow');

		expect(host.files).toEqual([]);
	});
});

/**
 * **Opening a node closes nothing, and costs exactly the level it draws** (#198).
 *
 * These are the only cases in this file that click a **row** rather than render an address: what is
 * under test is the open set, which the mocked `useParams` deliberately leaves the address out of —
 * so a click here toggles a branch and the selection stays where the test put it, which is what
 * isolates the two halves of one gesture. Where the click *goes* is asserted through the `href` of
 * every row, and the toggle's own rule in `panel/src/archive/open-branches.test.ts`.
 */
describe('opening a second branch', () => {
	/** A second project with a level of its own, so both branches have something to draw. */
	function twoProjects(): Record<string, unknown> {
		return { ...archive(), '["payments-web"]': listed(directory('refund-flow', 2)) };
	}

	/** One row of the tree, clicked the way a reader clicks it — and settled afterwards. */
	async function clickRow(name: string) {
		const tree = document.querySelector('aside') as HTMLElement;
		fireEvent.click(within(tree).getByRole('link', { name }));
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}
	}

	// AC 1, at the top level: the first branch is still open, all of it, and the second is open
	// beside it. Under the derived rule this was unreachable — one selection is one path.
	it('leaves the first branch open, at the root', async () => {
		await showing(undefined, twoProjects());

		await clickRow('checkout-app');
		await clickRow('payments-web');

		expect(treeRows()).toEqual([
			'checkout-app',
			'login-flow',
			'unlabeled',
			'payments-web',
			'refund-flow',
		]);
	});

	// AC 6: one `list_archive` per level actually drawn — the root, then exactly one per click, in
	// the order they were opened, and nothing for a level nobody opened.
	it('asks for exactly the level each click draws', async () => {
		await showing(undefined, twoProjects());
		expect(host.asked).toEqual([[]]);

		await clickRow('checkout-app');
		expect(host.asked).toEqual([[], ['checkout-app']]);

		await clickRow('payments-web');
		expect(host.asked).toEqual([[], ['checkout-app'], ['payments-web']]);
	});

	// And closing reads nothing: a second click on an open row takes its level off the screen, and
	// nothing under it is asked for again when it comes back.
	it('reads nothing when a branch closes, or when it opens again', async () => {
		await showing(undefined, twoProjects());
		await clickRow('checkout-app');
		await clickRow('payments-web');

		await clickRow('checkout-app');
		expect(treeRows()).toEqual(['checkout-app', 'payments-web', 'refund-flow']);
		expect(host.asked).toEqual([[], ['checkout-app'], ['payments-web']]);

		await clickRow('checkout-app');
		expect(treeRows()).toEqual([
			'checkout-app',
			'login-flow',
			'unlabeled',
			'payments-web',
			'refund-flow',
		]);
		expect(host.asked).toEqual([[], ['checkout-app'], ['payments-web']]);
	});

	/**
	 * **The same, for a branch the reader never clicked open** (#202 review) — and the one case in
	 * this file that lets the address move with the click, because that is the whole of the defect:
	 * a branch drawn open by the floor alone falls the moment the selection leaves it.
	 *
	 * Search, follow a hit, clear the field, open a second project. Nothing in that sequence clicks a
	 * row of the branch being read, so the set holds none of it until the screen absorbs the floor
	 * (`open-branches.ts`, `absorbing`).
	 */
	it('keeps a branch reached by a search hit open when a second project is opened', async () => {
		const SERIAL_LEVEL = ['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE'];
		const HIT = [...SERIAL_LEVEL, 'screenshots'];
		vi.useFakeTimers();
		try {
			host.search = {
				outcome: 'searched',
				truncated: false,
				matches: [{ path: HIT, kind: 'directory' }],
			};
			const { rerender } = await showing(undefined, {
				...twoProjects(),
				[JSON.stringify(HIT)]: listed({ kind: 'file', name: 'a.png', sizeBytes: 4 }),
			});
			const search = screen.getByRole('textbox') as HTMLInputElement;

			const type = async (text: string) => {
				fireEvent.change(search, { target: { value: text } });
				await act(async () => {
					await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
					await vi.advanceTimersByTimeAsync(0);
				});
			};
			await type('screenshots');
			// Following the hit: `Hits` carries no toggle, so this moves the address and nothing else.
			at.splat = HIT.join('/');
			await act(async () => {
				rerender(<ArchiveScreen view="all" />);
			});
			for (let turn = 0; turn < 6; turn += 1) {
				await act(async () => undefined);
			}
			await type('');
			const readSoFar = [...host.asked];

			// And now the gesture the issue is about, with the address following it this time.
			const tree = document.querySelector('aside') as HTMLElement;
			fireEvent.click(within(tree).getByRole('link', { name: 'payments-web' }));
			at.splat = 'payments-web';
			await act(async () => {
				rerender(<ArchiveScreen view="all" />);
			});
			for (let turn = 0; turn < 6; turn += 1) {
				await act(async () => undefined);
			}

			// The branch the reader was reading is still there, all the way down to the hit's own row.
			expect(treeRows()).toEqual([
				'checkout-app',
				'login-flow',
				RUN,
				// The run's own contents, artifacts first — `level-order.ts`, and the same order
				// wherever this level is drawn (#208).
				'screenshots',
				'device_info.json',
				OLDER,
				'unlabeled',
				'payments-web',
				'refund-flow',
			]);
			// One click, one level: nothing already read is read again.
			expect(host.asked).toEqual([...readSoFar, ['payments-web']]);
		} finally {
			vi.useRealTimers();
		}
	});

	/*
	 * **Both views draw one tree, so this is not a view's choice** (AC 2, #181). The groups view's
	 * rows come from the grouping answer above a run, and two groups under one project open beside
	 * each other exactly as two projects do — with no `list_archive` at all, because no level of that
	 * arrangement is a listing.
	 */
	it('does the same in the groups view, over the same open set', async () => {
		await grouped('checkout-app');

		await clickRow(GROUP);
		await clickRow(OTHER_GROUP);

		expect(treeRows()).toEqual(['checkout-app', GROUP, 'login-flow', OTHER_GROUP, 'basket']);
		expect(host.asked).toEqual([]);
	});
});

/**
 * The run's device card end to end: the archive's own file, off the byte route, onto the six fields
 * the design settles (#136, `docs/DESIGN.md` §9).
 */
describe('the device a run was recorded on', () => {
	const DEVICE_INFO = {
		outcome: 'read',
		text: JSON.stringify({
			serial: 'R5CT30ABCDE',
			platform: 'android',
			model: 'SM-G991B',
			screen: {
				widthPx: 1080,
				heightPx: 2400,
				density: 420,
				densityScale: 2.625,
				widthDp: 411.42857142857144,
				heightDp: 914.2857142857143,
			},
			osVersion: '14',
			osApiLevel: 34,
		}),
	};

	it('reads its facts out of the run own file', async () => {
		host.file = DEVICE_INFO;

		await showing(`checkout-app/login-flow/${RUN}`);

		expect(screen.getByText('DEVICE — FROM device_info.json')).toBeDefined();
		expect(screen.getByText('SM-G991B')).toBeDefined();
		expect(screen.getByText('android')).toBeDefined();
		expect(screen.getByText('34')).toBeDefined();
		expect(screen.getByText('2.625x — 411 x 914 dp')).toBeDefined();
	});

	it('says a file that is not there is not there, without alarm', async () => {
		const { container } = await showing(`checkout-app/login-flow/${RUN}`);

		expect(screen.getByText(/No device_info.json is filed for this run/)).toBeDefined();
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
		expect(container.textContent).not.toContain('Rover cannot read this run');
	});

	it('says a file it cannot read differently again', async () => {
		host.file = { outcome: 'unreadable' };

		const { container } = await showing(`checkout-app/login-flow/${RUN}`);

		expect(screen.getByText(/Rover cannot read this run's device_info.json/)).toBeDefined();
		expect(container.textContent).not.toContain('No device_info.json is filed');
	});
});

/**
 * The run's own description end to end: the archive's second file, off the same byte route, onto the
 * identity card's `DESCRIPTION` field (#148, `docs/DESIGN.md` §9).
 *
 * The two files are scripted separately here, because a run whose device card reads and whose
 * description does not is the ordinary state of every run filed before the field existed.
 */
describe('what the lease said the run was about', () => {
	const DESCRIBED = {
		outcome: 'read',
		text: JSON.stringify({
			testDescription: 'Checks the login form still fits above the keyboard on a short screen.',
		}),
	};

	it('reads the sentence the lease filed with the run', async () => {
		host.fileByName = { 'test_description.json': DESCRIBED };

		await showing(`checkout-app/login-flow/${RUN}`);

		expect(screen.getByText('DESCRIPTION')).toBeDefined();
		expect(
			screen.getByText('Checks the login form still fits above the keyboard on a short screen.'),
		).toBeDefined();
	});

	// The default answer for both files is `missing`, which is a run that described nothing.
	it('says none is filed, without alarm and not in the unreadable words', async () => {
		const { container } = await showing(`checkout-app/login-flow/${RUN}`);

		expect(screen.getByText('none filed')).toBeDefined();
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
		expect(container.textContent).not.toContain('not readable');
	});

	it('says a description it cannot read differently again', async () => {
		host.fileByName = { 'test_description.json': { outcome: 'unreadable' } };

		const { container } = await showing(`checkout-app/login-flow/${RUN}`);

		expect(screen.getByText('not readable')).toBeDefined();
		expect(container.textContent).not.toContain('none filed');
		// And the device card is unaffected: two files, two answers, one card each.
		expect(screen.getByText(/No device_info.json is filed for this run/)).toBeDefined();
	});
});

/*
 * **The criterion the issue asks be pinned**, built like `devices.test.tsx`'s `the two empty
 * states`: *an empty directory deeper down* and *the archive cannot be read* are the pair that must
 * never render alike, because one says there is nothing here and the other says nobody can tell.
 */
describe('the two states with nothing to browse', () => {
	const EMPTY_DEEPER = {
		...archive(),
		'["checkout-app","login-flow"]': { outcome: 'listed', entries: [] },
	};
	const UNREADABLE_DEEPER = {
		...archive(),
		'["checkout-app","login-flow"]': { outcome: 'unreadable' },
	};

	it('do not say the same thing', async () => {
		const { unmount } = await showing('checkout-app/login-flow', EMPTY_DEEPER);
		const empty = document.body.textContent ?? '';
		unmount();

		await showing('checkout-app/login-flow', UNREADABLE_DEEPER);
		const unreadable = document.body.textContent ?? '';

		expect(empty).toContain('Nothing is filed under this directory');
		expect(empty).not.toContain('ARCHIVE NOT READABLE');
		expect(empty).not.toContain('runs may well be filed here');
		expect(unreadable).toContain('ARCHIVE NOT READABLE');
		expect(unreadable).not.toContain('Nothing is filed under this directory');
	});

	// Both are levels *inside* an archive that has other things in it, so the tree stays beside them.
	it('keep the tree, because there is still an archive to browse', async () => {
		for (const levels of [EMPTY_DEEPER, UNREADABLE_DEEPER]) {
			const { unmount } = await showing('checkout-app/login-flow', levels);

			expect(screen.getByText('DIRECTORY')).toBeDefined();
			expect(screen.getByRole('link', { name: /payments-web/ })).toBeDefined();
			unmount();
		}
	});

	it('offer no retry and carry no error code', async () => {
		for (const levels of [EMPTY_DEEPER, UNREADABLE_DEEPER]) {
			const { container, unmount } = await showing('checkout-app/login-flow', levels);

			expect(contentArea(container).querySelectorAll('button')).toHaveLength(0);
			expect(container.innerHTML).not.toContain('error');
			unmount();
		}
	});
});

describe('nothing in the archive', () => {
	const EMPTY_ROOT = { '[]': { outcome: 'listed', entries: [] } };

	it('says what would change it, with no counter and no tree card', async () => {
		const { container } = await showing(undefined, EMPTY_ROOT);

		expect(screen.getByText('Nothing in the archive')).toBeDefined();
		expect(screen.getByText(/writes a screenshot, a recording or a log/)).toBeDefined();
		expect(container.textContent).not.toContain('archived');
		expect(screen.queryByText('DIRECTORY')).toBeNull();
		expect(contentArea(container).querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	// The root's own absence is this case too: nothing has ever been archived here.
	it('says the same for a root that is not there at all', async () => {
		await showing(undefined, { '[]': { outcome: 'missing' } });

		expect(screen.getByText('Nothing in the archive')).toBeDefined();
	});

	it("takes §7's quiet panel rather than the banner's surface", async () => {
		const { container } = await showing(undefined, EMPTY_ROOT);

		const panel = container.querySelector('section > div');
		expect(panel?.className).toContain('bg-surface-container-lowest');
	});
});

describe('the archive cannot be read', () => {
	const UNREADABLE_ROOT = { '[]': { outcome: 'unreadable' } };

	it('says so in one clause, and that it is not the same as being empty', async () => {
		const { container } = await showing(undefined, UNREADABLE_ROOT);

		expect(screen.getByText('ARCHIVE NOT READABLE')).toBeDefined();
		expect(screen.getByText(/This is not the same as the archive being empty/)).toBeDefined();
		expect(container.textContent).not.toContain('Nothing in the archive');
		expect(screen.queryByText('DIRECTORY')).toBeNull();
		expect(contentArea(container).querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	it("takes the banner's surface rather than the quiet panel's", async () => {
		const { container } = await showing(undefined, UNREADABLE_ROOT);

		const banner = container.querySelector('section');
		expect(banner?.className).toContain('bg-surface-variant');
	});

	// A daemon that answered something this panel cannot read has told it as much as one that
	// answered nothing, and *runs may well be filed here* is true either way.
	it('says the same for an answer the panel cannot parse', async () => {
		await showing(undefined, { '[]': { outcome: 'a new outcome' } });

		expect(screen.getByText('ARCHIVE NOT READABLE')).toBeDefined();
	});
});

describe('before the host has answered', () => {
	it('says it is reading, in one line and with no spinner', () => {
		at.splat = undefined;
		host.hangs = true;
		const { container } = render(<ArchiveScreen view="all" />);

		expect(screen.getByText("Reading the host's artifact archive.")).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
		expect(screen.queryByText('DIRECTORY')).toBeNull();
	});
});

/*
 * **The two panes list the same run directories side by side**, so an order decided twice is an
 * order they can disagree on — which is what `panel/src/archive/level-order.ts` exists to stop.
 */
describe('the order the runs are listed in', () => {
	it('is most recent first in the tree and in the contents card alike', async () => {
		const { container } = await showing('checkout-app/login-flow');

		// By where each name first appears, because a tree row and a card row share no markup.
		const order = (pane: Element | null) => {
			const text = pane?.textContent ?? '';
			return [OLDER, RUN].sort((first, second) => text.indexOf(first) - text.indexOf(second));
		};

		expect(order(container.querySelector('aside'))).toEqual([RUN, OLDER]);
		expect(order(container.querySelector('section'))).toEqual([RUN, OLDER]);
	});
});

/*
 * **A run's artifacts lead its contents level** (#208) — the second departure from *the host's order
 * stands*, and one level's one answer: the tree, the card beside it, both views and a typed
 * `<serial>` address all draw it, so all four are asserted off the same fixture.
 */
describe('the order a run’s own contents are listed in', () => {
	/** The run's own `<serial>` level, over the archive every other case browses. */
	const filed = (...entries: readonly unknown[]) => ({
		...archive(),
		[JSON.stringify(['checkout-app', 'login-flow', RUN, SERIAL])]: listed(...entries),
	});

	/** The sidecar files a lease writes, whose contents the card beside the tree already draws. */
	const SIDECARS = [
		{ kind: 'file', name: 'device_info.json', sizeBytes: 80 },
		{ kind: 'file', name: 'group_id.json', sizeBytes: 20 },
		{ kind: 'file', name: 'test_description.json', sizeBytes: 120 },
	] as const;

	/** Exactly what a run holds on the host, in the host's own code-unit order (#208). */
	const EVERYTHING = filed(
		SIDECARS[0],
		SIDECARS[1],
		directory('logs', 1),
		directory('recordings', 1),
		directory('screenshots', 3),
		SIDECARS[2],
	);

	/*
	 * Screenshots, then recordings, then the rest of the level exactly as the host answered it —
	 * `logs` still between `group_id.json` and `test_description.json`, because nothing but those two
	 * names is lifted and nothing else is re-sorted.
	 */
	const ARTIFACTS_FIRST = [
		'screenshots',
		'recordings',
		'device_info.json',
		'group_id.json',
		'logs',
		'test_description.json',
	];

	it('puts screenshots and recordings first, in the tree and in the card alike', async () => {
		const { container } = await showing(`checkout-app/login-flow/${RUN}/${SERIAL}`, EVERYTHING);

		expect(cardRows(container)).toEqual(ARTIFACTS_FIRST);
		// The tree draws the same level, under the run's node, and the levels above it are untouched.
		expect(treeRows()).toEqual([
			'checkout-app',
			'login-flow',
			RUN,
			...ARTIFACTS_FIRST,
			OLDER,
			'unlabeled',
			'payments-web',
		]);
	});

	// The groups view lists the same directory at its own address, so it gets the same answer — the
	// group id is out of the archive depth before the order is decided.
	it('is the same order in the groups view', async () => {
		const { container } = await grouped(
			`checkout-app/${GROUP}/login-flow/${RUN}/${SERIAL}`,
			EVERYTHING,
		);

		expect(cardRows(container)).toEqual(ARTIFACTS_FIRST);
		expect(treeRows()).toEqual([
			'checkout-app',
			GROUP,
			'login-flow',
			RUN,
			...ARTIFACTS_FIRST,
			OLDER,
			OTHER_GROUP,
		]);
	});

	// An archive that recorded nothing draws exactly what it draws today: a level with neither
	// directory in it sorts to itself, which is what a stable sort on one key gives for free.
	it('leaves a level holding neither directory in the host’s own order', async () => {
		const { container } = await showing(
			`checkout-app/login-flow/${RUN}/${SERIAL}`,
			filed(SIDECARS[0], SIDECARS[1], directory('logs', 1), SIDECARS[2]),
		);

		expect(cardRows(container)).toEqual([
			'device_info.json',
			'group_id.json',
			'logs',
			'test_description.json',
		]);
	});
});

/*
 * **The state a shared link lands in.** The levels are independent round trips and the root is the
 * smallest `readdir`, so it commonly answers first and the run panel renders with the level above it
 * still in flight — or, when that level cannot be read, never coming. Neither is the run naming no
 * single child, which is `unknown`: that is a definite claim about a lease, out of an answer the
 * host has not given (D6).
 */
describe('a run whose level above has not answered', () => {
	it('says it is reading, and never that the run named no single child', async () => {
		const { container } = await showing(`checkout-app/login-flow/${RUN}`, {
			...archive(),
			'["checkout-app","login-flow"]': HANGS,
		});

		// `SERIAL` and `DESCRIPTION` are both read off that level, so both say it (#148), and the
		// device card says it about the file it cannot address without a serial.
		expect(screen.getAllByText('reading')).toHaveLength(2);
		expect(screen.getByText("Reading this run's device_info.json.")).toBeDefined();
		expect(container.textContent).not.toContain('unknown');
		expect(container.innerHTML).not.toContain('animate');
		// And no serial to ask for a level by, so the fourth request is not made on a guess.
		expect(host.asked).toEqual([[], ['checkout-app'], ['checkout-app', 'login-flow']]);
	});

	it('says the host cannot read that level, and never that the run named no single child', async () => {
		const { container } = await showing(`checkout-app/login-flow/${RUN}`, {
			...archive(),
			'["checkout-app","login-flow"]': { outcome: 'unreadable' },
		});

		expect(screen.getAllByText('not readable')).toHaveLength(2);
		expect(screen.getByText(/Rover cannot read this run's device_info.json/)).toBeDefined();
		expect(container.textContent).not.toContain('unknown');
	});

	/*
	 * The one state `unknown` is for: the host answered, and the run holds no single child. **The
	 * tree draws nothing under such a run either** — there is no level to open, so no triangle and
	 * no line, which is the same refusal to draw over nothing (#161, `directory-tree.tsx`).
	 */
	it('says `unknown` only when the level above named no serial', async () => {
		const { container } = await showing(`checkout-app/login-flow/${RUN}`, {
			...archive(),
			'["checkout-app","login-flow"]': listed(directory(RUN, 2, null)),
		});

		expect(screen.getByText('unknown')).toBeDefined();
		expect(container.textContent).not.toContain('ARCHIVE NOT READABLE');
		expect(container.textContent).not.toContain('This run wrote nothing.');
	});
});

describe('a legacy unlabeled directory', () => {
	// D22 as amended by #129: a run filed before `test_name` was required sits under `unlabeled/`,
	// and nothing on this screen treats it as anything but a directory.
	it('browses like any other test name', async () => {
		await showing('checkout-app/unlabeled', {
			...archive(),
			'["checkout-app","unlabeled"]': listed(directory(RUN, 1, 'R5CT30ABCDE')),
		});

		expect(screen.getByText('1 run archived')).toBeDefined();
		expect(screen.getByText('Runs filed under this test name, most recent first.')).toBeDefined();
	});
});

/**
 * **The artifact preview** (#133) — and since #160 it is a state of the tree like any other.
 *
 * One test is one address, as everywhere else on this screen. There is **one arrangement at every
 * depth** now — the tree, then one card — and what the parent listing says the address is decides
 * what that card *draws* and nothing about whether the tree is beside it: an artifact draws the
 * preview alone, a folder draws its own listing, and an address nobody has answered for draws one
 * quiet line claiming neither.
 */
describe('an artifact open inside a run', () => {
	const SERIAL_LEVEL = ['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE'];
	const SCREENSHOTS = [...SERIAL_LEVEL, 'screenshots'];
	const FILE = [...SCREENSHOTS, '001_screenshot.png'];
	const AT_THE_FILE = FILE.join('/');

	/** The archive above, plus the one level the open file's folder lists. */
	function withScreenshots(): Record<string, unknown> {
		return {
			...archive(),
			[JSON.stringify(SCREENSHOTS)]: listed(
				{ kind: 'file', name: '001_screenshot.png', sizeBytes: 421_112 },
				{ kind: 'file', name: '002_screenshot.png', sizeBytes: 398_004 },
			),
		};
	}

	const PNG = {
		outcome: 'read',
		mediaType: 'image/png',
		bytes: new Blob(['the-png-bytes'], { type: 'image/png' }),
	};

	/*
	 * **The levels the tree draws, and nothing else** (#160). The root, the project and the test level
	 * are read now, because the tree is there to draw them — #133's saving, knowingly given up. The
	 * run's own level is still never listed, and the run's **two files are not read at all**: nothing
	 * beside the preview draws them any more. And the artifact is asked for only once its own folder's
	 * listing says it is a file — a byte read of a directory would put a warning in the host's log on
	 * every folder a reader opens.
	 */
	it('reads the levels the tree draws and the artifact — and neither of the run’s files', async () => {
		host.artifact = PNG;

		await showing(AT_THE_FILE, withScreenshots());

		expect(host.asked).toEqual([
			[],
			['checkout-app'],
			['checkout-app', 'login-flow'],
			SERIAL_LEVEL,
			SCREENSHOTS,
		]);
		expect(host.files).toEqual([]);
		expect(host.artifacts).toEqual([FILE]);
	});

	/*
	 * The criterion the approved markup gets wrong, and #160's answer to it went only half way: a
	 * *fixed* child makes the split depend on the window, so the same screen shows different
	 * proportions on different monitors — and a 320px tree is a fixed child too. **The row is two
	 * fractions now** (#172), 0.4 for the tree and 0.6 for the card, so neither card carries a
	 * width and the split is the same at every width the row is horizontal at.
	 *
	 * **And it is horizontal from `xl`, not `lg`.** A fraction and the breakpoint are one decision:
	 * 40% of the row at `lg` is narrower than the tree it replaces (§9 carries the arithmetic and
	 * the measurement), so the stacked arrangement, where the tree has the whole width, runs a
	 * breakpoint further up rather than the fraction gaining a floor that would put the proportions
	 * back on the window.
	 */
	it('splits the row 0.4 / 0.6 from xl, with neither card carrying a width of its own', async () => {
		host.artifact = PNG;

		const { container } = await showing(AT_THE_FILE, withScreenshots());

		const row = container.querySelector('div.xl\\:flex-row') as HTMLElement;
		// Both fractions are written on the row, which is where the split belongs.
		expect(row.className).toContain('xl:[&>aside]:basis-2/5');
		expect(row.className).toContain('xl:[&>section]:basis-3/5');
		// `basis-*` and not `w-*`: the gutter is the row's one overflow and shrinking removes it.
		expect(row.className).toContain('gap-(--gutter)');
		// The stacked arrangement is what every width below `xl` gets, `lg` included now.
		expect(row.className).not.toContain('lg:');

		const columns = container.querySelectorAll('div.xl\\:flex-row > section');
		expect(columns).toHaveLength(1);
		const preview = columns[0] as HTMLElement;
		expect(preview.className).toContain('min-w-0');
		expect(preview.className).not.toMatch(/\bw-\[/);
		expect(preview.className).not.toMatch(/\bbasis-/);
		expect(preview.className).not.toMatch(/\bw-1\/2/);
		expect(preview.className).not.toContain('shrink-0');
		// And the tree is no longer the one sized child — it carries neither a width nor a `shrink-0`.
		const tree = container.querySelector('aside') as HTMLElement;
		expect(tree.className).not.toMatch(/\bw-\[/);
		expect(tree.className).not.toMatch(/\bbasis-/);
		expect(tree.className).not.toContain('shrink-0');
	});

	/*
	 * **The tree beside the preview, and the run's cards nowhere** (#160, reversing #133). The preview
	 * column holds one thing at a time and the tree is what keeps the reader placed, so the run's
	 * identity and device cards are not beside an open file — they are what a *selected run* is.
	 */
	it('draws the tree beside the preview, and the run’s cards nowhere', async () => {
		host.artifact = PNG;

		const { container } = await showing(AT_THE_FILE, withScreenshots());

		expect(screen.getByText('DIRECTORY')).toBeDefined();
		expect(container.querySelector('aside')).toBeDefined();
		expect(screen.queryByRole('heading', { level: 3, name: RUN })).toBeNull();
		expect(container.textContent).not.toContain('DEVICE — FROM device_info.json');
		expect(container.textContent).not.toContain('CONTENTS');
		expect(container.textContent).not.toContain('Run Details');
	});

	it('shows the artifact, and one control over it', async () => {
		host.artifact = PNG;

		await showing(AT_THE_FILE, withScreenshots());

		expect(screen.getByAltText('001_screenshot.png')).toBeDefined();
		expect(screen.getByRole('link', { name: /Open in a new window/ })).toBeDefined();
	});

	/*
	 * The path bar grows a segment for the file, and **the `<serial>` is in no segment**: it is not a
	 * tree level, so there is no screen to link it to. The file is where you are, so it is last and
	 * not a link.
	 */
	it('grows one breadcrumb segment for the file, in full and not a link', async () => {
		host.artifact = PNG;

		await showing(AT_THE_FILE, withScreenshots());

		const trail = document.querySelector('nav[aria-label="Breadcrumb"]');
		const last = trail?.querySelector('li:last-child > *');
		expect(last?.textContent).toBe('screenshots/001_screenshot.png');
		expect(last?.tagName).toBe('SPAN');
		expect(last?.getAttribute('aria-current')).toBe('page');
		expect(last?.className).toContain('text-tertiary');
		expect(last?.className).toContain('break-words');
		expect(trail?.textContent).not.toContain('R5CT30ABCDE');
		// The levels above it are still links, so the way back up is the path bar as well as the arrow.
		expect(trail?.querySelectorAll('a')).toHaveLength(4);
	});

	/*
	 * **The counter slot is empty, and that is the rule rather than an exception**: the badge is a
	 * counter and one file has nothing to count — exactly as §7 leaves the held/free counter absent
	 * rather than showing `0 held · 0 free`.
	 */
	it('carries no badge, and describes itself as one artifact', async () => {
		host.artifact = PNG;

		const { container } = await showing(AT_THE_FILE, withScreenshots());

		expect(screen.getByText('One artifact from this run, as it was written.')).toBeDefined();
		expect(container.textContent).not.toContain('archived');
	});

	/*
	 * **There is no way back, because nothing was taken away** (#160). The back arrow existed for the
	 * one state the run's column was the only exit from — a preview standing where the tree had been —
	 * and the tree stands beside the preview now, so the card's strip is the file's own name and the
	 * one control over it.
	 */
	it('offers no way back, and heads the card with the file’s own name', async () => {
		host.artifact = PNG;

		const { container } = await showing(AT_THE_FILE, withScreenshots());

		expect(
			screen.queryByRole('link', { name: 'Close the preview and go back to the directory' }),
		).toBeNull();
		const strip = container.querySelector('div.xl\\:flex-row > section > div:first-child');
		expect(strip?.textContent).toBe('001_screenshot.pngOpen in a new window');
	});

	// The tree is how another file is chosen now (#160), so it draws the open file's siblings and
	// marks the one that is open.
	it('draws the folder’s file names in the tree, with the open one selected', async () => {
		host.artifact = PNG;

		const { container } = await showing(AT_THE_FILE, withScreenshots());

		const tree = within(container.querySelector('aside') as HTMLElement);
		const open = tree.getByRole('link', { name: /001_screenshot.png/ });
		expect(open.getAttribute('aria-current')).toBe('page');
		expect(tree.getByRole('link', { name: /002_screenshot.png/ }).getAttribute('href')).toBe(
			`/archive/${[...SCREENSHOTS, '002_screenshot.png'].join('/')}`,
		);
	});

	/*
	 * **A folder below the `<serial>` draws its own listing beside the tree** (#160) — which is what
	 * depth 4 already did, and what every level above a run does. The run's cards are not beside it
	 * either: what the parent listing says the address is decides what the card draws, and it said
	 * *directory*. Nothing is read as an artifact, for the same reason.
	 */
	it('renders a folder below the serial as the tree beside that folder’s own listing', async () => {
		const { container } = await showing(SCREENSHOTS.join('/'), withScreenshots());

		expect(screen.getByText('Everything filed under this directory.')).toBeDefined();
		expect(screen.getByText('DIRECTORY')).toBeDefined();
		expect(container.textContent).not.toContain('DEVICE — FROM device_info.json');
		expect(container.textContent).not.toContain('Run Details');
		// The tree, then one card — the row every depth draws.
		const columns = container.querySelector('div.xl\\:flex-row');
		expect(columns?.children).toHaveLength(2);
		expect(columns?.children[0]?.tagName).toBe('ASIDE');
		// The card is the folder's own read-only listing, headed by its name — and read-only is now
		// literal: its rows name the files and lead nowhere (#161).
		const card = besideTheTree(container);
		expect(card.getByRole('heading', { level: 2, name: 'screenshots' })).toBeDefined();
		expect(card.getByText('001_screenshot.png')).toBeDefined();
		expect(card.queryAllByRole('link')).toHaveLength(0);
		expect(card.queryAllByRole('button')).toHaveLength(0);
		// The way into the file is the row beside it, in the one pane that navigates.
		expect(
			within(container.querySelector('aside') as HTMLElement)
				.getByRole('link', { name: /001_screenshot.png/ })
				.getAttribute('href'),
		).toBe(`/archive/${[...SCREENSHOTS, '001_screenshot.png'].join('/')}`);
		expect(
			screen.queryByRole('link', { name: 'Close the preview and go back to the directory' }),
		).toBeNull();
		expect(host.artifacts).toEqual([]);
		// The tree is expanded down to the folder, which is where you are (#159).
		const tree = container.querySelector('aside') as HTMLElement;
		const drawn = [...tree.querySelectorAll('a')];
		expect(drawn.map((row) => row.textContent)).toContain('screenshots');
		expect(drawn.filter((row) => row.getAttribute('aria-current') === 'page')).toHaveLength(1);
	});

	/*
	 * **The tree's own levels are wanted from the start now** (#160). They were asked for only once
	 * the `<serial>` listing had said the address was a folder, because an artifact drew no tree and
	 * was not to pay for one; the tree is drawn at every depth now, so the three are wanted by the
	 * depth again — and the folder's own listing is still wanted by the answer, never by its name
	 * (D22).
	 */
	it('asks for the tree’s levels from the start, and the folder’s own once it is known to be one', async () => {
		await showing(SCREENSHOTS.join('/'), withScreenshots());

		expect(host.asked).toEqual([
			[],
			['checkout-app'],
			['checkout-app', 'login-flow'],
			SERIAL_LEVEL,
			SCREENSHOTS,
		]);
		// And neither of the run's two files, which nothing at this depth draws.
		expect(host.files).toEqual([]);
	});

	// The address the host answers `missing` for. Said plainly, and not as the other one.
	it('says nothing is filed at an address the host does not have', async () => {
		const { container } = await showing(AT_THE_FILE, withScreenshots());

		expect(screen.getByText(/Nothing is filed at this address/)).toBeDefined();
		expect(container.textContent).not.toContain('Rover cannot read this artifact');
	});

	it('says a file it cannot read differently again', async () => {
		host.artifact = { outcome: 'unreadable' };

		const { container } = await showing(AT_THE_FILE, withScreenshots());

		expect(screen.getByText(/Rover cannot read this artifact/)).toBeDefined();
		expect(container.textContent).not.toContain('Nothing is filed at this address');
	});

	/*
	 * A link into the archive at a depth nobody browsed to. **The tree is there from the first frame**
	 * (#160), and the card still claims nothing until the parent listing answers (#140 review): the
	 * header carries the run's own line rather than *One artifact from this run*, and the card says
	 * *Reading this address.* Nothing that is drawn is ever replaced — the preview lands in the card
	 * the quiet line was in, and the tree fills its own levels in beside it.
	 */
	it('renders the preview on a reload straight onto it, with the tree beside it throughout', async () => {
		host.artifact = PNG;
		at.splat = AT_THE_FILE;
		host.answers = new Map(Object.entries(withScreenshots()));

		const { container } = render(<ArchiveScreen view="all" />);
		expect(screen.getByText('DIRECTORY')).toBeDefined();
		expect(container.querySelectorAll('div.xl\\:flex-row > section')).toHaveLength(1);
		expect(screen.getByText('Reading this address.')).toBeDefined();
		expect(screen.queryByText('Reading this artifact.')).toBeNull();
		expect(container.textContent).not.toContain('One artifact from this run');
		expect(container.textContent).not.toContain('Run Details');

		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		expect(screen.getByText('DIRECTORY')).toBeDefined();
		expect(container.querySelectorAll('div.xl\\:flex-row > section')).toHaveLength(1);
		expect(screen.getByAltText('001_screenshot.png')).toBeDefined();
	});

	/*
	 * **The same first frame for a folder** — and the wait is no longer an arrangement (#160). A name
	 * never says what an address is (D22), so until the `<serial>` listing answers the screen does not
	 * know whether the card is a preview or a listing; what it may not do is *claim* one. It is the
	 * card that says so, in one quiet line that is neither, while the tree is beside it from the
	 * first frame — so nothing that is drawn has to be taken away when the answer lands.
	 */
	it('claims nothing about an address whose parent has not answered, and flips nothing', async () => {
		at.splat = SCREENSHOTS.join('/');
		host.answers = new Map(Object.entries(withScreenshots()));

		const { container } = render(<ArchiveScreen view="all" />);
		expect(screen.getByText('DIRECTORY')).toBeDefined();
		const columns = container.querySelector('div.xl\\:flex-row');
		expect(columns?.children).toHaveLength(2);
		expect(columns?.children[0]?.tagName).toBe('ASIDE');
		// The card is headed by the address's last component and says neither *level* nor *artifact*.
		const card = besideTheTree(container);
		expect(card.getByRole('heading', { level: 2, name: 'screenshots' })).toBeDefined();
		expect(card.getByText('Reading this address.')).toBeDefined();
		expect(container.textContent).not.toContain('One artifact from this run');
		expect(container.textContent).not.toContain('Reading this artifact.');
		expect(container.textContent).not.toContain('Run Details');
		expect(container.innerHTML).not.toContain('animate');
		// Nothing is fetched for it either, which is the rule that first frame exists to keep.
		expect(host.artifacts).toEqual([]);

		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		// The listing landed in the card the quiet line was in: nothing added, and none replaced.
		expect(screen.getByText('DIRECTORY')).toBeDefined();
		expect(screen.getByText('Everything filed under this directory.')).toBeDefined();
		expect(container.querySelector('div.xl\\:flex-row')?.children).toHaveLength(2);
		expect(besideTheTree(container).getByText('001_screenshot.png')).toBeDefined();
		expect(host.artifacts).toEqual([]);
	});

	/*
	 * **One cache, so a level read at one depth is not read again at the next** (#140 review). The
	 * `<serial>` level a selected run reads used to be held by a second `useArchiveLevels` instance,
	 * so navigating from the run into one of its files re-`readdir`ed it — invisible to every test,
	 * because no case walked that route.
	 */
	it('does not re-read the `<serial>` level when a run is left for one of its files', async () => {
		host.artifact = PNG;
		host.answers = new Map(Object.entries(withScreenshots()));
		at.splat = `checkout-app/login-flow/${RUN}`;

		const { rerender } = render(<ArchiveScreen view="all" />);
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}
		expect(host.asked).toContainEqual(SERIAL_LEVEL);
		const readSoFar = host.asked.length;

		at.splat = AT_THE_FILE;
		rerender(<ArchiveScreen view="all" />);
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		// One further listing, and it is the open file's own folder — not the `<serial>` again.
		expect(host.asked.slice(readSoFar)).toEqual([SCREENSHOTS]);
		expect(screen.getByAltText('001_screenshot.png')).toBeDefined();
	});
});

/**
 * The two addresses above the preview state, unchanged (#133 is a state of this screen, not a
 * replacement for it).
 */
describe('the addresses that still browse', () => {
	it('renders the `<serial>` level itself beside the tree, as it did before', async () => {
		const { container } = await showing(`checkout-app/login-flow/${RUN}/R5CT30ABCDE`);

		expect(screen.getByText('DIRECTORY')).toBeDefined();
		expect(screen.getByText('Everything filed under this directory.')).toBeDefined();
		/*
		 * The level's own card, listing what the run wrote — and the tree beside it lists the same
		 * names (#159), so this is scoped to the card. **The card's rows are read-only** and the
		 * tree's row is the way into the file (#161): one listing that navigates, one that does not.
		 */
		const card = besideTheTree(container);
		expect(card.getByText('device_info.json')).toBeDefined();
		expect(card.queryAllByRole('link')).toHaveLength(0);
		expect(card.queryAllByRole('button')).toHaveLength(0);
		expect(
			within(container.querySelector('aside') as HTMLElement)
				.getByRole('link', { name: /device_info.json/ })
				.getAttribute('href'),
		).toBe(`/archive/checkout-app/login-flow/${RUN}/R5CT30ABCDE/device_info.json`);
		// The serial is not a level of the tree, so the run's own row is what the address marks.
		const marked = container.querySelectorAll('aside a[aria-current="page"]');
		expect([...marked].map((row) => row.textContent)).toEqual([RUN]);
	});

	it('renders a selected run beside the tree, with no back control', async () => {
		const { container } = await showing(`checkout-app/login-flow/${RUN}`);

		expect(screen.getByText('DIRECTORY')).toBeDefined();
		expect(screen.getByText('Run Details')).toBeDefined();
		expect(
			screen.queryByRole('link', { name: 'Close the preview and go back to the directory' }),
		).toBeNull();
		expect(host.artifacts).toEqual([]);
		// The tree lists what the run wrote, out of the `<serial>` level the run already reads.
		const tree = container.querySelector('aside') as HTMLElement;
		expect([...tree.querySelectorAll('a')].map((row) => row.textContent)).toContain(
			'device_info.json',
		);
		// **And it costs no request.** The four a selected run has always asked for, unchanged.
		expect(host.asked).toEqual([
			[],
			['checkout-app'],
			['checkout-app', 'login-flow'],
			['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE'],
		]);
	});
});

/**
 * The tree card's search, at the level of the screen that holds it (#146).
 *
 * **The state is held above the card on purpose**, so the cases here are the ones the card's own
 * suite cannot reach: that the field is absent wherever no tree is drawn, that the text survives the
 * navigation a hit performs, and that a search costs no listing.
 */
describe('searching the archive from the tree card', () => {
	const SERIAL_LEVEL = ['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE'];
	const SCREENSHOTS = [...SERIAL_LEVEL, 'screenshots'];

	function answered(matches: readonly { path: readonly string[]; kind: string }[]) {
		return { outcome: 'searched', matches, truncated: false };
	}

	function field(): HTMLInputElement {
		return screen.getByRole('textbox') as HTMLInputElement;
	}

	/** Type, then let the debounce fire and the answer land. */
	async function type(text: string): Promise<void> {
		fireEvent.change(field(), { target: { value: text } });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
			await vi.advanceTimersByTimeAsync(0);
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('draws the field wherever the tree is', async () => {
		await showing('checkout-app');

		expect(field().getAttribute('placeholder')).toBe('Search the whole archive...');
	});

	/*
	 * **Absent in every state that draws no tree**, and it falls out of the field being part of the
	 * tree card rather than of the header: nothing here says so a second time.
	 */
	it('draws no field where there is nothing to browse', async () => {
		for (const levels of [
			{ '[]': { outcome: 'listed', entries: [] } },
			{ '[]': { outcome: 'unreadable' } },
		]) {
			const { unmount } = await showing(undefined, levels);

			expect(screen.queryByRole('textbox')).toBeNull();
			unmount();
		}
	});

	// And it is drawn with an artifact open too, because the tree is (#160). The field goes wherever
	// the card goes, and there is one arrangement now.
	it('draws the field with an artifact open, because the tree is there', async () => {
		host.artifact = { outcome: 'read', mediaType: 'image/png', bytes: new Blob(['png']) };

		await showing([...SCREENSHOTS, '001_screenshot.png'].join('/'), {
			...archive(),
			[JSON.stringify(SCREENSHOTS)]: listed({
				kind: 'file',
				name: '001_screenshot.png',
				sizeBytes: 4,
			}),
		});

		expect(field().getAttribute('placeholder')).toBe('Search the whole archive...');
	});

	// One request for the settled text, and **no listing at all**: the matched tree is derived from
	// the one search answer rather than re-walked a level at a time.
	it('asks the host once and issues no extra listing', async () => {
		host.search = answered([{ path: ['checkout-app', 'login-flow'], kind: 'directory' }]);
		await showing('checkout-app');
		const listings = [...host.asked];

		await type('login');

		expect(host.searches).toEqual(['login']);
		expect(host.asked).toEqual(listings);
	});

	it('draws the hits in place of the URL’s own levels', async () => {
		host.search = answered([{ path: [...SCREENSHOTS, '001_screenshot.png'], kind: 'file' }]);
		await showing('checkout-app');

		await type('screenshot');

		expect(screen.getByRole('link', { name: /001_screenshot.png/ })).toBeDefined();
		expect(screen.queryByRole('link', { name: /payments-web/ })).toBeNull();
	});

	it('restores the URL’s own tree when the field is cleared', async () => {
		host.search = answered([{ path: ['checkout-app', 'login-flow'], kind: 'directory' }]);
		await showing('checkout-app');

		await type('login');
		await type('');

		expect(screen.getByRole('link', { name: /payments-web/ })).toBeDefined();
		expect(host.searches).toEqual(['login']);
	});

	/*
	 * **The text is not in the address**, so the mocked `useParams` — the whole of the address bar
	 * as far as this screen is concerned — is never asked to carry it, and no row links to it.
	 */
	it('never puts the text in the address', async () => {
		host.search = answered([{ path: ['checkout-app', 'login-flow'], kind: 'directory' }]);
		const { container } = await showing('checkout-app');

		await type('login');

		expect(at.splat).toBe('checkout-app');
		for (const link of container.querySelectorAll('a')) {
			expect(link.getAttribute('href')).not.toContain('login&');
			expect(link.getAttribute('href')).not.toContain('?');
		}
	});

	/*
	 * **The hits survive following one**, which is what holding the state above the card buys. There
	 * is one arrangement now, so the card is no longer remounted by the navigation itself (#160) —
	 * what the state still has to outlive is the address changing under it, which is what this
	 * asserts.
	 */
	it('keeps the text and the hits when a hit is navigated to', async () => {
		host.search = answered([{ path: SCREENSHOTS, kind: 'directory' }]);
		const { rerender } = await showing('checkout-app');
		await type('screenshots');
		expect(screen.getByRole('link', { name: /screenshots/ })).toBeDefined();

		// Following the hit's own row: the address changes and the screen re-renders at that folder,
		// with the same tree card still beside it.
		at.splat = SCREENSHOTS.join('/');
		host.answers.set(
			JSON.stringify(SCREENSHOTS),
			listed({ kind: 'file', name: 'a.png', sizeBytes: 4 }),
		);
		await act(async () => {
			rerender(<ArchiveScreen view="all" />);
		});
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		expect(field().value).toBe('screenshots');
		// The hit list itself, inside the tree card — the run's column names the folder too.
		const tree = document.querySelector('aside');
		expect([...(tree?.querySelectorAll('a') ?? [])].map((row) => row.textContent)).toEqual([
			'checkout-app',
			'login-flow',
			RUN,
			'R5CT30ABCDE',
			'screenshots',
		]);
		expect(host.searches).toEqual(['screenshots']);
	});
});

/**
 * **Searching from the groups view, over the runs that carry a group id** (#207).
 *
 * The hook, the debounce and the id discipline are the `All` view's and are asserted above; what is
 * this view's is the *population* and the *addresses*, which is what this screen composes
 * (`group-search.ts`). The contrast is drawn over one host: `unlabeled` names no group and
 * `payments-web` holds no grouped run, so both are hits in the `All` view and neither is one here.
 */
describe('searching the testing groups from the tree card', () => {
	const SERIAL_LEVEL = ['checkout-app', 'login-flow', RUN, SERIAL];
	const HIT = [...SERIAL_LEVEL, 'screenshots', 'login.png'];
	/** The same hit's address in this arrangement — the group id in front of the archive's own. */
	const IN_GROUPS = ['checkout-app', GROUP, 'login-flow', RUN, SERIAL, 'screenshots', 'login.png'];

	function answered(
		matches: readonly { path: readonly string[]; kind: string }[],
		truncated = false,
	) {
		return { outcome: 'searched', matches, truncated };
	}

	function field(): HTMLInputElement {
		return screen.getByRole('textbox') as HTMLInputElement;
	}

	async function type(text: string): Promise<void> {
		fireEvent.change(field(), { target: { value: text } });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
			await vi.advanceTimersByTimeAsync(0);
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/*
	 * One request for the settled text, **no listing** and — the half that is this view's — **no
	 * second grouping walk**: the restriction is composed from the answer this view already holds.
	 */
	it('asks the host once, and asks for no second grouping walk', async () => {
		host.search = answered([{ path: HIT, kind: 'file' }]);
		await grouped(`checkout-app/${GROUP}`);
		const listings = [...host.asked];

		await type('login');

		expect(host.searches).toEqual(['login']);
		expect(host.asked).toEqual(listings);
		expect(host.groupings).toBe(1);
	});

	// A hit navigates to a groups-view address, with the group id in front of the archive address.
	it('links a hit to this view’s own address', async () => {
		host.search = answered([{ path: HIT, kind: 'file' }]);
		const { container } = await grouped(`checkout-app/${GROUP}`);

		await type('login');

		expect(screen.getByRole('link', { name: 'login.png' }).getAttribute('href')).toBe(
			`/groups/${IN_GROUPS.join('/')}`,
		);
		// And every row of the searched tree is on this view's route, ancestors included.
		for (const row of container.querySelector('aside')?.querySelectorAll('a') ?? []) {
			expect(row.getAttribute('href')).toMatch(/^\/groups\//);
		}
	});

	// Following one lands on that address with the text and the hits intact, which is what holding
	// the state above the card buys — the `All` view's own rule, over this view's addresses.
	it('keeps the text and the hits when a hit is navigated to', async () => {
		host.search = answered([{ path: HIT, kind: 'file' }]);
		const { rerender } = await grouped(`checkout-app/${GROUP}`);
		await type('login');

		at.splat = IN_GROUPS.join('/');
		host.answers.set(
			JSON.stringify([...SERIAL_LEVEL, 'screenshots']),
			listed({ kind: 'file', name: 'login.png', sizeBytes: 4 }),
		);
		await act(async () => {
			rerender(<ArchiveScreen view="groups" />);
		});
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		expect(field().value).toBe('login');
		expect(treeRows()).toEqual([
			'checkout-app',
			GROUP,
			'login-flow',
			RUN,
			SERIAL,
			'screenshots',
			'login.png',
		]);
		expect(host.searches).toEqual(['login']);
	});

	/*
	 * **Only what this arrangement can address is drawn.** The same answer over the same host draws
	 * three hits in the `All` view and one here: a run that named no group is not a hit, a project
	 * with no grouped run is not drawn, and a test name is not addressable in this arrangement.
	 */
	it('draws only the matches under a grouped run, where the `All` view draws them all', async () => {
		const matches = [
			{ path: ['checkout-app', 'login-flow'], kind: 'directory' },
			{ path: ['checkout-app', 'unlabeled', RUN, SERIAL, 'login.png'], kind: 'file' },
			{ path: ['payments-web', 'refund-flow', RUN, SERIAL, 'login.png'], kind: 'file' },
			{ path: HIT, kind: 'file' },
		];
		host.search = answered(matches);

		const all = await showing('checkout-app');
		await type('login');
		expect(treeRows()).toEqual([
			'checkout-app',
			'login-flow',
			RUN,
			SERIAL,
			'screenshots',
			'login.png',
			'unlabeled',
			RUN,
			SERIAL,
			'login.png',
			'payments-web',
			'refund-flow',
			RUN,
			SERIAL,
			'login.png',
		]);
		all.unmount();

		await grouped(`checkout-app/${GROUP}`);
		await type('login');
		expect(treeRows()).toEqual([
			'checkout-app',
			GROUP,
			'login-flow',
			RUN,
			SERIAL,
			'screenshots',
			'login.png',
		]);
	});

	/*
	 * **The definitive negative is never said about an answer either walk cut short.** The search
	 * itself was complete here; the grouping walk was not, so the panel may not claim that nothing in
	 * this arrangement contains that text.
	 */
	it('narrows the negative when the grouping walk was cut short', async () => {
		host.search = answered([]);
		host.groups = { ...(groupings() as object), truncated: true };
		await grouped(`checkout-app/${GROUP}`);

		await type('nothing');

		expect(
			screen.getByText(
				'Nothing in the part of the testing groups that could be examined contains that text.',
			),
		).toBeDefined();
		expect(document.body.textContent).not.toContain(
			'No name under a testing group contains that text.',
		);
	});

	/*
	 * **No field where there is no tree**, in either of this view's two empty-handed states — and it
	 * stays structural, because the field is part of the card and neither state draws one.
	 */
	it('draws no field where there is nothing to browse', async () => {
		for (const answer of [
			{ outcome: 'listed', groups: [], truncated: false },
			{ outcome: 'unreadable' },
		]) {
			host.groups = answer;
			const { unmount } = await grouped(undefined);

			expect(screen.queryByRole('textbox')).toBeNull();
			expect(document.querySelector('aside')).toBeNull();
			unmount();
		}
	});

	/*
	 * A deep group address browses while the grouping walk is still out, so a search can answer
	 * before the panel knows which runs are grouped. It says it is searching rather than that nothing
	 * matched — the claim it has not established.
	 */
	it('says it is searching while the grouping walk is still out', async () => {
		host.groups = HANGS;
		host.search = answered([{ path: HIT, kind: 'file' }]);
		await grouped(`checkout-app/${GROUP}/login-flow/${RUN}/${SERIAL}/screenshots`);

		await type('login');

		expect(screen.getByText("Searching this host's archive.")).toBeDefined();
		expect(document.body.textContent).not.toContain('contains that text');
	});
});

/**
 * The screen's two views (#165, given addresses of their own by #181).
 *
 * The toggle's segments are **links** now: the view is where you are, so a reload and a shared link
 * land on it, and the reset machinery an address was standing in for is gone.
 */
describe('the view toggle', () => {
	function toggle() {
		return screen.getByRole('group', { name: 'Archive view' });
	}

	function segment(label: string) {
		return screen.getByRole('link', { name: label });
	}

	it('offers both, in text, with no icon on either', async () => {
		await showing(undefined);

		expect([...toggle().querySelectorAll('a')].map((one) => one.textContent)).toEqual([
			'All',
			'Testing groups',
		]);
		expect(toggle().querySelectorAll('svg')).toHaveLength(0);
	});

	// `aria-current` rather than `aria-pressed`, because this is where you are and not a control
	// you last pressed — the same word the breadcrumb and the nav item already use.
	it('says you are in the file explorer', async () => {
		await showing(undefined);

		expect(segment('All').getAttribute('aria-current')).toBe('page');
		expect(segment('Testing groups').getAttribute('aria-current')).toBeNull();
	});

	it('says you are in the groups view', async () => {
		await grouped(undefined);

		expect(segment('Testing groups').getAttribute('aria-current')).toBe('page');
		expect(segment('All').getAttribute('aria-current')).toBeNull();
	});

	/*
	 * Each segment points at its view's **root**, from any depth. The two arrangements share no
	 * vocabulary below the project — one has a group id where the other has a test name — so *the
	 * same place in the other view* is a claim neither can make honestly.
	 */
	it('links to each view’s own root, from a deep address', async () => {
		await showing(`checkout-app/login-flow/${RUN}`);

		expect(segment('All').getAttribute('href')).toBe('/archive');
		expect(segment('Testing groups').getAttribute('href')).toBe('/groups');
	});
});

/**
 * **The group-first arrangement of the same archive** (#181, `PROJECT.md` R41): project, then the
 * `groupId`, then the standard arrangement under it — test name, run, and the run's contents to any
 * depth.
 */
describe('the testing groups view', () => {
	it('describes itself and lists the projects that have groups, and no others', async () => {
		await grouped(undefined);

		expect(
			screen.getByText('Projects with runs filed under a testing group on this host.'),
		).toBeDefined();
		expect(treeRows()).toEqual(['checkout-app']);
		// `payments-web` is in the archive and has no grouped run, so it is not in this arrangement.
		expect(document.body.textContent).not.toContain('payments-web');
	});

	it('puts the group id below the project', async () => {
		await grouped('checkout-app');

		expect(screen.getByText('Testing groups the leases under this project named.')).toBeDefined();
		expect(treeRows()).toEqual(['checkout-app', GROUP, OTHER_GROUP]);
	});

	it('puts the standard arrangement below the group — test name, then run', async () => {
		await grouped(`checkout-app/${GROUP}`);

		expect(screen.getByText('Tests recorded under this testing group.')).toBeDefined();
		expect(treeRows()).toEqual(['checkout-app', GROUP, 'login-flow', OTHER_GROUP]);
	});

	/*
	 * **Most recent first, exactly as the `All` view lists the same run directories** — the answer
	 * arrives in the host's ascending order and one helper decides the direction for both panes and
	 * both views (`panel/src/archive/level-order.ts`).
	 */
	it('lists a group’s runs most recent first, in the tree and in the card alike', async () => {
		const { container } = await grouped(`checkout-app/${GROUP}/login-flow`);

		expect(
			screen.getByText('Runs filed under this test name in this group, most recent first.'),
		).toBeDefined();
		expect(treeRows()).toEqual(['checkout-app', GROUP, 'login-flow', RUN, OLDER, OTHER_GROUP]);
		// And the card beside it lists the same two in the same order — the run names, which lead
		// with a UTC basic-format timestamp, and not the `GRANTED` field reformatted out of them.
		const card = besideTheTree(container);
		expect(card.getAllByText(/^2026\d{4}T/).map((row) => row.textContent)).toEqual([RUN, OLDER]);
	});

	// A run that named no group is not drawn: this view is *what groups exist*. `unlabeled` holds a
	// run in the archive and named none, and the `All` view still lists it.
	it('draws no run that named no group', async () => {
		await grouped('checkout-app');

		expect(document.body.textContent).not.toContain('unlabeled');
	});

	/*
	 * **The whole arrangement above a run is one request.** No level is listed for it, because the
	 * grouping answer holds the projects, the group ids, the test names and the runs together.
	 */
	it('asks the grouping walk once and lists no level above a run', async () => {
		await grouped(`checkout-app/${GROUP}/login-flow`);

		expect(host.groupings).toBe(1);
		expect(host.asked).toEqual([]);
		expect(host.searches).toEqual([]);
	});

	// And the `All` view never pays for it — the reader who does not open this view spends no walk.
	it('is not walked at all by the All view', async () => {
		await showing('checkout-app/login-flow');

		expect(host.groupings).toBe(0);
	});

	/*
	 * **At and below the run it is the `All` view's own levels**, at the archive's own address —
	 * the group id is not a directory, and one helper drops it (`archiveAddressOf`).
	 */
	it('opens a run at the archive’s own address, with the serial off the answer', async () => {
		const { container } = await grouped(`checkout-app/${GROUP}/login-flow/${RUN}`);

		expect(host.asked).toEqual([['checkout-app', 'login-flow', RUN, SERIAL]]);
		expect(
			screen.getByText('Everything this lease wrote; nothing is added once it ends.'),
		).toBeDefined();
		expect(besideTheTree(container).getByText(SERIAL)).toBeDefined();
		// The run's own contents hang under its node, exactly as they do in the `All` view — the
		// `<serial>` is hopped rather than drawn, here off the answer rather than off `onlyChild`.
		expect(treeRows()).toEqual([
			'checkout-app',
			GROUP,
			'login-flow',
			RUN,
			// Artifacts first inside the run, which is one level's one answer in both views (#208).
			'screenshots',
			'device_info.json',
			OLDER,
			OTHER_GROUP,
		]);
	});

	/*
	 * **The selection is an address**: a reload and a shared link land on it. Rendering straight at
	 * a deep splat — which is what a reload is — draws that level with the tree expanded to it, and
	 * every row of that tree is a `/groups/…` address.
	 */
	it('lands on a deep selection straight from the address, on its own routes', async () => {
		await grouped(`checkout-app/${GROUP}/login-flow/${RUN}/${SERIAL}/screenshots`);

		expect(screen.getByText('Everything filed under this directory.')).toBeDefined();
		expect(treeRows()).toEqual([
			'checkout-app',
			GROUP,
			'login-flow',
			RUN,
			// Artifacts first inside the run, which is one level's one answer in both views (#208).
			'screenshots',
			'device_info.json',
			OLDER,
			OTHER_GROUP,
		]);
		// **Every row of this tree is an address of this view**, never of the file explorer: the
		// two arrangements are two route families and a row may not leave the one it is drawn in.
		const tree = document.querySelector('aside');
		for (const row of tree?.querySelectorAll('a') ?? []) {
			expect(row.getAttribute('href')).toMatch(/^\/groups(\/|$)/);
		}
		// The open folder's own row goes to its own address, which is where every row goes since
		// #198 — clicking it a second time closes it through the open set rather than by landing one
		// level up (#175's gesture, this issue's destination) — and that address is a `/groups` one.
		expect(screen.getByRole('link', { name: 'screenshots' }).getAttribute('href')).toBe(
			`/groups/checkout-app/${GROUP}/login-flow/${RUN}/${SERIAL}/screenshots`,
		);
		expect(document.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toContain(GROUP);
	});

	/*
	 * **The field is here now, over the grouped runs alone** (#207, reversing #181's *absent here* in
	 * place). The argument was about addresses, and an address composes — `archiveAddressOf` drops
	 * the group id and `groupsAddressOf` puts it back. The population is what differs, and it is what
	 * the field says.
	 */
	it('draws the field, over the grouped runs alone', async () => {
		await grouped(undefined);

		expect(screen.getByText('DIRECTORY')).toBeDefined();
		expect(screen.getByLabelText('Search the grouped runs')).toBeDefined();
		expect(screen.queryByLabelText('Search the whole archive')).toBeNull();
	});

	/*
	 * **No badge, at any depth.** This view is one bounded walk, so a count over it would read as a
	 * count of a set and could be short without saying so — the same rule that makes the badge
	 * absent at a run rather than an exception to it.
	 */
	it('shows no badge at the root, where the All view shows one', async () => {
		const { container } = await grouped(undefined);

		expect(container.textContent).not.toContain('archived');
	});

	it('shows no badge at a project either', async () => {
		const { container } = await grouped('checkout-app');

		expect(container.textContent).not.toContain('archived');
	});

	// A partial arrangement must not read like a complete one — said above the rows, as the
	// searched tree says it.
	it('says nothing about truncation when the walk was complete', async () => {
		await grouped(undefined);

		expect(screen.queryByText(/could examine/)).toBeNull();
	});

	it('says so when the walk was cut short', async () => {
		host.groups = { ...(groupings() as object), truncated: true };
		await grouped(undefined);

		expect(screen.getByText(/More is filed here than the host could examine/)).toBeDefined();
	});
});

/**
 * **The comparison card** (#199) — the one row of this screen's table the two views do not share.
 *
 * A lease names a group and files an artifact under a label, and the same label on an artifact of
 * two runs is the caller saying *these two are the same thing at two moments* (#150, R41). Selecting
 * such an artifact in this view stands them side by side, oldest run on the left. Everything else —
 * an artifact with no label, a label only one run filed, the `All` view at any depth — draws the
 * single preview it always drew, so an archive that never used labels sees no change at all.
 */
describe('a labelled artifact open in the testing groups view', () => {
	const SERIAL_LEVEL = ['checkout-app', 'login-flow', RUN, SERIAL];
	const OLDER_SERIAL_LEVEL = ['checkout-app', 'login-flow', OLDER, 'emulator-5554'];
	const SCREENSHOTS = [...SERIAL_LEVEL, 'screenshots'];
	/** The label both arms filed, and the one only the newer arm did. */
	const LABEL = 'home-baseline';
	const ONE_ARM_ONLY = 'home-after';
	/** The three files in the newer run's folder: labelled, labelled once, and not labelled at all. */
	const COMPARED = [...SCREENSHOTS, '001_screenshot.png'];
	const ALONE = [...SCREENSHOTS, '002_screenshot.png'];
	const UNLABELLED = [...SCREENSHOTS, '003_screenshot.png'];
	/**
	 * The older arm's artifact under the same label — never listed, only ever answered.
	 *
	 * **Its name differs from the newer arm's on purpose.** The two arms are the same file of two
	 * runs in the common case, and they were both `001_screenshot.png` here until the pane's head
	 * stopped naming the run: *oldest on the left* is this card's own claim, and the body's `alt` is
	 * now the only thing in the DOM that says which arm a pane is. Nothing about the arrangement
	 * depends on the name, and `comparison-card.test.tsx` covers the head itself.
	 */
	const OLDER_COMPARED = [...OLDER_SERIAL_LEVEL, 'screenshots', '000_screenshot.png'];

	const PNG = {
		outcome: 'read',
		mediaType: 'image/png',
		bytes: new Blob(['the-png-bytes'], { type: 'image/png' }),
	};

	/** The archive above, plus the newer run's own folder. */
	function withScreenshots(): Record<string, unknown> {
		return {
			...archive(),
			[JSON.stringify(SCREENSHOTS)]: listed(
				{ kind: 'file', name: '001_screenshot.png', sizeBytes: 421_112 },
				{ kind: 'file', name: '002_screenshot.png', sizeBytes: 398_004 },
				{ kind: 'file', name: '003_screenshot.png', sizeBytes: 12_004 },
			),
		};
	}

	/** The grouping answer with labels on it — the same two runs of the same group as everywhere. */
	function labelled(): unknown {
		return {
			outcome: 'listed',
			truncated: false,
			groups: [
				{
					project: 'checkout-app',
					groupId: GROUP,
					// The host's own ascending order, oldest first.
					runs: [
						groupRun('login-flow', OLDER, 'emulator-5554', {
							'000_screenshot.png': LABEL,
						}),
						groupRun('login-flow', RUN, SERIAL, {
							'001_screenshot.png': LABEL,
							'002_screenshot.png': ONE_ARM_ONLY,
						}),
					],
				},
				{ project: 'checkout-app', groupId: OTHER_GROUP, runs: [groupRun('basket', RUN)] },
			],
		};
	}

	/** One archive address of the newer run, as this view's own splat — the group id put back in. */
	function splatFor(address: readonly string[]): string {
		return ['checkout-app', GROUP, ...address.slice(1)].join('/');
	}

	beforeEach(() => {
		host.groups = labelled();
		host.artifact = PNG;
	});

	it('stands the label’s artifacts side by side, oldest run on the left', async () => {
		const { container } = await grouped(splatFor(COMPARED), withScreenshots());

		const card = besideTheTree(container);
		// The label names the card, and it is the label as the archive filed it.
		expect(card.getByRole('heading', { level: 2 }).textContent).toBe(LABEL);
		const panes = [...(container.querySelectorAll('article') ?? [])];
		expect(panes).toHaveLength(2);
		// Oldest → newest, left to right: the departure from *most recent first*, drawn. Read off
		// each pane's own body, which is what says which arm it is now the head carries the badge.
		expect(panes[0]?.querySelector('img')?.getAttribute('alt')).toBe('000_screenshot.png');
		expect(panes[1]?.querySelector('img')?.getAttribute('alt')).toBe('001_screenshot.png');
	});

	/*
	 * **`host.artifacts` is exactly the pane addresses**, in the archive's own path vocabulary with
	 * no group id in it — and the selected address is **not read twice**, because the screen's own
	 * hook is gated on the comparison.
	 */
	it('reads each pane’s own artifact once, and the selected one no second time', async () => {
		await grouped(splatFor(COMPARED), withScreenshots());

		expect(host.artifacts).toEqual([OLDER_COMPARED, COMPARED]);
	});

	// The header claims the order out loud, the way *most recent first* is claimed one level up —
	// and the badge is still absent, at this depth as at every other in this view.
	it('describes the card, and still carries no badge', async () => {
		const { container } = await grouped(splatFor(COMPARED), withScreenshots());

		expect(
			screen.getByText('The artifacts filed under this label in this group, oldest first.'),
		).toBeDefined();
		expect(container.textContent).not.toContain('One artifact from this run');
		expect(container.textContent).not.toContain('archived');
	});

	/*
	 * **The tree is still beside it and the run's cards are still nowhere** (#160). This is one more
	 * state of the one card, not a second screen — and the breadcrumb is a path rather than a label,
	 * with the `<serial>` in no segment of it (§11's list of what the reference screen got wrong).
	 */
	it('is one state of this screen: the tree beside it, the path in the trail', async () => {
		const { container } = await grouped(splatFor(COMPARED), withScreenshots());

		expect(container.querySelector('aside')).not.toBeNull();
		expect(container.textContent).not.toContain('Run Details');
		expect(container.textContent).not.toContain('DEVICE — FROM device_info.json');
		const trail = document.querySelector('nav[aria-label="Breadcrumb"]');
		expect(trail?.querySelector('li:last-child > *')?.textContent).toBe(
			'screenshots/001_screenshot.png',
		);
		expect(trail?.textContent).toContain(GROUP);
		expect(trail?.textContent).not.toContain(SERIAL);
	});

	// One pane is not a comparison, so a label only this run filed draws the preview it always drew.
	it('draws the single preview for a label only one run filed', async () => {
		const { container } = await grouped(splatFor(ALONE), withScreenshots());

		expect(besideTheTree(container).getByRole('heading', { level: 2 }).textContent).toBe(
			'002_screenshot.png',
		);
		expect(container.querySelectorAll('article')).toHaveLength(0);
		expect(screen.getByText('One artifact from this run, as it was written.')).toBeDefined();
		expect(host.artifacts).toEqual([ALONE]);
	});

	// And an artifact the answer filed under no label at all — the common case, unchanged.
	it('draws the single preview for an artifact with no label', async () => {
		const { container } = await grouped(splatFor(UNLABELLED), withScreenshots());

		expect(besideTheTree(container).getByRole('heading', { level: 2 }).textContent).toBe(
			'003_screenshot.png',
		);
		expect(host.artifacts).toEqual([UNLABELLED]);
	});

	// **The `All` view is untouched.** Its rows carry no label by construction, so the same file
	// there is the single preview at every depth — and the grouping walk is not even asked for.
	it('leaves the All view showing the single preview for the same file', async () => {
		const { container } = await showing(COMPARED.join('/'), withScreenshots());

		expect(container.querySelectorAll('article')).toHaveLength(0);
		expect(besideTheTree(container).getByRole('heading', { level: 2 }).textContent).toBe(
			'001_screenshot.png',
		);
		expect(host.groupings).toBe(0);
	});

	/*
	 * **A deep link does not wait on the grouping walk** — this screen's own rule (`Content`), so
	 * the single preview is drawn from the first frame and becomes the comparison when the walk
	 * answers. The cost is one artifact read repeated, which is stated rather than worked around.
	 */
	it('browses while the grouping walk is out, then draws the comparison when it answers', async () => {
		let answer: () => void = () => undefined;
		host.groupsGate = new Promise<void>((resolve) => {
			answer = resolve;
		});
		at.splat = splatFor(COMPARED);
		host.answers = new Map(Object.entries(withScreenshots()));
		const { container } = render(<ArchiveScreen view="groups" />);
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		// The single preview, with no wait: the address below the `<serial>` is fully in the URL.
		expect(container.querySelectorAll('article')).toHaveLength(0);
		expect(screen.queryByText("Reading the testing groups on this host's archive.")).toBeNull();
		expect(host.artifacts).toEqual([COMPARED]);

		answer();
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		expect(container.querySelectorAll('article')).toHaveLength(2);
		// And the one duplicate read the deep link costs, rather than a third address.
		expect(host.artifacts).toEqual([COMPARED, OLDER_COMPARED, COMPARED]);
	});
});

/**
 * The three empty-handed answers of this view, and **no two of them render alike** (D6) — the same
 * rule §9 already holds the `All` view's three to.
 */
describe('the testing groups view with nothing to arrange', () => {
	it('says it is reading, in one line and with no spinner', () => {
		at.splat = undefined;
		host.hangs = true;
		const { container } = render(<ArchiveScreen view="groups" />);

		expect(screen.getByText("Reading the testing groups on this host's archive.")).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
		expect(screen.queryByText('DIRECTORY')).toBeNull();
	});

	it('says no lease has named a group, and shows no tree beside it', async () => {
		host.groups = { outcome: 'listed', groups: [], truncated: false };
		const { container } = await grouped(undefined);

		expect(screen.getByText('No testing groups')).toBeDefined();
		expect(screen.queryByText('DIRECTORY')).toBeNull();
		expect(container.textContent).not.toContain('Nothing in the archive');
		expect(container.textContent).not.toContain('ARCHIVE NOT READABLE');
	});

	/*
	 * **A walk that was cut short must not be reported as a definitive negative** (#189 review).
	 * The host sets `truncated` having recorded no group at all whenever a `group_id.json` is not
	 * JSON, a subtree cannot be read, or a bound is reached — so *nothing filed on this host has
	 * named a group* would be a claim about an archive nobody finished examining. The same
	 * distinction the searched tree already draws, one level up.
	 */
	it('does not claim nothing named a group when the walk was cut short', async () => {
		host.groups = { outcome: 'listed', groups: [], truncated: true };
		const { container } = await grouped(undefined);

		expect(screen.getByText('No testing groups')).toBeDefined();
		expect(container.textContent).not.toContain('Nothing filed on this host has named a group');
		expect(container.textContent).toContain('More is filed here than the host could examine');
		expect(container.textContent).toContain('A grouped run may be missing from this view');
	});

	// D6, extended to the pair inside this state: the two claims may never render alike, and neither
	// may borrow a sentence from the `All` view's empty hand or from the unreadable banner.
	it('keeps the cut-short answer apart from the complete one, and from the other two', async () => {
		host.groups = { outcome: 'listed', groups: [], truncated: false };
		const complete = (await grouped(undefined)).container.textContent ?? '';
		cleanup();
		host.groups = { outcome: 'listed', groups: [], truncated: true };
		const short = (await grouped(undefined)).container.textContent ?? '';

		expect(complete).toContain('Nothing filed on this host has named a group');
		expect(short).not.toContain('Nothing filed on this host has named a group');
		expect(complete).not.toContain('More is filed here than the host could examine');
		for (const text of [complete, short]) {
			expect(text).not.toContain('Nothing in the archive');
			expect(text).not.toContain('ARCHIVE NOT READABLE');
		}
	});

	// Nothing ever archived here is *no groups here* to a reader standing in this view: there is no
	// group either way, and what would change it is the same thing.
	it('says the same for a host that has never archived anything', async () => {
		host.groups = { outcome: 'missing' };
		await grouped(undefined);

		expect(screen.getByText('No testing groups')).toBeDefined();
	});

	it('keeps an archive it cannot read apart from one with no groups in it', async () => {
		host.groups = { outcome: 'unreadable' };
		const { container } = await grouped(undefined);

		expect(screen.getByText('ARCHIVE NOT READABLE')).toBeDefined();
		expect(container.textContent).not.toContain('No testing groups');
		expect(screen.queryByText('DIRECTORY')).toBeNull();
	});

	/*
	 * **A deep address does not wait on the walk.** Below the `<serial>` every component of the
	 * archive address is in the URL already, so the tree draws and the card fills in — the same
	 * rule that keeps a deep `All` address off the root gate.
	 */
	it('browses a deep address while the walk is still out', async () => {
		at.splat = `checkout-app/${GROUP}/login-flow/${RUN}/${SERIAL}/screenshots`;
		host.answers = new Map(Object.entries(archive()));
		host.groups = HANGS;
		render(<ArchiveScreen view="groups" />);
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		expect(screen.getByText('DIRECTORY')).toBeDefined();
		expect(screen.queryByText('No testing groups')).toBeNull();
		expect(host.asked).toContainEqual(['checkout-app', 'login-flow', RUN, SERIAL]);
	});
});

/**
 * **The `Keep` checkbox — one flag per test, and the two cards that carry it share it.**
 *
 * It marks a test to be kept once Rover starts sweeping the archive. Nothing sweeps it yet, so the
 * state is deliberately ephemeral and lives on this screen (`pinned-tests.ts`) — which is *why*
 * these assertions belong here rather than beside either card: the test-name card and a run's card
 * are never on screen together, so *ticking one lights the other* is a claim only the screen can
 * make.
 */
describe('the Keep checkbox', () => {
	const box = () => screen.getByRole('checkbox', { name: 'Keep' }) as HTMLInputElement;

	/*
	 * The navigation is a `rerender` with a new splat rather than a fresh `render`: the flag lasts as
	 * long as the screen is mounted, which is the whole of what this test is about, and a remount
	 * would be a different question with an obvious answer.
	 */
	it('ticks on a run and is already ticked on that run’s test', async () => {
		const { rerender } = await showing(`checkout-app/login-flow/${RUN}`);
		expect(box().checked).toBe(false);

		fireEvent.click(box());
		expect(box().checked).toBe(true);

		at.splat = 'checkout-app/login-flow';
		await act(async () => {
			rerender(<ArchiveScreen view="all" />);
		});

		// `Run Details` heads the run's card and nothing else, so its absence is the navigation
		// having happened — `getByText('login-flow')` would match the tree row as well as the card.
		expect(screen.queryByText('Run Details')).toBeNull();
		expect(box().checked).toBe(true);
	});

	it('unticks from either card', async () => {
		const { rerender } = await showing('checkout-app/login-flow');
		fireEvent.click(box());
		expect(box().checked).toBe(true);

		at.splat = `checkout-app/login-flow/${RUN}`;
		await act(async () => {
			rerender(<ArchiveScreen view="all" />);
		});
		fireEvent.click(box());

		at.splat = 'checkout-app/login-flow';
		await act(async () => {
			rerender(<ArchiveScreen view="all" />);
		});
		expect(box().checked).toBe(false);
	});

	/*
	 * **Only the two cards that are about a test carry it.** The card above a run also draws the
	 * root and a project, and every directory *below* the `<serial>` — all of which are addresses
	 * that pass through a test without being about one.
	 */
	it('is drawn at a test name and at a run, and at no other depth', async () => {
		for (const [splat, drawn] of [
			[undefined, false],
			['checkout-app', false],
			['checkout-app/login-flow', true],
			[`checkout-app/login-flow/${RUN}`, true],
			[`checkout-app/login-flow/${RUN}/R5CT30ABCDE`, false],
			[`checkout-app/login-flow/${RUN}/R5CT30ABCDE/screenshots`, false],
		] as const) {
			const { unmount } = await showing(splat);

			expect(screen.queryAllByRole('checkbox', { name: 'Keep' })).toHaveLength(drawn ? 1 : 0);
			unmount();
		}
	});

	/*
	 * **The same test is the same flag in the groups view**, which is what keying it on the *archive*
	 * address buys: a groups address carries a group id the archive has no directory for, and keying
	 * on the address as the URL spells it would have pinned `checkout-app/app-bar-top-space` — a
	 * name that is not a test — leaving the tick invisible from the `All` view.
	 */
	it('carries a tick made in one view into the other', async () => {
		const { rerender } = await showing('checkout-app/login-flow');
		fireEvent.click(box());

		at.splat = `checkout-app/${GROUP}/login-flow`;
		await act(async () => {
			rerender(<ArchiveScreen view="groups" />);
		});

		expect(box().checked).toBe(true);
	});
});
