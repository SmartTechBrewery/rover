import type { ArchiveLevel, ArchiveLevels } from '@panel/archive/archive-levels.js';
import { keyOf } from '@panel/archive/archive-path.js';
import type { ArchivedDeviceInfo } from '@panel/archive/device-info.js';
import type { ArchivedTestDescription } from '@panel/archive/test-description.js';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../tests/fixtures/panel/device-info.json';

// `directory-tree.test.tsx`'s shape: a `Link` is a plain anchor, so the panel renders with no router
// instance. The splat's own encoding is asserted against a real router in `archive-path.test.tsx`.
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
}));

import { RunPanel, type RunSerial } from './run-panel.js';

const RUN = ['checkout-app', 'login-flow', '20260830T170501Z-issue-112-9f1c2ab4'] as const;

/** The run's own `<serial>` directory, as the host listed it — the real capture's shape. */
const CONTENTS: ArchiveLevel = {
	status: 'listed',
	entries: [
		{ kind: 'file', name: 'device_info.json', sizeBytes: 80 },
		{ kind: 'other', name: 'latest_recording' },
		{ kind: 'directory', name: 'logs', childCount: 2, onlyChild: null },
		{ kind: 'directory', name: 'recordings', childCount: 1, onlyChild: '001.mp4' },
		{ kind: 'directory', name: 'screenshots', childCount: 3, onlyChild: null },
	],
};

/** The level above answered and named the run's one child — the ordinary case. */
const NAMED: RunSerial = { status: 'answered', serial: 'R5CT30ABCDE' };
/** It answered, and the run directory holds something other than exactly one entry. */
const NO_SINGLE_CHILD: RunSerial = { status: 'answered', serial: null };

/** The run's own `device_info.json`, as the archive wrote it — the real capture's shape. */
const DEVICE: ArchivedDeviceInfo = { status: 'read', info: fixture.files[0] };
/** The same device, with the three facts it could not answer (`docs/DESIGN.md` §6). */
const UNANSWERED: ArchivedDeviceInfo = { status: 'read', info: fixture.files[1] };

/** No level below the `<serial>` has been read, which is every state with nothing open. */
const NO_LEVELS: ArchiveLevels = new Map();

/** The run's own `test_description.json`, as the archive wrote it (#148). */
const DESCRIBED: ArchivedTestDescription = {
	status: 'read',
	description: 'Checks the login form still fits above the keyboard on a short screen.',
};
/** The common case for a run filed before the field existed: no such file. */
const UNDESCRIBED: ArchivedTestDescription = { status: 'missing' };

function showing(
	serial: RunSerial = NAMED,
	contents: ArchiveLevel = CONTENTS,
	device: ArchivedDeviceInfo = DEVICE,
	description: ArchivedTestDescription = DESCRIBED,
) {
	return render(
		<RunPanel
			back={false}
			below={NO_LEVELS}
			contents={contents}
			description={description}
			device={device}
			open={null}
			run={RUN}
			serial={serial}
		/>,
	);
}

/** The `<serial>` directory every address below this run carries. */
const SERIAL_PATH = [...RUN, 'R5CT30ABCDE'] as const;

/** One level of the run's subtree, keyed the way `useArchiveLevels` keys them. */
function levels(...read: readonly [readonly string[], ArchiveLevel][]): ArchiveLevels {
	return new Map(read.map(([path, level]) => [keyOf(path), level]));
}

/**
 * The column with an address inside the run open, and **`back` is what tells the two apart**: a
 * preview took the tree's place, so the arrow is the way out of it; a folder is open beside the tree
 * and has no control at all (#143).
 */
function withOpen(open: readonly string[], below: ArchiveLevels, back: boolean) {
	return render(
		<RunPanel
			back={back}
			below={below}
			contents={CONTENTS}
			description={DESCRIBED}
			device={DEVICE}
			open={open}
			run={RUN}
			serial={NAMED}
		/>,
	);
}

/** The column beside an open artifact — the preview state, where the tree is not there. */
function beside(open: readonly string[], below: ArchiveLevels = NO_LEVELS) {
	return withOpen(open, below, true);
}

/** The column beside the tree, with a folder of this run open in `CONTENTS` (#143). */
function browsing(open: readonly string[], below: ArchiveLevels = NO_LEVELS) {
	return withOpen(open, below, false);
}

describe('a run', () => {
	it('names itself in full, and reads its owner and time out of that name', () => {
		showing();

		expect(screen.getByText('20260830T170501Z-issue-112-9f1c2ab4')).toBeDefined();
		expect(screen.getByText('issue-112')).toBeDefined();
		expect(screen.getByText('2026-08-30 17:05:01 UTC')).toBeDefined();
	});

	// The serial is the parent listing's `onlyChild`: one lease is one device, so it is a fact about
	// the run rather than a level worth a round trip.
	it('reads `SERIAL` from the run directory that holds exactly one child', () => {
		showing();

		expect(screen.getByText('SERIAL')).toBeDefined();
		expect(screen.getByText('R5CT30ABCDE')).toBeDefined();
	});

	/*
	 * A run directory that is not one-device shaped, or one the host could not read into. `unknown`
	 * and nothing to list — never an invented `0`, and never a second request to go looking.
	 */
	it('says `unknown` and lists nothing when the run holds no single child', () => {
		const { container } = showing(NO_SINGLE_CHILD);

		expect(screen.getByText('unknown')).toBeDefined();
		expect(screen.getByText('There is nothing to list for this run.')).toBeDefined();
		expect(container.textContent).not.toContain('0 files');
	});
});

/*
 * **The pair that must never render alike, one level further up.** The serial comes off the level
 * *above* the run, so *nobody has answered for that level yet* and *the host cannot read it* are not
 * the run naming no single child — and *there is nothing to list for this run* is a definite claim
 * about what a lease wrote. Both of these reach here with a fully listed `contents` on purpose: the
 * state of the level above is ordered first, so a listing for some other level cannot leak in.
 */
describe('the level the serial is read from', () => {
	it('says it is reading, rather than that the run wrote nothing', () => {
		const { container } = showing({ status: 'loading' });

		// `SERIAL` and `DESCRIPTION` both read off that level, so both say it — and saying the same
		// thing is the point: neither may claim anything definite about a level nobody has answered.
		expect(screen.getAllByText('reading')).toHaveLength(2);
		expect(screen.getByText('Reading this level of the archive.')).toBeDefined();
		expect(container.textContent).not.toContain('There is nothing to list for this run.');
		// A `CONTENTS` entry rather than `device_info.json`, which card 2's heading names in every
		// state: what must not leak in is the listing.
		expect(container.textContent).not.toContain('latest_recording');
		expect(container.innerHTML).not.toContain('animate');
	});

	it('says the host cannot read it, rather than that the run wrote nothing', () => {
		const { container } = showing({ status: 'unreadable' });

		expect(screen.getAllByText('not readable')).toHaveLength(2);
		expect(screen.getByText('ARCHIVE NOT READABLE')).toBeDefined();
		expect(screen.getByText(/runs may well be filed here/)).toBeDefined();
		expect(container.textContent).not.toContain('There is nothing to list for this run.');
		expect(container.textContent).not.toContain('latest_recording');
	});

	// `unknown` is the screen saying the host answered and had no serial to give, so neither state
	// above may borrow it — that is the whole distinction these three sentences exist to draw.
	it('never reads `unknown` for a level that has not answered or cannot be read', () => {
		for (const serial of [{ status: 'loading' }, { status: 'unreadable' }] as const) {
			const { container, unmount } = showing(serial);

			expect(container.textContent).not.toContain('unknown');
			unmount();
		}
	});
});

describe('what the run wrote', () => {
	it('lists a directory with its count and a file with its size', () => {
		showing();

		expect(screen.getByText('screenshots/')).toBeDefined();
		expect(screen.getByText('3 files')).toBeDefined();
		// Singular at one, because a run with one recording is the common case.
		expect(screen.getByText('1 file')).toBeDefined();
		expect(screen.getByText('device_info.json')).toBeDefined();
		expect(screen.getByText('80 B')).toBeDefined();
	});

	it('names an entry that is neither a directory nor a file, with no measure', () => {
		showing();

		expect(screen.getByText('latest_recording')).toBeDefined();
	});

	it('says `unknown` for a size the host could not read', () => {
		showing(NAMED, {
			status: 'listed',
			entries: [{ kind: 'file', name: 'notes.txt', sizeBytes: null }],
		});

		expect(screen.getByText('unknown')).toBeDefined();
	});

	it('keeps the footnote that stops a short listing reading as a truncated one', () => {
		showing();

		expect(screen.getByText(/A directory that is not listed does not exist/)).toBeDefined();
	});
});

/**
 * **`DEVICE — FROM device_info.json`** (#136) — the one card here that is a file's contents rather
 * than a listing. Every value comes out of that file, with `docs/DESIGN.md` §6's three fallbacks
 * and nothing else.
 */
describe('the device the lease held', () => {
	it('names its six fields and reads every one out of the file', () => {
		showing();

		for (const label of ['MODEL', 'PLATFORM', 'OS VERSION', 'API LEVEL', 'SCREEN', 'DENSITY']) {
			expect(screen.getByText(label)).toBeDefined();
		}
		expect(screen.getByText('sdk_gphone64_arm64')).toBeDefined();
		expect(screen.getByText('15')).toBeDefined();
		expect(screen.getByText('35')).toBeDefined();
		expect(screen.getByText('1080 x 2400 px')).toBeDefined();
		expect(screen.getByText('2.625x — 411 x 914 dp')).toBeDefined();
	});

	// The wire's own word. A display table mapping it onto `Android` would be a platform branch in
	// shared code (`ai/RULES.md` §2), and the device card holds the same line.
	it('prints the platform verbatim, so it reads `android` and never `Android`', () => {
		const { container } = showing();

		expect(screen.getByText('android')).toBeDefined();
		expect(container.textContent).not.toContain('Android');
	});

	it('falls back to the serial for a model the device could not answer', () => {
		showing(NAMED, CONTENTS, UNANSWERED);

		// The serial the level above named — the card's job is to identify the device, and it always
		// can. It is on the panel twice now, in `SERIAL` and here.
		expect(screen.getAllByText('R5CT30ABCDE')).toHaveLength(2);
	});

	it('names an OS version and an API level it does not have, rather than closing the row up', () => {
		showing(NAMED, CONTENTS, UNANSWERED);

		expect(screen.getByText('OS VERSION')).toBeDefined();
		expect(screen.getByText('API LEVEL')).toBeDefined();
		expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(2);
	});
});

/**
 * **The pair that must never render alike**, one file down from the archive's own empty/unreadable
 * pair (D6, `docs/DESIGN.md` §7). Neither is an alarm: no colour, no icon, no error code and no
 * retry control — a file the archive does not carry is an ordinary answer.
 */
describe('a device_info.json that could not be read', () => {
	it('says a missing one plainly, with nothing on it that reads as a fault', () => {
		const { container } = showing(NAMED, CONTENTS, { status: 'missing' });

		expect(screen.getByText(/No device_info.json is filed for this run/)).toBeDefined();
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	it('says an unreadable one differently, and says so in as many words', () => {
		const { container } = showing(NAMED, CONTENTS, { status: 'unreadable' });

		expect(screen.getByText(/Rover cannot read this run's device_info.json/)).toBeDefined();
		expect(screen.getByText(/not the same as none being filed/)).toBeDefined();
		expect(container.textContent).not.toContain('No device_info.json is filed');
		expect(container.querySelectorAll('button')).toHaveLength(0);
	});

	it('says it is reading, with no spinner', () => {
		const { container } = showing(NAMED, CONTENTS, { status: 'reading' });

		expect(screen.getByText("Reading this run's device_info.json.")).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
	});

	/*
	 * The file is inside the run's `<serial>` directory, so the level above answers before this card
	 * can: a serial nobody has answered for is *reading*, one the host cannot read is *not readable*,
	 * and a run naming no single child has no directory for a file to be in. None of the three may
	 * borrow another's sentence — the distinction `SERIAL` draws, applied to a file.
	 */
	it('never claims a file is missing on the strength of a level nobody answered for', () => {
		for (const serial of [{ status: 'loading' }, { status: 'unreadable' }] as const) {
			const { container, unmount } = showing(serial, CONTENTS, { status: 'read', info: {} });

			expect(container.textContent).not.toContain('No device_info.json is filed');
			unmount();
		}
	});

	it('says a run with no `<serial>` directory has no file filed, rather than reading forever', () => {
		showing(NO_SINGLE_CHILD, CONTENTS, { status: 'reading' });

		expect(screen.getByText(/No device_info.json is filed for this run/)).toBeDefined();
	});
});

/*
 * **The assertion this screen is most likely to lose.** The superseded design invented a run
 * duration, a trigger, an author, an environment panel, a network figure and file names nothing
 * wrote; every one of them would look plausible and none of them is on the wire.
 */
/**
 * **`DESCRIPTION` — what the lease said it was about** (#148), out of the run's own
 * `test_description.json` and off the same byte route the device card reads.
 *
 * Four answers and no two of them share a phrase: the sentence itself, *reading*, *none filed* and
 * *not readable*. The pair that must never render alike is the last two — a lease that never
 * described itself is the ordinary case, and a host that will not read the file is saying nothing
 * about the lease at all (D6).
 */
describe('what the lease said the run was about', () => {
	it('reads the sentence out of the run own file', () => {
		showing(NAMED, CONTENTS, DEVICE, DESCRIBED);

		expect(screen.getByText('DESCRIPTION')).toBeDefined();
		expect(
			screen.getByText('Checks the login form still fits above the keyboard on a short screen.'),
		).toBeDefined();
	});

	// The common case for every run filed before the field existed, and said without alarm.
	it('says none is filed, in words that are not the unreadable ones', () => {
		const { container } = showing(NAMED, CONTENTS, DEVICE, UNDESCRIBED);

		expect(screen.getByText('none filed')).toBeDefined();
		expect(container.textContent).not.toContain('not readable');
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
	});

	it('says the host cannot read the file differently again', () => {
		const { container } = showing(NAMED, CONTENTS, DEVICE, { status: 'unreadable' });

		expect(screen.getByText('not readable')).toBeDefined();
		expect(container.textContent).not.toContain('none filed');
	});

	it('says it is reading, with no spinner', () => {
		const { container } = showing(NAMED, CONTENTS, DEVICE, { status: 'reading' });

		expect(screen.getByText('reading')).toBeDefined();
		expect(container.textContent).not.toContain('none filed');
		expect(container.innerHTML).not.toContain('animate');
	});

	/*
	 * A run with no `<serial>` directory has nowhere for the file to be, so *none filed* is the
	 * honest answer — and the file is never asked for, which is why the state arrives as `reading`
	 * and must not be rendered as such (`archive.tsx`, and the device card's own rule).
	 */
	it('says none is filed for a run with no `<serial>` directory, rather than reading forever', () => {
		showing(NO_SINGLE_CHILD, CONTENTS, DEVICE, { status: 'reading' });

		expect(screen.getByText('none filed')).toBeDefined();
	});
});

describe('what is not on this panel', () => {
	it('lists only what the host listed', () => {
		const { container } = showing();
		const text = container.textContent ?? '';

		for (const invented of ['run_log.txt', 'trace_video.mp4', 'network_log.json']) {
			expect(text).not.toContain(invented);
		}
	});

	it('invents no fact about the run', () => {
		const { container } = showing();
		const text = (container.textContent ?? '').toLowerCase();

		for (const invented of ['duration', 'trigger', 'author', 'environment', 'network']) {
			expect(text).not.toContain(invented);
		}
	});

	// The design's own mock data, which the card must never fall back to: every value on it comes
	// out of the run's own file (#136).
	it('draws no device the file did not name', () => {
		const { container } = showing();
		const text = container.textContent ?? '';

		expect(text).not.toContain('Pixel');
		expect(text).not.toContain('2.75x');
	});

	// Rover has no verdicts to report (`docs/DESIGN.md` §2).
	it('says nothing about how the run went', () => {
		const { container } = showing();

		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});
});

describe('contents that could not be read', () => {
	it('says the host cannot see into the directory, apart from saying it is empty', () => {
		showing(NAMED, { status: 'unreadable' });

		expect(screen.getByText('ARCHIVE NOT READABLE')).toBeDefined();
		expect(screen.getByText(/runs may well be filed here/)).toBeDefined();
	});

	it('says an empty one plainly', () => {
		showing(NAMED, { status: 'empty' });

		expect(screen.getByText(/Nothing is filed under this directory/)).toBeDefined();
	});

	it('says it is reading, with no spinner', () => {
		const { container } = showing(NAMED, { status: 'loading' });

		expect(screen.getByText('Reading this level of the archive.')).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
	});
});

/**
 * **The column beside an open artifact** (#133) — this same panel in less space, with the two things
 * that change and the assertion that everything else does not.
 */
describe('the run column while a file is open', () => {
	const SCREENSHOTS = [...SERIAL_PATH, 'screenshots'] as const;
	const OPEN_FILE = [...SCREENSHOTS, '001_screenshot.png'] as const;
	const SCREENSHOTS_LEVEL: ArchiveLevel = {
		status: 'listed',
		entries: [
			{ kind: 'file', name: '001_screenshot.png', sizeBytes: 421_112 },
			{ kind: 'file', name: '002_screenshot.png', sizeBytes: 398_004 },
			{ kind: 'directory', name: '001_frames', childCount: 2, onlyChild: null },
		],
	};

	/*
	 * **The arrow, then a left-aligned `Run Details`** — the approved markup's own header, restored
	 * (#143): the arrow was alone and centred, which put the one control on the card off the axis
	 * everything under it sits on. Pressing it closes the preview, which is the same act as navigating
	 * to the run, so the tree comes back exactly when the preview closes.
	 */
	it('is headed by the back arrow and a left-aligned `Run Details`', () => {
		const { container } = beside(OPEN_FILE);

		const strip = container.querySelector('section > div:first-child');
		expect(strip?.textContent).toBe('Run Details');
		const back = screen.getByRole('link', {
			name: 'Close the preview and go back to the directory',
		});
		expect(back.getAttribute('href')).toBe(`/archive/${RUN.join('/')}`);
		expect(strip?.querySelectorAll('a')).toHaveLength(1);
		// The arrow first and the heading after it, on one axis and not centred in the strip.
		const row = strip?.firstElementChild;
		expect(row?.children[0]?.tagName).toBe('A');
		expect(row?.children[1]?.tagName).toBe('H2');
		expect(row?.className).not.toContain('justify-center');
	});

	it('is headed by `Run Details` and no back control when the tree is beside it instead', () => {
		const { container } = showing();

		expect(screen.getByText('Run Details')).toBeDefined();
		expect(
			screen.queryByRole('link', { name: 'Close the preview and go back to the directory' }),
		).toBeNull();
		expect(container.querySelector('section > div:first-child')?.textContent).toBe('Run Details');
	});

	// A folder is open *beside* the tree, and the tree is the way back from it — so this column keeps
	// the heading it has with nothing open and gains nothing (#143).
	it('keeps that header, with no back control, while a folder of the run is open', () => {
		const { container } = browsing(SCREENSHOTS, levels([SCREENSHOTS, SCREENSHOTS_LEVEL]));

		expect(container.querySelector('section > div:first-child')?.textContent).toBe('Run Details');
		expect(
			screen.queryByRole('link', { name: 'Close the preview and go back to the directory' }),
		).toBeNull();
	});

	/*
	 * **The identity and device cards do not change at all.** The column is the run screen's own
	 * second column in less space, and what earns the one difference is `CONTENTS` becoming the
	 * chooser — nothing else may take the opportunity.
	 */
	it('draws the identity and device cards exactly as it does with nothing open', () => {
		const { container: withNothingOpen, unmount } = showing();
		const cards = (root: HTMLElement) =>
			Array.from(root.querySelectorAll('section > div > section'))
				.slice(0, 2)
				.map((card) => card.outerHTML);
		const before = cards(withNothingOpen);
		unmount();

		const { container: withAFileOpen } = beside(OPEN_FILE);

		expect(cards(withAFileOpen)).toEqual(before);
	});

	// The way in, and the way to the next file: every row addresses its own path, with the `<serial>`
	// in it because the serial is part of the address and not a level of the tree.
	it('makes every `CONTENTS` row a link to its own address, with nothing open too', () => {
		showing();

		expect(screen.getByRole('link', { name: /screenshots/ }).getAttribute('href')).toBe(
			`/archive/${[...SERIAL_PATH, 'screenshots'].join('/')}`,
		);
		expect(screen.getByRole('link', { name: /device_info.json/ }).getAttribute('href')).toBe(
			`/archive/${[...SERIAL_PATH, 'device_info.json'].join('/')}`,
		);
	});

	it('expands the folder the open file is in, and leaves the others summarised', () => {
		beside(OPEN_FILE, levels([SCREENSHOTS, SCREENSHOTS_LEVEL]));

		// The folder being browsed, by its file names.
		expect(screen.getByRole('link', { name: /001_screenshot.png/ })).toBeDefined();
		expect(screen.getByRole('link', { name: /002_screenshot.png/ })).toBeDefined();
		// And the others, still one row each with their counts.
		expect(screen.getByText('logs/')).toBeDefined();
		expect(screen.getByText('2 files')).toBeDefined();
		expect(screen.queryByText('001.mp4')).toBeNull();
	});

	it('gives the open file the selected treatment, and says so to a screen reader', () => {
		beside(OPEN_FILE, levels([SCREENSHOTS, SCREENSHOTS_LEVEL]));

		const open = screen.getByRole('link', { name: /001_screenshot.png/ });
		expect(open.getAttribute('aria-current')).toBe('page');
		expect(open.className).toContain('bg-tertiary-container');
		expect(open.className).toContain('border-tertiary');

		const other = screen.getByRole('link', { name: /002_screenshot.png/ });
		expect(other.getAttribute('aria-current')).toBeNull();
		expect(other.className).not.toContain('bg-tertiary-container');
		// Bordered transparent, so opening a row does not shift it by 2px.
		expect(other.className).toContain('border-transparent');
	});

	// A top-level `device_info.json` is opened the same way as anything else, and reads as open.
	it('applies the selected treatment to a top-level row too', () => {
		beside([...SERIAL_PATH, 'device_info.json']);

		const open = screen.getByRole('link', { name: /device_info.json/ });
		expect(open.getAttribute('aria-current')).toBe('page');
		expect(open.className).toContain('bg-tertiary-container');
	});

	// What makes `recordings/001_frames/0001.png` reachable at all, since the tree is not there.
	it('expands a nested folder on the open path, recursively', () => {
		const frames = [...SCREENSHOTS, '001_frames'] as const;
		beside(
			[...frames, '0001.png'],
			levels(
				[SCREENSHOTS, SCREENSHOTS_LEVEL],
				[
					frames,
					{ status: 'listed', entries: [{ kind: 'file', name: '0001.png', sizeBytes: 900 }] },
				],
			),
		);

		expect(screen.getByText('001_frames/')).toBeDefined();
		const open = screen.getByRole('link', { name: /0001.png/ });
		expect(open.getAttribute('aria-current')).toBe('page');
		expect(open.getAttribute('href')).toBe(`/archive/${[...frames, '0001.png'].join('/')}`);
	});

	/*
	 * A nested row is a control for choosing another file, not a report of what is filed: the design's
	 * own shape, and the measures stay on the top-level rows where the card's job is to say what the
	 * run wrote.
	 */
	it('carries no size or count on an expanded folder’s rows', () => {
		beside(OPEN_FILE, levels([SCREENSHOTS, SCREENSHOTS_LEVEL]));

		const open = screen.getByRole('link', { name: /001_screenshot.png/ });
		expect(open.textContent).toBe('001_screenshot.png');
		expect(open.textContent).not.toContain('KB');
	});

	/*
	 * **The addressed folder expands under its own row** (#143), which reverses #133: a folder had a
	 * column of its own then, so drawing its listing here as well would have been the same listing in
	 * two places. It has no column now, and the folder a reader actually pointed at was the one thing
	 * this card would not open where it was clicked.
	 */
	it('expands the addressed folder itself, and gives its own row the selected treatment', () => {
		browsing(SCREENSHOTS, levels([SCREENSHOTS, SCREENSHOTS_LEVEL]));

		const row = screen.getByRole('link', { name: /screenshots\// });
		expect(row.getAttribute('aria-current')).toBe('page');
		expect(row.className).toContain('bg-tertiary-container');
		expect(row.className).toContain('border-tertiary');
		// Its count stays on it, because it is still a top-level row saying what the run wrote.
		expect(row.textContent).toContain('3 files');
		// And what it holds is listed under it, name only.
		expect(screen.getByRole('link', { name: /001_screenshot.png/ }).textContent).toBe(
			'001_screenshot.png',
		);
		expect(screen.getByText('001_frames/')).toBeDefined();
	});

	// The settled sentences, indented and not reworded: the same three states one level up.
	it('reuses this screen’s own sentences for a folder whose level is not a listing', () => {
		for (const [level, said] of [
			[{ status: 'loading' } as ArchiveLevel, 'Reading this level of the archive.'],
			[{ status: 'empty' } as ArchiveLevel, 'Nothing is filed under this directory'],
			[{ status: 'unreadable' } as ArchiveLevel, 'ARCHIVE NOT READABLE'],
		] as const) {
			const { unmount } = beside(OPEN_FILE, levels([SCREENSHOTS, level]));

			expect(screen.getByText(new RegExp(said))).toBeDefined();
			unmount();
		}
	});
});
