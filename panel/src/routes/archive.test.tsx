import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * `devices.test.tsx`'s shape: a `Link` is a plain anchor and `createRoute` is here because this
 * module builds two at import. `useParams` is what puts the screen at a level — the path is the
 * whole of this screen's state, so one test is one address.
 */
const { at } = vi.hoisted(() => ({ at: { splat: undefined as string | undefined } }));
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		params,
		children,
		...rest
	}: {
		to: string;
		params?: { _splat?: string };
		children: ReactNode;
	} & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={`${to.replace('$', '')}${params?._splat ?? ''}`} {...rest}>
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
		/** Every text `search_archive` was asked about — one per settled text, never per keystroke. */
		searches: [] as unknown[],
		/** What the host answers a search with. */
		search: { outcome: 'searched', matches: [], truncated: false } as unknown,
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

	return {
		useSession: () => ({
			/*
			 * Two methods now (#146), so this reads `method` rather than assuming a listing: the tree
			 * card's field asks `search_archive`, and *searching issues no extra `list_archive`* is
			 * assertable only because the two are logged apart.
			 */
			call: async (method: string, params: { path: readonly string[]; text?: string }) =>
				method === 'search_archive' ? await search(params.text) : await listing(params.path),
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
				return { ok: true, value: host.artifact };
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
	const rendered = render(<ArchiveScreen />);
	// The levels settle over as many microtask turns as there are levels to fetch, because each is
	// asked for only once the one above it has answered.
	for (let turn = 0; turn < 6; turn += 1) {
		await act(async () => undefined);
	}
	return rendered;
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
	const card = container.querySelector('div.lg\\:flex-row > section');
	if (card === null) {
		throw new Error('no card is drawn beside the tree');
	}
	return within(card as HTMLElement);
}

beforeEach(() => {
	host.asked = [];
	host.files = [];
	host.artifacts = [];
	host.searches = [];
	host.search = { outcome: 'searched', matches: [], truncated: false };
	host.file = { outcome: 'missing' };
	host.fileByName = {};
	host.artifact = { outcome: 'missing' };
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

			expect(container.querySelectorAll('button')).toHaveLength(0);
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
		expect(container.querySelectorAll('button')).toHaveLength(0);
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
		expect(container.querySelectorAll('button')).toHaveLength(0);
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
		const { container } = render(<ArchiveScreen />);

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
	 * The one criterion the approved markup gets wrong: a pinned preview makes the *split* depend on
	 * the window, so the same screen shows different proportions on different monitors. **The tree is
	 * the one sized child** and the card beside it takes the rest, which is what every other depth
	 * already does — one row, one shape (#160).
	 */
	it('takes the rest of the row beside the sized tree, with no width, percentage or basis', async () => {
		host.artifact = PNG;

		const { container } = await showing(AT_THE_FILE, withScreenshots());

		const columns = container.querySelectorAll('div.lg\\:flex-row > section');
		expect(columns).toHaveLength(1);
		const preview = columns[0] as HTMLElement;
		expect(preview.className).toContain('flex-1');
		expect(preview.className).toContain('min-w-0');
		expect(preview.className).not.toMatch(/\bw-\[/);
		expect(preview.className).not.toMatch(/\bbasis-/);
		expect(preview.className).not.toMatch(/\bw-1\/2/);
		expect(preview.className).not.toContain('shrink-0');
		// And the tree is the sized one, exactly as it is at every other depth.
		expect(container.querySelector('aside')?.className).toContain('shrink-0');
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
		const strip = container.querySelector('div.lg\\:flex-row > section > div:first-child');
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
		const columns = container.querySelector('div.lg\\:flex-row');
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

		const { container } = render(<ArchiveScreen />);
		expect(screen.getByText('DIRECTORY')).toBeDefined();
		expect(container.querySelectorAll('div.lg\\:flex-row > section')).toHaveLength(1);
		expect(screen.getByText('Reading this address.')).toBeDefined();
		expect(screen.queryByText('Reading this artifact.')).toBeNull();
		expect(container.textContent).not.toContain('One artifact from this run');
		expect(container.textContent).not.toContain('Run Details');

		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}

		expect(screen.getByText('DIRECTORY')).toBeDefined();
		expect(container.querySelectorAll('div.lg\\:flex-row > section')).toHaveLength(1);
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

		const { container } = render(<ArchiveScreen />);
		expect(screen.getByText('DIRECTORY')).toBeDefined();
		const columns = container.querySelector('div.lg\\:flex-row');
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
		expect(container.querySelector('div.lg\\:flex-row')?.children).toHaveLength(2);
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

		const { rerender } = render(<ArchiveScreen />);
		for (let turn = 0; turn < 6; turn += 1) {
			await act(async () => undefined);
		}
		expect(host.asked).toContainEqual(SERIAL_LEVEL);
		const readSoFar = host.asked.length;

		at.splat = AT_THE_FILE;
		rerender(<ArchiveScreen />);
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
			rerender(<ArchiveScreen />);
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
