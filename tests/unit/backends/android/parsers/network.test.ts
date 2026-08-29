import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { acceptedNetworkChange } from '@/backends/android/parsers/network.js';

/**
 * Pinned against output **captured from a real device** — an API 37 emulator
 * (`sdk_gphone16k_arm64`) with adb 37.0.1, `tests/fixtures/adb/` (ai/TESTING.md).
 *
 * There is no *success* fixture for either recipe, and that is the capture's own finding
 * rather than a gap: both print zero bytes on both streams and exit 0, so the file would
 * be empty and an empty fixture reads as a mistake
 * (`tests/fixtures/adb/README.md`). What the success cases below use instead is
 * `am-force-stop.daemon-start.stderr` — a real capture of the one thing that makes
 * "silent" and "zero bytes" different answers, taken on a command that worked. It is not
 * copied under a network name because the banner is written by the adb *client* before it
 * dispatches any subcommand, so it is not this command's output at all; the capture was
 * taken here too and compared byte for byte.
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const DAEMON_BANNER = fixture('am-force-stop.daemon-start.stderr.api37-sdk-gphone16k-arm64.txt');
const AIRPLANE_BAD_ARGUMENT = fixture(
	'cmd-connectivity-airplane-mode.bad-argument.api37-sdk-gphone16k-arm64.txt',
);
const WIFI_BAD_ARGUMENT = fixture(
	'cmd-wifi-set-wifi-enabled.bad-argument.api37-sdk-gphone16k-arm64.txt',
);

const streams = (stdout: string, stderr = ''): { stdout: string; stderr: string } => ({
	stdout,
	stderr,
});

describe('acceptedNetworkChange', () => {
	// What all four calls actually answered on the device: nothing, on either stream.
	it('accepts the silence both recipes answer with', () => {
		expect(acceptedNetworkChange(streams(''))).toBe(true);
	});

	/**
	 * The banner, captured on a command that worked and exited 0. Reading it as a failure
	 * would make the restoration of D9 reject work it had already done, intermittently and
	 * only ever after an `adb kill-server` — which is routine on a developer's machine.
	 */
	it("is not fooled by adb's daemon banner on the stderr of a call that worked", () => {
		expect(acceptedNetworkChange(streams('', DAEMON_BANNER))).toBe(true);
	});

	/**
	 * The connectivity refusal is the whole help text of the service — 943 captured bytes
	 * with no `Error`, no `Exception` and no `Failed` anywhere in them. A predicate that
	 * hunted for error-shaped lines the way `startedActivity` does would read this as a
	 * success, which is why silence is the assertion.
	 */
	it('refuses the help text `cmd connectivity airplane-mode` answers a bad argument with', () => {
		expect(AIRPLANE_BAD_ARGUMENT).not.toMatch(/error|exception|failed/i);
		expect(acceptedNetworkChange(streams(AIRPLANE_BAD_ARGUMENT))).toBe(false);
	});

	// One line, and on stdout — where `am start` puts its refusals on stderr. Neither
	// stream is the authoritative one, which is why both are read.
	it('refuses the IllegalArgumentException `cmd wifi set-wifi-enabled` answers with', () => {
		expect(acceptedNetworkChange(streams(WIFI_BAD_ARGUMENT))).toBe(false);
	});

	// Both captured refusals arrived on stdout, so this is the half no fixture proves. It
	// is one adb release away from arriving, and a device-side failure that reached stderr
	// while the banner was also there must still be a failure.
	it('refuses a device-side failure that shared stderr with the banner', () => {
		expect(acceptedNetworkChange(streams('', `${DAEMON_BANNER}Failed\n`))).toBe(false);
	});

	/**
	 * The recipes exit 255 on every refusal captured, so `runAdb` throws before this
	 * module is consulted (PROJECT.md §6). This is the case that says the exit code is not
	 * what is being trusted: the same wording, arriving with exit 0 on some future adb, is
	 * still a refusal.
	 */
	it('refuses printed output regardless of the exit code that carried it', () => {
		expect(acceptedNetworkChange(streams('Invalid args for set-wifi-enabled: …\n'))).toBe(false);
	});
});
