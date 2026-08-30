/**
 * The device backend for this platform.
 *
 * It answers every required method of the contract — enumeration, presence, the device
 * facts, the app lifecycle, the capture and the log read — with no stub, which is what
 * lets it declare `implements DeviceBackend` and what lets `./index.ts` register it
 * (ai/TESTING.md, "A backend under construction registers nothing"), plus **every**
 * capability-gated method: the environment pair behind `canControlNetwork`, the four input
 * primitives behind `canInput`, `readScreen` behind `canReadScreen` (#13) and `recordVideo`
 * behind `canRecordVideo` (#14). No flag in `./capabilities.ts` is a declared opt-out any
 * more.
 *
 * Everything that touches the device goes through `./adb.js`, everything that reads its
 * output goes through `./parsers/`, and the two pure modules beside this one own the
 * arithmetic — `./input.js` on the way to the device, `./screen.js` on the way back. This
 * file is the join between them and holds no text-shaped knowledge of its own: the wording
 * each verb asserts on lives in `./parsers/app-control.js`, `./parsers/network.js`,
 * `./parsers/input.js`, `./parsers/uiautomator.js` and `./parsers/logcat.js`, pinned
 * against captures, and every **caller-supplied** value that enters a device-side command
 * line is quoted by `./adb.js`. Which quoter is the one judgement call in this file:
 *
 * - `shellArg` for a value whose shape was already checked — every app id, and the
 *   component resolved off the device. It refuses an apostrophe, because one arriving there
 *   is a bug in that check.
 * - `shellText` for `typeText`'s argument, the only value here that is screen *content*:
 *   an apostrophe in it is ordinary, so it is escaped rather than refused.
 * - **Neither, only for a literal this file owns** — the environment pair's two words, the
 *   four keycodes of `./input.js`'s `KEY_CODES`, {@link DUMP_PATH}, {@link RECORDING_PATH},
 *   and the numbers `tap`, `swipe` and `recordVideo` compute. No caller's string reaches any
 *   of them, which is the property `shellArg` exists to restore when one does. A new argument
 *   outside that list takes a quoter.
 */

import {
	type Device,
	type DeviceBackend,
	type DeviceInfo,
	DeviceInfoSchema,
	type DeviceKey,
	DeviceSchema,
	type DeviceState,
	type DeviceWatch,
	type DeviceWatcher,
	type LogRead,
	type Point,
	type ReadLogsOptions,
	type RecordVideoOptions,
	type ScreenElement,
} from '../../core/device.js';
import { UnfinishedRecordingError, UnsupportedTextError } from '../../core/errors.js';
import { type AppId, type DeviceSerial, parseAppId, unwrap } from '../../core/ids.js';
import { waitForCondition } from '../../core/wait.js';
import {
	type AdbBinaryResult,
	type AdbResult,
	type AdbStream,
	describeBytes,
	INSTALL_ADB_TIMEOUT_MS,
	quoteStream,
	RECORDING_FINISH_TIMEOUT_MS,
	RECORDING_PULL_TIMEOUT_MS,
	runAdb,
	runAdbBinaryOnDevice,
	runAdbOnDevice,
	SCREENSHOT_ADB_TIMEOUT_MS,
	shellArg,
	shellText,
	streamAdb,
} from './adb.js';
import { attachmentOfSerial } from './attachment.js';
import { ANDROID_PLATFORM_ID } from './capabilities.js';
import {
	KEY_CODES,
	toDevicePixels,
	toSwipeDuration,
	typeTextSegments,
	untypeableCharacters,
} from './input.js';
import {
	isSilent,
	parseResolvedActivity,
	saysSuccess,
	startedActivity,
} from './parsers/app-control.js';
import {
	type AdbDevice,
	isUsable,
	parseAdbDeviceLines,
	parseAdbDevices,
} from './parsers/devices.js';
import { parseGetprop } from './parsers/getprop.js';
import { parseUiHierarchy, type UiHierarchy } from './parsers/hierarchy.js';
import { acceptedInput } from './parsers/input.js';
import { parseLogcat } from './parsers/logcat.js';
import { acceptedNetworkChange } from './parsers/network.js';
import { isPng } from './parsers/screencap.js';
import { isFinishedRecording, isRecorderRunning, recorderPids } from './parsers/screenrecord.js';
import { TrackFrameDecoder } from './parsers/track.js';
import { dumpedPath } from './parsers/uiautomator.js';
import { parseWmDensity, parseWmSize } from './parsers/wm.js';
import { toScreenElements } from './screen.js';

/** The state token adb prints for a device whose authorisation was refused or not granted. */
const UNAUTHORIZED_STATE = 'unauthorized';

/**
 * Where {@link AndroidDeviceBackend.readScreen} has the device write its hierarchy.
 *
 * `/sdcard/window_dump.xml` is uiautomator's own default and the path PROJECT.md §6's
 * verified recipe uses — writable without root on API 37, and on external storage rather
 * than in the app sandbox of whatever happens to be running. Fixed rather than randomised
 * per call: a unique path per read would make a stale document impossible by construction,
 * and would also leave one behind for every read that died before its cleanup, on hardware
 * lent out to somebody else next. Freshness is bought with the confirmation check instead,
 * which costs nothing on the device.
 */
const DUMP_PATH = '/sdcard/window_dump.xml';

/**
 * Where {@link AndroidDeviceBackend.recordVideo} has the device write its recording.
 *
 * A fixed literal this file owns, for {@link DUMP_PATH}'s reason and with more at stake: a
 * unique path per call would leave a multi-megabyte file behind for every recording that
 * died before its cleanup, on hardware lent out to somebody else next. Freshness is bought
 * with an `rm -f` *before* the recording rather than with the path, so a leftover from a
 * killed run can never be the file that is pulled.
 */
const RECORDING_PATH = '/sdcard/rover-recording.mp4';

/**
 * What `screenrecord` is asked to encode at — 2 Mbps, a quarter of a megabyte per second.
 *
 * Derived rather than picked, and the derivation is what ties it to
 * `MAX_RECORDING_MS` (`src/verbs/record.ts`): a recording travels on
 * `ActionResult.artifact` and must fit `MAX_ARTIFACT_BYTES` (4 MiB), so the longest
 * recording the verb allows times this rate has to stay under that bound — 15 s × 250 KB/s
 * ≈ 3.6 MiB. `tests/unit/backends/android/backend.test.ts` asserts the relationship,
 * because a constant derived from another by hand is one the other is free to drift away
 * from.
 *
 * Well below `screenrecord`'s own 20 Mbps default, deliberately. The verb answers *what
 * happened on the screen*, which a low-bitrate encode of a mostly-static UI carries fine;
 * what it is not is a video-quality tool, and PROJECT.md §8 already says a recording samples
 * motion rather than describing it.
 */
export const RECORDING_BIT_RATE_BPS = 2_000_000;

/**
 * `screenrecord --time-limit` counts whole seconds — see
 * {@link AndroidDeviceBackend.recordVideo}.
 */
const RECORDING_TIME_LIMIT_UNIT_MS = 1_000;

/**
 * The tracker's argv. `-l` because the long format is what carries `model:`, and the
 * watched snapshots have to be the same `Device` shape the enumeration answers with —
 * otherwise a device gains and loses its model depending on which path saw it.
 */
const TRACK_DEVICES_ARGV = ['track-devices', '-l'] as const;

/**
 * How long to wait before restarting a tracker that ended, and the ceiling that wait grows
 * to. Doubling, and reset by the first frame a new tracker delivers.
 *
 * Mandatory rather than nice: on adb 37.0.1 a tracker whose server dies exits 0
 * (PROJECT.md §6), and `adb kill-server` is something a developer on the host machine does
 * routinely — without a restart the host would go permanently blind after it. Bounded
 * because the other reason a tracker ends immediately is that adb is not on `PATH` at all,
 * and retrying that every 250 ms forever is a busy loop with a process spawn in it.
 *
 * Constants, not configuration (ai/RULES.md §7): nothing about them is a host's choice.
 */
const TRACK_RESTART_MIN_DELAY_MS = 250;
const TRACK_RESTART_MAX_DELAY_MS = 5_000;

/**
 * Map one enumerated entry onto the neutral vocabulary.
 *
 * `device` and `unauthorized` are the two tokens with a neutral counterpart; **everything
 * else becomes `offline`**. The token list adb can print (`authorizing`,
 * `no permissions (…)`, `bootloader`, `recovery`, `sideload`, …) is longer than the
 * fixtures pin (tests/fixtures/adb/README.md), and the conservative answer for an
 * unpinned token is the true one either way: visible to the host, and no verb can run on
 * it.
 */
function toDeviceState(entry: AdbDevice): DeviceState {
	if (isUsable(entry)) return 'ready';
	return entry.state === UNAUTHORIZED_STATE ? UNAUTHORIZED_STATE : 'offline';
}

/**
 * `model` comes from the `-l` property tail rather than from a `getprop` per device: an
 * enumeration is on the hot path of every lease grant (D6), and the tail is present even
 * for a device that is not usable — the captured `offline` fixture still carries it.
 */
function toDevice(entry: AdbDevice): Device {
	return DeviceSchema.parse({
		serial: entry.serial,
		platform: ANDROID_PLATFORM_ID,
		model: entry.properties.model ?? null,
		state: toDeviceState(entry),
		// The serial is the only discriminator adb offers — see `./attachment.js` for what
		// was measured before accepting that.
		attachment: attachmentOfSerial(entry.serial),
	});
}

/**
 * Re-throw a parse failure with the command and the *other* stream attached.
 *
 * The parser only ever saw stdout, and the reason a well-formed command produced
 * unparseable output is usually on stderr — the daemon banner and its failures go there
 * (PROJECT.md §6). Exit code 0 means `./adb.js` had nothing to complain about, so this is
 * the only place that context can be added.
 */
function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function unparseable(command: string, result: AdbResult, cause: unknown): Error {
	const reason = message(cause);
	const stderr = result.stderr.trimEnd();
	return new Error(`${command}: ${reason}${stderr.length === 0 ? '' : `\nstderr: ${stderr}`}`, {
		cause,
	});
}

/**
 * The app id as it goes into a device-side command line.
 *
 * Two guards, because they fail at different times. {@link AppId} is the compile-time one
 * — a caller cannot reach these verbs without having parsed the string — and a cast, an
 * IPC payload deserialized without its schema or a backend called from JavaScript defeats
 * it silently. Re-parsing here is the runtime one, at the last point before the value
 * becomes part of a command the *device's* shell will read; `shellArg` then makes it one
 * word regardless. Cheap, and this is the seam where being wrong costs someone else's
 * device (PROJECT.md §6).
 */
function appArg(appId: AppId): string {
	return shellArg(unwrap(parseAppId(appId)));
}

/**
 * The failure adb declined to put in its exit code.
 *
 * Everything that reaches here exited 0 — `./adb.js` throws on anything else — and adb
 * reports plenty of real failures that way: `Failure [INSTALL_FAILED_…]` from `install`,
 * `Error: …` from `am start`, `Failed` from `pm clear`. Trusting the exit code instead is
 * how an install that never landed reads as a success.
 *
 * Both streams are quoted, and neither is treated as the authoritative one, because which
 * one carries the reason is not stable: on API 37 with adb 37.0.1 all three of those land
 * on stderr, while every guide of the era shows them on stdout (PROJECT.md §6). The device
 * is named because a message about the wrong device is the failure mode this backend's
 * pinning exists to prevent.
 */
function refused(what: string, serial: DeviceSerial, result: AdbResult): Error {
	return new Error(
		[
			`${what} on device '${unwrap(serial)}' reported a failure`,
			`stdout: ${quoteStream(result.stdout)}`,
			`stderr: ${quoteStream(result.stderr)}`,
		].join('\n'),
	);
}

/**
 * A capture that came back as something other than an image.
 *
 * Its own failure rather than {@link refused}'s, because there is no output to quote:
 * what identifies a mangled stream is its length and its first bytes, and naming them is
 * what tells "the device sent nothing" apart from "the bytes were decoded on the way here"
 * without anyone having to reproduce it. Handing the payload back unchecked is the
 * alternative, and it puts a corrupt image in front of an agent that will read it as the
 * screen.
 */
function notAnImage(serial: DeviceSerial, result: AdbBinaryResult): Error {
	return new Error(
		[
			`screencap on device '${unwrap(serial)}' did not return a PNG`,
			`stdout: ${describeBytes(result.stdout)}`,
			`stderr: ${quoteStream(result.stderr)}`,
		].join('\n'),
	);
}

export class AndroidDeviceBackend implements DeviceBackend {
	/**
	 * The tail of the queue of calls holding a device-side scratch path on each device —
	 * {@link exclusivelyOn}'s register, and the only state this class holds.
	 *
	 * It is a queue and not a cache, which is the distinction D6 draws: nothing about a
	 * device is remembered here between calls, only whether a call is still running. A serial
	 * appears while one is in flight and is dropped again straight afterwards.
	 */
	private readonly scratchUse = new Map<DeviceSerial, Promise<void>>();

	async listDevices(): Promise<Device[]> {
		const result = await runAdb(['devices', '-l']);

		try {
			return parseAdbDevices(result.stdout).map(toDevice);
		} catch (cause) {
			throw unparseable('adb devices -l', result, cause);
		}
	}

	/**
	 * Watch the attached set with `adb track-devices -l`, restarting the tracker whenever it
	 * ends.
	 *
	 * The tracker re-emits the **whole** list on every change rather than a delta (verified
	 * on adb 37.0.1, 2026-08-29 — PROJECT.md §6), which is exactly what the contract asks
	 * for, so each decoded frame becomes one `onDevices` and nothing here accumulates state
	 * between frames.
	 *
	 * **An end of stream is never an empty device list.** Only a decoded frame produces
	 * `onDevices`; an end — including the exit 0 a tracker gives when its adb server is
	 * killed — produces `onInterrupted` and a scheduled restart. Delivering the end as `[]`
	 * would tell an inventory that every device had gone away at the moment it lost the
	 * ability to know anything at all.
	 *
	 * A payload that will not parse is treated the same way: reported through
	 * `onInterrupted` and the tracker restarted, never thrown. There is nothing above a
	 * stdout handler to catch a throw from it.
	 */
	watchDevices(watcher: DeviceWatcher): DeviceWatch {
		let stopped = false;
		let current: AdbStream | null = null;
		let restart: NodeJS.Timeout | null = null;
		let backoffMs = TRACK_RESTART_MIN_DELAY_MS;

		const scheduleRestart = (): void => {
			const delayMs = backoffMs;
			backoffMs = Math.min(backoffMs * 2, TRACK_RESTART_MAX_DELAY_MS);
			restart = setTimeout(() => {
				restart = null;
				if (!stopped) start();
			}, delayMs);
		};

		const start = (): void => {
			const decoder = new TrackFrameDecoder();
			// Per attempt, so a chunk arriving from the tracker that just ended cannot end the
			// one that replaced it.
			let over = false;

			const end = (reason: string): void => {
				if (over || stopped) return;
				over = true;
				current = null;
				// A parse failure ends a tracker that is still running; an `onEnd` ends one that
				// already stopped, where this resolves at once. Not awaited: the caller of this
				// path is a stdout handler, and the restart is scheduled either way.
				void handle?.stop();
				watcher.onInterrupted(reason);
				scheduleRestart();
			};

			const handle: AdbStream | undefined = streamAdb([...TRACK_DEVICES_ARGV], {
				onStdout(chunk) {
					if (over || stopped) return;

					let snapshots: Device[][];
					try {
						snapshots = decoder
							.push(chunk)
							.map((payload) => parseAdbDeviceLines(payload).map(toDevice));
					} catch (cause) {
						end(`adb ${TRACK_DEVICES_ARGV.join(' ')}: ${message(cause)}`);
						return;
					}

					// A frame is the only evidence the view is healthy again, so it is what resets
					// the backoff — an adb that starts and dies in a loop keeps backing off.
					if (snapshots.length > 0) backoffMs = TRACK_RESTART_MIN_DELAY_MS;
					for (const devices of snapshots) watcher.onDevices(devices);
				},
				onEnd(reason) {
					end(reason);
				},
			});
			current = handle;
		};

		start();

		return {
			async stop(): Promise<void> {
				stopped = true;
				if (restart !== null) {
					clearTimeout(restart);
					restart = null;
				}
				const handle = current;
				current = null;
				await handle?.stop();
			},
		};
	}

	/**
	 * One enumeration, filtered — which is D6's "the daemon is a cache, the bridge is the
	 * truth" re-verification in its cheapest form, and the whole of what lifecycle means
	 * after D21. `null` rather than a throw: a device that is no longer attached is a
	 * lookup miss (ai/CODING_STANDARDS.md "Error handling").
	 */
	async describeDevice(serial: DeviceSerial): Promise<Device | null> {
		const devices = await this.listDevices();
		return devices.find((device) => device.serial === serial) ?? null;
	}

	/**
	 * Three queries, in parallel — the size, the density and the properties.
	 *
	 * The **effective** size and density are what the answer is built from, not the
	 * physical ones: an override is what the device actually renders at, so it is the one a
	 * coordinate and the dp scale belong to (PROJECT.md §6). A device that has gone away
	 * throws from `./adb.js` naming the command and both streams, rather than answering
	 * `null` — see the contract comment on {@link DeviceBackend.deviceInfo}.
	 */
	async deviceInfo(serial: DeviceSerial): Promise<DeviceInfo> {
		const [size, density, properties] = await Promise.all([
			runAdbOnDevice(serial, ['shell', 'wm', 'size']),
			runAdbOnDevice(serial, ['shell', 'wm', 'density']),
			runAdbOnDevice(serial, ['shell', 'getprop']),
		]);

		const screen = parseWmSize(size.stdout);
		const dpi = parseWmDensity(density.stdout);
		const props = parseGetprop(properties.stdout);

		return DeviceInfoSchema.parse({
			serial: unwrap(serial),
			platform: ANDROID_PLATFORM_ID,
			model: props.model,
			screen: {
				widthPx: screen.effective.width,
				heightPx: screen.effective.height,
				density: dpi.effective,
				densityScale: dpi.scale,
				widthDp: screen.effective.width / dpi.scale,
				heightDp: screen.effective.height / dpi.scale,
			},
			osVersion: props.androidRelease,
			osApiLevel: props.apiLevel,
		});
	}

	/**
	 * `adb install -r <path>`, with `packagePath` read on the **host** (D19).
	 *
	 * `-r` because a primitive that refuses to overwrite would make every re-install a
	 * two-call dance the caller has to get right, and the caller asked for this package to
	 * be on the device.
	 *
	 * `packagePath` is not quoted for a device shell the way the app ids below are, and does
	 * not need to be: `adb install` is an adb subcommand that reads the file on the host,
	 * so its argument stays an argv entry and never reaches a shell on either machine.
	 * Whether the success wording is there is `./parsers/app-control.js`'s question — the
	 * short version is that neither `stdout.trim() === 'Success'` nor an empty stderr
	 * survives what a real install prints (PROJECT.md §6).
	 */
	async installApp(serial: DeviceSerial, packagePath: string): Promise<void> {
		const result = await runAdbOnDevice(serial, ['install', '-r', packagePath], {
			timeoutMs: INSTALL_ADB_TIMEOUT_MS,
		});

		if (!saysSuccess(result.stdout)) {
			throw refused(`adb install -r '${packagePath}'`, serial, result);
		}
	}

	/**
	 * Resolve the app's launchable component on the device, then start it.
	 *
	 * Two calls rather than `monkey -p <appId> -c android.intent.category.LAUNCHER 1`,
	 * which was measured against the same emulator: monkey answers a package with no
	 * launchable activity and a package that is not installed with the *same*
	 * `** No activities found to run` line, never says which component it started, and
	 * buries both in its own argument echo. Resolving first means the failure names the
	 * app id, and the start names the component it actually dispatched.
	 */
	async launchApp(serial: DeviceSerial, appId: AppId): Promise<void> {
		const component = await this.resolveLaunchComponent(serial, appId);
		const result = await runAdbOnDevice(serial, [
			'shell',
			'am',
			'start',
			'-n',
			shellArg(component),
		]);

		if (!startedActivity(result)) throw refused(`am start -n ${component}`, serial, result);
	}

	/**
	 * `am force-stop <appId>`.
	 *
	 * **This is the one verb here with no success wording to assert**, so silence is the
	 * assertion: on API 37 a force-stop that worked prints nothing on either stream, and
	 * anything the device said is therefore something going wrong. "Silence" is
	 * {@link isSilent}'s definition and not an empty stderr — adb's own
	 * `* daemon started successfully` lands there on the first call after a server restart,
	 * on a force-stop that worked. The cost of the rule is stated rather than papered over:
	 * an app id no package has is *also* silent and exit 0, so this cannot tell "stopped it"
	 * from "there was nothing by that name" (PROJECT.md §6).
	 * Answering whether the app is really gone is the verb layer's post-state (#11), which
	 * reads the device rather than adb's opinion of it.
	 */
	async stopApp(serial: DeviceSerial, appId: AppId): Promise<void> {
		const result = await runAdbOnDevice(serial, ['shell', 'am', 'force-stop', appArg(appId)]);

		if (!isSilent(result)) throw refused(`am force-stop ${unwrap(appId)}`, serial, result);
	}

	/** `pm clear <appId>` — the `Success` line, or the `Failed` this refuses to swallow. */
	async clearAppData(serial: DeviceSerial, appId: AppId): Promise<void> {
		const result = await runAdbOnDevice(serial, ['shell', 'pm', 'clear', appArg(appId)]);

		if (!saysSuccess(result.stdout)) {
			throw refused(`pm clear ${unwrap(appId)}`, serial, result);
		}
	}

	/**
	 * `exec-out screencap -p` — the device's own PNG, as bytes (D19).
	 *
	 * **`exec-out`, never `shell`.** `adb shell` may put a pty between the device and this
	 * process, and a pty translates `\n` to `\r\n`: every 0x0a in the image becomes two
	 * bytes and the PNG is silently no longer a PNG. It is the same trap as the hierarchy
	 * dump (PROJECT.md §6), and worse here, because it is conditional — with stdout
	 * redirected on adb 37.0.1 the translation did **not** reproduce, so a `shell` capture
	 * can work on the machine it was written on and corrupt every frame on the next one.
	 * `exec-out` is the unconditional guarantee, and costs nothing.
	 *
	 * It is also the one read here that is not a query — 2.4 s on an emulator, measured —
	 * so it carries {@link SCREENSHOT_ADB_TIMEOUT_MS} rather than the ten seconds the
	 * device facts get.
	 *
	 * Bytes rather than a path on this host, because an artifact crosses the machine
	 * boundary (D19); the archive of D23 is a separate effect and not this primitive's.
	 * Whether the image is *black* is deliberately not asked: an app blocking screen capture
	 * yields a valid all-black PNG (PROJECT.md §6), which is a true answer about the device
	 * rather than a failed capture, and judging it belongs to whoever knows what was
	 * supposed to be on screen.
	 */
	async screenshot(serial: DeviceSerial): Promise<Uint8Array> {
		const result = await runAdbBinaryOnDevice(serial, ['exec-out', 'screencap', '-p'], {
			timeoutMs: SCREENSHOT_ADB_TIMEOUT_MS,
		});

		if (!isPng(result.stdout)) throw notAnImage(serial, result);

		return result.stdout;
	}

	/**
	 * `logcat -d -v threadtime -t <n> -b main -b crash` — the device's log, bounded, over
	 * in one call.
	 *
	 * Every flag is load-bearing, and all of them were run against API 37 / adb 37.0.0
	 * before being written down (PROJECT.md §6):
	 *
	 * - **`-d`** dumps and exits. A follow never returns, and there is no sleep and no
	 *   unbounded wait in this repository (ai/RULES.md §2). `-t` implies it; both are passed
	 *   so the intent survives someone changing the bound.
	 * - **`-b main -b crash`**, repeated rather than `-b main,crash` — this adb accepts the
	 *   repetition, and the crash buffer is where a fatal exception lands. Without it a read
	 *   after a crash shows ordinary chatter and nothing else, which is the failure this verb
	 *   exists to prevent.
	 * - **`-v threadtime`** is the one format carrying the timestamp, the pid and the level
	 *   on every line, which is exactly {@link LogEntry}'s shape.
	 *
	 * **`-t` counts logcat *entries*, and an entry is not a line.** One Java crash is a
	 * single entry whose message runs to fourteen lines, so `-t 2` on the crash buffer
	 * returned 28 log lines here — 29 lines of output, the first being logcat's own
	 * `--------- beginning of crash` separator (PROJECT.md §6,
	 * `tests/fixtures/adb/README.md`). The cap this method promises is on **entries as the
	 * caller sees them** — one per line — so the request is `maxEntries + 1` and whatever
	 * comes back is bounded on this side. The `+ 1` is what makes {@link LogRead.truncated}
	 * honest in the ordinary single-line case: without it, a device holding exactly
	 * `maxEntries` lines and one holding a thousand more answer identically.
	 *
	 * **The newest are the ones kept**, because a log read is asked *after* something
	 * happened.
	 *
	 * `runAdbOnDevice`, never `runAdb`: an unpinned read is somebody else's device, and a
	 * log from the wrong device is worse than no log, since nothing about it looks wrong.
	 *
	 * The default ten-second timeout: this is a query. Two thousand entries came back in
	 * 36 ms on an emulator (PROJECT.md §6).
	 */
	async readLogs(serial: DeviceSerial, options: ReadLogsOptions): Promise<LogRead> {
		const result = await runAdbOnDevice(serial, [
			'logcat',
			'-d',
			'-v',
			'threadtime',
			'-t',
			String(options.maxEntries + 1),
			'-b',
			'main',
			'-b',
			'crash',
		]);

		const entries = parseLogcat(result.stdout);
		const truncated = entries.length > options.maxEntries;

		return { entries: truncated ? entries.slice(-options.maxEntries) : entries, truncated };
	}

	/**
	 * The screen as elements — `uiautomator dump` to a file on the device, then the file.
	 *
	 * Two commands and a cleanup, because uiautomator has no mode that writes the document
	 * to stdout: `dump /dev/tty` is the recipe every guide shows for that and it interleaves
	 * the XML with the confirmation line below (PROJECT.md §6).
	 *
	 * **`exec-out` for the `cat`, never `shell`.** `adb shell` may put a pty between the
	 * device and this process, and a pty translates `\n` to `\r\n` — which turns a
	 * well-formed hierarchy into a document the parser will not accept, or worse, one it
	 * will. It is the same trap as {@link screenshot}'s, and conditional in the same way:
	 * §6 records that a `shell cat` of a dump did *not* corrupt on adb 37.0.1 with stdout
	 * redirected, because adb only allocates the pty in some combinations of version,
	 * platform and whether stdin is a terminal. That is the argument *for* `exec-out`, not
	 * against it — it never allocates one, so the guarantee stops depending on the machine
	 * the code happens to run on. The text runner rather than the binary one: the payload is
	 * UTF-8.
	 *
	 * **The confirmation line is checked before the `cat`, and that check is the freshness
	 * guarantee.** {@link DUMP_PATH} is a fixed literal, so it can already hold the document
	 * a previous read left there; a dump that produced nothing followed by a `cat` that
	 * succeeds would hand back a screen from a minute ago, indistinguishable from this one
	 * and acted on. What the check can and cannot prove is
	 * `./parsers/uiautomator.js`'s subject — in short, it says the command named the path
	 * this call asked for, and the `cat` says a file is there.
	 *
	 * **The density is asked fresh**, for the reason {@link pixelScale} gives, and started
	 * before the dump so the two overlap. It is awaited only after the dump has settled, so
	 * the cleanup below can never race a dump that is still writing.
	 *
	 * **The whole triple is exclusive per device**, which is {@link exclusivelyOn}'s subject: the
	 * three commands share one fixed device-side path, and a second read overlapping this
	 * one either has its `uiautomator` killed by the device (exit 137 with both streams
	 * empty, measured on API 37 — PROJECT.md §6) or has its file removed between its dump
	 * and its `cat`. Either way a device that is working perfectly answers a verb with a
	 * throw. Nothing above this stops that: the IPC server dispatches frames without
	 * awaiting them and `src/daemon/verb-traffic.ts` registers concurrent calls on one
	 * device rather than excluding them, both on purpose, so the exclusion belongs to the
	 * one place that knows {@link DUMP_PATH} is shared.
	 *
	 * **The `rm` runs in a `finally` and its own failure never replaces the answer.**
	 * Leaving a file behind on hardware held under a lease is what the cleanup exists to
	 * prevent; losing a screen the caller already paid for because the cleanup failed is
	 * worse. It also runs on the refusal path, which is where it does the most good: a stale
	 * file removed now is one the *next* read cannot be served. The dump is *inside* the
	 * `try` for that reason too — a dump that throws is exactly the case where a partial
	 * file may be sitting there, and `rm -f` on a file that was never written costs nothing.
	 *
	 * The default ten-second timeout: a dump is a query on the order of a `wm size`, not a
	 * capture of the framebuffer.
	 *
	 * `DUMP_PATH` takes no `shellArg` — it is a literal this file owns, the case this file's
	 * header names. If it ever becomes a caller's value it takes a quoter.
	 */
	async readScreen(serial: DeviceSerial): Promise<ScreenElement[]> {
		return this.exclusivelyOn(serial, async () => {
			const density = this.pixelScale(serial);
			// Awaited at the end; the handler is attached now so a density that fails while the
			// dump is still in flight is never an unhandled rejection.
			void density.catch(() => undefined);

			try {
				const dumped = await runAdbOnDevice(serial, ['shell', 'uiautomator', 'dump', DUMP_PATH]);

				if (dumpedPath(dumped.stdout) !== DUMP_PATH) {
					throw refused(`uiautomator dump ${DUMP_PATH}`, serial, dumped);
				}

				const document = await runAdbOnDevice(serial, ['exec-out', 'cat', DUMP_PATH]);

				let hierarchy: UiHierarchy;
				try {
					hierarchy = parseUiHierarchy(document.stdout);
				} catch (cause) {
					throw unparseable(`adb exec-out cat ${DUMP_PATH}`, document, cause);
				}

				return toScreenElements(hierarchy, await density);
			} finally {
				await runAdbOnDevice(serial, ['shell', 'rm', '-f', DUMP_PATH]).catch(() => undefined);
			}
		});
	}

	/**
	 * Run `work` after every call already queued for `serial`, and never beside one.
	 *
	 * **The subject is the device-side scratch paths this backend owns** — {@link DUMP_PATH}
	 * and {@link RECORDING_PATH} — both of which are fixed literals, so two overlapping calls
	 * on one device would share one file. For a screen read that means a `uiautomator` killed
	 * by the device or a document removed between the dump and the `cat`; for a recording it
	 * means two encoders writing one file and both answers corrupt. One queue covers both
	 * rather than one per path: the two do not overlap in practice, and a second register
	 * would be a second thing to get right for a verb that is not competing for the device
	 * anyway.
	 *
	 * A promise chain per serial rather than a lock, because there is nothing to unlock: the
	 * entry *is* the tail of the queue, and the next caller waits on it. Per serial, because
	 * the thing being made exclusive is one device's scratch path — two devices are driven at
	 * the same time as before, which is what an inventory of several is for.
	 *
	 * The chain never rejects and never carries a value: a call that threw has still finished
	 * with the device, and letting its rejection through would fail the *next* caller with the
	 * previous caller's error. The entry is dropped once this call is the last one queued, so
	 * the map is bounded by the devices being driven right now rather than by every device
	 * this host has ever touched.
	 *
	 * It bounds nothing else. A call that hangs holds the queue for exactly as long as
	 * `./adb.js`'s timeout allows the command underneath it to hang, which is the bound that
	 * already applies to every caller of it.
	 */
	private async exclusivelyOn<T>(serial: DeviceSerial, work: () => Promise<T>): Promise<T> {
		const queued = (this.scratchUse.get(serial) ?? Promise.resolve()).then(work);
		const settled = queued.then(
			() => undefined,
			() => undefined,
		);
		this.scratchUse.set(serial, settled);

		try {
			return await queued;
		} finally {
			if (this.scratchUse.get(serial) === settled) this.scratchUse.delete(serial);
		}
	}

	/**
	 * `input tap <x> <y>`, with `at` converted from dp to physical pixels first.
	 *
	 * The conversion is the whole subtlety and it is silent when it is missing: `PointSchema`
	 * is device-independent coordinates and `input` takes pixels, so an unconverted point on
	 * this scale-3 emulator lands a third of the way to where the caller asked, on a real
	 * control, with `input` reporting success either way. `./input.js`'s `toDevicePixels`
	 * holds the arithmetic and the reason it floors.
	 *
	 * **Silence is the assertion**, the shape `am force-stop` and the environment pair have:
	 * `input tap` printed zero bytes on both streams at exit 0 on API 37, and the one refusal
	 * that exits 0 (`Unknown command: …`) is what {@link acceptedInput} catches. The cost is
	 * stated rather than papered over: a coordinate off the edge of the screen is *also*
	 * silent and exit 0 (PROJECT.md §6), so this cannot tell "tapped it" from "tapped past
	 * the panel". Keeping a point on the screen is the verb layer's, which is the layer that
	 * holds the screen it resolved the point from (D12).
	 *
	 * The two coordinates and the duration below are numbers this file produced, so unlike
	 * every app verb they take no `shellArg` — the property that function exists to restore
	 * is already theirs. {@link typeText} is the one method here whose argument *is* a
	 * caller's string, and it is quoted.
	 */
	async tap(serial: DeviceSerial, at: Point): Promise<void> {
		const { x, y } = toDevicePixels(at, await this.pixelScale(serial));
		const result = await runAdbOnDevice(serial, ['shell', 'input', 'tap', String(x), String(y)]);

		if (!acceptedInput(result)) throw refused(`input tap ${x} ${y}`, serial, result);
	}

	/**
	 * `input swipe <x1> <y1> <x2> <y2> <ms>` — both points converted the same way
	 * {@link tap}'s is, off one `wm density` query.
	 *
	 * **This is also the long press**, and phase 2 composes one out of it rather than getting
	 * a method of its own: a drag from a point to the same point, held past the platform's
	 * long-press timeout, raised the long-press menu on API 37 at 390 ms and did not at
	 * 380 ms, against a device whose `settings get secure long_press_timeout` reads `400`
	 * (PROJECT.md §6). The threshold is a device setting, not a constant, which is why no
	 * default duration is baked in here — the primitive takes the caller's number.
	 */
	async swipe(serial: DeviceSerial, from: Point, to: Point, durationMs: number): Promise<void> {
		// Before the query, so a programmer error costs no round trip and reads as itself.
		const duration = toSwipeDuration(durationMs);
		const scale = await this.pixelScale(serial);
		const start = toDevicePixels(from, scale);
		const end = toDevicePixels(to, scale);

		const argv = [String(start.x), String(start.y), String(end.x), String(end.y)];
		const result = await runAdbOnDevice(serial, [
			'shell',
			'input',
			'swipe',
			...argv,
			String(duration),
		]);

		if (!acceptedInput(result)) {
			throw refused(`input swipe ${argv.join(' ')} ${duration}`, serial, result);
		}
	}

	/**
	 * `input text <text>` — the caller's string, quoted for the device's own shell.
	 *
	 * The quoting is `./adb.js`'s `shellText` and not `shellArg`: this is the one argument in
	 * this file that is screen *content* rather than a shape somebody already checked, and an
	 * apostrophe in it is ordinary rather than a bug. Once it is one shell word, a space needs
	 * no `%s` and every shell metacharacter arrives verbatim (measured — PROJECT.md §6).
	 *
	 * **Usually one call, occasionally more.** `input text` substitutes a space for a literal
	 * `%s`, so a caller's own `%s` is not representable in a single injection;
	 * `./input.js`'s `typeTextSegments` cuts the string so that each piece is typed as itself,
	 * and everything without a `%s` is still exactly one call.
	 *
	 * **What the device was measured not to type is refused before anything is sent** — a tab
	 * or a newline is dropped in silence, and a non-ASCII character throws inside the device
	 * and types nothing at all (PROJECT.md §6). That refusal is an `UnsupportedTextError`
	 * rather than a plain one because it is a caller's string that is wrong rather than the
	 * host: `src/verbs/failure.ts` carries it to the agent as `unsupported-text`, naming the
	 * characters to change, where a plain `Error` would arrive as `internal_error`. The words
	 * for what this device *can* take are passed in from here, because they are this
	 * platform's and the error class names no platform's particulars.
	 *
	 * Each piece is checked on its own, so a run that got half the text in says so rather
	 * than reporting a success for the half that landed.
	 */
	async typeText(serial: DeviceSerial, text: string): Promise<void> {
		const unsupported = untypeableCharacters(text);
		if (unsupported.length > 0) {
			throw new UnsupportedTextError(
				serial,
				text,
				unsupported,
				"'input text' only types printable ASCII",
			);
		}

		for (const segment of typeTextSegments(text)) {
			const result = await runAdbOnDevice(serial, ['shell', 'input', 'text', shellText(segment)]);

			if (!acceptedInput(result)) {
				throw refused(`input text ${JSON.stringify(segment)}`, serial, result);
			}
		}
	}

	/**
	 * `input keyevent <keycode>` — the neutral key mapped through `./input.js`'s `KEY_CODES`.
	 *
	 * The keycode is a literal this file's neighbour owns and no caller's string reaches it,
	 * so it takes no `shellArg` for the reason the environment pair states.
	 *
	 * The check below cannot catch the failure that matters here, and saying so is the point:
	 * `input keyevent NOT_A_KEY` exits **0 with zero bytes on both streams** on API 37, so a
	 * wrong keycode is indistinguishable from a key that was pressed. What keeps the map
	 * honest is that it is exhaustive over `DeviceKey` at compile time, pinned in the unit
	 * suite, and pressed against a real device in `tests/device/android/input.test.ts`.
	 */
	async pressKey(serial: DeviceSerial, key: DeviceKey): Promise<void> {
		const keycode = KEY_CODES[key];
		const result = await runAdbOnDevice(serial, ['shell', 'input', 'keyevent', keycode]);

		if (!acceptedInput(result)) throw refused(`input keyevent ${keycode}`, serial, result);
	}

	/**
	 * `cmd connectivity airplane-mode enable|disable` — the first half of the environment
	 * pair the daemon restores on release and on expiry (D9).
	 *
	 * **Not `svc`.** On API 37 `svc` has only `power`, `usb`, `nfc` and `system-server`, so
	 * every guide showing `svc wifi disable` / `svc data disable` is out of date; this path
	 * works without root (PROJECT.md §6, re-confirmed on adb 37.0.1).
	 *
	 * The two words are the platform's, not a rendering of the boolean: this command takes
	 * `enable`/`disable` while {@link setWifiEnabled} next door takes `enabled`/`disabled`.
	 * Neither is quoted with `shellArg`, and that asymmetry with every app verb above is
	 * deliberate rather than an omission — the argument is one of two literals this file
	 * owns and no caller's string reaches it, which is the property `shellArg` exists to
	 * restore when one does.
	 *
	 * **This is not a wifi switch, in either direction.** Airplane mode moves wifi as a side
	 * effect whose direction depends on state the device remembers, and turning it off never
	 * switches wifi on (PROJECT.md §6) — so a caller restoring a device sets both explicitly
	 * and sets wifi last.
	 */
	async setAirplaneMode(serial: DeviceSerial, enabled: boolean): Promise<void> {
		const argument = enabled ? 'enable' : 'disable';
		const result = await runAdbOnDevice(serial, [
			'shell',
			'cmd',
			'connectivity',
			'airplane-mode',
			argument,
		]);

		if (!acceptedNetworkChange(result)) {
			throw refused(`cmd connectivity airplane-mode ${argument}`, serial, result);
		}
	}

	/**
	 * `cmd wifi set-wifi-enabled enabled|disabled` — the other half, same era of dead
	 * recipe, same absence of a success wording (see {@link acceptedNetworkChange}).
	 *
	 * `enabled`/`disabled`, **not** `enable`/`disable`: the two commands disagree about the
	 * words for the same boolean, and nothing but a device says so — a crossed pair compiles,
	 * reads correctly and is refused only once it gets there (exit 255, PROJECT.md §6). That
	 * is why the argv of all four calls is pinned in
	 * `tests/unit/backends/android/backend.test.ts`.
	 *
	 * Honoured while airplane mode is on, and does not change airplane mode itself
	 * (PROJECT.md §6) — which is what makes it the safe last step of a restoration.
	 */
	async setWifiEnabled(serial: DeviceSerial, enabled: boolean): Promise<void> {
		const argument = enabled ? 'enabled' : 'disabled';
		const result = await runAdbOnDevice(serial, [
			'shell',
			'cmd',
			'wifi',
			'set-wifi-enabled',
			argument,
		]);

		if (!acceptedNetworkChange(result)) {
			throw refused(`cmd wifi set-wifi-enabled ${argument}`, serial, result);
		}
	}

	/**
	 * `screenrecord` to a file on the device, then the file — and **never the other way
	 * round**.
	 *
	 * Verified against API 37 / Android 17 with adb 37.0.1-15733141, and the whole method is
	 * shaped by one finding (PROJECT.md §6): `screenrecord` writes the container header and a
	 * *reserved gap* immediately, fills the payload as it records, and writes the `moov` index
	 * into that gap **only when it exits**. Pull the file a moment early and what comes back is
	 * not a shorter video — the committed capture is `ftyp`, `free`, then an `mdat` claiming a
	 * 64-bit length of 4557430888798830399 over 3232 bytes, which no player will open
	 * (`tests/fixtures/adb/screenrecord.unfinished.api37-….mp4`). To an agent that reads as a
	 * broken tool rather than as a race, which is what the order below and the check at the end
	 * exist to make impossible.
	 *
	 * The order is fixed: **remove, record, wait on the condition, pull, check, answer.**
	 *
	 * - **`rm -f` first**, so a leftover from a run that died before its own cleanup can never
	 *   be the file that is pulled — the freshness guarantee {@link readScreen} buys with a
	 *   confirmation line, bought here by removing the only file this method will ever read.
	 * - **`--time-limit` is always passed, and never as `0`.** It is what makes a recorder that
	 *   outlived its adb client self-terminate rather than run on under the next lease — and
	 *   `--time-limit 0` is documented by `screenrecord` itself as *removing* the limit, so a
	 *   zero computed here would turn the kill switch off rather than record nothing. It counts
	 *   **whole seconds** (`screenrecord v1.4`, default 180), so the conversion rounds **up**
	 *   and then floors at one: a caller who asked for 2500 ms gets three seconds, never two —
	 *   never less than was asked for — and a duration of zero or below, which the wire schema
	 *   already refuses but an in-process caller can still pass, gets one second rather than an
	 *   unbounded recorder on borrowed hardware.
	 * - **The completion check is a condition with a timeout, never a sleep** (D12(b),
	 *   ai/RULES.md §2). "The recorder is gone" is what actually wrote the index; "the duration
	 *   plus a bit" is a guess that is wrong on a loaded device, in the direction that corrupts
	 *   the answer. `waitForCondition` probes *before* any delay, so the ordinary case — the
	 *   recorder had already exited when its adb client returned, which is what this emulator
	 *   did every time — costs one round trip and no wait at all.
	 * - **`pidof screenrecord || true`**, because `pidof` exits **1** when nothing matches and
	 *   `./adb.js` treats a non-zero exit as a failure. "No such process" is the answer this
	 *   wait is looking for, not an error. The `|| true` is a literal this file owns, the case
	 *   this file's header names, and no caller's string is anywhere near it.
	 * - **`exec-out` for the pull, never `shell`.** `adb shell` may put a pty in the path and a
	 *   pty translates every `0x0a` in the stream, conditionally on version and platform — so a
	 *   recording that survives on one machine is corrupt on the next. Same trap as
	 *   {@link screenshot}'s, and the binary runner because this is not text.
	 * - **The `moov` check is on the bytes that actually arrived**, not on the device's exit
	 *   code: `screenrecord` succeeded silently at exit 0 in every run here, including the ones
	 *   whose file was pulled early. {@link UnfinishedRecordingError} names the device and the
	 *   byte length so the failure is an answer rather than an `internal_error`.
	 * - **The `rm -f` cleanup is in a `finally` and its own failure never replaces the
	 *   answer**, exactly as {@link readScreen}'s is, and it runs on the refusal paths too —
	 *   where it does the most good, because a multi-megabyte file left on borrowed hardware is
	 *   what the cleanup is for.
	 *
	 * **Exclusive per device** ({@link exclusivelyOn}), because {@link RECORDING_PATH} is a
	 * fixed literal: two concurrent recordings on one device would otherwise share one file and
	 * corrupt both, and nothing above this excludes them — `src/daemon/verb-traffic.ts`
	 * registers concurrent calls on one device rather than preventing them, on purpose.
	 *
	 * **A recorder somebody else started on the same device makes this time out.** The probe
	 * asks whether *any* `screenrecord` is running, because matching a particular one would
	 * mean matching a pid this code never learned; the timeout names the pids that were there,
	 * which is what makes it actionable rather than mysterious.
	 *
	 * Neither `RECORDING_PATH` nor the bit rate takes a quoter: both are literals this file
	 * owns, and the `--time-limit` argument is a number it computed.
	 */
	async recordVideo(serial: DeviceSerial, options: RecordVideoOptions): Promise<Uint8Array> {
		// Whole seconds, rounded up: never record less than the caller asked for. Floored at one
		// because `--time-limit 0` means "no limit" — the one value that would defeat the guard.
		const timeLimitSeconds = Math.max(
			1,
			Math.ceil(options.durationMs / RECORDING_TIME_LIMIT_UNIT_MS),
		);
		// The window the recorder will actually run for, which is the floored limit rather than
		// what was asked: the adb client must outlive the command it is waiting on.
		const timeLimitMs = timeLimitSeconds * RECORDING_TIME_LIMIT_UNIT_MS;

		return this.exclusivelyOn(serial, async () => {
			await this.removeRecording(serial);

			try {
				await runAdbOnDevice(
					serial,
					[
						'shell',
						'screenrecord',
						'--bit-rate',
						String(RECORDING_BIT_RATE_BPS),
						'--time-limit',
						String(timeLimitSeconds),
						RECORDING_PATH,
					],
					// The capture window plus the budget for the encoder to close the file: this
					// command does not return until both have happened.
					{ timeoutMs: timeLimitMs + RECORDING_FINISH_TIMEOUT_MS },
				);

				await waitForCondition({
					what: `the recording on device '${serial}' to finish`,
					timeoutMs: RECORDING_FINISH_TIMEOUT_MS,
					probe: async () => {
						const running = await runAdbOnDevice(serial, ['shell', 'pidof screenrecord || true']);
						if (!isRecorderRunning(running.stdout)) return { met: true, value: undefined };
						return {
							found: `screenrecord still running as pid ${recorderPids(running.stdout).join(', ')}`,
							met: false,
						};
					},
				});

				const pulled = await runAdbBinaryOnDevice(serial, ['exec-out', 'cat', RECORDING_PATH], {
					timeoutMs: RECORDING_PULL_TIMEOUT_MS,
				});

				if (!isFinishedRecording(pulled.stdout)) {
					throw new UnfinishedRecordingError(serial, pulled.stdout.byteLength);
				}

				return pulled.stdout;
			} finally {
				await this.removeRecording(serial).catch(() => undefined);
			}
		});
	}

	/** The scratch file, gone — run before the recording and again after it, on every path. */
	private async removeRecording(serial: DeviceSerial): Promise<void> {
		await runAdbOnDevice(serial, ['shell', 'rm', '-f', RECORDING_PATH]);
	}

	/**
	 * The device's physical-pixels-per-dp, asked fresh for every injection.
	 *
	 * **Not cached.** D6's rule — the daemon is a cache and adb is the truth — applies to a
	 * density as much as to a device list: `wm density <n>` changes it under a running lease,
	 * and a remembered scale would then put every subsequent tap somewhere the caller did not
	 * ask for, silently. One `wm density` is a millisecond-scale query beside the injection it
	 * precedes.
	 *
	 * **Not `deviceInfo`**, which would be three queries where one answers the question.
	 *
	 * The parse failure is wrapped the way `listDevices` wraps its own: the parser only ever
	 * saw stdout, and what explains an unparseable answer to a well-formed command is usually
	 * on stderr.
	 */
	private async pixelScale(serial: DeviceSerial): Promise<number> {
		const result = await runAdbOnDevice(serial, ['shell', 'wm', 'density']);

		try {
			return parseWmDensity(result.stdout).scale;
		} catch (cause) {
			throw unparseable('adb shell wm density', result, cause);
		}
	}

	/**
	 * The `<package>/<class>` component to launch an app id by, asked of the device.
	 *
	 * Reading the answer out of what `--brief` prints is
	 * {@link parseResolvedActivity}'s; what belongs here is the failure, because a `null`
	 * from it covers both "no such package" and "nothing launchable in it" — adb answers
	 * the two identically, on stdout, exit 0 (PROJECT.md §6) — and only this side knows the
	 * app id and the device to name.
	 */
	private async resolveLaunchComponent(serial: DeviceSerial, appId: AppId): Promise<string> {
		const result = await runAdbOnDevice(serial, [
			'shell',
			'cmd',
			'package',
			'resolve-activity',
			'--brief',
			appArg(appId),
		]);

		const component = parseResolvedActivity(result.stdout);
		if (component === null) {
			throw refused(`resolving a launchable activity of '${unwrap(appId)}'`, serial, result);
		}

		return component;
	}
}
