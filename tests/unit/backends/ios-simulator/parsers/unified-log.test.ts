import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseUnifiedLog } from '@/backends/ios-simulator/parsers/unified-log.js';
import type { LogLevel } from '@/core/device.js';

/**
 * Pinned against output **captured from a real simulator** — an already-booted iPhone 17 on
 * Xcode 26.4.1 / iOS 26.4.1, `tests/fixtures/ios-simulator/` (ai/TESTING.md). Nothing here
 * spawns anything, so the suite runs on a machine with no Xcode at all.
 *
 * Two captures, and the second is here for the levels. `ORDINARY` is one minute of one
 * process, which is what an ordinary read looks like: `Default`, `Info`, `Error`, and
 * entries carrying **no `messageType` key at all**. `LEVELS` is a one-second window over
 * one process's launch burst, the only narrowing on this bench that carries all five of
 * Apple's level words in tens of kilobytes — the fixtures README has the commands.
 *
 * The last block holds the shapes no capture here carries, each inline case saying why —
 * `logcat.test.ts`'s arrangement. **`messageType: "None"` is the one that matters**:
 * `docs/IOS.md` §5 records it from a different bench, and no capture on this one carries a
 * single instance — 195,947 entries of a 30-minute all-process capture, 25,422 of which
 * carried no `messageType` key instead and not one of which spelled it `"None"`. So its
 * destination is pinned here rather than left to be discovered on someone else's machine.
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/ios-simulator/${name}`, import.meta.url), 'utf8');

const ORDINARY = fixture('unified-log-ndjson.xcode26.4.1-ios26.4.1.json');
const LEVELS = fixture('unified-log-ndjson.levels.xcode26.4.1-ios26.4.1.json');

/** The capture's own lines, decoded here so an assertion can compare Apple's word to ours. */
const lines = (capture: string): string[] => capture.split('\n').filter((line) => line.length > 0);

/**
 * What each `messageType` in a capture came out as, read off the capture rather than off a
 * table in the test: every non-trailer line is decoded here, paired with the entry the
 * parser answered at the same index, and grouped by Apple's word. `absent` is the key for a
 * line with no `messageType` at all, which is most of what is not a `logEvent`.
 */
function levelsByMessageType(capture: string): Record<string, LogLevel[]> {
	const decoded = lines(capture)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((event) => 'eventType' in event);
	const entries = parseUnifiedLog(capture);
	expect(entries).toHaveLength(decoded.length);

	const grouped = new Map<string, Set<LogLevel>>();
	for (const [index, event] of decoded.entries()) {
		const word = typeof event.messageType === 'string' ? event.messageType : 'absent';
		const seen = grouped.get(word) ?? new Set<LogLevel>();
		seen.add(entries[index].level);
		grouped.set(word, seen);
	}

	return Object.fromEntries([...grouped].map(([word, levels]) => [word, [...levels].sort()]));
}

describe('parseUnifiedLog, against the ordinary capture', () => {
	/**
	 * 53 lines came back for a one-minute window: fifty-two entries and the tool's own
	 * `{"count":52,"finished":1}`, which describes the output rather than anything the device
	 * said. It is the one line this parser deliberately drops.
	 */
	it('reads every line as an entry and drops the trailer', () => {
		expect(lines(ORDINARY)).toHaveLength(53);
		expect(JSON.parse(lines(ORDINARY).at(-1) as string)).toEqual({ count: 52, finished: 1 });

		const entries = parseUnifiedLog(ORDINARY);

		expect(entries).toHaveLength(52);
		expect(entries.map((entry) => entry.message)).not.toContain('{"count":52,"finished":1}');
		expect(entries.every((entry) => !entry.message.includes('"finished"'))).toBe(true);
	});

	/**
	 * The mapping in one assertion, off the first line of the capture — which is also an
	 * entry with **no `messageType` key**, the ordinary shape of everything that is not a
	 * `logEvent` (here an `activityCreateEvent`). It lands on `info` and keeps every other
	 * field the device gave it: a timestamp, a pid and a message, none of which a dropped
	 * line would have carried.
	 */
	it('reads the timestamp, level, tag, pid and message off the first entry', () => {
		expect(parseUnifiedLog(ORDINARY)[0]).toEqual({
			timestamp: '2026-09-08 10:11:34.092155+0200',
			level: 'info',
			tag: '',
			pid: 4337,
			message: 'observedProcessStatesDidChange',
		});
	});

	/**
	 * `tag` is the **subsystem**, and nothing else. A `subsystem:category` composite would
	 * read well and is a name the device never printed; the neutral shape has one field for
	 * attribution, so the entry below is attributed `com.apple.runningboard` and its
	 * `category` of `monitor` is not folded in anywhere.
	 */
	it('takes the tag from the subsystem alone, never a composite with the category', () => {
		const entries = parseUnifiedLog(ORDINARY);

		expect(entries[1]).toMatchObject({ level: 'info', tag: 'com.apple.runningboard' });
		expect(entries.every((entry) => !entry.tag.includes(':'))).toBe(true);
		expect(entries.map((entry) => entry.tag)).not.toContain('com.apple.runningboard:monitor');
	});

	/**
	 * An entry the device attributed to nothing spells its subsystem `""`, which is
	 * `LogEntry.tag`'s own wording for the case — so it arrives as an empty tag rather than
	 * as a placeholder this parser invented. Seven of the fifty-two are like that.
	 */
	it('keeps an empty tag where the device named no subsystem', () => {
		const untagged = parseUnifiedLog(ORDINARY).filter((entry) => entry.tag === '');

		expect(untagged).toHaveLength(7);
	});

	it('keeps the device order — oldest first, so the last entry is the newest', () => {
		const timestamps = parseUnifiedLog(ORDINARY).map((entry) => entry.timestamp);

		expect(timestamps).toEqual([...timestamps].sort());
		expect(timestamps.at(-1)).toBe('2026-09-08 10:11:59.965276+0200');
	});

	/** Every level word in this capture, off the capture: three of Apple's five, plus absent. */
	it('maps every messageType the capture carries onto a level', () => {
		expect(levelsByMessageType(ORDINARY)).toEqual({
			absent: ['info'],
			Default: ['info'],
			Error: ['error'],
			Info: ['info'],
		});
	});
});

describe('parseUnifiedLog, against the levels capture', () => {
	/**
	 * **All five of Apple's level words, against output a simulator produced** rather than
	 * against a table someone remembered — and `Default → info` beside `Info → info` is the
	 * fold worth seeing pinned: `Default` is what a log call with no level argument emits,
	 * so it is the platform's ordinary line rather than a sixth severity.
	 *
	 * `absent` is in the same answer because it is the same rule: nineteen of these
	 * sixty-nine entries carry no `messageType` key, and they are entries all the same.
	 */
	it('maps all five of the platform level words, and an absent one, onto a level', () => {
		expect(levelsByMessageType(LEVELS)).toEqual({
			absent: ['info'],
			Debug: ['debug'],
			Default: ['info'],
			Error: ['error'],
			Fault: ['fatal'],
			Info: ['info'],
		});
	});

	/**
	 * The one `Fault` in the capture, in full. A fault is the platform's own name for a
	 * programming error it captured a backtrace for, which is why it is the entry that maps
	 * to `fatal` — and it is exactly the kind of line a screenshot cannot show.
	 */
	it('carries the fault through as a fatal entry with its message intact', () => {
		const faults = parseUnifiedLog(LEVELS).filter((entry) => entry.level === 'fatal');

		expect(faults).toHaveLength(1);
		expect(faults[0]).toMatchObject({
			timestamp: '2026-09-08 10:00:16.269794+0200',
			tag: 'com.apple.contacts',
			pid: 37506,
		});
		expect(faults[0].message).toContain('Failed to exclude URL from backup');
	});

	it('reads every line as an entry and drops the trailer here too', () => {
		expect(lines(LEVELS)).toHaveLength(70);
		expect(JSON.parse(lines(LEVELS).at(-1) as string)).toEqual({ count: 69, finished: 1 });
		expect(parseUnifiedLog(LEVELS)).toHaveLength(69);
	});
});

describe('parseUnifiedLog, on the two neutral levels this platform has no word for', () => {
	/**
	 * `verbose` and `warn` are **never** produced, and that is a decision rather than an
	 * accident: the vocabulary is `Debug | Info | Default | Error | Fault` and nothing in it
	 * means either (`docs/IOS.md` §5). The neutral enum is a superset by design, and
	 * manufacturing a `warn` out of `Error` would report a severity the device did not claim.
	 */
	it('never answers verbose or warn for any capture', () => {
		const levels = [...parseUnifiedLog(ORDINARY), ...parseUnifiedLog(LEVELS)].map(
			(entry) => entry.level,
		);

		expect(levels).not.toContain('verbose');
		expect(levels).not.toContain('warn');
		expect(new Set(levels)).toEqual(new Set(['debug', 'info', 'error', 'fatal']));
	});
});

describe('parseUnifiedLog, on shapes no capture here carries', () => {
	/**
	 * **`messageType: "None"`, the value `docs/IOS.md` §5 left open.** It is `info`, and the
	 * entry keeps its timestamp, its subsystem, its pid and its message — the same
	 * destination as an absent `messageType`, because both mean the same thing: the level
	 * could not be read, which is not evidence of severity in either direction. Dropping the
	 * line would put a silent hole in the one verb whose job is to show what a screenshot
	 * cannot.
	 *
	 * Inline because no capture on this bench carries one — see this file's header.
	 */
	it('lands a messageType of None on info, keeping every other field', () => {
		const line = JSON.stringify({
			timestamp: '2026-09-08 08:53:49.236268+0200',
			messageType: 'None',
			eventType: 'logEvent',
			subsystem: 'com.apple.rover',
			category: 'fixture',
			processID: 4337,
			eventMessage: 'a line whose level the tool spelled None',
		});

		expect(parseUnifiedLog(line)).toEqual([
			{
				timestamp: '2026-09-08 08:53:49.236268+0200',
				level: 'info',
				tag: 'com.apple.rover',
				pid: 4337,
				message: 'a line whose level the tool spelled None',
			},
		]);
	});

	/**
	 * A level word a later release invents takes the same route as `None`, for the same
	 * reason — and deliberately **not** the route `logcat.ts` gives an unknown level letter,
	 * which is to keep the whole line as a message and lose the rest. There, an unreadable
	 * letter means the line did not match at all; here it is one key of an object whose other
	 * five keys read perfectly well, and throwing away a timestamp and a pid this parser is
	 * holding would be a loss with nothing behind it.
	 */
	it('lands a level word it does not know on info, keeping every other field', () => {
		const line = JSON.stringify({
			timestamp: '2026-09-08 08:53:49.236268+0200',
			messageType: 'Notice',
			eventType: 'logEvent',
			subsystem: 'com.apple.rover',
			category: 'fixture',
			processID: 4337,
			eventMessage: 'a level word this table has never seen',
		});

		expect(parseUnifiedLog(line)).toEqual([
			{
				timestamp: '2026-09-08 08:53:49.236268+0200',
				level: 'info',
				tag: 'com.apple.rover',
				pid: 4337,
				message: 'a level word this table has never seen',
			},
		]);
	});

	/**
	 * **The one rule for a line this parser cannot read**, `logcat.ts`'s verbatim: keep it,
	 * as an `info` entry with no tag, no pid and no timestamp. This is a real path rather
	 * than a defensive one — on a host whose developer directory points at CommandLineTools
	 * the tool prints a sentence of English (`docs/IOS.md` §1), and a caller that merged the
	 * two streams hands exactly that text to this function.
	 */
	it('keeps a line that is not JSON rather than dropping it', () => {
		const line = 'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH';

		expect(parseUnifiedLog(line)).toEqual([
			{ timestamp: '', level: 'info', tag: '', pid: null, message: line },
		]);
	});

	/** JSON that is not an entry either — a fragment of some other tool's output. */
	it('keeps a JSON line that is not an entry, carrying itself', () => {
		const line = '{"unexpected":"json"}';

		expect(parseUnifiedLog(line)).toEqual([
			{ timestamp: '', level: 'info', tag: '', pid: null, message: line },
		]);
	});

	/**
	 * The trailer is recognised **by name**, not by position: "the last line" is a property
	 * of a complete capture, and a caller that read a bounded prefix of a long one has a
	 * trailer nowhere or in the middle of what it concatenated. The test puts one in front of
	 * an entry for exactly that reason.
	 */
	it('drops the trailer wherever it appears, not only at the end', () => {
		const entry = JSON.stringify({
			timestamp: '2026-09-08 08:53:49.236268+0200',
			messageType: 'Error',
			eventType: 'logEvent',
			subsystem: 'com.apple.rover',
			category: 'fixture',
			processID: 4337,
			eventMessage: 'the entry after the trailer',
		});

		expect(parseUnifiedLog(`{"count":1431,"finished":1}\n${entry}\n`)).toEqual([
			{
				timestamp: '2026-09-08 08:53:49.236268+0200',
				level: 'error',
				tag: 'com.apple.rover',
				pid: 4337,
				message: 'the entry after the trailer',
			},
		]);
	});

	it('answers an empty read with no entries at all', () => {
		// What the tool prints for a window nothing matched: the trailer and nothing else,
		// measured on the bench with a predicate no process satisfied.
		expect(parseUnifiedLog('')).toEqual([]);
		expect(parseUnifiedLog('{"count":0,"finished":1}\n')).toEqual([]);
	});
});
