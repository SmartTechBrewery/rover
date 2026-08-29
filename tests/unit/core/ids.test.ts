import { describe, expect, it } from 'vitest';
import {
	InvalidIdError,
	parseAppId,
	parseDeviceSerial,
	parseElementId,
	parsePlatformId,
	unwrap,
} from '@/core/ids.js';

describe('id parsers', () => {
	const parsers = [
		['parseDeviceSerial', parseDeviceSerial, 'DeviceSerial'],
		['parsePlatformId', parsePlatformId, 'PlatformId'],
		['parseElementId', parseElementId, 'ElementId'],
	] as const;

	for (const [name, parse, kind] of parsers) {
		describe(name, () => {
			it('round-trips a non-empty string through unwrap', () => {
				expect(unwrap(parse('abc-123'))).toBe('abc-123');
			});

			it.each(['', '   ', '\t\n'])('rejects %j with InvalidIdError', (raw) => {
				expect(() => parse(raw)).toThrow(InvalidIdError);
				try {
					parse(raw);
				} catch (error) {
					expect(error).toBeInstanceOf(InvalidIdError);
					expect((error as InvalidIdError).kind).toBe(kind);
					expect((error as InvalidIdError).attempted).toBe(raw);
				}
			});
		});
	}
});

/**
 * The one id with a shape, and the only one whose parser is a security boundary: an app id
 * ends up inside a command line the **device** interprets (`adb shell am force-stop
 * <appId>` is one string handed to the device's `sh`), so `com.a; pm uninstall com.b` gets
 * two commands run on hardware lent out for four verbs. Verified on API 37 / adb 37.0.1:
 * `am force-stop 'com.rover.nope;echo INJECTED'` printed `INJECTED` and exited 0, and
 * `pm clear 'com.rover.nope; echo Success'` came back with `Success` on stdout, `Failed` on
 * stderr and exit 0 — a clear that never happened, reported as done (PROJECT.md §6).
 */
describe('parseAppId', () => {
	it.each([
		'com.android.settings',
		'com.example.app',
		'a.b',
		'com.example.my_app',
		'com.my-company.app',
		'com.example.app2',
	])('accepts %j', (raw) => {
		expect(unwrap(parseAppId(raw))).toBe(raw);
	});

	it.each([
		['empty', ''],
		['whitespace', '   '],
		['a single segment', 'settings'],
		['a second command', 'com.a; echo Success'],
		['a command substitution', 'com.a$(id)'],
		['a space', 'com.a b'],
		['a leading-digit segment', 'com.1a'],
		['a leading dash, which a command would read as an option', '-rf.com.a'],
		['a trailing dot', 'com.a.'],
		['a newline, which is a command separator of its own', 'com.a\nreboot'],
	])('rejects %s with InvalidIdError', (_case, raw) => {
		expect(() => parseAppId(raw)).toThrow(InvalidIdError);
		try {
			parseAppId(raw);
		} catch (error) {
			expect((error as InvalidIdError).kind).toBe('AppId');
			expect((error as InvalidIdError).attempted).toBe(raw);
		}
	});
});
