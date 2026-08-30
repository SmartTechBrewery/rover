import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { acceptedInput } from '@/backends/android/parsers/input.js';

/**
 * Pinned against output **captured from a real device** — an API 37 emulator
 * (`sdk_gphone16k_arm64`) with adb 37.0.0, `tests/fixtures/adb/` (ai/TESTING.md).
 *
 * There is no *success* fixture for any of the four `input` recipes, and that is the
 * capture's own finding rather than a gap: `tap`, `swipe`, `text` and `keyevent` each print
 * zero bytes on both streams and exit 0, so the file would be empty and an empty fixture
 * reads as a mistake (`tests/fixtures/adb/README.md`). The success cases below use
 * `am-force-stop.daemon-start.stderr` for the reason `parsers/network.test.ts` does: it is a
 * real capture of the one thing that makes "silent" and "zero bytes" different answers,
 * taken on a command that worked, and the banner is the adb *client*'s rather than any one
 * verb's output.
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const DAEMON_BANNER = fixture('am-force-stop.daemon-start.stderr.api37-sdk-gphone16k-arm64.txt');
const UNKNOWN_COMMAND = fixture('input.unknown-command.api37-sdk-gphone16k-arm64.txt');
const TAP_MISSING_ARGUMENT = fixture('input-tap.missing-argument.api37-sdk-gphone16k-arm64.txt');
const TEXT_NON_ASCII = fixture('input-text.non-ascii.api37-sdk-gphone16k-arm64.txt');

const streams = (stdout: string, stderr = ''): { stdout: string; stderr: string } => ({
	stdout,
	stderr,
});

describe('acceptedInput', () => {
	// What all four recipes actually answered on the device: nothing, on either stream.
	it('accepts the silence every input recipe succeeds with', () => {
		expect(acceptedInput(streams(''))).toBe(true);
	});

	it("is not fooled by adb's daemon banner on the stderr of a call that worked", () => {
		expect(acceptedInput(streams('', DAEMON_BANNER))).toBe(true);
	});

	/**
	 * The one refusal that reaches this module at all. `input` answers a subcommand it does
	 * not recognise with `Unknown command: …` **on stdout, at exit 0** — so `runAdb` has
	 * nothing to complain about and the predicate is the only thing between it and a
	 * reported success.
	 */
	it('refuses the `Unknown command` line input answers an unknown subcommand with', () => {
		expect(UNKNOWN_COMMAND).toMatch(/Unknown command/);
		expect(acceptedInput(streams(UNKNOWN_COMMAND))).toBe(false);
	});

	/**
	 * The two captured refusals that arrive at exit 255, where `../adb.js` throws first. They
	 * are asserted anyway, for the reason the network suite states: an exit code that agrees
	 * today is not a reason to stop reading what the device said, and the same wording
	 * arriving with exit 0 on some future adb must still be a refusal.
	 */
	it.each([
		['a malformed tap', TAP_MISSING_ARGUMENT, /IllegalArgumentException/],
		['text the device cannot type', TEXT_NON_ASCII, /NullPointerException/],
	])('refuses %s regardless of the exit code that carried it', (_what, capture, wording) => {
		expect(capture).toMatch(wording);
		expect(acceptedInput(streams('', capture))).toBe(false);
		expect(acceptedInput(streams(capture))).toBe(false);
	});

	// The banner and a real device failure on the same stream — the half no fixture proves,
	// because both captured stack traces arrived on a stderr the banner was not on.
	it('refuses a device-side failure that shared stderr with the banner', () => {
		expect(acceptedInput(streams('', `${DAEMON_BANNER}${TAP_MISSING_ARGUMENT}`))).toBe(false);
	});

	/**
	 * The limit of this module, asserted so that nobody reads its green as coverage of it:
	 * an `input` that ran and did nothing is **byte-for-byte a success**. `input keyevent
	 * NOT_A_KEY` and `input tap 99999 99999` are each exit 0 with zero bytes on both streams
	 * (PROJECT.md §6). What catches those is `../input.js`, before the call — which is why
	 * that module exists.
	 */
	it('cannot tell a successful injection from one that did nothing', () => {
		expect(acceptedInput(streams(''))).toBe(true);
	});
});
