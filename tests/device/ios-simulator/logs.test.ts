import { describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend, LOG_WINDOWS } from '@/backends/ios-simulator/backend.js';
import { SimctlCommandError } from '@/backends/ios-simulator/simctl.js';
import { type Device, LogLevelSchema } from '@/core/device.js';
import { LogFilterRefusedError } from '@/core/errors.js';
import { type AppId, parseAppId } from '@/core/ids.js';
import { shutDownSimulator } from '../../helpers/simulators.js';

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
 * **Read-only but for one case**: a log read is the one verb that cannot alter the device, and
 * nothing here boots, shuts down or installs anything (`docs/IOS.md` §8, trap 4). The `appId`
 * case is the exception — it **launches Settings and stops it again** in a `finally`, because the
 * one claim only a device can settle is that the pid launchd reports for a running app is the
 * `processID` that app's log entries carry, and an app has to be running to have either.
 *
 * **Nothing asserts an absolute count or a level**, and that is deliberate rather than shy. What
 * a device says in a given window belongs to whatever is running on it: the same simulator
 * answered 67 and 160 entries per second half an hour apart on this repository's bench, and
 * `Debug` is rare
 * enough on an idle one that waiting for it would be a flaky test rather than a check
 * (`tests/fixtures/ios-simulator/README.md`). The flags that decide the levels are pinned as argv
 * in the unit suite, where they are a fact about this backend rather than about the host's mood.
 *
 * No lease, for `./backend.test.ts`'s reason — which is no longer that nothing is registered
 * (#230 landed the manifest and `./verb-dispatch.test.ts` takes one) but that every call here is a
 * read against a device nobody is holding, so what it asserts is a claim about the backend.
 */
const backend = new IosSimulatorDeviceBackend();

/** The contract's own ceiling on one read (`MAX_LOG_ENTRIES`, `src/ipc/verb-methods.ts`). */
const CEILING = 5_000;

/** The one app every simulator runtime ships, so the `appId` case needs nothing installed. */
const SETTINGS: AppId = parseAppId('com.apple.Preferences');

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
		const device = await shutDownSimulator();
		if (device === null) {
			console.warn('no shut-down simulator on this host: the log-read refusal was NOT exercised');
			return;
		}

		const started = Date.now();

		await expect(backend.readLogs(device.serial, { maxEntries: 10 })).rejects.toThrow(
			/exited 149|not booted/,
		);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	/**
	 * A `pid` selection, against a pid the device itself just named. What a capture cannot prove
	 * is that `processIdentifier == <n>` is a clause this `log` binary still reads the way it did
	 * on the bench — a predicate it stopped understanding would answer *fewer* entries rather
	 * than fail, which is the quiet wrong answer the pushdown has to be checked against.
	 */
	it('selects one process, and answers only that process’ entries', async () => {
		const device = await bootedDevice();
		const seed = await backend.readLogs(device.serial, { maxEntries: 50 });
		const pid = seed.entries.map((entry) => entry.pid).find((value) => value !== null);
		expect(pid).not.toBeUndefined();

		const read = await backend.readLogs(device.serial, { maxEntries: 50, pid: pid as number });

		expect(read.entries.length).toBeGreaterThan(0);
		for (const entry of read.entries) expect(entry.pid).toBe(pid);
	});

	/**
	 * A `tag` selection is a *subsystem* selection on this platform, which is the decision
	 * `log-query.ts` carries: `LogEntry.tag` is filled from `subsystem`, so a tag taken out of an
	 * entry is a value the device will select on. This takes one from a live read rather than
	 * naming a subsystem, because which ones are talking belongs to the host's mood.
	 */
	it('selects a tag the device itself attributed an entry to', async () => {
		const device = await bootedDevice();
		const seed = await backend.readLogs(device.serial, { maxEntries: 200 });
		const tag = seed.entries.map((entry) => entry.tag).find((value) => value !== '');
		if (tag === undefined) {
			console.warn(
				'no entry of this read carried a subsystem: the tag selection was NOT exercised',
			);
			return;
		}

		const read = await backend.readLogs(device.serial, { maxEntries: 50, tag });

		expect(read.entries.length).toBeGreaterThan(0);
		for (const entry of read.entries) expect(entry.tag).toBe(tag);
	});

	/**
	 * The level pushdown: both flags are dropped and a `messageType` clause takes their place, so
	 * this is the case where a predicate the tool read differently would show up as an answer
	 * holding the wrong levels. **No count is asserted** — whether an idle simulator says anything
	 * severe in five minutes is the host's business, so an empty answer is warned about rather
	 * than failed (this suite's own rule).
	 */
	it('selects a minimum level, and answers nothing below it', async () => {
		const device = await bootedDevice();

		const read = await backend.readLogs(device.serial, { maxEntries: 50, minLevel: 'error' });

		for (const entry of read.entries) expect(['error', 'fatal']).toContain(entry.level);
		if (read.entries.length === 0) {
			console.warn(
				'this simulator said nothing at error or above: the level pushdown ran, ' +
					'but selected nothing to check',
			);
		}
	});

	/**
	 * `since` becomes `--start`, and the two halves of it are what this proves against a live log:
	 * that the tool accepts the floored, offset-carrying form the backend builds (it rejects the
	 * fractional one outright, measured), and that the host comparison then makes the boundary
	 * exact — an anchor taken from the middle of a read drops everything before it.
	 */
	it('anchors a read on an entry’s own timestamp, exactly', async () => {
		const device = await bootedDevice();
		const all = await backend.readLogs(device.serial, { maxEntries: 50 });
		expect(all.entries.length).toBeGreaterThan(1);
		const anchor = all.entries[Math.floor(all.entries.length / 2)]?.timestamp as string;

		const read = await backend.readLogs(device.serial, { maxEntries: 5_000, since: anchor });

		expect(read.entries.length).toBeGreaterThan(0);
		for (const entry of read.entries) expect(entry.timestamp >= anchor).toBe(true);
	});

	/**
	 * The buffers, both ways round. `main` *is* the unified log here, so naming it changes
	 * nothing; the other three have nothing on this device to answer from and are refused by
	 * name — **quickly**, because every one of those refusals is decided before `simctl` runs.
	 */
	it('reads the one buffer this device has, and refuses the three it does not', async () => {
		const device = await bootedDevice();

		const read = await backend.readLogs(device.serial, { maxEntries: 10, buffers: ['main'] });
		expect(read.entries.length).toBeGreaterThan(0);

		const started = Date.now();
		for (const buffer of ['system', 'events', 'crash'] as const) {
			const failure = backend.readLogs(device.serial, { maxEntries: 10, buffers: [buffer] });
			await expect(failure).rejects.toBeInstanceOf(LogFilterRefusedError);
			await expect(failure).rejects.toMatchObject({ filter: 'buffers' });
		}
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	/**
	 * `appId`, end to end — and the one claim in this backend that only a device can settle: that
	 * the pid `launchctl list` reports for an app is the `processID` its log entries carry. The
	 * unit suite pins the parser and the predicate against captures; what it cannot pin is that
	 * the two numbers are the same number.
	 *
	 * **This case launches Settings and stops it again**, which is why the suite header no longer
	 * claims to change nothing. The stop is in a `finally` so a failed assertion still leaves the
	 * device as it was found.
	 */
	it('selects an app by resolving it to the processes launchd is running it under', async () => {
		const device = await bootedDevice();
		await backend.launchApp(device.serial, SETTINGS);

		try {
			const read = await backend.readLogs(device.serial, { maxEntries: 200, appId: SETTINGS });

			if (read.entries.length === 0) {
				console.warn(
					'Settings said nothing in the widest window: the appId read ran, but ' +
						'selected nothing to check',
				);
				return;
			}
			const pids = new Set(read.entries.map((entry) => entry.pid));
			expect(pids.size).toBe(1);
		} finally {
			await backend.stopApp(device.serial, SETTINGS);
		}
	});

	/**
	 * An app with no running process is refused by name rather than answered empty: an empty
	 * answer would read as an app that said nothing (ai/RULES.md §2). Refused after the listing
	 * and before any log read, so it is fast.
	 */
	it('refuses an app that is not running by name, rather than answering it empty', async () => {
		const device = await bootedDevice();

		const failure = backend.readLogs(device.serial, {
			maxEntries: 10,
			appId: parseAppId('com.rover.never.installed'),
		});

		await expect(failure).rejects.toBeInstanceOf(LogFilterRefusedError);
		await expect(failure).rejects.toMatchObject({ filter: 'appId' });
	});

	/**
	 * The `since` shape is the backend's to check, and it is checked before anything runs — an
	 * anchor in the *Android* log's shape is the mistake a caller actually makes, and it comes
	 * back named rather than ordering against nothing.
	 */
	it('refuses an anchor that is not in this log’s own shape, at once', async () => {
		const device = await bootedDevice();

		const failure = backend.readLogs(device.serial, {
			maxEntries: 10,
			since: '10-06 14:54:08.135',
		});

		await expect(failure).rejects.toBeInstanceOf(LogFilterRefusedError);
		await expect(failure).rejects.toMatchObject({ filter: 'since' });
	});
});
