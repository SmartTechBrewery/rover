import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLogcat } from '@/backends/android/parsers/logcat.js';

/**
 * Pinned against output **captured from a real device** — an API 37 emulator
 * (`sdk_gphone16k_arm64`) with adb 37.0.0, `tests/fixtures/adb/` (ai/TESTING.md).
 *
 * The crash capture is the one that matters: it is a real `FATAL EXCEPTION` off a real
 * device, and the acceptance criterion of #69 is that a crash a screenshot cannot show
 * comes back through this parser intact.
 *
 * A handful of cases are inline and each says why. They are all the same kind: a shape no
 * capture here carries, held by an inline case so the behaviour is decided rather than
 * discovered on someone else's device.
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const ORDINARY = fixture('logcat-threadtime.api37-sdk-gphone16k-arm64.txt');
const CRASH = fixture('logcat-threadtime.crash.api37-sdk-gphone16k-arm64.txt');
const LEVELS = fixture('logcat-threadtime.levels.api37-sdk-gphone16k-arm64.txt');

describe('parseLogcat, against the ordinary capture', () => {
	/**
	 * 61 lines came back for `-t 60`: sixty entries and logcat's own `--------- beginning of
	 * main`, which is the tool describing its own output rather than anything the device
	 * said.
	 */
	it('reads every line as an entry and drops the buffer separator', () => {
		expect(ORDINARY.split('\n').filter((line) => line.length > 0)).toHaveLength(61);

		expect(parseLogcat(ORDINARY)).toHaveLength(60);
		expect(parseLogcat(ORDINARY).map((entry) => entry.message)).not.toContain('beginning of main');
	});

	it('reads the timestamp, pid, level, tag and message off a threadtime line', () => {
		expect(parseLogcat(ORDINARY)[0]).toEqual({
			timestamp: '08-30 10:54:11.130',
			level: 'warn',
			tag: 'skia',
			pid: 472,
			message: 'AGTM parsing failed flags.readFromStream(s) at 159',
		});
	});

	/**
	 * `W skia    :` — logcat pads a short tag out to eight columns, and a tag carrying four
	 * trailing spaces would never match anything a caller filtered on.
	 */
	it('trims the padding logcat puts after a short tag, and nothing else', () => {
		const tags = new Set(parseLogcat(ORDINARY).map((entry) => entry.tag));

		expect(tags).toContain('skia');
		expect([...tags].every((tag) => tag === tag.trimEnd())).toBe(true);
	});

	/**
	 * A message routinely contains a colon (`wlan0: CTRL-EVENT-BEACON-LOSS`) and a tag does
	 * not, so the split is on the **first** one. Getting this wrong moves half the message
	 * into the tag, silently.
	 */
	it('splits tag from message at the first colon, leaving the rest of the message alone', () => {
		const supplicant = parseLogcat(ORDINARY).find((entry) => entry.tag === 'wpa_supplicant');

		expect(supplicant?.message).toBe('wlan0: CTRL-EVENT-BEACON-LOSS ');
	});

	it('keeps the device order — oldest first, so the last entry is the newest', () => {
		const entries = parseLogcat(ORDINARY);
		const timestamps = entries.map((entry) => entry.timestamp);

		expect(timestamps).toEqual([...timestamps].sort());
		expect(entries.at(-1)?.tag).toBe('adbd');
	});
});

describe('parseLogcat, against the crash capture', () => {
	/**
	 * The acceptance criterion in miniature: `am crash com.android.settings` on API 37 lands
	 * in the **crash** buffer as `E AndroidRuntime`, and the two lines naming the exception
	 * and the process are what an agent reads to learn the app died.
	 *
	 * Note the level: a Java crash is `E`, never `F` — a check looking for a fatal-level
	 * entry would miss every application crash on this platform.
	 */
	it('carries the fatal exception, its process and its cause through intact', () => {
		const entries = parseLogcat(CRASH);
		const fatal = entries.filter((entry) => entry.message.startsWith('FATAL EXCEPTION'));

		expect(fatal).toHaveLength(2);
		expect(fatal[0]).toMatchObject({ level: 'error', tag: 'AndroidRuntime' });
		expect(entries.map((entry) => entry.message)).toContain(
			'Process: com.android.settings, PID: 14682',
		);
		expect(entries.map((entry) => entry.message)).toContain(
			'android.app.RemoteServiceException$CrashedByAdbException: shell-induced crash',
		);
	});

	/**
	 * One logcat *entry* is fourteen lines here, and every one of them carries the full
	 * threadtime prefix — which is why this parser answers per line rather than trying to
	 * decide where a stack trace ends.
	 */
	it('reads each line of a multi-line crash as its own entry, all naming the same pid', () => {
		const entries = parseLogcat(CRASH);
		const first = entries.filter((entry) => entry.pid === 14682);

		expect(first).toHaveLength(14);
		expect(first.every((entry) => entry.tag === 'AndroidRuntime')).toBe(true);
	});

	/** A stack frame's leading tab is what makes a pasted trace readable; it is not padding. */
	it('keeps the indentation of a stack frame', () => {
		const frames = parseLogcat(CRASH).filter((entry) => entry.message.includes('at android.app'));

		expect(frames.length).toBeGreaterThan(0);
		expect(frames[0]?.message.startsWith('\tat ')).toBe(true);
	});

	it('reads every line of the capture and invents none', () => {
		const lines = CRASH.split('\n').filter((line) => line.length > 0);

		// Every line but logcat's own `--------- beginning of crash`.
		expect(parseLogcat(CRASH)).toHaveLength(lines.length - 1);
	});
});

describe('parseLogcat, against the levels capture', () => {
	/**
	 * Six lines written to the device with `log -p <v|d|i|w|e|f>` and read straight back, so
	 * every letter logcat prints is mapped against output a device produced rather than
	 * against a table someone remembered. `F` is here because a native abort is the only
	 * other way to get one, and that needs root.
	 */
	it('maps every level letter the device prints onto the neutral vocabulary', () => {
		const written = parseLogcat(LEVELS).filter((entry) => entry.tag === 'RoverFixture');

		expect(written.map((entry) => [entry.level, entry.message])).toEqual([
			['verbose', 'verbose line'],
			['debug', 'debug line'],
			['info', 'info line'],
			['warn', 'warn line'],
			['error', 'error line'],
			['fatal', 'fatal line'],
		]);
	});
});

describe('parseLogcat, on shapes no capture here carries', () => {
	/**
	 * Nothing on an API 37 emulator over the v2 shell protocol returns CRLF. A device on a
	 * pty-backed shell does, and the carriage return would otherwise end up inside the
	 * message — where it is invisible in a diff and breaks every comparison downstream.
	 */
	it('survives the CRLF a pty-backed shell would return', () => {
		const line = '08-30 10:54:11.130   472   570 W skia    : AGTM parsing failed\r\n';

		expect(parseLogcat(line)).toEqual([
			{
				timestamp: '08-30 10:54:11.130',
				level: 'warn',
				tag: 'skia',
				pid: 472,
				message: 'AGTM parsing failed',
			},
		]);
	});

	/**
	 * **The one rule for a line this parser cannot read**: keep it, as an `info` entry with
	 * no tag, no pid and no timestamp. Dropping it would put a hole in the one verb whose job
	 * is to show what a screenshot cannot, and a hole reads exactly like a device that said
	 * nothing.
	 */
	it('keeps a line it cannot parse rather than dropping it', () => {
		expect(parseLogcat('a line in no format this parser knows')).toEqual([
			{
				timestamp: '',
				level: 'info',
				tag: '',
				pid: null,
				message: 'a line in no format this parser knows',
			},
		]);
	});

	/**
	 * `S` is a filter argument rather than an output level and no capture has ever shown one,
	 * so it is not mapped to a level nobody observed — it falls to the same rule as any other
	 * unreadable line, and the text survives.
	 */
	it('keeps a line whose level letter is not one logcat prints', () => {
		const line = '08-30 10:54:11.130   472   570 S skia    : silent';

		expect(parseLogcat(line)).toEqual([
			{ timestamp: '', level: 'info', tag: '', pid: null, message: line },
		]);
	});

	/**
	 * A crash entry contains blank lines — `E AndroidRuntime: ` with nothing after it, which
	 * separates a trace from its `Caused by:`. The capture committed here happens not to have
	 * one (the two crashes it holds have no nested cause), so it is inline; the shape was
	 * observed on the same device's crash buffer while capturing.
	 *
	 * It is kept, with an empty message, rather than dropped: the device printed a line, and
	 * the blank between a trace and its cause is part of how a trace reads.
	 */
	it('keeps a line whose message is empty, which a stack trace contains', () => {
		expect(parseLogcat('08-30 10:26:41.778 15356 15356 E AndroidRuntime: ')).toEqual([
			{
				timestamp: '08-30 10:26:41.778',
				level: 'error',
				tag: 'AndroidRuntime',
				pid: 15356,
				message: '',
			},
		]);
	});

	it('answers an empty read with no entries at all', () => {
		// What a device with nothing matching prints: zero bytes, measured on API 37 with a
		// tag filter nothing matched.
		expect(parseLogcat('')).toEqual([]);
		expect(parseLogcat('--------- beginning of crash\n')).toEqual([]);
	});
});
