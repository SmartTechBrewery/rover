import type { ArchiveLevel } from '@panel/archive/archive-levels.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunPanel } from './run-panel.js';

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

function showing(serial: string | null = 'R5CT30ABCDE', contents: ArchiveLevel = CONTENTS) {
	return render(<RunPanel contents={contents} run={RUN} serial={serial} />);
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
		const { container } = showing(null);

		expect(screen.getByText('unknown')).toBeDefined();
		expect(screen.getByText('There is nothing to list for this run.')).toBeDefined();
		expect(container.textContent).not.toContain('0 files');
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
		showing('R5CT30ABCDE', {
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

	// Phase 2, waiting on #133: the card needs a file's *contents*, `list_archive` answers directory
	// listings only, and nothing in the panel fetches #131's artifact route yet. The gap is
	// deliberate rather than filled with a guess.
	it('carries no device card in this phase', () => {
		const { container } = showing();
		const text = container.textContent ?? '';

		expect(text).not.toContain('DEVICE');
		expect(text).not.toContain('API LEVEL');
		expect(text).not.toContain('Pixel');
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
		showing('R5CT30ABCDE', { status: 'unreadable' });

		expect(screen.getByText('ARCHIVE NOT READABLE')).toBeDefined();
		expect(screen.getByText(/runs may well be filed here/)).toBeDefined();
	});

	it('says an empty one plainly', () => {
		showing('R5CT30ABCDE', { status: 'empty' });

		expect(screen.getByText(/Nothing is filed under this directory/)).toBeDefined();
	});

	it('says it is reading, with no spinner', () => {
		const { container } = showing('R5CT30ABCDE', { status: 'loading' });

		expect(screen.getByText('Reading this level of the archive.')).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
	});
});
