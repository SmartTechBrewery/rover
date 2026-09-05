import type { ArchivedDeviceInfo } from '@panel/archive/device-info.js';
import type { ArchivedTestDescription } from '@panel/archive/test-description.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/panel/device-info.json';
import { RunPanel, type RunSerial } from './run-panel.js';

const RUN = ['checkout-app', 'login-flow', '20260830T170501Z-issue-112-9f1c2ab4'] as const;

/** The level above answered and named the run's one child — the ordinary case. */
const NAMED: RunSerial = { status: 'answered', serial: 'R5CT30ABCDE' };
/** It answered, and the run directory holds something other than exactly one entry. */
const NO_SINGLE_CHILD: RunSerial = { status: 'answered', serial: null };

/** The run's own `device_info.json`, as the archive wrote it — the real capture's shape. */
const DEVICE: ArchivedDeviceInfo = { status: 'read', info: fixture.files[0] };
/** The same device, with the three facts it could not answer (`docs/DESIGN.md` §6). */
const UNANSWERED: ArchivedDeviceInfo = { status: 'read', info: fixture.files[1] };

/** The run's own `test_description.json`, as the archive wrote it (#148). */
const DESCRIBED: ArchivedTestDescription = {
	status: 'read',
	description: 'Checks the login form still fits above the keyboard on a short screen.',
};
/** The common case for a run filed before the field existed: no such file. */
const UNDESCRIBED: ArchivedTestDescription = { status: 'missing' };

function showing(
	serial: RunSerial = NAMED,
	device: ArchivedDeviceInfo = DEVICE,
	description: ArchivedTestDescription = DESCRIBED,
) {
	return render(<RunPanel description={description} device={device} run={RUN} serial={serial} />);
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
	 * — never an invented `0`, and never a second request to go looking. The tree draws nothing
	 * under such a run for the same reason (`directory-tree.test.tsx`).
	 */
	it('says `unknown` when the run holds no single child', () => {
		const { container } = showing(NO_SINGLE_CHILD);

		expect(screen.getByText('unknown')).toBeDefined();
		expect(container.textContent).not.toContain('0 files');
	});
});

/*
 * **The pair that must never render alike, one level further up.** The serial comes off the level
 * *above* the run, so *nobody has answered for that level yet* and *the host cannot read it* are not
 * the run naming no single child, which is the one fact `unknown` stands for here. The card lists
 * nothing since #161, so what draws the three apart is `SERIAL`, `DESCRIPTION` and the device card
 * — every one of which orders the state of the level above before its own answer.
 */
describe('the level the serial is read from', () => {
	it('says it is reading, rather than that the run holds no single child', () => {
		const { container } = showing({ status: 'loading' });

		// `SERIAL` and `DESCRIPTION` both read off that level, so both say it — and saying the same
		// thing is the point: neither may claim anything definite about a level nobody has answered.
		expect(screen.getAllByText('reading')).toHaveLength(2);
		expect(screen.getByText("Reading this run's device_info.json.")).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
	});

	it('says the host cannot read it, rather than that the run holds no single child', () => {
		showing({ status: 'unreadable' });

		expect(screen.getAllByText('not readable')).toHaveLength(2);
		expect(screen.getByText(/Rover cannot read this run's device_info.json/)).toBeDefined();
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
		showing(NAMED, UNANSWERED);

		// The serial the level above named — the card's job is to identify the device, and it always
		// can. It is on the panel twice now, in `SERIAL` and here.
		expect(screen.getAllByText('R5CT30ABCDE')).toHaveLength(2);
	});

	it('names an OS version and an API level it does not have, rather than closing the row up', () => {
		showing(NAMED, UNANSWERED);

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
		const { container } = showing(NAMED, { status: 'missing' });

		expect(screen.getByText(/No device_info.json is filed for this run/)).toBeDefined();
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	it('says an unreadable one differently, and says so in as many words', () => {
		const { container } = showing(NAMED, { status: 'unreadable' });

		expect(screen.getByText(/Rover cannot read this run's device_info.json/)).toBeDefined();
		expect(screen.getByText(/not the same as none being filed/)).toBeDefined();
		expect(container.textContent).not.toContain('No device_info.json is filed');
		expect(container.querySelectorAll('button')).toHaveLength(0);
	});

	it('says it is reading, with no spinner', () => {
		const { container } = showing(NAMED, { status: 'reading' });

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
			const { container, unmount } = showing(serial, { status: 'read', info: {} });

			expect(container.textContent).not.toContain('No device_info.json is filed');
			unmount();
		}
	});

	it('says a run with no `<serial>` directory has no file filed, rather than reading forever', () => {
		showing(NO_SINGLE_CHILD, { status: 'reading' });

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
		showing(NAMED, DEVICE, DESCRIBED);

		expect(screen.getByText('DESCRIPTION')).toBeDefined();
		expect(
			screen.getByText('Checks the login form still fits above the keyboard on a short screen.'),
		).toBeDefined();
	});

	// The common case for every run filed before the field existed, and said without alarm.
	it('says none is filed, in words that are not the unreadable ones', () => {
		const { container } = showing(NAMED, DEVICE, UNDESCRIBED);

		expect(screen.getByText('none filed')).toBeDefined();
		expect(container.textContent).not.toContain('not readable');
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
	});

	it('says the host cannot read the file differently again', () => {
		const { container } = showing(NAMED, DEVICE, { status: 'unreadable' });

		expect(screen.getByText('not readable')).toBeDefined();
		expect(container.textContent).not.toContain('none filed');
	});

	it('says it is reading, with no spinner', () => {
		const { container } = showing(NAMED, DEVICE, { status: 'reading' });

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
		showing(NO_SINGLE_CHILD, DEVICE, { status: 'reading' });

		expect(screen.getByText('none filed')).toBeDefined();
	});
});

describe('what is not on this panel', () => {
	// The superseded design's own file names. The card lists nothing at all since #161, and the one
	// file it may name is the one whose contents the device card reads.
	it('names no file the run did not write', () => {
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

/**
 * **The column, and nothing on it navigates** (#160, #161).
 *
 * It stood beside a preview, beside the tree with a folder of the run open in `CONTENTS`, and alone
 * while nobody had answered for the address — three arrangements, with a back arrow in one of them
 * and `CONTENTS` expanded down to the open address in two. The tree is beside the card at every
 * depth now and reaches every address in the archive, so this column is what a **selected run** is:
 * two cards, no listing, and no way in or out of it at all.
 */
describe('the run column', () => {
	it('is headed by `Run Details`, and the strip carries no control', () => {
		const { container } = showing();

		const strip = container.querySelector('section > div:first-child');
		expect(strip?.textContent).toBe('Run Details');
		expect(strip?.querySelectorAll('a')).toHaveLength(0);
		expect(strip?.querySelectorAll('button')).toHaveLength(0);
		expect(
			screen.queryByRole('link', { name: 'Close the preview and go back to the directory' }),
		).toBeNull();
	});

	/*
	 * **Two cards, and the third is deliberately not built** (#161, `docs/DESIGN.md` §1 and §9).
	 * `d24d2c84…` draws the identity card, the device card and `CONTENTS`; listing what the run
	 * wrote is the tree's job, and a second explorer of the addresses the tree already draws is what
	 * this phase removes rather than what it keeps.
	 */
	it('draws the identity card and the device card, and no listing at all', () => {
		const { container } = showing();

		const cards = [...container.querySelectorAll('div.space-y-6 > section')];
		expect(cards.map((card) => card.querySelector('h3')?.textContent)).toEqual([
			'20260830T170501Z-issue-112-9f1c2ab4',
			'DEVICE — FROM device_info.json',
		]);
		expect(container.textContent).not.toContain('CONTENTS');
		expect(container.querySelectorAll('ul')).toHaveLength(0);
	});

	/*
	 * **Nothing on this card is clickable**, which is the whole of #159's third phase from this
	 * side: the tree is the one navigation surface, and `Open in a new window` on an artifact is the
	 * only interactive control the card beside it may carry.
	 */
	it('carries no link and no button in any state', () => {
		for (const serial of [
			NAMED,
			NO_SINGLE_CHILD,
			{ status: 'loading' },
			{ status: 'unreadable' },
		] as const) {
			const { container, unmount } = showing(serial);

			expect(container.querySelectorAll('a')).toHaveLength(0);
			expect(container.querySelectorAll('button')).toHaveLength(0);
			unmount();
		}
	});
});
