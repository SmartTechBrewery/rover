import type { DeviceListState } from '@panel/devices/device-list-provider.js';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * `devices.test.tsx`'s shape: a `Link` is a plain anchor and `createRoute` is here because this
 * module builds two at import. `useParams` is what puts the screen at a level — the path is the
 * whole of this screen's state, so one test is one address.
 */
const { at, navigated } = vi.hoisted(() => ({
	at: { splat: undefined as string | undefined },
	/**
	 * Every programmatic navigation this screen made — the panel's first, and the one a settled
	 * `Remove` performs (#276).
	 *
	 * A spy rather than a real router, for `Link`'s reason: what is worth asserting is *where* the
	 * screen sent the reader and *that it replaced* the entry, not that TanStack can route. Nothing
	 * here moves `useParams`, so a navigation in this file is recorded and leaves the address where
	 * the test put it — which is what lets one case assert the destination and the re-read
	 * separately from what the destination would then draw.
	 */
	navigated: { calls: [] as unknown[] },
}));
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
	useNavigate: () => (options: unknown) => {
		navigated.calls.push(options);
	},
}));

/**
 * **The device list, mocked to *no lease live* by default** (#287) — not optional, because
 * `useDeviceList` throws outside its provider and this screen reads it for one bit: whether
 * anything is being written into the archive, which is what runs the level cache's clock
 * (`archive/live-writes.ts`). `devices.test.tsx`'s own shape, and the default is what keeps every
 * case below counting the requests it counted before there was a clock.
 */
const { list } = vi.hoisted(() => ({
	list: { state: { status: 'loading' } as DeviceListState },
}));
vi.mock('@panel/devices/device-list-provider.js', () => ({
	useDeviceList: () => ({ state: list.state, refresh: () => undefined }),
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
		 * Every scope `measure_archive` was asked to walk (#261) — logged apart from the listings for
		 * the reason the search is: *one call per scope*, and *an artifact costs no request at all*,
		 * are assertable only if the two are counted separately.
		 */
		measures: [] as unknown[],
		/** What the host answers a measurement with — the size badge's own three outcomes. */
		measure: { outcome: 'measured', bytes: 8_074_035, truncated: false } as unknown,
		/**
		 * Every scope `measure_archive_groups` was asked to walk (#262) — logged apart from the
		 * addresses above for that log's own reason, one step further: *a group's badge is one
		 * request and not one per run*, and *the groups view's depths below a group go to the
		 * address method*, are assertable only if the two measures are counted separately.
		 */
		groupMeasures: [] as unknown[],
		/** What the host answers a grouped measurement with — the same three outcomes. */
		groupMeasure: { outcome: 'measured', bytes: 8_074_035, truncated: false } as unknown,
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
		/**
		 * The same, one method over: a gate every **listing** waits behind, so a case can watch this
		 * screen while a refresh of the drawn levels is still out (#287). That is the one thing a
		 * clock adds that has to be looked at mid-flight — *no level that has an answer falls back
		 * to reading* is a claim about exactly that moment, and `hangs` cannot express it because a
		 * request it swallows is never answered at all.
		 */
		listingGate: null as null | Promise<void>,
		/**
		 * **Which tests this host keeps** — the `Keep` flag, which is host state since #237. The
		 * mock applies each press to it the way `src/daemon/kept-tests.ts` does, so *ticking a test's
		 * card lights its run's* is a fact about one set rather than about two mocked answers.
		 */
		kept: [] as readonly { readonly project: string; readonly testName: string }[],
		/** How many times the whole set was read — **once per mount**, and nothing refreshes it. */
		keptReads: 0,
		/** Every press, in order — one per press however many tests it stood over. */
		presses: [] as unknown[],
		/** What `list_kept_tests` answers instead of the set, for the states that draw no tick. */
		keptAnswer: null as unknown,
		/** What `set_kept_tests` answers instead of the new set — a press the host did not make. */
		pressAnswer: null as unknown,
		/**
		 * Every `delete_archived_test` this screen asked for, in order — logged apart from the
		 * listings for the reason the search and the measures are: *one call per confirmed press*,
		 * and *nothing is deleted by a control being drawn*, are assertable only if it is counted
		 * separately (#276).
		 */
		deletes: [] as unknown[],
		/** What the host answers a delete with, or `null` for the ask that reached nothing. */
		deleted: null as unknown,
		/**
		 * Every `delete_archived_group` this screen asked for, in order — logged apart from the
		 * test's deletes for the reason those are logged apart from the listings: *the group's card
		 * calls the group's method and never the test's* is assertable only if the two are counted
		 * separately (#277).
		 */
		groupDeletes: [] as unknown[],
		/** What the host answers a group delete with, or `null` for the ask that reached nothing. */
		groupDeleted: null as unknown,
		/** Accepts every request and never answers it — the state before the first answer. */
		hangs: false,
	},
}));
vi.mock('@panel/session/session-provider.js', () => {
	/** One level's listing, logged as asked for. */
	const listing = async (path: readonly string[], signal?: AbortSignal) => {
		host.asked.push(path);
		if (host.hangs) {
			return await new Promise(() => undefined);
		}
		if (host.listingGate !== null) {
			/*
			 * **A caller that abandons the request is answered `unanswered`**, which is
			 * `host-client.ts`'s own contract for an aborted `fetch` (#289 review). Without it the
			 * request deadline is invisible to this file, and *a slow host is not an unreadable one*
			 * could not be asserted at the screen's level at all — the gate would simply answer late
			 * and the screen would never see the difference.
			 */
			const abandoned = new Promise<{ ok: false; refusal: 'unanswered' }>((resolve) => {
				signal?.addEventListener('abort', () => resolve({ ok: false, refusal: 'unanswered' }));
			});
			const raced = await Promise.race([host.listingGate.then(() => null), abandoned]);
			if (raced !== null) {
				return raced;
			}
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
	/** One scope's measurement, logged apart — see `call` below (#261). */
	const measure = async (path: readonly string[]) => {
		host.measures.push(path);
		if (host.hangs || host.measure === HANGS) {
			return await new Promise(() => undefined);
		}
		return { ok: true, value: { type: 'result', result: host.measure } };
	};
	/** One grouped scope's measurement, logged apart — see `call` below (#262). */
	const measureGroups = async (params: unknown) => {
		host.groupMeasures.push(params);
		if (host.hangs || host.groupMeasure === HANGS) {
			return await new Promise(() => undefined);
		}
		return { ok: true, value: { type: 'result', result: host.groupMeasure } };
	};
	/** The one grouping walk, counted apart for the same reason (#181). */
	const grouping = async (signal?: AbortSignal) => {
		host.groupings += 1;
		if (host.hangs || host.groups === HANGS) {
			return await new Promise(() => undefined);
		}
		if (host.groupsGate !== null) {
			/*
			 * **A caller that abandons the walk is answered `unanswered`**, exactly as a listing's own
			 * gate answers it (#289 review, #288). The walk carries a deadline of its own while a lease
			 * is live, so a gate that could only ever answer late would make that deadline invisible
			 * to this file — and *the arrangement is left standing rather than replaced* is a claim
			 * about precisely the moment it is spent.
			 */
			const abandoned = new Promise<{ ok: false; refusal: 'unanswered' }>((resolve) => {
				signal?.addEventListener('abort', () => resolve({ ok: false, refusal: 'unanswered' }));
			});
			const raced = await Promise.race([host.groupsGate.then(() => null), abandoned]);
			if (raced !== null) {
				return raced;
			}
		}
		return { ok: true, value: { type: 'result', result: host.groups } };
	};
	/** The whole kept set, counted apart because *once per mount* is what is worth asserting. */
	const keptTests = async () => {
		host.keptReads += 1;
		if (host.hangs || host.keptAnswer === HANGS) {
			return await new Promise(() => undefined);
		}
		const result = host.keptAnswer ?? { outcome: 'listed', tests: host.kept };
		return { ok: true, value: { type: 'result', result } };
	};
	/**
	 * One press, applied to the set the way the host applies it — a union of the tests it names, or
	 * a difference — and answered with the whole set afterwards (R29). Doing the arithmetic here is
	 * what makes the two cards' shared flag assertable: the panel is told what the host now holds
	 * and draws nothing of its own.
	 */
	/*
	 * The pair the host keys a kept test by, joined on NUL for `archive-path.ts`'s reason: it is one
	 * of the two characters an archive path component cannot contain, so no two pairs collide. It is
	 * an escape rather than a byte in this file — a literal NUL makes git call the file binary and
	 * stops its diff being reviewable.
	 */
	const keptKeyOf = (test: { project: string; testName: string }) =>
		`${test.project}\u0000${test.testName}`;
	/**
	 * One confirmed `Remove`, logged apart — see `route` below. `null` is the fifth case rather than
	 * an outcome: no answer at all, which is what leaves the dialog open and the screen untouched.
	 */
	const deleteTest = async (params: unknown) => {
		host.deletes.push(params);
		if (host.hangs) {
			return await new Promise(() => undefined);
		}
		if (host.deleted === null) {
			return { ok: false, refusal: 'unanswered' };
		}
		return { ok: true, value: { type: 'result', result: host.deleted } };
	};
	/** One confirmed `Remove` on a group's card, logged apart — see `route` below (#277). */
	const deleteGroup = async (params: unknown) => {
		host.groupDeletes.push(params);
		if (host.hangs) {
			return await new Promise(() => undefined);
		}
		if (host.groupDeleted === null) {
			return { ok: false, refusal: 'unanswered' };
		}
		return { ok: true, value: { type: 'result', result: host.groupDeleted } };
	};
	const keepPress = async (params: {
		tests: readonly { project: string; testName: string }[];
		kept: boolean;
	}) => {
		host.presses.push(params);
		if (host.hangs) {
			return await new Promise(() => undefined);
		}
		if (host.pressAnswer === null) {
			const named = new Set(params.tests.map(keptKeyOf));
			host.kept = params.kept
				? [...host.kept.filter((test) => !named.has(keptKeyOf(test))), ...params.tests]
				: host.kept.filter((test) => !named.has(keptKeyOf(test)));
		}
		const result = host.pressAnswer ?? { outcome: 'set', tests: host.kept };
		return { ok: true, value: { type: 'result', result } };
	};

	/**
	 * Which of the seven methods a call is (#146, #181, #237, #261, #262) — read off `method` rather
	 * than assumed to be a listing: the tree card's field asks `search_archive`, the groups view
	 * asks `list_archive_groups`, the `Keep` tick reads and writes the host's kept set, and the size
	 * badge asks `measure_archive` for an address and `measure_archive_groups` for one of the groups
	 * view's three shallow scopes. *Searching issues no extra `list_archive`*, *the groups view
	 * lists nothing above a run*, *a group's press is one request*, *a group's badge is one request*
	 * and *an artifact is measured out of the listing* are assertable only because each is logged
	 * apart.
	 *
	 * It is out here rather than inline on `call` below so the dispatch is one branch per method at
	 * one nesting level; `call` is what a screen holds and this is what it asks.
	 */
	const route = async (
		method: string,
		params: {
			path: readonly string[];
			text?: string;
			tests?: readonly { project: string; testName: string }[];
			kept?: boolean;
		},
		/**
		 * The caller's deadline, which only a listing and the grouping walk carry, and only under
		 * their own clocks (#287, #288).
		 */
		signal?: AbortSignal,
	) => {
		if (method === 'search_archive') {
			return await search(params.text);
		}
		if (method === 'list_archive_groups') {
			return await grouping(signal);
		}
		if (method === 'measure_archive') {
			return await measure(params.path);
		}
		if (method === 'measure_archive_groups') {
			return await measureGroups(params);
		}
		if (method === 'list_kept_tests') {
			return await keptTests();
		}
		const written = await wrote(method, params);
		return written ?? (await listing(params.path, signal));
	};

	/**
	 * The three methods that **change** something on the host — the `Keep` press and the two deletes
	 * — or `undefined` for a method that is none of them (#277).
	 *
	 * Split out of {@link route} rather than three more branches in it: the reads there are one
	 * branch each and stay that way, and this half is the one that grows with every operator action
	 * the screen gains.
	 */
	const wrote = async (
		method: string,
		params: {
			tests?: readonly { project: string; testName: string }[];
			kept?: boolean;
		},
	) => {
		if (method === 'set_kept_tests') {
			return await keepPress(params as Parameters<typeof keepPress>[0]);
		}
		if (method === 'delete_archived_test') {
			return await deleteTest(params);
		}
		if (method === 'delete_archived_group') {
			return await deleteGroup(params);
		}
		return undefined;
	};

	return {
		useSession: () => ({
			/*
			 * The signed-in identity, which is what the `Keep` press is attributed with (D20, D28) —
			 * the panel derives nothing from the credential, and this is the one thing on `state`
			 * that any of these screens reads.
			 */
			state: {
				status: 'signed-in',
				identity: { identifier: 'karolina', displayName: 'Karolina' },
			},
			call: route,
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

import { GROUPS_WALK_MS } from '@panel/archive/archive-groups.js';
import { ARCHIVE_POLL_MS } from '@panel/archive/archive-levels.js';
import { SEARCH_DEBOUNCE_MS } from '@panel/archive/archive-search.js';
import { ArchiveScreen } from './archive.js';

/** One held device, which is the whole of *something is being written into the archive*. */
function leaseIsLive(): DeviceListState {
	return {
		status: 'ready',
		stale: false,
		staleReason: null,
		receivedAtMs: 1_757_000_000_000,
		devices: [
			{
				serial: SERIAL,
				platform: 'android',
				model: 'Pixel 7',
				osVersion: '16',
				state: 'ready',
				heldBy: {
					serial: SERIAL,
					owner: 'issue-287',
					project: 'checkout-app',
					testName: 'login-flow',
					grantedAt: '2026-09-10T09:14:03.000Z',
					expiresInMs: 540_000,
				},
			},
		],
	};
}

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

/**
 * The tree card's rows, in the order they are drawn — the one pane a level's arrangement is in.
 *
 * **Drawn is narrower than mounted since #280.** A branch that has been open keeps its rows once it
 * is shut, so a *collapse* has something on screen to move; `visibility: hidden` on the wrapper is
 * what takes every one of them off the screen, out of the tab order and out of the accessibility
 * tree. The stylesheet is not loaded here, so the class is read instead — the same thing said one
 * step earlier, and `tests/unit/panel/branch-motion-is-a-transition.test.ts` is what pins the class
 * to that behaviour.
 */
function treeRows(): readonly (string | null)[] {
	const tree = document.querySelector('aside');
	return [...(tree?.querySelectorAll('a') ?? [])]
		.filter((row) => row.closest('.tree-branch:not(.tree-branch-open)') === null)
		.map((row) => row.textContent);
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
	/*
	 * **What follows the settled-`Remove` region**, which is always in the DOM and empty when there
	 * is nothing to say (#276): a live region announced reliably has to exist before its text does,
	 * so it cannot be mounted with the line. It is chrome above the content area exactly as the
	 * header is, and a state's claim to offer *no control* is a claim about neither of them.
	 */
	const content = container.querySelector(':scope > div[aria-live="polite"] + *');
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
	host.measures = [];
	host.measure = { outcome: 'measured', bytes: 8_074_035, truncated: false };
	host.groupMeasures = [];
	host.groupMeasure = { outcome: 'measured', bytes: 8_074_035, truncated: false };
	host.groupings = 0;
	host.groups = groupings();
	host.file = { outcome: 'missing' };
	host.fileByName = {};
	host.artifact = { outcome: 'missing' };
	host.artifactByName = {};
	host.groupsGate = null;
	host.listingGate = null;
	host.kept = [];
	host.keptReads = 0;
	host.presses = [];
	host.keptAnswer = null;
	host.pressAnswer = null;
	host.hangs = false;
	host.deleted = null;
	host.deletes = [];
	host.groupDeleted = null;
	host.groupDeletes = [];
	navigated.calls = [];
	// No lease live, which is no clock and no requests of its own (#287) — every case below that
	// counts requests counts them against this default.
	list.state = { status: 'loading' };
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

	/*
	 * The count badge is the one count for whatever is selected, and a run is not a count of
	 * anything — corrected in place (#261): *no badge at all* was true while there was one badge,
	 * and the size badge is drawn here, because *how much disk did this run take* is a question a
	 * run has an answer to.
	 */
	it('describes a run, shows no count badge, and still says what the run takes', async () => {
		const { container } = await showing(`checkout-app/login-flow/${RUN}`);

		expect(
			screen.getByText('Everything this lease wrote; nothing is added once it ends.'),
		).toBeDefined();
		expect(container.textContent).not.toContain('archived');
		expect(screen.getByText('This run takes 7.7 MB on disk')).toBeDefined();
		expect(screen.getByText('R5CT30ABCDE')).toBeDefined();
	});

	it('counts in the singular at one', async () => {
		await showing('checkout-app', { ...archive(), '["checkout-app"]': listed(directory('x', 1)) });

		expect(screen.getByText('1 test archived')).toBeDefined();
	});
});

/**
 * **The size badge** — the second badge in the header, and the one that says *how much* (#261, R49,
 * `docs/DESIGN.md` §9).
 *
 * One sentence naming its own scope, one `measure_archive` behind it, and nothing summed here: the
 * badge is what the host answered about one address, or it is not drawn.
 */
describe('what the size badge says', () => {
	/** The header's right-hand slot, in the order it draws — the one row both badges share. */
	function headerAside(container: HTMLElement): readonly (string | null)[] {
		const aside = container.querySelector('header > div > div');
		if (aside === null) {
			throw new Error('the header drew no right-hand slot');
		}
		return [...aside.children].map((child) => child.textContent);
	}

	// One case per depth of the `All` view, because the scope is the whole point of the number and
	// the depth is the whole of what decides it.
	it('names the whole archive at the root', async () => {
		await showing(undefined);

		expect(screen.getByText('All tests take 7.7 MB on disk')).toBeDefined();
	});

	it('names the project, the test name and the run at their own depths', async () => {
		await showing('checkout-app');
		expect(screen.getByText('This project takes 7.7 MB on disk')).toBeDefined();
		cleanup();

		await showing('checkout-app/login-flow');
		expect(screen.getByText('This test takes 7.7 MB on disk')).toBeDefined();
		cleanup();

		await showing(`checkout-app/login-flow/${RUN}`);
		expect(screen.getByText('This run takes 7.7 MB on disk')).toBeDefined();
	});

	// The `<serial>` is a directory to whoever measures it, even though it is not a level of the
	// tree — and a folder the reader opened below it is the same sentence one depth further down.
	it('names a directory inside a run, at the `<serial>` and below it', async () => {
		await showing(`checkout-app/login-flow/${RUN}/R5CT30ABCDE`);
		expect(screen.getByText('This directory takes 7.7 MB on disk')).toBeDefined();
		cleanup();

		await showing(`checkout-app/login-flow/${RUN}/R5CT30ABCDE/screenshots`);
		expect(screen.getByText('This directory takes 7.7 MB on disk')).toBeDefined();
	});

	/*
	 * **The deepest context costs no request at all** — the issue's own observation. `list_archive`
	 * already carries a `sizeBytes` for every file it lists, and the parent level is read anyway
	 * because it is what classified the address; a walk to re-derive that number would be a round
	 * trip for a fact in hand.
	 */
	it('names a file, out of the listing and at no `measure_archive` at all', async () => {
		const SCREENSHOTS = ['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE', 'screenshots'];
		const levels = {
			...archive(),
			[JSON.stringify(SCREENSHOTS)]: listed({
				kind: 'file',
				name: '001_screenshot.png',
				sizeBytes: 421_112,
			}),
		};

		await showing([...SCREENSHOTS, '001_screenshot.png'].join('/'), levels);

		expect(screen.getByText('This file takes 411 KB on disk')).toBeDefined();
		expect(host.measures).toEqual([]);
	});

	// A `sizeBytes` the host could not `stat` is a gap, and the badge says whose it is rather than
	// closing it up with a `0 B` — which is a claim about an empty file.
	it('says a file it could not size could not be sized, never `0 B`', async () => {
		const SCREENSHOTS = ['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE', 'screenshots'];
		const levels = {
			...archive(),
			[JSON.stringify(SCREENSHOTS)]: listed({
				kind: 'file',
				name: '001_screenshot.png',
				sizeBytes: null,
			}),
		};

		const { container } = await showing([...SCREENSHOTS, '001_screenshot.png'].join('/'), levels);

		expect(
			screen.getByText('The host could not measure what this file takes on disk'),
		).toBeDefined();
		expect(container.textContent).not.toContain('0 B');
	});

	// Absent, not `0`, while the walk is still out — the count badge's own rule over the other kind
	// of number, and the reason a slow archive draws no figure rather than a wrong one.
	it('is absent while the answer is still out, with the count badge still there', async () => {
		host.measure = HANGS;

		const { container } = await showing('checkout-app');

		expect(container.textContent).not.toContain('on disk');
		expect(screen.getByText('2 tests archived')).toBeDefined();
	});

	// Nothing is at the address, so there is nothing to have a size — and `0 B` would be a claim
	// about an empty directory, which is a different fact (D6).
	it('is absent where there is nothing at the address to measure', async () => {
		host.measure = { outcome: 'missing' };

		const { container } = await showing('checkout-app');

		expect(container.textContent).not.toContain('on disk');
		expect(container.textContent).not.toContain('0 B');
	});

	// A sentence of its own, rather than the word `unknown` dropped into a value slot: this badge
	// has no label, so a hole in it would be a hole in a sentence.
	it('says the host could not measure it, rather than `unknown`', async () => {
		host.measure = { outcome: 'unreadable' };

		const { container } = await showing('checkout-app');

		expect(
			screen.getByText('The host could not measure what this project takes on disk'),
		).toBeDefined();
		expect(container.textContent).not.toContain('unknown');
	});

	/*
	 * **A bounded walk renders a lower bound, never a plain figure.** `truncated` means at least one
	 * directory that exists was not fully examined, so the number is short and the sentence says so
	 * — the tree's own truncation rule over a total instead of over a set of rows.
	 */
	it('renders a truncated answer as an explicit lower bound', async () => {
		host.measure = { outcome: 'measured', bytes: 8_074_035, truncated: true };

		const { container } = await showing('checkout-app');

		expect(screen.getByText('This project takes at least 7.7 MB on disk')).toBeDefined();
		expect(container.textContent).not.toContain('takes 7.7 MB');
	});

	// **Nothing is summed in the browser**: one walk, of the selected scope, and of no other — not
	// of the levels the tree happens to have listed on the way down to it.
	it('measures the selected scope once, and no other', async () => {
		await showing('checkout-app/login-flow');

		expect(host.measures).toEqual([['checkout-app', 'login-flow']]);
	});

	/*
	 * **The size leads the row and the toggle is still last** (#261). The badge that comes and goes
	 * appears on the left, so it moves neither the count a reader is reading nor the control they
	 * are reaching for.
	 */
	it('leads the header row — size, then count, then the view toggle', async () => {
		const { container } = await showing('checkout-app');

		expect(headerAside(container)).toEqual([
			'This project takes 7.7 MB on disk',
			'2 tests archived',
			'AllTesting groups',
		]);
	});

	// Both badges are one component now, so the pill is one class string rather than two that drift
	// apart by a border width — and the toggle's frame is that same constant.
	it('draws both badges in one pill treatment', async () => {
		const { container } = await showing('checkout-app');
		const [size, count] = [...(container.querySelector('header > div > div')?.children ?? [])];

		expect(size?.className).toBe(count?.className);
		expect(size?.className).toContain('border-outline-variant');
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
				// The run's own contents, directories first — `level-order.ts`, and the same order
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

	/*
	 * **The claim is *no retry and no error code*, and it is amended in place rather than dropped**
	 * (#276, `ai/RULES.md` §1). It read *no button at all* while these two states were the only
	 * things at this depth; a test name's card carries the `Remove` control now (§9), which is about
	 * the test rather than about either of these answers and is drawn here whatever the level turned
	 * out to be. So what is asserted is that neither state grew a retry, and that the `error` accent
	 * in the markup belongs to that one control (§10's recorded departure) rather than to a level
	 * the host could not read.
	 */
	it('offer no retry and carry no error code', async () => {
		for (const levels of [EMPTY_DEEPER, UNREADABLE_DEEPER]) {
			const { container, unmount } = await showing('checkout-app/login-flow', levels);
			const area = contentArea(container);

			expect(
				[...area.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
			).toEqual(['Remove test login-flow']);
			expect([...area.querySelectorAll('[class*="error"]')].map((node) => node.tagName)).toEqual([
				'BUTTON',
			]);
			expect(area.textContent).not.toContain('error');
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

	// The size answer is the same host's answer about the same address (#261): an archive nothing
	// has ever been filed in has nothing to measure, so this state stays as bare as it claims.
	it('carries neither badge, because there is nothing to measure either', async () => {
		host.measure = { outcome: 'missing' };

		const { container } = await showing(undefined, EMPTY_ROOT);

		expect(container.textContent).not.toContain('archived');
		expect(container.textContent).not.toContain('on disk');
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

	/*
	 * **The header says it in the header's own words** (#261, `docs/DESIGN.md` §9). The listing and
	 * the measurement are two independent answers about one address, and a host that cannot read the
	 * archive cannot size it either — so the badge states that, rather than a figure it does not
	 * have, over a banner stating the other half.
	 */
	it('says the host could not measure it either, rather than a figure', async () => {
		host.measure = { outcome: 'unreadable' };

		const { container } = await showing(undefined, UNREADABLE_ROOT);

		expect(
			screen.getByText('The host could not measure what all tests take on disk'),
		).toBeDefined();
		expect(container.textContent).not.toContain('7.7 MB');
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
 * **A run's directories lead its contents level** (#208, by `kind` rather than by name since #235) —
 * the second departure from *the host's order stands*, and one level's one answer: the tree, the
 * card beside it, both views and a typed `<serial>` address all draw it, so all four are asserted
 * off the same fixture.
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
	 * Every directory, then every file, each half exactly as the host answered it — so the three
	 * directories are in the host's own code-unit order rather than in one this screen chose, and
	 * the sidecar files keep theirs below them. **`logs` leads with the other two**, which is what
	 * naming `screenshots` and `recordings` got wrong (#235).
	 */
	const DIRECTORIES_FIRST = [
		'logs',
		'recordings',
		'screenshots',
		'device_info.json',
		'group_id.json',
		'test_description.json',
	];

	it('puts every directory first, in the tree and in the card alike', async () => {
		const { container } = await showing(`checkout-app/login-flow/${RUN}/${SERIAL}`, EVERYTHING);

		expect(cardRows(container)).toEqual(DIRECTORIES_FIRST);
		// The tree draws the same level, under the run's node, and the levels above it are untouched.
		expect(treeRows()).toEqual([
			'checkout-app',
			'login-flow',
			RUN,
			...DIRECTORIES_FIRST,
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

		expect(cardRows(container)).toEqual(DIRECTORIES_FIRST);
		expect(treeRows()).toEqual([
			'checkout-app',
			GROUP,
			'login-flow',
			RUN,
			...DIRECTORIES_FIRST,
			OLDER,
			OTHER_GROUP,
		]);
	});

	/*
	 * **The case the two names got wrong** (#235). A lease that pulled logs and recorded nothing has
	 * one directory, and it used to sort between `group_id.json` and `test_description.json` — three
	 * sidecar files above the only row that reaches what the run wrote, which is the complaint #208
	 * was filed about.
	 */
	it('lifts a run’s `logs` above the sidecar files beside it', async () => {
		const { container } = await showing(
			`checkout-app/login-flow/${RUN}/${SERIAL}`,
			filed(SIDECARS[0], SIDECARS[1], directory('logs', 1), SIDECARS[2]),
		);

		expect(cardRows(container)).toEqual([
			'logs',
			'device_info.json',
			'group_id.json',
			'test_description.json',
		]);
	});

	// An archive that filed nothing at all draws exactly what it draws today: a level with no
	// directory in it sorts to itself, which two passes in the level's own order give for free.
	it('leaves a level holding no directory in the host’s own order', async () => {
		const { container } = await showing(
			`checkout-app/login-flow/${RUN}/${SERIAL}`,
			filed(...SIDECARS),
		);

		expect(cardRows(container)).toEqual([
			'device_info.json',
			'group_id.json',
			'test_description.json',
		]);
	});

	/*
	 * **`other` is the host declining to classify an entry, and this must not read it as a
	 * directory** (#235). It is reported rather than dropped so that a short listing cannot pass for
	 * a complete one, and it lands with the files — in the host's own place among them.
	 */
	it('does not lift a `kind: "other"` entry', async () => {
		const { container } = await showing(
			`checkout-app/login-flow/${RUN}/${SERIAL}`,
			filed(SIDECARS[0], { kind: 'other', name: 'latest_recording' }, directory('screenshots', 3)),
		);

		expect(cardRows(container)).toEqual(['screenshots', 'device_info.json', 'latest_recording']);
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
		// And the row takes no measure of its own, so it ends where the header does (§4, #240).
		expect(row.className).not.toMatch(/\bmax-w-/);

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
	 * **The counter slot is empty, and that is the rule rather than an exception**: the count badge
	 * is a counter and one file has nothing to count — exactly as §7 leaves the held/free counter
	 * absent rather than showing `0 held · 0 free`. The *size* badge is drawn (#261), out of the
	 * listing that named the file and at no request at all.
	 */
	it('carries no count badge, and describes itself as one artifact', async () => {
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
			// Directories first inside the run, which is one level's one answer in both views (#208).
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
			// Directories first inside the run, which is one level's one answer in both views (#208).
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
	 * **The count badge, at no depth** (amended in place a second time, #262 — it was *neither
	 * badge*, and before that *no badge*). This view is one bounded walk, so a *count* over it would
	 * read as a count of a set and could be short without saying so — the same rule that makes the
	 * count badge absent at a run rather than an exception to it.
	 *
	 * **The size badge is drawn at every depth now, and the two are consistent rather than
	 * contradictory**: a bounded walk cannot be honestly rendered as a count of a set, and it *can*
	 * be rendered as a lower bound, which is what `truncated` is for.
	 */
	it('shows the size badge but no count badge at the root', async () => {
		const { container } = await grouped(undefined);

		expect(screen.getByText('Grouped tests take 7.7 MB on disk')).toBeDefined();
		expect(container.textContent).not.toContain('archived');
	});

	it('shows no count badge at a project either, and never says `all` there', async () => {
		const { container } = await grouped('checkout-app');

		expect(screen.getByText('Grouped tests in this project take 7.7 MB on disk')).toBeDefined();
		expect(container.textContent).not.toContain('archived');
		// The one thing this badge must not do: the view lists only the runs that named a group.
		expect(container.textContent).not.toContain('All tests');
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
 * **The size badge in the groups view** — one sentence per depth, and the two questions behind them
 * (#262, R49, `docs/DESIGN.md` §9).
 *
 * The three shallow depths describe a **subset** of the archive — the runs that named a `group_id`
 * — which no address walk can answer, so they go to `measure_archive_groups`. A group's depth and
 * everything below it is the archive's own address once the group id is dropped, so those go to
 * `measure_archive`, at the same addresses the `All` view uses. Which method a depth asks is
 * asserted beside the sentence, because *no second address vocabulary appears* is the whole reason
 * this view needed only three new scopes.
 */
describe('what the size badge says in the testing groups view', () => {
	const GROUP_ROOT = ['checkout-app', GROUP];
	const TEST_NAME = [...GROUP_ROOT, 'login-flow'];

	// The two wordings the operator did not specify, decided in this phase: they say *grouped* and
	// never *all*, because this view lists only the runs that named a group.
	it('names the grouped runs at the root, and one project’s at a project', async () => {
		await grouped(undefined);
		expect(screen.getByText('Grouped tests take 7.7 MB on disk')).toBeDefined();
		expect(host.groupMeasures).toEqual([{ scope: 'all' }]);
		expect(host.measures).toEqual([]);
		cleanup();

		host.groupMeasures = [];
		await grouped('checkout-app');
		expect(screen.getByText('Grouped tests in this project take 7.7 MB on disk')).toBeDefined();
		expect(host.groupMeasures).toEqual([{ scope: 'project', project: 'checkout-app' }]);
		expect(host.measures).toEqual([]);
	});

	it('names the group at a group', async () => {
		await grouped(GROUP_ROOT.join('/'));

		expect(screen.getByText('Tests in this group take 7.7 MB on disk')).toBeDefined();
		expect(host.groupMeasures).toEqual([
			{ scope: 'group', project: 'checkout-app', groupId: GROUP },
		]);
	});

	/*
	 * **Below a group it is the `All` view's own four sentences, at the `All` view's own addresses**
	 * — the group id dropped, which is the same function every other read below a group already
	 * goes through (`archiveAddressOf`).
	 */
	it('says the All view’s own sentences below a group, at the archive’s own addresses', async () => {
		await grouped(TEST_NAME.join('/'));
		expect(screen.getByText('This test takes 7.7 MB on disk')).toBeDefined();
		expect(host.measures).toEqual([['checkout-app', 'login-flow']]);
		expect(host.groupMeasures).toEqual([]);
		cleanup();

		host.measures = [];
		await grouped([...TEST_NAME, RUN].join('/'));
		expect(screen.getByText('This run takes 7.7 MB on disk')).toBeDefined();
		expect(host.measures).toEqual([['checkout-app', 'login-flow', RUN]]);
		cleanup();

		host.measures = [];
		await grouped([...TEST_NAME, RUN, SERIAL].join('/'));
		expect(screen.getByText('This directory takes 7.7 MB on disk')).toBeDefined();
		expect(host.measures).toEqual([['checkout-app', 'login-flow', RUN, SERIAL]]);
		expect(host.groupMeasures).toEqual([]);
	});

	// And the two depths the parent listing classifies, on the same terms as the `All` view's: a
	// folder is a directory, and a file is measured out of the listing at no request at all.
	it('classifies a directory and a file below the `<serial>` out of the listing', async () => {
		await grouped([...TEST_NAME, RUN, SERIAL, 'screenshots'].join('/'));
		expect(screen.getByText('This directory takes 7.7 MB on disk')).toBeDefined();
		expect(host.measures).toEqual([['checkout-app', 'login-flow', RUN, SERIAL, 'screenshots']]);
		cleanup();

		host.measures = [];
		await grouped([...TEST_NAME, RUN, SERIAL, 'device_info.json'].join('/'));
		expect(screen.getByText('This file takes 80 B on disk')).toBeDefined();
		expect(host.measures).toEqual([]);
		expect(host.groupMeasures).toEqual([]);
	});

	/*
	 * **A group's badge is one request, not one per run** — the whole reason this is a host method
	 * and not a `reduce` over the grouping answer. `GROUP` holds two runs on that answer, and it
	 * would be one `reduce` away with no sizes on it to reduce (§9's *lazily, one `readdir` at a
	 * time*).
	 */
	it('measures a group in one request, whatever the group holds', async () => {
		await grouped(GROUP_ROOT.join('/'));

		expect(host.groupMeasures).toHaveLength(1);
		expect(host.measures).toEqual([]);
	});

	/*
	 * **A bounded walk renders a lower bound, never a plain figure**, and this view is where that
	 * matters most: the grouping walk is bounded, so a grouped total is far likelier to be short
	 * than an address's is.
	 */
	it('renders a truncated grouped total as an explicit lower bound', async () => {
		host.groupMeasure = { outcome: 'measured', bytes: 8_074_035, truncated: true };

		const { container } = await grouped(undefined);

		expect(screen.getByText('Grouped tests take at least 7.7 MB on disk')).toBeDefined();
		expect(container.textContent).not.toContain('take 7.7 MB');
	});

	// The `unmeasurable` sentence of a grouped scope, which is a sentence of its own like every
	// other — and still never the word *all*.
	it('says the host could not measure the grouped runs, rather than a figure', async () => {
		host.groupMeasure = { outcome: 'unreadable' };

		const { container } = await grouped('checkout-app');

		expect(
			screen.getByText(
				'The host could not measure what grouped tests in this project take on disk',
			),
		).toBeDefined();
		expect(container.textContent).not.toContain('7.7 MB');
	});

	// Absent rather than `0 B` while the walk is out and where there is nothing to measure — the
	// count badge's own rule, which this view keeps at its own depths too.
	it('draws nothing while the grouped walk is out, and nothing where there is none', async () => {
		host.groupMeasure = HANGS;
		const { container } = await grouped(undefined);
		expect(container.textContent).not.toContain('on disk');
		cleanup();

		host.groupMeasure = { outcome: 'missing' };
		const second = await grouped(undefined);
		expect(second.container.textContent).not.toContain('on disk');
		expect(second.container.textContent).not.toContain('0 B');
	});

	// The count badge is absent at every depth of this view, size badge or no size badge — the rule
	// #181 settled, unchanged by this phase.
	it('carries no count badge at any depth', async () => {
		for (const splat of [
			undefined,
			'checkout-app',
			GROUP_ROOT.join('/'),
			TEST_NAME.join('/'),
			[...TEST_NAME, RUN].join('/'),
		]) {
			const { container } = await grouped(splat);
			expect(container.textContent).not.toContain('archived');
			cleanup();
		}
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
	// and the *count* badge is still absent, at this depth as at every other in this view (amended
	// in place, #262: the size badge is drawn here, out of the listing that named the artifact).
	it('describes the card, and still carries no count badge', async () => {
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
 * It marks a test to be kept when the host sweeps its archive — by the disk budget after every
 * lease ends, and by both bounds at local midnight and at daemon start (#246). **The flag is the
 * host's**
 * since #237 (D33): this screen reads the whole set once per mount and every press is one
 * `set_kept_tests` whose answer it draws (`pinned-tests.ts`), so what the assertions below watch is
 * the traffic as much as the box. They belong here rather than beside either card for the reason
 * they always did: the test-name card and a run's card are never on screen together, so *ticking
 * one lights the other* is a claim only the screen can make.
 */
describe('the Keep checkbox', () => {
	const box = () => screen.getByRole('checkbox', { name: 'Keep' }) as HTMLInputElement;
	/** A press is a round trip now, so the click and the answer it draws are one act. */
	const tick = async () => {
		await act(async () => {
			fireEvent.click(box());
		});
	};

	/*
	 * The navigation is a `rerender` with a new splat rather than a fresh `render`: what is in
	 * question is that the two cards read one flag, and a remount would be asking a second question
	 * (that the host still holds it) which `is the host's answer and not this mount's` asks on its
	 * own.
	 */
	it('ticks on a run and is already ticked on that run’s test', async () => {
		const { rerender } = await showing(`checkout-app/login-flow/${RUN}`);
		expect(box().checked).toBe(false);

		await tick();
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
		await tick();
		expect(box().checked).toBe(true);

		at.splat = `checkout-app/login-flow/${RUN}`;
		await act(async () => {
			rerender(<ArchiveScreen view="all" />);
		});
		await tick();

		at.splat = 'checkout-app/login-flow';
		await act(async () => {
			rerender(<ArchiveScreen view="all" />);
		});
		expect(box().checked).toBe(false);
	});

	/*
	 * **The tick is drawn from the host's answer, so a remount finds it where it was left** — the
	 * whole point of #237. A fresh `render` is a reload of the page with the same daemon behind it,
	 * which is the state the old ephemeral set could not survive.
	 */
	it('is the host’s answer and not this mount’s', async () => {
		host.kept = [{ project: 'checkout-app', testName: 'login-flow' }];

		const { unmount } = await showing('checkout-app/login-flow');
		expect(box().checked).toBe(true);
		unmount();

		await showing('checkout-app/login-flow');
		expect(box().checked).toBe(true);
	});

	// One read for the whole screen, and the press is the only other thing on this wire: nothing
	// polls the set and nothing refreshes it (`pinned-tests.ts`).
	it('reads the whole set once per mount, and writes only when pressed', async () => {
		await showing('checkout-app/login-flow');

		expect(host.keptReads).toBe(1);
		expect(host.presses).toEqual([]);

		await tick();
		expect(host.keptReads).toBe(1);
		expect(host.presses).toEqual([
			{
				tests: [{ project: 'checkout-app', testName: 'login-flow' }],
				kept: true,
				actor: 'karolina',
			},
		]);
	});

	/*
	 * **No tick at all until the set has answered, and none if it cannot be read.** An empty box for
	 * a test the panel cannot ask about says *this is not kept*, which is a claim about the
	 * operator's own decision that nothing has established (`docs/DESIGN.md` §9).
	 */
	it('is not drawn while the set is out, or on an answer that cannot be read', async () => {
		for (const answer of [HANGS, { outcome: 'unreadable' }]) {
			host.keptAnswer = answer;
			const { unmount } = await showing('checkout-app/login-flow');

			expect(screen.queryAllByRole('checkbox', { name: 'Keep' })).toHaveLength(0);
			// The card itself is drawn — the absence is the tick's own and not the level's.
			expect(screen.getByText('2 runs archived')).toBeDefined();
			unmount();
		}
	});

	/*
	 * **A press the host did not make leaves the tick where it was.** Nothing is written
	 * optimistically, so there is nothing to unwind: the panel renders what it was sent (R29), and
	 * an ask that reached nothing sent nothing.
	 */
	it.each([
		['the host did not write it', { outcome: 'unwritable' }],
		['its cap refused the press', { outcome: 'refused', reason: 'too-many' }],
	])('leaves the tick where it was when %s', async (_case, answer) => {
		host.pressAnswer = answer;
		await showing('checkout-app/login-flow');

		await tick();

		expect(box().checked).toBe(false);
		// The press was made — this is a failed write and not a control that did nothing.
		expect(host.presses).toHaveLength(1);
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
		await tick();

		at.splat = `checkout-app/${GROUP}/login-flow`;
		await act(async () => {
			rerender(<ArchiveScreen view="groups" />);
		});

		expect(box().checked).toBe(true);
	});
});

/**
 * **A group's own `Keep` tick — the same flag as its tests', over all of them at once.**
 *
 * It is a way of ticking a group's tests and not a claim that outranks them: a reader may untick one
 * afterwards, which is deliberately not prevented, and the group's tick then has to say *some*
 * rather than pick one of the two lies (`pinned-tests.ts`, `docs/DESIGN.md` §9).
 */
describe('the Keep tick on a group', () => {
	const box = () => screen.getByRole('checkbox', { name: 'Keep' }) as HTMLInputElement;
	const tick = async () => {
		await act(async () => {
			fireEvent.click(box());
		});
	};

	/** One group, two arms — R41's own `_variant` shape, and the only fixture `mixed` can be seen in. */
	function twoArms() {
		return {
			outcome: 'listed',
			truncated: false,
			groups: [
				{
					project: 'checkout-app',
					groupId: GROUP,
					runs: [groupRun('login-flow_variantA', OLDER), groupRun('login-flow_variantB', RUN)],
				},
			],
		};
	}

	async function atTheGroup() {
		host.groups = twoArms();
		return await grouped(`checkout-app/${GROUP}`);
	}

	it('says the sentence about the group rather than about one test', async () => {
		await atTheGroup();

		const said =
			document.getElementById(box().getAttribute('aria-describedby') ?? '')?.textContent ?? '';
		expect(said).toContain('every test in this group');
		expect(said).toContain('keep them all');
		// The test's own wording is not what a group's tick shows.
		expect(said).not.toContain('Traces of this test');
	});

	/*
	 * **One press, one request, every test in it** — the shape the write takes an array for
	 * (`kept-tests.ts`). Nine calls would leave a partly-written group visible between them and nine
	 * audit lines for one decision, so the count is asserted and not only the outcome.
	 */
	it('is one request carrying every test in the group, never one per test', async () => {
		await atTheGroup();

		await tick();

		expect(host.presses).toEqual([
			{
				tests: [
					{ project: 'checkout-app', testName: 'login-flow_variantA' },
					{ project: 'checkout-app', testName: 'login-flow_variantB' },
				],
				kept: true,
				actor: 'karolina',
			},
		]);
	});

	it('keeps every test in the group, and each test says so on its own card', async () => {
		const { rerender } = await atTheGroup();
		await tick();
		expect(box().checked).toBe(true);

		for (const arm of ['login-flow_variantA', 'login-flow_variantB']) {
			at.splat = `checkout-app/${GROUP}/${arm}`;
			await act(async () => {
				rerender(<ArchiveScreen view="groups" />);
			});
			expect(box().checked).toBe(true);
		}
	});

	/*
	 * The point of the whole arrangement: nothing locks a test to its group's tick, so unticking one
	 * arm leaves the group **part**-kept — `indeterminate`, which is the platform's own third state.
	 */
	it('goes part-kept when one of its tests is unticked, and does not force it back', async () => {
		const { rerender } = await atTheGroup();
		await tick();

		at.splat = `checkout-app/${GROUP}/login-flow_variantB`;
		await act(async () => {
			rerender(<ArchiveScreen view="groups" />);
		});
		await tick();
		expect(box().checked).toBe(false);

		at.splat = `checkout-app/${GROUP}`;
		await act(async () => {
			rerender(<ArchiveScreen view="groups" />);
		});
		expect(box().checked).toBe(false);
		expect(box().indeterminate).toBe(true);
	});

	/** From part-kept, one press keeps the rest rather than clearing the ones already kept. */
	it('keeps the remainder from part-kept', async () => {
		const { rerender } = await atTheGroup();

		at.splat = `checkout-app/${GROUP}/login-flow_variantA`;
		await act(async () => {
			rerender(<ArchiveScreen view="groups" />);
		});
		await tick();

		at.splat = `checkout-app/${GROUP}`;
		await act(async () => {
			rerender(<ArchiveScreen view="groups" />);
		});
		expect(box().indeterminate).toBe(true);

		await tick();
		expect(box().checked).toBe(true);
		expect(box().indeterminate).toBe(false);
	});

	/*
	 * **No tick over a group whose tests nobody has listed.** There is nothing to keep, and a tick
	 * there would be a promise about runs the reader has not been shown.
	 */
	it('is not drawn while the walk is out, or on an answer that cannot be read', async () => {
		for (const answer of [HANGS, { outcome: 'unreadable' }]) {
			host.groups = answer;
			const { unmount } = await grouped(`checkout-app/${GROUP}`);

			expect(screen.queryAllByRole('checkbox', { name: 'Keep' })).toHaveLength(0);
			unmount();
		}
	});
});

/**
 * `Remove` — the control on the two cards a test's tick is on, driven through the whole chain
 * (#276, D43, `docs/DESIGN.md` §9).
 *
 * What each component says on its own is its own suite's (`remove-control.test.tsx`,
 * `remove-dialog.test.tsx`, `remove-notice.test.tsx`). What only this file can assert is the three
 * things that are the *screen's*: which card is handed which scope, what a settled delete does to
 * the address the reader is on, and that the line outlives the card it was about.
 */
describe('the Remove control', () => {
	/** Press the control on whichever card is drawn, and let the dialog's measurement land. */
	async function askToRemove(name = 'Remove test login-flow'): Promise<void> {
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name }));
		});
	}

	/** The value under one of the confirmation's caps labels. */
	function valueUnder(label: string): string {
		return screen.getByText(label).nextElementSibling?.textContent ?? '';
	}

	/**
	 * **Which card gets a control, and it is the two whose tick is about a test** (`levelRemoval`).
	 * The level card draws six different levels and only one of them is a test.
	 */
	it.each([
		['the root', undefined, false],
		['a project', 'checkout-app', false],
		['a test name', 'checkout-app/login-flow', true],
		['a run', `checkout-app/login-flow/${RUN}`, true],
		[
			'a directory below the `<serial>`',
			`checkout-app/login-flow/${RUN}/${SERIAL}/screenshots`,
			false,
		],
	])('is on %s: %s', async (_case, splat, drawn) => {
		const { container } = await showing(splat);

		expect(
			besideTheTree(container).queryAllByRole('button', { name: /^Remove test / }),
		).toHaveLength(drawn ? 1 : 0);
	});

	/*
	 * **A group's card carries the tick *and* the control since #277**, which closed the phase
	 * boundary #276 recorded (§9, R51). The control is the group's own — labelled with the group's
	 * noun, because the two scopes are drawn at the same depth in their two views.
	 */
	it('is on a group’s card, beside its tick, as the group’s own', async () => {
		const { container } = await grouped(`checkout-app/${GROUP}`);

		const card = besideTheTree(container);
		expect(card.getByRole('checkbox', { name: 'Keep' })).toBeDefined();
		expect(card.getByRole('button', { name: `Remove group ${GROUP}` })).toBeDefined();
		// And it is not the test's control wearing a group's name.
		expect(card.queryAllByRole('button', { name: /^Remove test / })).toHaveLength(0);
	});

	/**
	 * **Which card in the groups view gets a group's control, and it is the group's alone** — the
	 * root and a project are levels of the arrangement rather than one group, and a test name and a
	 * run below it are about a test.
	 */
	it.each([
		['the groups root', undefined, 0],
		['a project', 'checkout-app', 0],
		['a group', `checkout-app/${GROUP}`, 1],
		['a test name in a group', `checkout-app/${GROUP}/login-flow`, 0],
		['a run in a group', `checkout-app/${GROUP}/login-flow/${RUN}`, 0],
	])('is on %s: %s', async (_case, splat, drawn) => {
		const { container } = await grouped(splat);

		expect(
			besideTheTree(container).queryAllByRole('button', { name: /^Remove group / }),
		).toHaveLength(drawn);
	});

	/*
	 * **A group whose runs are not listed gets no control**, which is the rule its tick already
	 * keeps. A deep link to a group id nothing on this host named is the one shape of that which
	 * still draws a card — the walk being out or unreadable takes the whole content area — and a
	 * control there would be a press about runs nobody has seen.
	 */
	it('is not on the card for a group id nothing on this host named', async () => {
		const { container } = await grouped('checkout-app/nobody-named-this');

		const card = besideTheTree(container);
		expect(card.queryAllByRole('button', { name: /^Remove group / })).toHaveLength(0);
		// The tick is absent for the same reason, which is what makes this one rule and not two.
		expect(card.queryAllByRole('checkbox', { name: 'Keep' })).toHaveLength(0);
	});

	/**
	 * **The group scope the screen hands over**, read back off the confirmation: the project, the
	 * group id, and the run count off the grouping answer — the same answer the size badge measures,
	 * so it costs no request of its own.
	 */
	it('hands the group and its run count to the confirmation', async () => {
		await grouped(`checkout-app/${GROUP}`);

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: `Remove group ${GROUP}` }));
		});

		// Scoped to the dialog: at a group's depth the card behind it lists test names, which carry
		// a `RUNS` column of their own.
		const dialog = within(screen.getByRole('dialog'));
		const valueInDialog = (label: string): string =>
			dialog.getByText(label).nextElementSibling?.textContent ?? '';
		expect(valueInDialog('PROJECT')).toBe('checkout-app');
		expect(valueInDialog('GROUP')).toBe(GROUP);
		// Two runs of `login-flow` are in this group, and neither the project's other group's run
		// nor the archive's ungrouped ones are.
		expect(valueInDialog('RUNS')).toBe('2 runs');
		expect(dialog.queryByText('KEPT')).toBeNull();
	});

	/*
	 * **And when the grouping walk was cut short, the count it hands over is a bound** (#284 review).
	 * That walk drops runs at its bounds while the delete's own walk is scoped to one project and
	 * reaches runs the listing never did — so a plain figure here would understate an irreversible
	 * action. The control stays: the group is still listed and the delete is still correct about
	 * what it takes.
	 */
	it('hands over a bound rather than a figure when the grouping walk was cut short', async () => {
		host.groups = { ...(groupings() as object), truncated: true };
		await grouped(`checkout-app/${GROUP}`);

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: `Remove group ${GROUP}` }));
		});

		const dialog = within(screen.getByRole('dialog'));
		expect(dialog.getByText('RUNS').nextElementSibling?.textContent).toBe('at least 2 runs');
	});

	// And it calls the group's method, with the group's params — never the test's (R41: the group
	// id is content and not a second path component).
	it('asks the group’s method when the group’s control is confirmed', async () => {
		host.groupDeleted = { outcome: 'refused', reason: 'lease-live' };
		await grouped(`checkout-app/${GROUP}`);

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: `Remove group ${GROUP}` }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Remove group' }));
		});

		expect(host.groupDeletes).toEqual([
			{ project: 'checkout-app', groupId: GROUP, actor: 'karolina' },
		]);
		expect(host.deletes).toHaveLength(0);
	});

	/**
	 * **The scope the screen hands over**, read back off the confirmation because that is where every
	 * field of it is visible — the two components, the run count off the listing the tree already
	 * had, and the `Keep` mark off the set the ticks are drawn from.
	 */
	it('hands the test, its run count and its Keep mark to the confirmation', async () => {
		host.kept = [{ project: 'checkout-app', testName: 'login-flow' }];
		await showing('checkout-app/login-flow');

		await askToRemove();

		expect(valueUnder('PROJECT')).toBe('checkout-app');
		expect(valueUnder('TEST')).toBe('login-flow');
		// 42 is the `childCount` the project's own listing carries for this test — no second request.
		expect(valueUnder('RUNS')).toBe('42 runs');
		expect(valueUnder('KEPT')).toBe('yes');
		expect(host.asked).not.toContainEqual(['checkout-app', 'login-flow', 'childCount']);
	});

	/*
	 * **From a run's card it is the same test**, and the confirmation says in as many words that the
	 * run on screen goes with the rest (D43) — the control is bound to `<project>/<test_name>` out of
	 * the run's own address, exactly as the tick above it is.
	 */
	it('is bound to the test above a run, and says the run goes with it', async () => {
		await showing(`checkout-app/login-flow/${RUN}`);

		await askToRemove();

		expect(valueUnder('TEST')).toBe('login-flow');
		expect(screen.getByRole('dialog').textContent).toContain(
			'The run you are looking at is one of them.',
		);
	});

	/*
	 * **In the groups view the run count is *the host cannot say* rather than a number**, and that is
	 * honest rather than a gap: that view asks `list_archive` for nothing above a run, and the count
	 * on a group's row is the runs of this test *in this group* — which would understate a delete
	 * that takes every run of it.
	 */
	it('says the host cannot say for a run count the groups view has no listing for', async () => {
		await grouped(`checkout-app/${GROUP}/login-flow`);

		await askToRemove();

		expect(valueUnder('TEST')).toBe('login-flow');
		expect(valueUnder('RUNS')).toBe('the host cannot say');
	});

	// Nothing is asked of the host by the controls being drawn — §9's *one request on navigation*,
	// which is what makes the dialog's own measurement the only extra one and only on a press.
	it('asks the host nothing until it is pressed', async () => {
		await showing('checkout-app/login-flow');

		expect(host.deletes).toHaveLength(0);
		expect(host.measures).toHaveLength(1);

		await askToRemove();

		expect(host.deletes).toHaveLength(0);
		expect(host.measures).toEqual([
			['checkout-app', 'login-flow'],
			['checkout-app', 'login-flow'],
		]);
	});
});

/**
 * **Where the screen lands after a settled delete** — the half of this that only the screen can do
 * (#276, §9's *the screen re-reads rather than assuming*).
 */
describe('a settled Remove', () => {
	const DELETED = {
		outcome: 'deleted',
		archive: 'removed',
		keptTests: 'removed',
		freedBytes: 4_180_532,
		keptTestsRemoved: 1,
	};
	const PARTIAL = {
		outcome: 'partial',
		archive: 'failed',
		keptTests: 'removed',
		freedBytes: 0,
		keptTestsRemoved: 1,
	};

	async function removeFrom(splat: string, answer: unknown): Promise<void> {
		host.deleted = answer;
		await showing(splat);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Remove test login-flow' }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Remove test' }));
		});
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}
	}

	/** The line above the content area, or `''` when there is nothing to say. */
	function noticed(): string {
		return document.querySelector('div[aria-live="polite"] section p')?.textContent ?? '';
	}

	/*
	 * **Onto the parent of the *test*, with `replace`.** From a test name's card that is the project;
	 * from a run's card it is still the project, because the run's own parent is the test that just
	 * went. `replace` so Back does not return to an address the host now refuses.
	 */
	it.each([
		['a test name’s card', 'checkout-app/login-flow'],
		['a run’s card', `checkout-app/login-flow/${RUN}`],
	])('moves the selection to the parent address from %s', async (_case, splat) => {
		await removeFrom(splat, DELETED);

		expect(navigated.calls).toEqual([
			{ to: '/archive/$', params: { _splat: 'checkout-app' }, replace: true },
		]);
	});

	// The groups view lands on the **group**, which is the level a test name sits under there — the
	// same arithmetic, over this view's own offset.
	it('moves to the group in the groups view, on that view’s own route', async () => {
		host.deleted = DELETED;
		await grouped(`checkout-app/${GROUP}/login-flow`);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Remove test login-flow' }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Remove test' }));
		});

		expect(navigated.calls).toEqual([
			{ to: '/groups/$', params: { _splat: `checkout-app/${GROUP}` }, replace: true },
		]);
	});

	/*
	 * **And the levels are read again**, so the parent listing is `list_archive`'s answer rather than
	 * the panel's edit of what it had: the project's listing named the test as a row, and editing
	 * that array here would draw a listing nothing on the host ever answered with.
	 */
	it('reads every level it still draws again', async () => {
		await showing('checkout-app/login-flow');
		const before = host.asked.length;
		host.deleted = DELETED;

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Remove test login-flow' }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Remove test' }));
		});
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		expect(host.asked.length).toBeGreaterThan(before);
		expect(host.asked.slice(before)).toContainEqual([]);
		expect(host.asked.slice(before)).toContainEqual(['checkout-app']);
	});

	// `partial` and `not-found` are settled too, and both mean the address may not exist: one left
	// part of it filed, and the other proves the screen was already out of date.
	it.each([
		['a delete that could not take all of it', PARTIAL],
		['an address there was nothing at', { outcome: 'not-found' }],
	])('moves and re-reads for %s as well', async (_case, answer) => {
		await removeFrom('checkout-app/login-flow', answer);

		expect(navigated.calls).toHaveLength(1);
		expect(noticed().length).toBeGreaterThan(0);
	});

	/*
	 * **A `refused` does neither**, and that is not an inconsistency: a live lease means nothing at
	 * all was touched, so what is filed is exactly what the screen already shows — a navigation and a
	 * second `list_archive` would both be the panel acting on a change that did not happen.
	 */
	it('neither moves nor re-reads for a live lease, and still says so', async () => {
		await showing('checkout-app/login-flow');
		const before = host.asked.length;
		host.deleted = { outcome: 'refused', reason: 'lease-live' };

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Remove test login-flow' }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Remove test' }));
		});
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		expect(navigated.calls).toHaveLength(0);
		expect(host.asked).toHaveLength(before);
		expect(noticed()).toContain('nothing at all was touched');
	});

	/*
	 * **The request that reached nothing settles nothing** (§7's fourth case): the dialog stays open
	 * with the control usable again, the screen does not move, nothing is re-read, and **nothing is
	 * said above the tree** — the panel never reports a deletion it did not get.
	 */
	it('says nothing above the tree for a request that reached nothing', async () => {
		await showing('checkout-app/login-flow');
		const before = host.asked.length;
		// `host.deleted` is `null` in `beforeEach`, which is the host answering nothing usable.

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Remove test login-flow' }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Remove test' }));
		});

		expect(screen.getByRole('dialog')).toBeDefined();
		expect(screen.getByRole('button', { name: 'Remove test' }).getAttribute('disabled')).toBeNull();
		expect(navigated.calls).toHaveLength(0);
		expect(host.asked).toHaveLength(before);
		expect(noticed()).toBe('');
	});

	/**
	 * **What a settled delete of a *group* does to the screen** (#277) — the same three moves as a
	 * test's, over the one difference only a group has: the grouping answer is what the groups view
	 * draws its own levels from, so it is re-read as well.
	 */
	describe('on a group’s card', () => {
		const GROUP_DELETED = {
			outcome: 'deleted',
			archive: 'removed',
			keptTests: 'removed',
			freedBytes: 8_451_208,
			keptTestsRemoved: 1,
			runsRemoved: 2,
		};

		/** Press and confirm, answering the counts as they stood **after** the first walk. */
		async function removeTheGroup(answer: unknown): Promise<{ readonly walks: number }> {
			host.groupDeleted = answer;
			await grouped(`checkout-app/${GROUP}`);
			const walks = host.groupings;
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: `Remove group ${GROUP}` }));
			});
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Remove group' }));
			});
			for (let turn = 0; turn < 6; turn += 1) {
				await act(async () => undefined);
			}
			return { walks };
		}

		/*
		 * **Onto the group's parent — the project, in the groups view's own address.** A group's card
		 * *is* that group, so the address the reader is on may not exist once its runs have gone.
		 */
		it('moves the selection to the project, on the groups view’s own route', async () => {
			await removeTheGroup(GROUP_DELETED);

			expect(navigated.calls).toEqual([
				{ to: '/groups/$', params: { _splat: 'checkout-app' }, replace: true },
			]);
		});

		/*
		 * **The grouping answer is walked again**, which is the half of the re-read only a group
		 * needs: this view draws its own three levels out of that one answer, so a group whose runs
		 * went is stale in it. The levels cache is re-read too — the same `reread()` a test's delete
		 * calls — and it is deliberately not asserted here, because above a run the groups view asks
		 * `list_archive` for nothing, so there is no listing at this address for it to ask for
		 * (`levelsWanted`). *That* half is covered where it is observable, on a test's card.
		 */
		it('walks the groupings again, which is what this view’s levels come out of', async () => {
			const { walks } = await removeTheGroup(GROUP_DELETED);

			expect(host.groupings).toBe(walks + 1);
		});

		// `partial` and `not-found` are settled too, and both mean the address may not exist.
		it.each([
			[
				'a delete that could not take all of it',
				{ ...GROUP_DELETED, outcome: 'partial', archive: 'failed' },
			],
			['a group nothing named', { outcome: 'not-found' }],
		])('moves and re-reads for %s as well', async (_case, answer) => {
			const { walks } = await removeTheGroup(answer);

			expect(navigated.calls).toHaveLength(1);
			expect(host.groupings).toBe(walks + 1);
			expect(noticed().length).toBeGreaterThan(0);
		});

		/*
		 * **A `refused` does neither**, for the test scope's reason: a live lease means nothing at all
		 * was touched, so both a navigation and a second walk would be the panel acting on a change
		 * that did not happen.
		 */
		it('neither moves nor re-reads for a live lease, and still says so', async () => {
			const { walks } = await removeTheGroup({ outcome: 'refused', reason: 'lease-live' });

			expect(navigated.calls).toHaveLength(0);
			expect(host.groupings).toBe(walks);
			expect(noticed()).toContain('nothing at all was touched');
		});

		// And the line above the content area is the **group's**, sharing no phrase with the test's.
		it('says the group’s own sentence, with the run count leading', async () => {
			await removeTheGroup(GROUP_DELETED);

			expect(noticed()).toContain(`${GROUP} holds nothing any more`);
			expect(noticed()).toContain('2 runs went');
			expect(noticed()).toContain('not in it are still filed');
		});
	});

	/**
	 * **The line outlives the card it was about**, which is why it is above the content area rather
	 * than in either column: the address it names may be gone, and it stays until dismissed. Nothing
	 * else could clear it in any case — it is state of the screen, so the clock re-reading every
	 * drawn level leaves it where it is (§9, #287).
	 */
	it('says what went above the content area, and stays until dismissed', async () => {
		await removeFrom('checkout-app/login-flow', DELETED);

		expect(noticed()).toContain('login-flow is gone');
		expect(noticed()).toContain('4.0 MB');
		expect(noticed()).toContain('Keep mark');

		// Above both columns, so nothing in the tree or the card can be its ancestor.
		const region = document.querySelector('div[aria-live="polite"]');
		expect(region?.querySelector('aside')).toBeNull();
		expect(region?.closest('aside')).toBeNull();

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
		});
		expect(noticed()).toBe('');
	});
});

/**
 * **A slow host is not an unreadable one** (#289 review), and with the gate shut nothing will ever
 * ask again — so a listing that takes longer than a tick has to be waited for, not abandoned.
 *
 * This is the screen's side of *no clock, no budget* (`archive-levels.ts`). `list_archive` is one
 * `readdir` per entry (`src/daemon/list-archive.ts`), so a level holding several hundred runs, or a
 * host across the network (D17), is an ordinary slow answer rather than a broken one — and *Rover
 * cannot see into this directory* is a claim about the host that would be false, cached for the
 * life of the mounted screen, and correctable only by the reload #287 exists to remove.
 */
describe('the host is slow and no lease is live', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		host.listingGate = null;
		vi.useRealTimers();
	});

	it('waits for a listing that outlasts a tick rather than calling the level unreadable', async () => {
		at.splat = 'checkout-app/login-flow';
		host.answers = new Map(Object.entries(archive()));
		let answerAtLast: () => void = () => undefined;
		host.listingGate = new Promise((resolve) => {
			answerAtLast = () => resolve();
		});

		const { container } = render(<ArchiveScreen view="all" />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ARCHIVE_POLL_MS * 3);
		});

		expect(container.textContent).not.toContain('ARCHIVE NOT READABLE');

		host.listingGate = null;
		await act(async () => {
			answerAtLast();
		});
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		expect(container.textContent).not.toContain('ARCHIVE NOT READABLE');
		expect(treeRows()).toEqual([
			'checkout-app',
			'login-flow',
			RUN,
			OLDER,
			'unlabeled',
			'payments-web',
		]);
	});
});

/**
 * **The listings keep up while a lease is live** (#287) — the acceptance criterion this screen is
 * judged on, and the four things that must not move while it happens.
 *
 * The gate is the device list's own answer (`archive/live-writes.ts`): the page polls
 * `list_devices` above the router, so *is anything being written* costs this screen no request. Every
 * other case in this file runs with that gate **shut**, which is what keeps their request counts the
 * counts they were before there was a clock.
 */
describe('while a lease is writing into the archive', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		list.state = leaseIsLive();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** One turn of the listings' clock, and enough settling for a level below one to answer after it. */
	async function tick(): Promise<void> {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ARCHIVE_POLL_MS);
		});
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}
	}

	/**
	 * One turn of the **grouping walk's** clock, which is six of the above (#288) — and the reason
	 * there are two helpers here rather than one: a cadence the two answers shared is exactly what
	 * this screen may not have, so a case advancing by one of them must not be able to reach the
	 * other by accident.
	 */
	async function walkTick(): Promise<void> {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(GROUPS_WALK_MS);
		});
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}
	}

	/** What the host answers from here on — a run landing is a level answering differently. */
	function nowHolding(levels: Record<string, unknown>): void {
		host.answers = new Map(Object.entries(levels));
	}

	/** The archive with a second run filed under `login-flow`, as a lease would leave it. */
	const NEWER = '20260910T091403Z-issue-287-1a2b3c4d';
	function withANewRun(): Record<string, unknown> {
		return {
			...archive(),
			'["checkout-app","login-flow"]': listed(
				directory(OLDER, 1, 'emulator-5554'),
				directory(RUN, 1, SERIAL),
				directory(NEWER, 1, SERIAL),
			),
		};
	}

	// The bug, stated as a pass: the run that landed is drawn without a reload — in both panes, and
	// with the count in the header agreeing with them.
	it('draws a run that landed, in the tree and in the card, without a reload', async () => {
		const { container } = await showing('checkout-app/login-flow');
		expect(treeRows()).toEqual([
			'checkout-app',
			'login-flow',
			RUN,
			OLDER,
			'unlabeled',
			'payments-web',
		]);

		nowHolding(withANewRun());
		let answerTheRefresh: () => void = () => undefined;
		host.listingGate = new Promise((resolve) => {
			answerTheRefresh = () => resolve();
		});
		await tick();

		/*
		 * **A refresh is invisible until it lands.** Every drawn level is out and none has answered,
		 * and the screen is still exactly the screen it was: no level falls back to *reading*, and
		 * the header still counts what the last answer said.
		 */
		expect(screen.queryByText('Reading this level of the archive.')).toBeNull();
		expect(screen.queryByText('Reading this level.')).toBeNull();
		expect(screen.getByText('2 runs archived')).toBeDefined();

		host.listingGate = null;
		await act(async () => {
			answerTheRefresh();
		});
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		// Most recent first, which is the screen's own order over the host's ascending one — and the
		// new row **appends** into a tree whose other rows are exactly where they were.
		expect(treeRows()).toEqual([
			'checkout-app',
			'login-flow',
			NEWER,
			RUN,
			OLDER,
			'unlabeled',
			'payments-web',
		]);
		// The card's rows carry each run's own owner and grant instant, so it is the leading name
		// that says which run a row is.
		expect(cardRows(container).map((row) => row?.slice(0, NEWER.length))).toEqual([
			NEWER,
			RUN,
			OLDER,
		]);
		expect(screen.getByText('3 runs archived')).toBeDefined();
	});

	/*
	 * **Nothing the reader is doing moves.** The selection is the URL, the open set is state nothing
	 * here writes, and the tree's rows are keyed by path — so a new row appends and no row the
	 * reader was reading is remounted, moved or closed.
	 */
	it('leaves the open branch and the selection where the reader put them', async () => {
		const twoProjects = { ...archive(), '["payments-web"]': listed(directory('refund-flow', 2)) };
		await showing(undefined, twoProjects);
		const tree = document.querySelector('aside') as HTMLElement;
		fireEvent.click(within(tree).getByRole('link', { name: 'payments-web' }));
		await tick();
		expect(treeRows()).toEqual(['checkout-app', 'payments-web', 'refund-flow']);

		nowHolding({
			...twoProjects,
			'["payments-web"]': listed(directory('refund-flow', 2), directory('chargeback', 1)),
		});
		await tick();

		// `checkout-app` is still shut, `payments-web` is still open, and the new row appended
		// under it in the host's own order — the reader's browsing is untouched and the address
		// never moved.
		expect(treeRows()).toEqual(['checkout-app', 'payments-web', 'refund-flow', 'chargeback']);
		expect(screen.getByText('Projects with runs filed on this host.')).toBeDefined();
		expect(navigated.calls).toEqual([]);
	});

	/*
	 * **The search is not re-issued under the reader** (#287's recorded decision). It answers a
	 * question asked with text that has settled, and re-asking it on a clock would move a hit list
	 * nobody touched. The stated cost: a hit list can miss a run that landed after the search.
	 */
	it('leaves the search text and its hits alone, and does not search again', async () => {
		host.search = {
			outcome: 'searched',
			matches: [{ path: ['checkout-app', 'login-flow'], kind: 'directory' }],
			truncated: false,
		};
		await showing('checkout-app');
		const field = screen.getByRole('textbox') as HTMLInputElement;
		fireEvent.change(field, { target: { value: 'login' } });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(host.searches).toEqual(['login']);
		const hits = treeRows();

		nowHolding(withANewRun());
		await tick();
		await tick();

		expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('login');
		expect(host.searches).toEqual(['login']);
		expect(treeRows()).toEqual(hits);
	});

	/*
	 * **The clock reads the listings and nothing else** — the four decisions #287 asked to be
	 * recorded rather than left, pinned here so none of them can be lost to a refactor:
	 *
	 * - `measure_archive` is a **disk walk per scope**, and a badge that re-walked the archive every
	 *   five seconds while runs land is a worse bug than a stale figure. The cost is stated: the
	 *   `ON DISK` figure under-reports until the reader navigates to another scope and back.
	 * - The run's two files are written **once, with `wx`, and never rewritten**
	 *   (`src/daemon/archive.ts`), so they cannot grow under the reader and there is nothing for a
	 *   refresh to notice.
	 * - An artifact is filed under a fresh per-lease sequence number and never rewritten, so a file
	 *   on screen cannot change.
	 */
	it('re-reads the listings and re-reads nothing else', async () => {
		await showing(`checkout-app/login-flow/${RUN}`);
		const listings = host.asked.length;
		const measures = [...host.measures];
		const files = [...host.files];
		expect(listings).toBe(4);
		expect(files).toHaveLength(2);
		expect(measures).toHaveLength(1);

		await tick();
		await tick();

		// The listings were read again, twice over — every drawn level and no other.
		expect(host.asked.length).toBe(listings * 3);
		// And nothing else was asked for a second time.
		expect(host.measures).toEqual(measures);
		expect(host.files).toEqual(files);
		expect(host.keptReads).toBe(1);
	});

	// The same for an open artifact's bytes, which are megabytes rather than a listing: an artifact
	// is filed under a fresh per-lease sequence number and never rewritten, so a file on screen
	// cannot change and there is nothing for a refresh to notice.
	it('asks the byte route for nothing new while an artifact is open', async () => {
		host.artifact = { outcome: 'read', mediaType: 'image/png', bytes: new Blob(['png']) };
		const screenshots = ['checkout-app', 'login-flow', RUN, SERIAL, 'screenshots'];
		await showing([...screenshots, '001_screenshot.png'].join('/'), {
			...archive(),
			[JSON.stringify(screenshots)]: listed({
				kind: 'file',
				name: '001_screenshot.png',
				sizeBytes: 4,
			}),
		});
		const artifacts = [...host.artifacts];
		const listings = host.asked.length;
		expect(artifacts).toHaveLength(1);

		await tick();
		await tick();

		expect(host.asked.length).toBe(listings * 3);
		expect(host.artifacts).toEqual(artifacts);
	});

	/**
	 * **The grouping walk is on a clock of its own, and a slower one** (#288) — this case is the
	 * opposite of the one it replaces in place (`ai/RULES.md` §1). That one read *walks no group and
	 * measures no group on a tick*, on the reasoning that a cadence for a bounded walk of the
	 * **whole** archive was a decision phase 2 would have to make. It has been made:
	 * `GROUPS_WALK_MS` is six times `ARCHIVE_POLL_MS`, so the listings' tick still walks no group
	 * and the walk's own tick is what does. The half of that case's claim which survives — the
	 * asymmetry — is asserted here rather than dropped.
	 *
	 * **And the size badges are still on neither clock**, which is phase 1's recorded decision and
	 * stays pinned here: `measure_archive_groups` is a disk walk per scope, and a badge that
	 * re-walked the archive every few seconds while runs land is a worse bug than a stale figure.
	 */
	it('walks the groups on its own slower clock, and measures no group on either', async () => {
		await grouped(`checkout-app/${GROUP}`);
		expect(host.groupings).toBe(1);
		const groupMeasures = [...host.groupMeasures];
		expect(groupMeasures).toHaveLength(1);

		// Two listing ticks walk no group: the fast clock is the listings' and nothing else's.
		await tick();
		await tick();
		expect(host.groupings).toBe(1);

		await walkTick();

		expect(host.groupings).toBe(2);
		expect(host.groupMeasures).toEqual(groupMeasures);
	});

	/**
	 * **The groups view's arrangement keeps up** (#288) — the acceptance criterion this screen is
	 * judged on, and the four things that must not move while it happens.
	 *
	 * Every level of it above a run is `group-tree.ts`'s pure function over the one grouping answer,
	 * so *the run appears*, *the tree keeps its shape* and *the counts follow* are all one answer
	 * being replaced — which is why they are asserted about the same walk rather than separately.
	 */
	describe('and the reader is in the testing groups view', () => {
		/** The grouping answer with a third run of `login-flow` filed under the group. */
		function withANewGroupedRun(): unknown {
			return {
				outcome: 'listed',
				truncated: false,
				groups: [
					{
						project: 'checkout-app',
						groupId: GROUP,
						runs: [
							groupRun('login-flow', OLDER, 'emulator-5554'),
							groupRun('login-flow', RUN),
							groupRun('login-flow', NEWER),
						],
					},
					{ project: 'checkout-app', groupId: OTHER_GROUP, runs: [groupRun('basket', RUN)] },
				],
			};
		}

		/** Opens a branch of the tree without moving the address — a click, and nothing else. */
		function open(name: string): void {
			const tree = document.querySelector('aside') as HTMLElement;
			fireEvent.click(within(tree).getByRole('link', { name }));
		}

		/*
		 * The bug, stated as a pass: the run filed under the group the reader has open is drawn
		 * without a reload, the test name's count follows it, and **the walk is invisible until it
		 * lands** — the arrangement is never replaced by *Reading the testing groups on this host's
		 * archive.* on the way, which here would take the tree, the card and the reader's place all
		 * at once.
		 */
		it('draws a run that landed under the group, with the test name’s count following it', async () => {
			const { container } = await grouped(`checkout-app/${GROUP}`);
			open('login-flow');
			expect(treeRows()).toEqual(['checkout-app', GROUP, 'login-flow', RUN, OLDER, OTHER_GROUP]);
			expect(cardRows(container)).toEqual(['login-flowRUNS2']);

			host.groups = withANewGroupedRun();
			let answerTheWalk: () => void = () => undefined;
			host.groupsGate = new Promise((resolve) => {
				answerTheWalk = () => resolve();
			});
			await walkTick();

			// The walk is out and nothing has answered it, and the screen is still exactly the
			// screen it was — no level falls back to reading, and the count still says what the last
			// answer said.
			expect(screen.queryByText("Reading the testing groups on this host's archive.")).toBeNull();
			expect(treeRows()).toEqual(['checkout-app', GROUP, 'login-flow', RUN, OLDER, OTHER_GROUP]);
			expect(cardRows(container)).toEqual(['login-flowRUNS2']);

			host.groupsGate = null;
			await act(async () => {
				answerTheWalk();
			});

			// Most recent first, which is the screen's own order over the host's ascending one — and
			// the new row **appends** into a tree whose other rows are exactly where they were.
			expect(treeRows()).toEqual([
				'checkout-app',
				GROUP,
				'login-flow',
				NEWER,
				RUN,
				OLDER,
				OTHER_GROUP,
			]);
			expect(cardRows(container)).toEqual(['login-flowRUNS3']);
		});

		// And the group's own count, one level up, off the same answer — a group's row counts every
		// run under every test name in it, so it follows a run that landed too.
		it('follows the group’s own run count at the project it is under', async () => {
			const { container } = await grouped('checkout-app');
			expect(cardRows(container)).toEqual([`${GROUP}RUNS2`, `${OTHER_GROUP}RUNS1`]);

			host.groups = withANewGroupedRun();
			await walkTick();

			expect(cardRows(container)).toEqual([`${GROUP}RUNS3`, `${OTHER_GROUP}RUNS1`]);
		});

		/*
		 * **Nothing the reader is doing moves.** The selection is the URL, the open set and the
		 * search text are state no answer writes, and the tree's rows are keyed by path — so a new
		 * row appends and no row the reader was reading is remounted, moved or closed. The search is
		 * not re-issued either, which is #287's own recorded decision and this clock changes nothing
		 * about it.
		 */
		it('leaves the selection, the open branch and the search text where the reader put them', async () => {
			host.search = {
				outcome: 'searched',
				matches: [{ path: ['checkout-app', 'login-flow'], kind: 'directory' }],
				truncated: false,
			};
			await grouped(`checkout-app/${GROUP}`);
			open('login-flow');
			const field = screen.getByRole('textbox') as HTMLInputElement;
			fireEvent.change(field, { target: { value: 'login' } });
			await act(async () => {
				await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(host.searches).toEqual(['login']);
			const hits = treeRows();

			host.groups = withANewGroupedRun();
			await walkTick();

			expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('login');
			expect(host.searches).toEqual(['login']);
			expect(treeRows()).toEqual(hits);
			expect(navigated.calls).toEqual([]);
			// And clearing the field puts the reader back on an arrangement that did keep up: the
			// walk landed under the search, so the run is there when the hits go.
			await act(async () => {
				fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
				await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
			});
			expect(treeRows()).toEqual([
				'checkout-app',
				GROUP,
				'login-flow',
				NEWER,
				RUN,
				OLDER,
				OTHER_GROUP,
			]);
		});
	});

	// And the idle cost, from the screen's side: gate shut, no interval, no requests, however long
	// the reader sits there.
	it('asks nothing at all once no lease is live', async () => {
		list.state = { status: 'loading' };
		await showing('checkout-app/login-flow');
		const listings = host.asked.length;

		await tick();
		await tick();
		await tick();

		expect(host.asked.length).toBe(listings);
	});
});
