import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dumpedPath, nullRootReport } from '@/backends/android/parsers/uiautomator.js';

/**
 * Pinned against output **captured from a real device** — an API 37 emulator
 * (`sdk_gphone16k_arm64`) with adb 37.0.0, `tests/fixtures/adb/` (ai/TESTING.md). Both
 * captures were taken with `> f 2>&1`, so the *stream* the confirmation lands on is
 * recorded rather than assumed; it is stdout, and stderr was empty (PROJECT.md §6).
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const DUMPED = fixture('uiautomator-dump.api37-sdk-gphone16k-arm64.txt');
const UNWRITABLE = fixture('uiautomator-dump.unwritable-path.api37-sdk-gphone16k-arm64.txt');
const NULL_ROOT = fixture('uiautomator-dump.null-root.api36-sdk-gphone64-arm64.txt');

describe('dumpedPath', () => {
	it('reads the path out of a real confirmation', () => {
		expect(dumpedPath(DUMPED)).toBe('/sdcard/window_dump.xml');
	});

	/**
	 * The capture this pins is the reason the caller compares the path rather than testing
	 * for the line's presence: `uiautomator dump /data/nope/window_dump.xml` prints exactly
	 * the same confirmation, exits 0, and writes nothing at all (measured 2026-08-30). This
	 * module reports what the command *said*; whether that is the path the caller asked for
	 * is the caller's question.
	 */
	it('reads back a path the dump only claimed to write', () => {
		expect(dumpedPath(UNWRITABLE)).toBe('/data/nope/window_dump.xml');
	});

	it('answers null for output that carries no confirmation at all', () => {
		expect(dumpedPath('')).toBeNull();
		expect(dumpedPath('ERROR: could not get idle state.\n')).toBeNull();
		expect(dumpedPath('java.lang.NullPointerException\n\tat android.foo(Foo.java:1)\n')).toBeNull();
	});

	// The label has to start the line, so a path or a `content-desc` echoed back by some
	// other command cannot supply one.
	it('does not match the label in the middle of a line', () => {
		expect(dumpedPath('note: UI hierchary dumped to: /sdcard/window_dump.xml')).toBeNull();
	});

	// Nothing on an API 37 emulator over the v2 shell protocol carries a `\r`, but a
	// pty-backed shell ends every line `\r\n` — and the caller compares this value to a path
	// by equality.
	it('survives the CRLF a pty-backed shell would add', () => {
		expect(dumpedPath('UI hierchary dumped to: /sdcard/window_dump.xml\r\n')).toBe(
			'/sdcard/window_dump.xml',
		);
	});

	// adb's client chatter precedes the command's own output, so the last line wins.
	it('takes the last confirmation when the output carries more than one', () => {
		const output = [
			'* daemon not running; starting now at tcp:5037',
			'UI hierchary dumped to: /sdcard/stale.xml',
			'UI hierchary dumped to: /sdcard/window_dump.xml',
			'',
		].join('\n');

		expect(dumpedPath(output)).toBe('/sdcard/window_dump.xml');
	});

	// A path with a space in it is a path, and the label ends at the colon rather than at
	// the next whitespace.
	it('keeps a path that contains a space', () => {
		expect(dumpedPath('UI hierchary dumped to: /sdcard/two words.xml\n')).toBe(
			'/sdcard/two words.xml',
		);
	});

	it('answers null when the command named no path at all', () => {
		expect(dumpedPath('UI hierchary dumped to: \n')).toBeNull();
	});
});

/**
 * `nullRootReport`, the one non-confirmation that means "not yet".
 *
 * Pinned to its own capture, taken the way the other two were (`> f 2>&1`) so the stream is
 * recorded rather than assumed: on an API 36 emulator with its **screen off**, the dump
 * printed this line on **stderr** with stdout empty and **exit 0** — no confirmation line at
 * all, which is the shape the backend has to tell apart from every other non-confirmation.
 * Issue #299 reported the identical wording from a physical Android 13 / API 33 device on a
 * read taken right after a cold `launch_app`; the screen off is simply a way to hold the
 * automation bridge in that state on demand (PROJECT.md §6).
 */
describe('nullRootReport', () => {
	const REPORTED = 'ERROR: null root node returned by UiTestAutomationBridge.';

	it('reads the line out of a real capture', () => {
		expect(nullRootReport(NULL_ROOT)).toBe(REPORTED);
	});

	// The full stop is the kind of detail a platform release edits, and the fact the line
	// states does not depend on it.
	it('matches the same line without its trailing full stop', () => {
		expect(nullRootReport('ERROR: null root node returned by UiTestAutomationBridge\n')).toBe(
			'ERROR: null root node returned by UiTestAutomationBridge',
		);
	});

	/**
	 * The separation that keeps the waits' "not yet" from becoming a catch-all: a dump that
	 * could not get an idle state is a screen that will not *settle*, which is a different
	 * fact from a screen that is not there yet, and it stays an untyped refusal.
	 */
	it('answers null for every other way a dump reports nothing', () => {
		expect(nullRootReport('')).toBeNull();
		expect(nullRootReport('ERROR: could not get idle state.\n')).toBeNull();
		expect(nullRootReport(DUMPED)).toBeNull();
		expect(nullRootReport(UNWRITABLE)).toBeNull();
		expect(
			nullRootReport('java.lang.NullPointerException\n\tat android.foo(Foo.java:1)\n'),
		).toBeNull();
	});

	// A pty-backed shell ends every line `\r\n`, and the pattern is anchored at the end of
	// the line — exactly the assertion that would otherwise stop matching.
	it('survives the CRLF a pty-backed shell would add', () => {
		expect(nullRootReport(`${REPORTED}\r\n`)).toBe(REPORTED);
	});

	// What this answer unlocks is a caller polling instead of failing, so the phrase echoed
	// back inside a path or a label must not supply one.
	it('does not match the phrase in the middle of a line', () => {
		expect(nullRootReport(`note: ${REPORTED}`)).toBeNull();
		expect(nullRootReport(`UI hierchary dumped to: /sdcard/${REPORTED}`)).toBeNull();
	});

	// adb's client chatter precedes the command's own output, so the last line wins — the
	// rule `dumpedPath` already follows.
	it('finds the line among adb client chatter', () => {
		const output = ['* daemon not running; starting now at tcp:5037', REPORTED, ''].join('\n');

		expect(nullRootReport(output)).toBe(REPORTED);
	});
});
