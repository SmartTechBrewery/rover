import { describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend, LOG_WINDOWS } from '@/backends/ios-simulator/backend.js';
import { SimctlCommandError } from '@/backends/ios-simulator/simctl.js';
import { type Device, LogLevelSchema } from '@/core/device.js';

/**
 * The log read against a real booted simulator. Gated on `ROVER_TEST_SIMULATOR`
 * (`tests/device/setup.ts`), so a host without one **skips rather than fails** (ai/TESTING.md).
 *
 * The mocked suite beside it proves the argv, the widening, the cap and what `truncated` means
 * against a committed capture. What this proves is what a capture cannot: that a simulator still
 * answers this argv, that the read really is bounded — the whole point of pushing the bound down
 * into the query — and that what comes back off a *live* log parses into entries rather than into
 * lines the parser could not read.
 *
 * **Read-only, and it changes nothing**: a log read is the one verb that cannot alter the device.
 * Nothing here boots, shuts down, installs or launches anything (`docs/IOS.md` §8, trap 4).
 *
 * **Nothing asserts an absolute count or a level**, and that is deliberate rather than shy. What
 * a device says in a given window belongs to whatever is running on it: the same simulator
 * answered 67 and 160 entries per second half an hour apart on this repository's bench, and
 * `Debug` is rare
 * enough on an idle one that waiting for it would be a flaky test rather than a check
 * (`tests/fixtures/ios-simulator/README.md`). The flags that decide the levels are pinned as argv
 * in the unit suite, where they are a fact about this backend rather than about the host's mood.
 *
 * No lease, for `./backend.test.ts`'s reason: nothing is registered yet, so there is no daemon
 * that could lend one of these devices.
 */
const backend = new IosSimulatorDeviceBackend();

/** The contract's own ceiling on one read (`MAX_LOG_ENTRIES`, `src/ipc/verb-methods.ts`). */
const CEILING = 5_000;

async function bootedDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

describe.skipIf(!process.env.ROVER_TEST_SIMULATOR)('the log read against a real simulator', () => {
	/**
	 * The bound, end to end: a small cap comes back full and says it dropped the rest. A cap this
	 * small is filled by the narrowest width, so this is the one-read case and the timing below
	 * bounds a single read.
	 *
	 * The five seconds are against a read measured at **0.9–1.8 s** on this bench, nearly all of
	 * it `simctl spawn`'s own start-up rather than the window — a one-second window cost 1.39 s and
	 * a five-minute one 1.75 s. Loose on purpose: what the bound is here to catch is an unbounded
	 * read, not a busy host.
	 */
	it('answers the newest entries up to the cap, and says the rest were dropped', async () => {
		const device = await bootedDevice();

		const started = Date.now();
		const read = await backend.readLogs(device.serial, { maxEntries: 10 });

		expect(read.entries).toHaveLength(10);
		expect(read.truncated).toBe(true);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	/**
	 * The half of `truncated` that holds on a device whose log rate nobody controls: truncation
	 * implies a full answer, while a full answer does not imply truncation — a window holding
	 * *exactly* the cap is not truncated, and this bench has produced 4,902, 4,983 and 5,339
	 * entries for the same width minutes apart, so an equality across that boundary would be a
	 * flake rather than a check. The exact-fit case is pinned deterministically in the mocked
	 * suite instead.
	 *
	 * What is worth asserting against a *live* log is the widening: at the contract's ceiling the
	 * read escalates through `LOG_WINDOWS` until the cap binds, so on any simulator that says
	 * 5,000 things in five minutes the answer comes back cap-bound rather than window-bound —
	 * **and it comes back at all**, which is what a widening bounded by a count and not by bytes
	 * did not manage. A quieter one is allowed to answer short — that is the horizon, not a bug —
	 * and says so by having taken every width.
	 *
	 * **The host state this is interesting on is a device that has been busy and then gone
	 * quiet**: a burst that has aged out of the narrowest width but not out of a wider one is
	 * what makes a wider read enormous, and a simulator a minute or two past a boot, an install
	 * or a launch is exactly that. Past the *narrowest* width the burst is beyond rescue — 113.6
	 * MB in `30s` a minute after boot on this bench, against a 64 MB buffer, with no narrower
	 * answer to fall back on — so that one case is skipped out loud rather than asserted, the way
	 * the refusal below is on a host with nothing shut down (ai/RULES.md §6).
	 */
	it('lets the cap bind the answer at the contract’s ceiling, not the lookback', async () => {
		const device = await bootedDevice();

		const read = await backend
			.readLogs(device.serial, { maxEntries: CEILING })
			.catch((cause: unknown) => {
				if (!(cause instanceof SimctlCommandError) || !cause.overflowedBuffer) throw cause;
				return null;
			});

		if (read === null) {
			console.warn(
				'this simulator says more in 30s than the log read’s buffer holds — a boot, an install ' +
					'or a launch inside the last minutes: the cap-bound read at the ceiling was NOT exercised',
			);
			return;
		}

		expect(read.entries.length).toBeLessThanOrEqual(CEILING);
		if (read.truncated) expect(read.entries).toHaveLength(CEILING);
		if (read.entries.length < CEILING) {
			console.warn(
				`this simulator said only ${read.entries.length} things in ${LOG_WINDOWS.at(-1)}: ` +
					'the cap-bound read at the ceiling was NOT exercised',
			);
		}
	});

	/**
	 * Every entry of a live read is one the parser could read. An unreadable line survives as an
	 * entry carrying the line and nothing else (`parsers/unified-log.ts`), so it shows up here as
	 * an empty timestamp and a null pid — which is exactly what this would catch if `--style
	 * ndjson` ever stopped being what the parser is pinned against.
	 */
	it('parses what the device really printed into entries, not into unreadable lines', async () => {
		const device = await bootedDevice();

		const read = await backend.readLogs(device.serial, { maxEntries: 50 });

		expect(read.entries.length).toBeGreaterThan(0);
		for (const entry of read.entries) {
			expect(entry.timestamp).not.toBe('');
			expect(entry.pid).not.toBeNull();
			expect(LogLevelSchema.safeParse(entry.level).success).toBe(true);
			expect(typeof entry.message).toBe('string');
		}
	});

	/**
	 * The reason this method has no state check where the capture has one: the tool refuses a
	 * device that is not booted itself, in **0.15 s** at exit 149 (measured on macOS 26.6.2 /
	 * Xcode 26.4.1, 2026-09-08), so there is nothing to pre-empt. Skipped out loud on a host
	 * carrying only the one booted simulator rather than passing quietly (ai/RULES.md §6).
	 */
	it('lets the tool refuse a simulator that is not booted, loudly and at once', async () => {
		const down = (await backend.listDevices()).filter((device) => device.state !== 'ready');
		const device = down[0];
		if (device === undefined) {
			console.warn('no shut-down simulator on this host: the log-read refusal was NOT exercised');
			return;
		}

		const started = Date.now();

		await expect(backend.readLogs(device.serial, { maxEntries: 10 })).rejects.toThrow(
			/exited 149|not booted/,
		);
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
