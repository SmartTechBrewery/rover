import { describe, expect, it } from 'vitest';
import {
	instantOf,
	isAtOrAfter,
	isUnifiedLogTimestamp,
	levelFlags,
	logPredicate,
	readLogsArgv,
	startOf,
} from '@/backends/ios-simulator/log-query.js';
import type { LogEntry } from '@/core/device.js';

/**
 * The pushdown, pinned as exact strings.
 *
 * **A predicate is the one kind of mistake this backend cannot make loudly.** A wrong flag fails;
 * a wrong `--predicate` answers fewer entries and looks exactly like a quiet device, which is the
 * plausible-looking wrong answer ai/RULES.md §2 is about. So each form is asserted character for
 * character here, and the device suite (`tests/device/ios-simulator/logs.test.ts`) proves the
 * same strings are ones a real `log` binary accepts.
 *
 * Every form was run against a booted simulator on macOS 27.0.1 / Xcode 26.4.1 / iOS 26.4.1,
 * 2026-10-06, before it was written down (`PROJECT.md` §6).
 */
describe('logPredicate', () => {
	it('answers nothing when the selection asks for nothing a predicate can carry', () => {
		expect(logPredicate({})).toBeUndefined();
		expect(logPredicate({ minLevel: 'verbose' })).toBeUndefined();
		expect(logPredicate({ minLevel: 'debug' })).toBeUndefined();
		expect(logPredicate({ minLevel: 'info' })).toBeUndefined();
	});

	it('selects one process by its identifier', () => {
		expect(logPredicate({ pid: 49_847 })).toBe('processIdentifier == 49847');
	});

	/** Parenthesised because `AND` binds tighter than `OR`, and this is the clause holding one. */
	it('selects an app’s processes as a bracketed alternation', () => {
		expect(logPredicate({ pids: [49_847, 26_209] })).toBe(
			'(processIdentifier == 49847 OR processIdentifier == 26209)',
		);
	});

	/** iOS has no `warn`, so `warn` and `error` select the same entries — the honest answer. */
	it.each([
		['warn', '(messageType == error OR messageType == fault)'],
		['error', '(messageType == error OR messageType == fault)'],
		['fatal', 'messageType == fault'],
	] as const)('pushes minLevel %s down as %s', (minLevel, clause) => {
		expect(logPredicate({ minLevel })).toBe(clause);
	});

	/**
	 * `tag` is the **subsystem**, which is the field `parsers/unified-log.ts` fills `LogEntry.tag`
	 * from — so a tag copied out of an entry selects the entries carrying it. `category` is never
	 * read, so selecting on it would filter by a field the answer does not show.
	 */
	it('selects a tag as the subsystem the entry was attributed to', () => {
		expect(logPredicate({ tag: 'com.apple.locationd.Core' })).toBe(
			'subsystem == "com.apple.locationd.Core"',
		);
	});

	/**
	 * The one caller-chosen string that reaches the predicate. Backslash first, so the escapes it
	 * introduces are not re-escaped. Measured: `subsystem == "a\"b\\c"` is accepted by the tool
	 * and matches nothing, where the unescaped form is a `Bad predicate` at exit 64.
	 */
	it('escapes a tag into a string literal it cannot leave', () => {
		expect(logPredicate({ tag: 'a"b\\c' })).toBe('subsystem == "a\\"b\\\\c"');
	});

	/** One string per selection, in `LogFilterSchema`'s order, so a suite can pin it. */
	it('joins every clause with AND, in the order the filters are declared in', () => {
		expect(
			logPredicate({ pids: [7], pid: 9, minLevel: 'fatal', tag: 'com.apple.SpringBoard' }),
		).toBe(
			'(processIdentifier == 7) AND processIdentifier == 9 AND messageType == fault AND ' +
				'subsystem == "com.apple.SpringBoard"',
		);
	});
});

describe('levelFlags', () => {
	/**
	 * Both flags are what an unselected read has always sent, and they are not optional: without
	 * them the tool answers neither `Info` nor `Debug` (`parsers/unified-log.ts`).
	 */
	it.each([undefined, 'verbose', 'debug'] as const)('leaves both flags on for %s', (minLevel) => {
		expect(levelFlags(minLevel)).toEqual(['--info', '--debug']);
	});

	/**
	 * `--info` stays, because an entry carrying no `messageType` at all maps to `info` and must
	 * survive — measured, `--info` alone still answers `Info`, `Default`, `Error`, `Fault` and
	 * the absent-level entries.
	 */
	it('drops only --debug for info', () => {
		expect(levelFlags('info')).toEqual(['--info']);
	});

	it.each(['warn', 'error', 'fatal'] as const)('drops both flags for %s', (minLevel) => {
		expect(levelFlags(minLevel)).toEqual([]);
	});
});

describe('readLogsArgv', () => {
	/**
	 * The argv a read with no selections sends — byte-identical to what this backend sent before
	 * the selections were mapped (#304), which is what proves mapping them changed nothing about
	 * the ordinary read.
	 */
	it('sends the unselected read’s argv unchanged', () => {
		expect(readLogsArgv({ last: '30s' }, levelFlags(undefined), undefined)).toEqual([
			'log',
			'show',
			'--style',
			'ndjson',
			'--info',
			'--debug',
			'--last',
			'30s',
		]);
	});

	it('puts the predicate between the level flags and the bound', () => {
		expect(readLogsArgv({ last: '2m' }, ['--info'], 'processIdentifier == 3')).toEqual([
			'log',
			'show',
			'--style',
			'ndjson',
			'--info',
			'--predicate',
			'processIdentifier == 3',
			'--last',
			'2m',
		]);
	});

	/** `--start` runs to now, so it replaces `--last` rather than joining it. */
	it('anchors with --start and no width at all', () => {
		expect(readLogsArgv({ start: '2026-10-06 14:54:08+0200' }, [], undefined)).toEqual([
			'log',
			'show',
			'--style',
			'ndjson',
			'--start',
			'2026-10-06 14:54:08+0200',
		]);
	});
});

describe('isUnifiedLogTimestamp', () => {
	it('accepts the shape this log’s own entries carry', () => {
		expect(isUnifiedLogTimestamp('2026-09-08 10:11:34.092155+0200')).toBe(true);
		expect(isUnifiedLogTimestamp('2026-10-06 14:54:08.135887-0730')).toBe(true);
	});

	/**
	 * The Android shape is the one a caller is most likely to bring by mistake, and it is refused
	 * by name rather than ordering wrongly — `MM-DD HH:MM:SS.mmm` has no year and no offset.
	 */
	it.each([
		['the Android shape', '10-06 14:54:08.135'],
		['a date with no time', '2026-10-06'],
		['no offset', '2026-10-06 14:54:08.135887'],
		['no fraction', '2026-10-06 14:54:08+0200'],
		['an ISO separator', '2026-10-06T14:54:08.135887+0200'],
		['an empty string', ''],
	])('refuses %s', (_name, value) => {
		expect(isUnifiedLogTimestamp(value)).toBe(false);
	});
});

describe('startOf', () => {
	/**
	 * **The fraction is dropped because the tool rejects it**: measured, `--start` with a
	 * fractional value fails with *"Failed conversion … using format '%Y-%m-%d %H:%M:%S%z'"*.
	 * Flooring moves the device-side bound earlier, so the read stays a superset of the answer.
	 */
	it('floors to the second and keeps the offset the device printed', () => {
		expect(startOf('2026-10-06 14:54:08.135887+0200')).toBe('2026-10-06 14:54:08+0200');
		expect(startOf('2026-10-06 14:54:08.1-0730')).toBe('2026-10-06 14:54:08-0730');
	});
});

describe('instantOf', () => {
	it('reads a timestamp as microseconds since the epoch', () => {
		expect(instantOf('1970-01-01 00:00:01.000500+0000')).toBe(1_000_500);
		expect(instantOf('1970-01-01 02:00:00.000000+0200')).toBe(0);
		expect(instantOf('1969-12-31 23:00:00.000000-0100')).toBe(0);
	});

	/** Padded when a release prints fewer digits, floored when it prints more. */
	it('reads the fraction to microsecond precision, whatever its width', () => {
		expect(instantOf('1970-01-01 00:00:00.5+0000')).toBe(500_000);
		expect(instantOf('1970-01-01 00:00:00.1234567+0000')).toBe(123_456);
	});

	it('answers nothing for a value that is not one of this log’s timestamps', () => {
		expect(instantOf('')).toBeNull();
		expect(instantOf('10-06 14:54:08.135')).toBeNull();
	});
});

describe('isAtOrAfter', () => {
	const entry = (timestamp: string): LogEntry => ({
		timestamp,
		level: 'info',
		tag: '',
		pid: 1,
		message: '',
	});

	it('keeps everything when no anchor was asked for', () => {
		expect(isAtOrAfter(entry(''), undefined)).toBe(true);
	});

	it('keeps the anchor’s own entry and drops the one before it', () => {
		const anchor = '2026-10-06 14:54:08.135887+0200';

		expect(isAtOrAfter(entry(anchor), anchor)).toBe(true);
		expect(isAtOrAfter(entry('2026-10-06 14:54:08.135886+0200'), anchor)).toBe(false);
		expect(isAtOrAfter(entry('2026-10-06 14:54:08.135888+0200'), anchor)).toBe(true);
	});

	/**
	 * The reason this is not the Android side's string comparison: an offset that changed across a
	 * DST boundary makes string order disagree with time order. `01:45+0100` is 00:45 UTC and
	 * `02:30+0200` is 00:30 UTC, so the first is the *later* instant while the lower string.
	 */
	it('orders two entries by instant rather than by the digits they print', () => {
		const earlier = '2026-10-25 02:30:00.000000+0200';
		const later = '2026-10-25 01:45:00.000000+0100';

		expect(later < earlier).toBe(true);
		expect(isAtOrAfter(entry(later), earlier)).toBe(true);
		expect(isAtOrAfter(entry(earlier), later)).toBe(false);
	});

	/** An unparseable line is at no point in time, so it is not at or after anything. */
	it('drops an entry whose timestamp could not be read', () => {
		expect(isAtOrAfter(entry(''), '2026-10-06 14:54:08.135887+0200')).toBe(false);
	});
});
