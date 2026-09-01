import { describe, expect, it } from 'vitest';
import { bodyKindFor, linesOf } from './artifact-body.js';

/**
 * The panel's one media-type vocabulary, and the one thing it is allowed to do to a log file:
 * count its lines.
 *
 * The cross-tree half of this — *every type the host can serve maps to a body* — is
 * `tests/unit/panel/artifact-bodies.test.ts`, which reads `CONTENT_TYPES` out of
 * `src/daemon/archive-file.ts`. What is here is this module's own behaviour.
 */

describe('the body one media type has', () => {
	it('draws the three the preview knows how to show', () => {
		expect(bodyKindFor('image/png')).toBe('image');
		expect(bodyKindFor('video/mp4')).toBe('recording');
		expect(bodyKindFor('text/plain')).toBe('text');
		// The archive's own file, and the one JSON the route serves as JSON.
		expect(bodyKindFor('application/json')).toBe('text');
	});

	// Any case and any parameters: the header is passed through verbatim by `host-client.ts`, so the
	// normalising happens once, here.
	it('reads a header with its parameters and its own casing', () => {
		expect(bodyKindFor('Text/Plain; charset=UTF-8')).toBe('text');
		expect(bodyKindFor('IMAGE/PNG')).toBe('image');
		expect(bodyKindFor('video/mp4 ; codecs="avc1"')).toBe('recording');
	});

	/*
	 * **Named rather than guessed at.** The route's fallback for bytes it cannot name is
	 * `application/octet-stream` — the honest answer, which the panel must not render as text.
	 */
	it('names bytes it cannot show as opaque, rather than choosing a body for them', () => {
		expect(bodyKindFor('application/octet-stream')).toBe('opaque');
		expect(bodyKindFor('application/zip')).toBe('opaque');
		// A response that named no type at all. `host-client.ts` reports that as the empty string.
		expect(bodyKindFor('')).toBe('opaque');
	});
});

describe('a text artifact’s lines', () => {
	// The archive ends every log file it writes with a newline (`renderLogs`), and numbering the
	// nothing after it would claim a line the device never logged.
	it('drops exactly the one trailing newline the archive writes', () => {
		expect(linesOf('first\nsecond\n')).toEqual(['first', 'second']);
		expect(linesOf('only\n')).toEqual(['only']);
	});

	it('keeps a blank line inside the file, because the file has one', () => {
		expect(linesOf('first\n\nthird\n')).toEqual(['first', '', 'third']);
		// Two trailing newlines are one blank line and then the file's end.
		expect(linesOf('first\n\n')).toEqual(['first', '']);
	});

	it('keeps a file with no trailing newline whole', () => {
		expect(linesOf('{"platform":"android"}')).toEqual(['{"platform":"android"}']);
	});

	it('reads an empty file as one empty line rather than as no file', () => {
		expect(linesOf('')).toEqual(['']);
	});

	/*
	 * A log line is what `renderLogs` wrote, and where the read was cut short the file's own first
	 * line says so. Nothing is parsed out of either: the level is the device's word about its own
	 * logs, and this module hands both lines back exactly as they arrived.
	 */
	it('hands back a log file verbatim, truncation comment and levels included', () => {
		const file = [
			'# older entries were dropped — the device had more than this read asked for',
			'08-30 17:05:03.123 I/ActivityManager(1234): Displayed com.example/.MainActivity',
			'08-30 17:05:04.001 W/ActivityManager(1234): Slow operation',
			'08-30 17:05:04.500 E/AndroidRuntime(2001): FATAL EXCEPTION: main',
			'',
		].join('\n');

		const lines = linesOf(file);

		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain('older entries were dropped');
		expect(lines[2]).toBe('08-30 17:05:04.001 W/ActivityManager(1234): Slow operation');
	});
});
