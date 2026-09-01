import type { ArchivedArtifactState } from '@panel/archive/artifact.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ArtifactPreview } from './artifact-preview.js';

const SCREENSHOT = [
	'checkout-app',
	'login-flow',
	'20260830T170501Z-issue-112-9f1c2ab4',
	'R5CT30ABCDE',
	'screenshots',
	'001_screenshot.png',
] as const;

const URL_OF_BYTES = 'blob:rover-panel/1';

/** The one height bound the three drawn bodies share — `artifact-preview.tsx`'s own constant. */
const MAX_HEIGHT = 'max-h-[70vh]';

function read(body: ArchivedArtifactState & { status: 'read' }): ArchivedArtifactState {
	return body;
}

const IMAGE = read({ status: 'read', body: { kind: 'image', url: URL_OF_BYTES } });
const RECORDING = read({ status: 'read', body: { kind: 'recording', url: URL_OF_BYTES } });
const LOG = read({
	status: 'read',
	body: {
		kind: 'text',
		url: URL_OF_BYTES,
		lines: [
			'# older entries were dropped — the device had more than this read asked for',
			'08-30 17:05:03.123 I/ActivityManager(1234): Displayed com.example/.MainActivity',
			'08-30 17:05:04.001 W/ActivityManager(1234): Slow operation took 812ms',
			'08-30 17:05:04.500 E/AndroidRuntime(2001): FATAL EXCEPTION: main',
		],
	},
});
const OPAQUE = read({ status: 'read', body: { kind: 'opaque' } });

function showing(artifact: ArchivedArtifactState, path: readonly string[] = SCREENSHOT) {
	return render(<ArtifactPreview artifact={artifact} path={path} />);
}

/** The region the artifact sits in, which is the one thing on this card that must stay clean. */
function region(container: HTMLElement): Element {
	const found = container.querySelector('section > div:last-child > div');
	if (found === null) {
		throw new Error('the preview card has no body region');
	}
	return found;
}

describe('an artifact preview', () => {
	it('names the file it is showing, and nothing else in that strip', () => {
		const { container } = showing(IMAGE);

		expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('001_screenshot.png');
		// The counter slot is the header row's, not this card's; nothing here counts anything.
		expect(container.textContent).not.toContain('files');
	});

	/*
	 * **The rule that must not be traded away** (`docs/DESIGN.md` §5, §9). An overlay tints the exact
	 * thing the reader opened the screen to look at, so the region around the artifact carries none
	 * of these — and a hairline border is the most that is permitted.
	 */
	it('lays nothing over or around the artifact', () => {
		for (const artifact of [IMAGE, RECORDING, LOG, OPAQUE]) {
			const { container, unmount } = showing(artifact);
			const markup = container.innerHTML;

			for (const forbidden of [
				'scanline',
				'scanlines',
				'mix-blend',
				'bg-gradient',
				'bg-linear',
				'shadow-',
				'drop-shadow',
				'opacity-',
				'backdrop-',
				'vignette',
				'watermark',
				'bezel',
				'frame',
			]) {
				expect(markup).not.toContain(forbidden);
			}
			// Nothing moves, either: §5 has no exception for a preview.
			expect(markup).not.toContain('animate');
			unmount();
		}
	});

	it('shows an image contained and centred at its natural ratio, with one hairline border', () => {
		const { container } = showing(IMAGE);

		const image = screen.getByAltText('001_screenshot.png');
		expect(image.getAttribute('src')).toBe(URL_OF_BYTES);
		// Contained rather than stretched or cropped, and never scaled up past its own pixels.
		expect(image.className).toContain('object-contain');
		expect(image.className).toContain(MAX_HEIGHT);
		expect(image.className).toContain('max-w-full');
		expect(image.className).toContain('border border-outline-variant');
		expect(image.className).not.toContain('object-cover');
		// Not stretched: `max-w-full` bounds it, `w-full` would fill — and no dimension is set at all,
		// which is what keeps a small screenshot at its own pixels.
		const utilities = image.className.split(' ');
		expect(utilities).not.toContain('w-full');
		expect(utilities).not.toContain('h-full');
		expect(region(container).className).toContain('items-center');
	});

	/*
	 * **A percentage bound here is inert, and the class-presence assertion above could not tell the
	 * difference** (#140 review). Nothing over the artifact has a definite height — the card's
	 * `<section>` is `min-h-[400px]` at `height: auto` and its body is a stretching `flex-1` item —
	 * so `max-height: 100%` computes to `none` while `max-width: 100%` resolves. Measured in headless
	 * Chrome at 1400x900 on the built chain: a 1080x2400 screenshot under `max-h-full` was 576x1278
	 * with the card 1372 px tall and its `overflow-y-auto` body never scrolling; under the bound below
	 * it is 257x569 with the card 663 px. jsdom lays nothing out, so this pins the class the
	 * measurement chose and nothing more — the measurement itself is in the module's own header.
	 */
	it('bounds the artifact’s height with something that resolves, not with a percentage', () => {
		const { container } = showing(IMAGE);
		const video = showing(RECORDING).container.querySelector('video');

		for (const bounded of [screen.getByAltText('001_screenshot.png'), video]) {
			const utilities = (bounded?.className ?? '').split(' ');
			expect(utilities).toContain(MAX_HEIGHT);
			expect(utilities).not.toContain('max-h-full');
		}
		// And the region it sits in carries no height of its own to be bounded against.
		expect(region(container).className).not.toContain('h-[');
	});

	/*
	 * The text body is the third one under the same bound, and the reason is `MAX_LOG_ENTRIES`: a
	 * 5 000-line log grew the card instead of scrolling in it, because the card's own
	 * `overflow-y-auto` has no definite height to overflow. Measured: 569 px over a 150 048 px
	 * `scrollHeight`, card 614 px.
	 */
	it('scrolls a long text file inside the card rather than growing it', () => {
		const { container } = showing(LOG);

		const lines = container.querySelector('ol')?.parentElement;
		expect(lines?.className).toContain(MAX_HEIGHT);
		expect(lines?.className).toContain('overflow-y-auto');
	});

	/*
	 * §5 forbids anything that loops on its own, and §10 forbids a styled player. A recording a
	 * person pressed play on is a response to something real; one that starts itself is not.
	 */
	it('gives a recording the browser’s own controls, and neither autoplay nor loop', () => {
		const { container } = showing(RECORDING);

		const video = container.querySelector('video');
		expect(video).not.toBeNull();
		expect(video?.getAttribute('src')).toBe(URL_OF_BYTES);
		expect(video?.hasAttribute('controls')).toBe(true);
		expect(video?.hasAttribute('autoplay')).toBe(false);
		expect(video?.hasAttribute('loop')).toBe(false);
		expect(video?.hasAttribute('muted')).toBe(false);
	});

	it('numbers a text file’s own lines from one, and wraps them rather than truncating', () => {
		const { container } = showing(LOG, [...SCREENSHOT.slice(0, 4), 'logs', '001_read_logs.txt']);

		const rows = container.querySelectorAll('ol > li');
		expect(rows).toHaveLength(4);
		expect(rows[0]?.textContent).toContain('1');
		expect(rows[0]?.textContent).toContain('older entries were dropped');
		expect(rows[3]?.textContent?.startsWith('4')).toBe(true);
		const line = rows[1]?.querySelector('span:last-child');
		expect(line?.className).toContain('whitespace-pre-wrap');
		expect(line?.className).toContain('break-words');
		expect(line?.className).not.toContain('truncate');
	});

	/*
	 * **The level is plain text with no colour.** `W` and `E` are the device's words about its own
	 * logs, not Rover's verdict on anything — colouring them is the pass/fail vocabulary §2 has had
	 * to remove several times, on the region where a fabricated `PASS` line lived longest.
	 */
	it('renders a log level as plain text, with no colour and nothing parsed out of the line', () => {
		const { container } = showing(LOG);

		const rows = container.querySelectorAll('ol > li');
		// Every line is one text node: nothing inside it is wrapped in a span of its own to be tinted.
		for (const row of rows) {
			const line = row.querySelector('span:last-child');
			expect(line?.children).toHaveLength(0);
		}
		// Scoped to the lines themselves: the header's own hover accent is a control's, not a level's.
		const printed = container.querySelector('ol')?.innerHTML ?? '';
		for (const colour of ['text-error', 'text-secondary', 'text-tertiary', 'bg-error']) {
			expect(printed).not.toContain(colour);
		}
		expect(container.textContent).toContain('W/ActivityManager(1234): Slow operation took 812ms');
	});
});

/**
 * **One control, and it is a view rather than a transfer** (`docs/DESIGN.md` §10). There is no
 * download control anywhere in the panel, and no second way to move through the artifacts: another
 * file is chosen in `CONTENTS`.
 */
describe('the preview’s one control', () => {
	it('opens the artifact in a new window, and offers no download', () => {
		for (const artifact of [IMAGE, RECORDING, LOG]) {
			const { container, unmount } = showing(artifact);

			const control = screen.getByRole('link', { name: /Open in a new window/ });
			expect(control.getAttribute('href')).toBe(URL_OF_BYTES);
			expect(control.getAttribute('target')).toBe('_blank');
			expect(control.getAttribute('rel')).toBe('noopener noreferrer');
			expect(control.hasAttribute('download')).toBe(false);
			expect(container.innerHTML).not.toContain('download');
			unmount();
		}
	});

	// Nothing a browser would display, so offering the tab would be offering a download.
	it('is absent for bytes the panel cannot show', () => {
		showing(OPAQUE);

		expect(screen.queryByRole('link')).toBeNull();
	});

	it('is absent while there is no artifact to open', () => {
		showing({ status: 'reading' });

		expect(screen.queryByRole('link')).toBeNull();
	});

	/*
	 * The absences the issue is explicit about: `CONTENTS` is how another file is chosen, and
	 * comparison is `Compare — Visual Diff`'s question on a different screen.
	 */
	it('offers no zoom, no filmstrip, no next or previous, and no annotation', () => {
		const { container } = showing(IMAGE);

		expect(container.querySelectorAll('button')).toHaveLength(0);
		const text = (container.textContent ?? '').toLowerCase();
		for (const absent of ['zoom', 'rotate', 'next', 'previous', 'annotate', 'compare', 'measure']) {
			expect(text).not.toContain(absent);
		}
	});
});

/**
 * The three states that are not an artifact, **none of them reading like another** (D6) and none of
 * them an alarm: no colour, no icon, no error code and no retry control (`docs/DESIGN.md` §7).
 */
describe('an artifact that is not there', () => {
	it('says it is reading, in one line and with no spinner', () => {
		const { container } = showing({ status: 'reading' });

		expect(screen.getByText('Reading this artifact.')).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
		expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
	});

	it('says nothing is filed at the address, plainly', () => {
		const { container } = showing({ status: 'missing' });

		expect(screen.getByText(/Nothing is filed at this address/)).toBeDefined();
		expect(container.textContent).not.toContain('Rover cannot read this artifact');
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	it('says a file it will not serve differently again', () => {
		const { container } = showing({ status: 'unreadable' });

		expect(screen.getByText(/Rover cannot read this artifact/)).toBeDefined();
		expect(container.textContent).not.toContain('Nothing is filed at this address');
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	// Not a fault either: the file is filed and the host it is on is where it can be opened.
	it('says bytes it cannot draw are bytes it cannot draw, with no control and no alarm', () => {
		const { container } = showing(OPAQUE);

		expect(screen.getByText(/no way to show this file/)).toBeDefined();
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
		expect(container.textContent).not.toContain('Nothing is filed at this address');
	});
});
