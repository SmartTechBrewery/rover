import type { ArchiveLevel } from '@panel/archive/archive-levels.js';
import type { ArchivedDeviceInfo } from '@panel/archive/device-info.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/panel/device-info.json';
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

function showing(
	serial: RunSerial = NAMED,
	contents: ArchiveLevel = CONTENTS,
	device: ArchivedDeviceInfo = DEVICE,
) {
	return render(<RunPanel contents={contents} device={device} run={RUN} serial={serial} />);
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

		expect(screen.getByText('reading')).toBeDefined();
		expect(screen.getByText('Reading this level of the archive.')).toBeDefined();
		expect(container.textContent).not.toContain('There is nothing to list for this run.');
		// A `CONTENTS` entry rather than `device_info.json`, which card 2's heading names in every
		// state: what must not leak in is the listing.
		expect(container.textContent).not.toContain('latest_recording');
		expect(container.innerHTML).not.toContain('animate');
	});

	it('says the host cannot read it, rather than that the run wrote nothing', () => {
		const { container } = showing({ status: 'unreadable' });

		expect(screen.getByText('not readable')).toBeDefined();
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
