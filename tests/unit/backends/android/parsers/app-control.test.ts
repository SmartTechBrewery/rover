import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	isSilent,
	outputLines,
	parseResolvedActivity,
	saysSuccess,
	startedActivity,
} from '@/backends/android/parsers/app-control.js';

/**
 * Pinned against output **captured from a real device** — an API 37 emulator
 * (`sdk_gphone16k_arm64`) with adb 37.0.1, `tests/fixtures/adb/` (ai/TESTING.md).
 *
 * A handful of cases below are inline rather than a fixture, and each says why. They are
 * all the same kind: a shape whose capture exits non-zero, so `runAdb` throws on it and it
 * can never reach this module from a device — but which is one adb release away from
 * arriving with exit 0, which is the whole reason these predicates read the output
 * instead of the exit code.
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const INSTALL_SUCCESS = fixture('install-success.api37-sdk-gphone16k-arm64.txt');
const RESOLVED = fixture('resolve-activity.api37-sdk-gphone16k-arm64.txt');
const NO_ACTIVITY = fixture('resolve-activity.none.api37-sdk-gphone16k-arm64.txt');
const AM_START = fixture('am-start.api37-sdk-gphone16k-arm64.txt');
const AM_START_TOP_MOST = fixture('am-start.top-most.api37-sdk-gphone16k-arm64.txt');
const DAEMON_BANNER = fixture('am-force-stop.daemon-start.stderr.api37-sdk-gphone16k-arm64.txt');
const PM_CLEAR_SUCCESS = fixture('pm-clear-success.api37-sdk-gphone16k-arm64.txt');

const streams = (stdout: string, stderr = ''): { stdout: string; stderr: string } => ({
	stdout,
	stderr,
});

describe('outputLines', () => {
	it('drops blank lines and the whitespace around each one', () => {
		expect(outputLines('  Success  \n\n\tFailed\n')).toEqual(['Success', 'Failed']);
	});

	// No fixture proves this: nothing on an API 37 emulator over the v2 shell protocol
	// returns CRLF. A device on a pty-backed shell does, and `=== 'Success'` is exactly the
	// assertion that would then stop matching, so the path is held by an inline case.
	it('survives the CRLF a pty-backed shell would return', () => {
		expect(outputLines('Performing Streamed Install\r\nSuccess\r\n')).toEqual([
			'Performing Streamed Install',
			'Success',
		]);
	});

	/**
	 * The banner is adb's own, written by the client before the subcommand runs at all —
	 * captured on a `force-stop` that worked and exited 0. Dropping it here is what stops
	 * "this stream should be empty" from reading a server restart as a device failure.
	 */
	it("drops adb's daemon banner, which is the client talking and not the device", () => {
		expect(outputLines(DAEMON_BANNER)).toEqual([]);
	});

	// The other shape the same banner arrives in, when a second adb binary killed the
	// running server. Inline: reproducing it needs two adb versions on one host.
	it('drops the version-mismatch line adb prints when it restarts a foreign server', () => {
		const stderr =
			"adb server version (41) doesn't match this client (39); killing...\n" +
			'* daemon started successfully\n';

		expect(outputLines(stderr)).toEqual([]);
	});

	// The filter is not "ignore stderr", and this is the line that proves the difference.
	it('keeps a device-side failure that arrived on the same stream as the banner', () => {
		expect(outputLines(`${DAEMON_BANNER}Failed\n`)).toEqual(['Failed']);
	});
});

describe('saysSuccess', () => {
	// Two lines on this capture, four on the incremental install PROJECT.md §6 records —
	// `stdout.trim() === 'Success'` rejects an install that worked, either way.
	it('finds the Success line inside what a real install prints around it', () => {
		expect(INSTALL_SUCCESS.trim()).not.toBe('Success');
		expect(saysSuccess(INSTALL_SUCCESS)).toBe(true);
	});

	it('accepts the bare Success pm clear answers with', () => {
		expect(saysSuccess(PM_CLEAR_SUCCESS)).toBe(true);
	});

	// `pm clear` on a package that is not installed. Its capture exits 1 with `Failed` on
	// stderr, so this is the stdout half of the same one-word answer.
	it.each(['Failed\n', 'Performing Streamed Install\n', ''])('rejects %j', (stdout) => {
		expect(saysSuccess(stdout)).toBe(false);
	});

	// A whole line, not a substring: `Success` inside a sentence is not adb saying it.
	it('does not take a mention of the word for the word itself', () => {
		expect(saysSuccess('Successfully queued the install\n')).toBe(false);
	});
});

describe('isSilent', () => {
	it('takes zero bytes on both streams for the success force-stop never states', () => {
		expect(isSilent(streams('', ''))).toBe(true);
	});

	/**
	 * The captured banner, on a force-stop that worked and exited 0. Before this filter the
	 * verb read it as a device failure — intermittently, on the first adb call after a
	 * server restart, on the one path R9 uses to restore state.
	 */
	it('takes silence-plus-daemon-banner for silence', () => {
		expect(isSilent(streams('', DAEMON_BANNER))).toBe(true);
	});

	// Inline, because `am force-stop` with no argument exits 255: the shape matters because
	// the rule has to stay "anything the device said", not "ignore stderr".
	it('rejects the exception a bad force-stop argument throws', () => {
		const stderr =
			"\nException occurred while executing 'force-stop':\n" +
			'java.lang.IllegalArgumentException: Argument expected after "force-stop"\n';

		expect(isSilent(streams('', stderr))).toBe(false);
		expect(isSilent(streams(`${DAEMON_BANNER}`, stderr))).toBe(false);
	});

	it('rejects anything on stdout, which force-stop has no reason to write to', () => {
		expect(isSilent(streams('INJECTED\n', ''))).toBe(false);
	});
});

describe('startedActivity', () => {
	it('accepts the Starting: Intent line am start prints on a launch', () => {
		expect(startedActivity(streams(AM_START))).toBe(true);
	});

	/**
	 * The app was already on top — a launch that succeeded. The capture is merged
	 * (`> f 2>&1`) because the `Warning:` line comes back on stderr while `Starting:` goes
	 * to stdout, and reading the word `Warning` as a failure would make re-launching the
	 * foreground app throw.
	 */
	it('accepts the already-top-most warning', () => {
		expect(startedActivity(streams(AM_START_TOP_MOST))).toBe(true);
	});

	// Exit 1 on the capture, so `runAdb` throws today. Inline, and kept, because
	// `Starting: Intent` is printed *before* anything can go wrong: this is the shape that
	// reads as a success the day adb stops setting the exit code.
	it('rejects a refusal printed under the Starting line', () => {
		const stdout = 'Starting: Intent { cmp=com.android.settings/.Settings }\nError type 3\n';

		expect(startedActivity(streams(stdout))).toBe(false);
	});

	// The same, on the stream API 37 actually put it on (exit 255 there).
	it('rejects a refusal that came back on stderr', () => {
		const stderr =
			"\nException occurred while executing 'start':\n" +
			'java.lang.SecurityException: Permission Denial: starting Intent …\n';

		expect(startedActivity(streams(AM_START, stderr))).toBe(false);
	});

	it('rejects silence — nothing was dispatched', () => {
		expect(startedActivity(streams('', ''))).toBe(false);
	});
});

describe('parseResolvedActivity', () => {
	// `--brief` prints a `priority=… isDefault=true` header above the answer, so a parser
	// reading the first line hands `priority=0 …` to `am start -n`.
	it('reads the component past the header line, off the capture', () => {
		expect(parseResolvedActivity(RESOLVED)).toBe('com.android.settings/.Settings');
	});

	// Both "no such package" and "installed, nothing launchable" answer this, on stdout,
	// exit 0. Neither is a component.
	it('answers null to No activity found', () => {
		expect(parseResolvedActivity(NO_ACTIVITY)).toBeNull();
	});

	/**
	 * An inner-class activity — `.Settings$MyDeviceInfoActivity` and the rest of the
	 * Settings dashboards are all this shape, so `$` has to survive the pattern. Keeping it
	 * out of the device's shell is `shellArg`'s job, not this one's: unquoted, that
	 * component launched plain `.Settings` and reported success (PROJECT.md §6).
	 */
	it('accepts an inner-class component', () => {
		const stdout =
			'priority=0 isDefault=true\ncom.android.settings/.Settings$MyDeviceInfoActivity\n';

		expect(parseResolvedActivity(stdout)).toBe(
			'com.android.settings/.Settings$MyDeviceInfoActivity',
		);
	});

	/**
	 * The shape is checked rather than the wording, so whatever a future adb answers with
	 * instead of `No activity found` still fails here — and a component is what goes into a
	 * device-side command line, so anything a shell would read as more than one word is not
	 * one.
	 */
	it.each([
		['a sentence', 'No launchable activity for this package\n'],
		['a header with no answer under it', 'priority=0 isDefault=true\n'],
		['nothing at all', ''],
		['a second command', 'com.a/.B; reboot\n'],
		['a substitution', 'com.a/.B$(id)\n'],
		['a quote', "com.a/.B'\n"],
		['a space', 'com.a/.B C\n'],
		['no class half', 'com.android.settings\n'],
	])('answers null to %s', (_case, stdout) => {
		expect(parseResolvedActivity(stdout)).toBeNull();
	});
});
