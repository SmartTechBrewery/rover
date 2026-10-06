import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAppPids } from '@/backends/ios-simulator/parsers/launchctl-list.js';

/**
 * The app-to-pids lookup a log read selecting by `appId` runs on, over a **capture** of
 * `launchctl list` taken inside a booted simulator — no process and no Xcode needed, which is
 * the property this whole folder keeps (`../simctl.test.ts`).
 *
 * Captured on macOS 27.0.1 (26A434) / Xcode 26.4.1 (17E202) / iOS 26.4.1 (23E254a), 2026-10-06,
 * with Settings launched (`tests/fixtures/ios-simulator/README.md`). What it is for is the one
 * thing a listing scan can get wrong quietly: attributing one app's processes to another.
 */
const LISTING = readFileSync(
	new URL(
		'../../../../fixtures/ios-simulator/launchctl-list.xcode26.4.1-ios26.4.1.txt',
		import.meta.url,
	),
	'utf8',
);

/** Settings, launched on the bench just before the capture — `simctl launch` reported this pid. */
const PREFERENCES = 'com.apple.Preferences';
const PREFERENCES_PID = 50111;

describe('parseAppPids', () => {
	it('finds the pid launchd has for a running app', () => {
		expect(parseAppPids(LISTING, PREFERENCES)).toEqual([PREFERENCES_PID]);
	});

	/**
	 * An app with no job in the listing is the shape a *terminated* app takes on this platform:
	 * measured on the bench, `simctl terminate` removed the label outright rather than leaving it
	 * behind with a `-`. The caller turns this into a refusal by name (`backend.ts`, `appPids`).
	 */
	it('answers nothing for an app with no job in the listing', () => {
		expect(parseAppPids(LISTING, 'com.example.never.installed')).toEqual([]);
	});

	/**
	 * The one thing a scan can get wrong silently. `com.apple.chrono.WidgetRenderer-Default` is in
	 * the capture and `com.apple.chrono` is not — a prefix match would hand one app's log lines
	 * back under the other's name, with nothing in the answer to say so.
	 */
	it('matches a bundle id whole, never as a prefix of a longer one', () => {
		expect(parseAppPids(LISTING, 'com.apple.chrono')).toEqual([]);
		expect(parseAppPids(LISTING, 'com.apple.chrono.WidgetRenderer-Default')).toEqual([26202]);
	});

	/** The three hundred daemons sharing the listing are not apps, however they are named. */
	it('ignores every job that is not an application’s', () => {
		expect(LISTING).toContain('com.apple.homed');
		expect(parseAppPids(LISTING, 'com.apple.homed')).toEqual([]);
	});

	/**
	 * `-` is how the PID column spells a job that is registered and not running — 198 of the 379
	 * jobs in the capture carry it. It is not a pid and must never be read as one.
	 */
	it('reads no pid out of a job that is registered but not running', () => {
		const listing = `PID\tStatus\tLabel\n-\t0\tUIKitApplication:com.example.idle[abcd][rb-legacy]\n`;

		expect(parseAppPids(listing, 'com.example.idle')).toEqual([]);
	});

	/**
	 * An app can hold more than one job at once — a relaunch, or an extension — which is why the
	 * neutral selection takes a list rather than one pid (`src/core/log-filter.ts`).
	 */
	it('keeps every pid an app has, in the order launchd listed them', () => {
		const listing =
			`PID\tStatus\tLabel\n` +
			`71\t0\tUIKitApplication:com.example.app[0001][rb-legacy]\n` +
			`13\t0\tUIKitApplication:com.example.app[0002][rb-legacy]\n`;

		expect(parseAppPids(listing, 'com.example.app')).toEqual([71, 13]);
	});

	/** A label with no instance tag is still a label, and the bundle id is the whole of it. */
	it('reads a label that carries no instance tag', () => {
		const listing = `PID\tStatus\tLabel\n9\t0\tUIKitApplication:com.example.bare\n`;

		expect(parseAppPids(listing, 'com.example.bare')).toEqual([9]);
	});

	it('answers nothing for output that is not a listing at all', () => {
		expect(parseAppPids('', PREFERENCES)).toEqual([]);
		expect(parseAppPids('PID\tStatus\tLabel\n', PREFERENCES)).toEqual([]);
	});
});
