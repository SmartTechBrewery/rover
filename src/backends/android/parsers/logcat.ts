/**
 * The parser for `logcat -v threadtime` output — the device's system log, turned into the
 * neutral entries `src/core/device.ts` declares.
 *
 * Lives here rather than in `../backend.ts` for the reason `ai/CODING_STANDARDS.md` gives:
 * output gets "a parser module with its own tests and its own fixture files captured from
 * a real device". Its captures are `tests/fixtures/adb/logcat-threadtime.*`, and one of
 * them carries a real crash.
 *
 * **This module is where the platform's vocabulary stops.** logcat's `V/D/I/W/E/F` becomes
 * the neutral level enum here, so no platform word escapes `src/backends/android/`
 * (`tests/unit/no-platform-names.test.ts` is the executable half of that rule).
 *
 * **A logcat *entry* is not a logcat *line*, and the difference is measured rather than
 * assumed.** A Java crash is one entry whose message is fourteen lines long, and
 * `threadtime` repeats the whole prefix on each of them (API 37, adb 37.0.0 — PROJECT.md
 * §6). So this parses per line and answers one entry per line: the alternative, stitching
 * a stack trace back together, would need to guess where one ends, and a guess that goes
 * wrong swallows the next line.
 */

import { type LogEntry, LogEntrySchema, type LogLevel } from '../../../core/device.js';

/**
 * One `threadtime` line: `MM-DD HH:MM:SS.mmm  <pid>  <tid> <L> <tag>: <message>`.
 *
 * The tag match is non-greedy and stops at the first colon, because a message routinely
 * contains one (`wlan0: CTRL-EVENT-BEACON-LOSS`) while a tag does not; the tag is then
 * right-trimmed, since logcat pads short ones out to eight columns (`skia    :`). The
 * message keeps everything after a single separating space — including the leading tab a
 * stack frame carries, which is what makes a pasted trace readable.
 *
 * The level letters are exactly the ones logcat prints. `S` (silent) is a filter argument
 * rather than an output level, and no capture here has ever shown one; a line carrying
 * some other letter falls to {@link unparseable} rather than being mapped to a level
 * nobody observed.
 */
const THREADTIME =
	/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+\d+\s+([VDIWEF])\s+(.*?): ?(.*)$/;

/**
 * logcat's own framing, printed once per buffer it was asked for: `--------- beginning of
 * main`. Dropped rather than kept as an entry — it is the tool describing its own output,
 * not something the device said, and it would otherwise arrive on every single read.
 */
const BUFFER_SEPARATOR = /^-{3,} beginning of /;

/** logcat's letter, mapped onto the neutral vocabulary once and in one place. */
const LEVELS: Readonly<Record<string, LogLevel>> = {
	V: 'verbose',
	D: 'debug',
	I: 'info',
	W: 'warn',
	E: 'error',
	F: 'fatal',
};

/**
 * A line this parser could not read, kept rather than dropped.
 *
 * **One rule, stated here**: an unparseable line becomes an `info` entry with no tag, no
 * pid and no timestamp, carrying the line as its message. The alternative — dropping it —
 * puts a silent hole in the one verb whose job is to show what a screenshot cannot, and a
 * hole is indistinguishable from a device that said nothing. `info` because a line whose
 * level could not be read is not evidence of severity in either direction, and an empty
 * `timestamp` because the device's own is the only one that would be true (D17).
 */
function unparseable(line: string): LogEntry {
	return { timestamp: '', level: 'info', tag: '', pid: null, message: line };
}

function toEntry(line: string): LogEntry {
	const match = THREADTIME.exec(line);
	if (!match) return unparseable(line);

	const level = LEVELS[match[3]];
	if (level === undefined) return unparseable(line);

	return {
		timestamp: match[1],
		level,
		tag: match[4].trimEnd(),
		pid: Number(match[2]),
		message: match[5],
	};
}

/**
 * Every entry in one captured `logcat` dump, oldest first — the order the device printed
 * them in, which is also the order they are useful in.
 *
 * Only the line ending is normalised, and only the `\r`: nothing on an API 37 emulator
 * over the v2 shell protocol carries one, but a device that falls back to a pty-backed
 * shell ends every line `\r\n`, and the trailing carriage return would then land inside a
 * message (`../parsers/app-control.ts` records the same trap for its own predicates).
 * Nothing else is trimmed — a message's own leading tab and trailing space are the
 * device's text, not this parser's to tidy.
 */
export function parseLogcat(stdout: string): LogEntry[] {
	const entries: LogEntry[] = [];

	for (const raw of stdout.split('\n')) {
		const line = raw.replace(/\r+$/, '');
		if (line.trim().length === 0 || BUFFER_SEPARATOR.test(line)) continue;
		entries.push(LogEntrySchema.parse(toEntry(line)));
	}

	return entries;
}
