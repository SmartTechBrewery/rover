/**
 * The device backend for this platform: every required method of `DeviceBackend`, the recorder,
 * the screen read and the four input primitives.
 *
 * **This is the backend that registers** (`./index.ts`, `./capabilities.ts`, and one import line
 * in `../index.ts`), which is why the four recording methods land in the same change as the
 * manifest rather than earlier: `CAPABILITY_METHODS.canControlRecording` names
 * {@link IosSimulatorDeviceBackend.startRecording}, {@link IosSimulatorDeviceBackend.stopRecording}
 * **and** {@link IosSimulatorDeviceBackend.discardRecording}, so a manifest declaring the
 * capability with any of them missing fails the conformance gate the manifest exists to pass
 * (`ai/TESTING.md`, "A backend under construction registers nothing"; `PROJECT.md` R45). The same
 * rule is what puts {@link IosSimulatorDeviceBackend.readScreen} in the change that flips
 * `canReadScreen` (#251), and all four of {@link IosSimulatorDeviceBackend.tap},
 * {@link IosSimulatorDeviceBackend.swipe}, {@link IosSimulatorDeviceBackend.typeText} and
 * {@link IosSimulatorDeviceBackend.pressKey} in the one that flips `canInput` (#252).
 *
 * **What is absent is absent on purpose.** There is no `setAirplaneMode` and no `setWifiEnabled`
 * — the one capability `./capabilities.ts` still declares `false`, which carries why it is an
 * honest opt-out rather than a gap. An absent method beside a `false` flag is a complete backend;
 * a stub beside it is one under construction.
 *
 * **Two external programs reach a device from here, not one.** Everything Xcode's own goes
 * through `./simctl.js`; the screen read and every injection go through `./idb-client.js`, which
 * supervises one `idb_companion` per target and speaks gRPC to it — a second program, with a
 * lifecycle this class holds ({@link IosSimulatorDeviceBackend.stopIdbCompanions}) and an install
 * this host may simply not have. Everything that reads either program's output goes through
 * `./parsers/`, and the four pure modules beside this one own the vocabulary, the arithmetic and
 * the path mapping — `./devices.js` on the enumeration, `./screen.js` on the screen and on the
 * elements on it, `./containers.js` on where a device path is on this host, `./input.js` on the
 * HID events and on the key vocabulary. This file is the join between them and holds no
 * text-shaped knowledge of its own: no key name, no state token, no plist path and no failure
 * wording appears here.
 *
 * **The two transfers reach no simulator at all**, which is the one thing about this backend that
 * has no counterpart on the Android side: a simulator's storage *is* a directory on this host, so
 * a push is a file copy and a pull is a file read. `./containers.js` carries why that is the only
 * route available and what confines it.
 *
 * **The recorder is a host process too, and that is the other place this backend's shape differs
 * from the Android one.** `screenrecord` runs on the device, so the device answers "am I
 * recording" and `--time-limit` is a kill switch that outlives its client; `simctl io
 * recordVideo` runs here, so this host's process table is that answer
 * ({@link IosSimulatorDeviceBackend.recorderPids}) and the limit is a timer in this process,
 * which is a cost {@link IosSimulatorDeviceBackend.startRecording} states rather than hides.
 *
 * **Nothing here quotes an argument, and that is a property of the tool rather than an
 * omission** — the counterpart to `../android/backend.ts`'s header, which has to choose a quoter
 * per value. `simctl` takes argv entries and there is no shell on either side of it
 * (`./simctl.js`), so every value this file passes is an argument and cannot become a second
 * command. {@link IosSimulatorDeviceBackend.readLogs} is the first call here to run a program
 * *inside* the device, and it changes nothing about that: what follows the udid is the guest
 * program's own argv — `log show …`, entry by entry — and no shell reads it. What would put the
 * question back on the table is a `simctl spawn <device> sh -c …`, which nothing here does.
 */

import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
	type Device,
	type DeviceBackend,
	type DeviceInfo,
	DeviceInfoSchema,
	type DeviceKey,
	type DeviceState,
	type DeviceWatch,
	type DeviceWatcher,
	type InterruptionCause,
	type LogRead,
	type Point,
	type PullFileOptions,
	type ReadLogsOptions,
	type RecordVideoOptions,
	type ScreenElement,
	type StartRecordingOptions,
} from '../../core/device.js';
import {
	DeviceVanishedError,
	FileTooLargeError,
	NoRecordingRunningError,
	RecordingAlreadyRunningError,
	UnfinishedRecordingError,
	UnsupportedKeyError,
	UnsupportedTextError,
} from '../../core/errors.js';
import { type AppId, type DeviceSerial, unwrap } from '../../core/ids.js';
import { waitForCondition } from '../../core/wait.js';
import { hostPathOf } from './containers.js';
import { SIMCTL_MISSING, SimctlNotFoundError } from './developer-dir.js';
import {
	borrowableNow,
	IOS_SIMULATOR_PLATFORM_ID,
	toDevices,
	toNotifiedDevices,
} from './devices.js';
import { IdbCompanions, type IdbStreamRpc, type IdbUnaryRpc } from './idb-client.js';
import {
	IDB_COMPANION_STDERR_TAIL_CHARS,
	type IdbCompanionStream,
	streamIdbCompanion,
} from './idb-companion.js';
import { IDB_COMPANION_MISSING, IdbCompanionNotFoundError } from './idb-companion-path.js';
import {
	buttonEvents,
	DEVICE_KEYS,
	isScreenBlanked,
	READ_SCREEN_BLANKED_ARGV,
	swipeEvents,
	TYPEABLE_TEXT,
	tapEvents,
	typeTextEvents,
	untypeableCharacters,
} from './input.js';
import { ACCESSIBILITY_FORMAT, parseAccessibilityRead } from './parsers/accessibility.js';
import { saysNothingToTerminate } from './parsers/app-control.js';
import { type DeviceTypeProfile, readDeviceTypeProfile } from './parsers/device-type-profile.js';
import { IdbNotifyFrameDecoder, type IdbTargetList } from './parsers/idb-notify.js';
import { isPng } from './parsers/png.js';
import { isFinishedRecording, recorderPids, saysRecordingStarted } from './parsers/recording.js';
import {
	parseSimctlDevices,
	parseSimctlDeviceTypes,
	parseSimctlRuntimes,
	type SimctlDevice,
	type SimctlDeviceList,
	type SimctlDeviceType,
	type SimctlRuntimeList,
} from './parsers/simctl-list.js';
import { parseUnifiedLog } from './parsers/unified-log.js';
import { deviceTypeProfilePath, toScreenElements, toScreenInfo } from './screen.js';
import {
	describeBytes,
	INSTALL_SIMCTL_TIMEOUT_MS,
	quoteStream,
	READ_LOGS_SIMCTL_MAX_BUFFER_BYTES,
	RECORDING_FINISH_TIMEOUT_MS,
	RECORDING_START_TIMEOUT_MS,
	readProcessTable,
	runSimctl,
	runSimctlOnDevice,
	SCREENSHOT_SIMCTL_TIMEOUT_MS,
	SimctlCommandError,
	type SimctlResult,
	type SimctlStream,
	streamSimctlOnDevice,
} from './simctl.js';

/**
 * The enumeration's argv: **both listings in one invocation**.
 *
 * `../devices.js`'s `toDevices` needs both and neither is derivable from the other — the device
 * map is keyed by runtime *identifier* while only the runtime list carries the version — so the
 * choice is one invocation or two. One, because two would let the pair disagree: a runtime
 * uninstalled between them reports a device without a version that has one. `simctl list` accepts
 * several listing names at once despite its own usage text saying to specify one
 * (`./parsers/simctl-list.js`, measured on Xcode 26.4.1).
 */
const ENUMERATE_ARGV = ['list', '-j', 'devices', 'runtimes'] as const;

/**
 * {@link IosSimulatorDeviceBackend.deviceInfo}'s argv: the same two listings plus the device
 * types, again in one invocation.
 *
 * Measured on macOS 26.6.2 (25G83) / Xcode 26.4.1 (17E202), 2026-09-08: three listing names
 * answered all three keys — and only those three, no `pairs` — at exit 0 in 0.24 s, 115 KB for
 * 22 devices, 2 runtimes and 124 device types. The device types are **not** on
 * {@link ENUMERATE_ARGV} because they are 124 entries this backend reads one of, and the
 * enumeration is the call every lease grant's re-verification makes (D6).
 */
const DEVICE_FACTS_ARGV = ['list', '-j', 'devices', 'runtimes', 'devicetypes'] as const;

/**
 * What the two transfers ask: the device listing alone, for the one field they need.
 *
 * `dataPath` is the device's own storage root on this host and the whole of what makes a
 * transfer here a file copy (`./containers.js`). The runtimes are not on this argv because
 * nothing about a transfer depends on an OS version, and this is a call made per transfer rather
 * than once — the same reason the device types are not on {@link ENUMERATE_ARGV}. That a
 * single-listing invocation parses is pinned by a committed capture of exactly this command
 * (`tests/fixtures/ios-simulator/simctl-list-devices.xcode26.4.1-ios26.4.1.json`).
 */
const DEVICE_PATHS_ARGV = ['list', '-j', 'devices'] as const;

/**
 * The subcommand and the container `clearAppData` asks for: the **installed bundle**, not the
 * data.
 *
 * `simctl get_app_container <device> <bundle> app` prints the path of the `.app` as installed —
 * measured on macOS 26.6.2 (25G83) / Xcode 26.4.1 (17E202), 2026-09-08, that is
 * `<dataPath>/Containers/Bundle/Application/<uuid>/<Name>.app`, *inside the device's own
 * storage*. Which is why the reinstall has to stage a copy first: see
 * {@link IosSimulatorDeviceBackend.clearAppData}.
 */
const APP_CONTAINER = 'app';

/** So a scratch directory that somehow outlives its `finally` is attributable to this backend. */
const CLEAR_PREFIX = 'rover-ios-clear-';

/** The same, for the directory one capture is staged in. */
const SCREENSHOT_PREFIX = 'rover-ios-screenshot-';

/**
 * What the staged capture is called inside that directory.
 *
 * The suffix is for whoever finds one of these left behind, not for the tool: `--type png` below
 * makes the encoding a demand of this method, so nothing here depends on the extension being
 * read. It is not left off either — `simctl` prints `Detected file type from extension: PNG` when
 * it does the detecting (`./simctl.js`), and a name that made it say something else about a file
 * this backend chose would be a message nobody could act on.
 */
const SCREENSHOT_FILE = 'screenshot.png';

/**
 * The capture's argv up to the path it writes: `simctl io <device> screenshot --type png --mask
 * ignored <path>`.
 *
 * **It goes to a file this backend stages and removes, never to stdout, and that is measured
 * rather than preferred.** `simctl help io` does document `-` for stdout. On this bench that
 * route is broken: `io <udid> screenshot --type png --mask ignored -` — and a bare `screenshot
 * -`, with stdout a pipe and with stdout redirected to a file alike — exits non-zero having
 * written nothing, with *"An error was encountered processing the command
 * (domain=NSCocoaErrorDomain, code=642)"* and *"You can’t save the file “-” because the volume
 * “Macintosh HD” is read only"*, while the same call with a real path prints `Wrote screenshot
 * to: …` and produces the PNG (macOS 26.6.2 / Xcode 26.4.1, 2026-09-08). The `-` is taken as a
 * *file name*, and resolved against a directory this process does not choose — a **relative**
 * path fails identically, which is why the staged one is absolute (`docs/IOS.md` §8, trap 10).
 *
 * **`--mask ignored` is deliberate.** The default returns the device's rounded corners with
 * alpha, which anything doing arithmetic on the frame will not want (`docs/IOS.md` §8, trap 5).
 * It changes no dimension: both forms came back 1206×2622 on the booted iPhone 17 of that bench,
 * which is what `deviceInfo` reports the screen to be.
 *
 * **`--type png` is asked for rather than left to the file name**, so the encoding this method
 * promises is a demand on the tool. It is also what makes {@link isPng} a check rather than a
 * guess: the bytes are refused for not being what `simctl` was told to write.
 */
const SCREENSHOT_ARGV = ['screenshot', '--type', 'png', '--mask', 'ignored'] as const;

/**
 * The screen read's RPC and its whole request: the accessibility read of the **whole screen**.
 *
 * `AccessibilityInfoRequest` (`./idb/idb.proto`) offers three ways to narrow one and none of them
 * is asked for. `point` resolves a single element and is the `describe-point` route — nothing in
 * the verb layer asks for one, because `src/verbs/target.ts` resolves a target against a whole
 * screen. `marker` searches by a substring of one key, which is target resolution done by idb
 * instead of by the layer that owns it. `keys` restricts which accessibility keys come back, and
 * this read wants three of them, which is not enough of a saving to have a second place where the
 * key set is decided (`./parsers/accessibility.js` is the first).
 *
 * The format is that module's, exported from it because the shape it parses *is* that format.
 */
const READ_SCREEN_RPC: IdbUnaryRpc = 'accessibility_info';
const READ_SCREEN_REQUEST = { format: ACCESSIBILITY_FORMAT } as const;

/**
 * The RPC every one of the four input primitives goes through — the only client-streaming call
 * this backend makes.
 *
 * One RPC for all four because that is what the companion offers: there is no tap call and no text
 * call, only a stream of HID events (`./idb/idb.proto`), so the difference between a tap, a swipe,
 * a key and a line of text is entirely which events `./input.js` builds. That is also why the
 * vocabulary is worth its own module rather than four argv constants here.
 */
const HID_RPC: IdbStreamRpc = 'hid';

/**
 * How far back one log read looks, narrowest first — the pushdown, and the honest answer to a
 * design problem `docs/IOS.md` §5 first proposed a different solution to.
 *
 * That section's measurement stands: a read that filters *after* the fact spends seconds
 * serialising noise before `maxEntries` throws it away, so the bound belongs in the query. What
 * it named as the pushdown was `--predicate 'process == "…"'` — and `ReadLogsOptions` carries
 * `maxEntries` and nothing else (`src/core/device.js`), so there is no process to filter *by*.
 * Inventing one would answer a narrower question than the caller asked; widening the contract to
 * pass one is a contract change and its own issue.
 *
 * So the pushdown is the other bound `log show` offers — its window — and **half of it is
 * already the device**. `simctl spawn` runs the query *inside* the simulator: a 20-second read
 * came back holding `launchd_sim`, `backboardd` and `SpringBoard` and nothing of this Mac's,
 * 1,958 entries against 2,766 for the same window of the host's own log (macOS 26.6.2 / Xcode
 * 26.4.1, 2026-09-08). §5's 92,204 is a busier bench than this one; what carries over is the
 * shape of its point rather than its number.
 *
 * **The window widens until the *cap* is what binds the answer**, because a window is the
 * wrong bound to answer a count with and a single one was the wrong call. The contract's
 * ceiling is 5,000 entries (`MAX_LOG_ENTRIES`, `src/ipc/verb-methods.ts`) and this device
 * answered **67–160 entries per second** depending on what the host was doing, so thirty
 * seconds holds 2,000–4,800 of them: *below* the ceiling. A caller asking for 5,000 therefore
 * got everything the window had together with `truncated: false` — told, by the one flag that
 * exists to say otherwise, that nothing older was dropped, while the device's own store held
 * an order of magnitude more (`--last 30s` answered 2,053 entries against `--last 5m`'s 34,819
 * on this bench). `../android/backend.ts` has no such gap: `logcat -t maxEntries + 1` reaches
 * as far back as the ring buffer holds, so the cap binds the answer and never the lookback.
 * Answering the same `read_logs` call with "the newest N" there and "whatever thirty seconds
 * held, up to N" here is also D10's one-set-of-verbs promise going quietly.
 *
 * So {@link readLogs} re-reads at the next width while the device said no more than the cap,
 * and only the last of these widths is allowed to answer `truncated: false`. **The escalation
 * is self-limiting**, which is what makes it cheap rather than three reads' worth of latency: a
 * device chatty enough to fill the cap fills it at `30s` and is never re-read — the 200 a caller
 * who did not say gets (`DEFAULT_MAX_LOG_ENTRIES`, `src/verbs/logs.js`) is ten to twenty-four
 * times over inside the first window — while a device quiet enough to reach the widest is by
 * definition saying less than `maxEntries` per `2m`, so the widest read is small in exactly the
 * case that reaches it.
 *
 * Measured on this bench (macOS 26.6.2 / Xcode 26.4.1, booted iPhone 17, 2026-09-08):
 * `30s` 2,053 entries / 2.6 MB / 1.01 s, `2m` 8,712 / 10.9 MB / 1.13 s, `5m` 34,819 / 42.8 MB /
 * 1.75 s. The cost is nearly flat in the width because what a read spends is `simctl spawn`'s
 * own start-up rather than the window.
 *
 * **A width bounds a duration and not a size, and the self-limiting argument above is about a
 * *rate*.** It said the widest read is small in the case that reaches it, and inferred from
 * 1.23 KB an entry that the ceiling costs about 15 MB — well inside
 * {@link READ_LOGS_SIMCTL_MAX_BUFFER_BYTES}. That inference holds only while the log rate is
 * roughly uniform across the widths, and the case it is written for — a read taken *after*
 * something happened — is exactly the case where it is not: a burst that has aged out of the
 * narrowest width is still inside a wider one, so the wider read is large precisely when the
 * narrow one came back quiet. Measured on the same bench, on a simulator a minute past boot:
 * `30s` 94,154 entries / 113.6 MB, `2m` 160,587 / 191.8 MB, `5m` 195,444 / 232.4 MB — and on a
 * second device type read seconds after boot, `30s` 107.9 MB, `2m` **576.8 MB**, `5m` 756.4 MB.
 * One to two orders of magnitude past the 64 MB buffer, and an overflow is not a graceful
 * truncation ({@link READ_LOGS_SIMCTL_MAX_BUFFER_BYTES}: the child is killed and the answer is
 * lost).
 *
 * So the escalation is bounded by bytes as well as by count: a wider width that overflows the
 * buffer does not fail the read, it **ends the widening** and the narrower width's answer stands,
 * flagged `truncated: true` — an overflow being positive proof the device said far more than the
 * cap, which is what the flag exists to say ({@link readLogs}). What no width can be rescued
 * from is an overflow at the *narrowest*: there is no earlier answer to keep, and the partial
 * buffer is no answer either, since `log show` writes oldest-first and a read is asked for the
 * newest. That case fails loudly, and on this bench it is reachable for the first half-minute
 * after a boot at any cap at all — at the very peak of the burst it can even exhaust the ten
 * second budget before the buffer, which is the same refusal wearing the other name. Raising the
 * buffer is not the fix — 756 MB was an *idle* device's figure, nothing was under test on it —
 * and the fix that would answer it is a streaming read that keeps a rolling tail of
 * `maxEntries + 1` lines, the way `../android/backend.ts` gets the same guarantee from
 * `logcat -t`. That is a runner this module does not have (`./simctl.ts` is `execFile` only) and
 * a change of its own.
 *
 * **`5m` is the horizon, and a read that exhausts it answers `truncated: false` honestly.**
 * That is the same claim the Android side makes when the ring buffer holds less than the cap:
 * nothing was dropped *for the cap's sake*. What neither platform can offer is an unbounded
 * lookback, and a caller has no way to ask for one — `ReadLogsOptions` carries `maxEntries` and
 * nothing else, and widening that is a contract change rather than something to improvise here.
 *
 * **The unit is spelled out because the tool's default is not what its help says.** `log show
 * --help` lists `--last <num>[m|h|d]` and no `s`, yet `s` is honoured — `--last 60s` and `--last
 * 1m` answered 5,750 and 5,752 lines seconds apart — while a **bare number is seconds**, not the
 * minutes that list implies: `--last 1` answered 93 entries where `--last 60s` answered 3,998
 * (same bench). Passing the suffix is what keeps an undocumented default from choosing the
 * window.
 *
 * Exported so `tests/unit/backends/ios-simulator/backend.test.ts` can pin the widest of these
 * against `MAX_LOG_ENTRIES` at the slowest rate measured above, rather than restating a number
 * that would then be free to drift away from this one.
 */
export const LOG_WINDOWS = ['30s', '2m', '5m'] as const;

/**
 * The log read's argv for one width, every flag load-bearing and every one measured — this is
 * the *guest* program's argv, handed to `simctl spawn` after the udid (this file's header).
 *
 * - **`log show`**, never `log stream`. A tail that stays open is a wait with no condition
 *   (ai/RULES.md §2) and a stream over IPC (D19); this is a bounded read that returns.
 * - **`--style ndjson`** is the shape `./parsers/unified-log.js` is pinned against: one entry per
 *   line, plus a trailer describing the output that the parser drops.
 * - **`--info --debug` are not optional.** Without them the tool answers neither level — the
 *   levels capture comes back carrying only `Default`, `Error`, `Fault` and absent — so a log
 *   read that left them off would silently omit two of the five levels this platform has
 *   (measured, `tests/fixtures/ios-simulator/README.md`).
 * - **`--last`** is one of {@link LOG_WINDOWS}, which carries the whole argument for a window
 *   and for why one width is not enough.
 */
function readLogsArgv(window: string): string[] {
	return ['log', 'show', '--style', 'ndjson', '--info', '--debug', '--last', window];
}

/**
 * The gap between two polls of the device set.
 *
 * **A `setTimeout` re-armed after each poll, never a sleep** (ai/RULES.md §2, D12(b)): what the
 * gate forbids is a delay awaited *instead of* a check, and `pause` may only be called from the
 * five files on `NO_SLEEP_PAUSE_CALLERS` (`tests/helpers/no-sleep-scan.ts`). This needs no sixth
 * entry — a timer whose callback does the next poll is a scheduled check, which is what
 * `setInterval` would be too. It is a re-armed timeout rather than an interval so the gap is
 * measured from the *end* of one poll: an interval whose period a slow `simctl` outran would
 * stack polls on top of each other.
 *
 * Two seconds because that is a gap rather than a poll rate: the listing took 0.11–0.24 s across
 * every run on this backend's benches, so the tool is idle roughly nine tenths of the time while
 * a device appearing or going away is noticed within about two seconds. Nothing depends on the
 * number for correctness — a lease grant re-verifies the device it is about to lend rather than
 * trusting this watch (D6) — so it is a constant and not configuration (ai/RULES.md §7).
 *
 * **The poll is the fallback now, not the design.** `idb_companion --notify` emits the full
 * target set on every change with no polling at all (`docs/IOS.md` §7), and
 * {@link IosSimulatorDeviceBackend.watchDevices} prefers it — this gap is what a host with no
 * companion still watches its devices through, and what the stream falls back to whenever it
 * will not stay up. Nothing a caller can see differs between the two: the contract is the full
 * current set on subscription and on every change either way.
 */
export const WATCH_POLL_INTERVAL_MS = 2_000;

/**
 * The companion's argv for the one mode this phase starts one in: the change stream, on stdout.
 *
 * **One per host, and no `--udid`** — this is the stream that reports every target, which is
 * what an enumeration needs. The per-target companions are a different job with a different
 * lifecycle (`docs/IOS.md` §4), and the runner beside this takes its argv from the caller so
 * that they can share the process handling without sharing the argv (`./idb-companion.js`).
 *
 * `stdout` rather than a path or a port because the process is this host's child and its output
 * is already a pipe; the alternative would be a file somebody has to clean up.
 */
const IDB_NOTIFY_ARGV = ['--notify', 'stdout'] as const;

/**
 * How long to wait before starting another companion after one ended, and the ceiling that wait
 * grows to. Doubling, and reset by the first frame a new companion delivers.
 *
 * `AndroidDeviceBackend`'s `TRACK_RESTART_MIN/MAX_DELAY_MS` shape and its reasoning, with this
 * platform's own two reasons for each half. **Mandatory** rather than nice: a companion is a
 * process on this host that nothing else supervises, killing one does not disturb the simulator
 * (`docs/IOS.md` §4), and a host that lost its stream permanently would be a host reduced to the
 * poll forever — while an `idb_companion` unpacked onto a *running* host is exactly what a
 * restart picks up, since the search is unmemoised (`./idb-companion-path.js`).
 * **Bounded** because the other reason a companion ends immediately is that there is none to
 * run, and retrying that every 250 ms forever is a busy loop with a process spawn in it.
 *
 * Constants, not configuration (ai/RULES.md §7): nothing about them is a host's choice.
 */
const NOTIFY_RESTART_MIN_DELAY_MS = 250;
const NOTIFY_RESTART_MAX_DELAY_MS = 5_000;

/**
 * The recorder's argv up to the file it writes: `simctl io <device> recordVideo --codec h264
 * --mask ignored <path>`.
 *
 * - **`--codec h264` is asked for rather than left to the default**, which is `hevc` (`simctl
 *   help io`, Xcode 26.6). The container is QuickTime either way, and what the codec decides is
 *   who can read the payload afterwards: the recording travels to the agent's machine as bytes
 *   and is re-encoded here only when `ffmpeg` is present (`src/daemon/normalise.ts`), so the
 *   more widely decodable of the two is the honest default for an answer somebody else opens.
 * - **`--mask ignored` is the same choice {@link SCREENSHOT_ARGV} makes**, for its reason: the
 *   default returns the device's rounded corners, which anything doing arithmetic on a frame
 *   will not want (`docs/IOS.md` §8, trap 5).
 * - **There is no `--force` and no bit rate.** The file is removed before the recorder is
 *   started ({@link IosSimulatorDeviceBackend.recordVideo}), so `--force` would only make a
 *   leftover this backend failed to remove silently overwritable — where without it the tool
 *   refuses at exit **17**, *"cannot save recorded video output into a file that already
 *   exists"* (measured, macOS 26.6.2 / Xcode 26.6, 2026-09-08), which is the answer worth
 *   getting. A bit rate is simply not on offer: `recordVideo` takes a codec, a display, a mask
 *   and `--force`, and nothing else — see {@link RECORDING_PATH_PREFIX} for what that costs.
 */
const RECORD_VIDEO_ARGV = ['recordVideo', '--codec', 'h264', '--mask', 'ignored'] as const;

/**
 * The signal that finishes a recording, and the only one this backend ever sends.
 *
 * `simctl help io`, verbatim: *"Send SIGINT (Control + C) to stop recording. simctl exits once
 * the in-flight frames are processed and the video file is finalized."* What a `SIGKILL` does
 * instead is measured and is much worse than a lost recording — see {@link SimctlStream.signal},
 * which carries it, and `docs/IOS.md` §8.
 */
const RECORDING_SIGNAL = 'SIGINT' as const;

/**
 * Where a recording is written on **this host**, one path per device, derived from the udid.
 *
 * Unlike every other scratch path in this backend this one is **not** a `mkdtemp` directory, and
 * it cannot be: a recording is held open across two calls (`startRecording` then
 * `stopRecording`), and the lease-end teardown has to find the file a *previous* call left
 * (`discardRecording`, D9). A path nobody can re-derive is a file nobody can collect.
 *
 * So it is derived rather than remembered, which is the same rule the recorder itself follows
 * (D6): asked of the udid at the moment it matters, never held on the host. Per device rather
 * than fixed, because one host lends several — `../android/backend.ts`'s `RECORDING_PATH` is a
 * single literal only because it names a path on the device it belongs to.
 *
 * Freshness is bought by removing it *before* the recording rather than by making the name
 * unique, `RECORDING_PATH`'s reasoning to the letter and with the same thing at stake: a unique
 * name would leave a multi-megabyte file behind for every recording that died before its
 * cleanup, on a host that lends the same hardware to somebody else next.
 *
 * **What it can hold is not bounded here, and that is worth stating rather than discovering.**
 * `recordVideo` has no bit rate to ask for, so the size of a recording is whatever the screen
 * did: measured on macOS 26.6.2 / Xcode 26.6 against a booted iPhone 17, 2026-09-08, an idle
 * screen came back at ~50 KB/s (100,782 bytes for ~2 s) while four full-screen repaints came back
 * at ~2.8 MB/s (810,871 bytes for 0.29 s). At that upper rate the verb layer's own ceiling —
 * `MAX_ARTIFACT_BYTES`, 4 MiB (`src/verbs/result.ts`) — is reached in under two seconds, and what
 * the caller then gets is an `artifact-too-large` refusal naming both numbers rather than a
 * truncated video. `../android/backend.ts` buys its way out of that with
 * `RECORDING_BIT_RATE_BPS`; this platform offers no equivalent, so the honest answer is that a
 * recording of a busy screen is short.
 */
const RECORDING_PATH_PREFIX = 'rover-ios-recording-';

/** `<tmpdir>/rover-ios-recording-<udid>.mov` — see {@link RECORDING_PATH_PREFIX}. */
function recordingPathOf(serial: DeviceSerial): string {
	return join(tmpdir(), `${RECORDING_PATH_PREFIX}${unwrap(serial)}.mov`);
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The errno of a `node:fs` failure, carried across into a message that cannot quote the failure
 * itself.
 *
 * Every message that library writes names a host path, and these are read on the agent's machine
 * (D19) — so the code travels and the sentence does not. One definition because three refusals
 * need it, and because `unknown` is genuinely all a `catch` binding says.
 */
function errnoOf(cause: unknown): string {
	return cause instanceof Error && 'code' in cause ? String(cause.code) : 'unknown';
}

/**
 * Re-throw a parse failure with the command and the stream the parser never saw attached.
 *
 * The parsers are handed stdout alone, and what explains an unparseable answer to a well-formed
 * command is usually on stderr. Exit 0 means `./simctl.js` had nothing to complain about, so this
 * is the only place that context can be added — `../android/backend.ts`'s helper of the same name,
 * with one difference: stderr is quoted **even when it is empty**, through `./simctl.js`'s own
 * {@link quoteStream}. On this platform a successful `simctl io` writes an informational note to
 * stderr, so "was there anything on stderr?" is a real question here and `(empty)` is the answer
 * to it rather than a line worth omitting.
 */
function unparseable(argv: readonly string[], result: SimctlResult, cause: unknown): Error {
	return new Error(
		`simctl ${argv.join(' ')}: ${message(cause)}\nstderr: ${quoteStream(result.stderr)}`,
		{ cause },
	);
}

/**
 * The three listings of one `simctl list -j` answer, with {@link unparseable} around the parse.
 *
 * `which` is the argv that produced the output, so a failure names the command that was really
 * run rather than one of the two this file makes, and `wantDeviceTypes` is what keeps the
 * enumeration from parsing 124 entries it does not read. Mapping onto the neutral vocabulary is
 * deliberately *not* in here: what this catches is output the *tool's* own shape rejects, and a
 * `DeviceSchema` rejection is a different failure carrying its own message — the same line
 * `../android/backend.ts` draws.
 */
function parseListings(
	which: readonly string[],
	result: SimctlResult,
	wantDeviceTypes: boolean,
): {
	devices: SimctlDeviceList;
	runtimes: SimctlRuntimeList;
	deviceTypes: readonly SimctlDeviceType[];
} {
	try {
		return {
			devices: parseSimctlDevices(result.stdout),
			runtimes: parseSimctlRuntimes(result.stdout),
			deviceTypes: wantDeviceTypes ? parseSimctlDeviceTypes(result.stdout).devicetypes : [],
		};
	} catch (cause) {
		throw unparseable(which, result, cause);
	}
}

/**
 * The raw listing entry for one serial, or `null` when the listing does not name it.
 *
 * Read alongside the mapped {@link Device} rather than instead of it, for the one field the
 * neutral shape deliberately does not carry: `deviceTypeIdentifier`, the join key onto the
 * device types. Which devices this backend *addresses* stays `../devices.js`'s decision — this
 * is a lookup over the same listing, not a second enumeration with its own rules.
 */
function findEntry(devices: SimctlDeviceList, serial: DeviceSerial): SimctlDevice | null {
	const udid = unwrap(serial);
	for (const entries of Object.values(devices.devices)) {
		const found = entries.find((entry) => entry.udid === udid);
		if (found !== undefined) return found;
	}
	return null;
}

/**
 * Whether two enumerations describe the same device set, compared as **sets** rather than as
 * listings.
 *
 * Two decisions, both about what counts as a change worth waking a caller for:
 *
 * - **The mapped `Device[]`, never the raw JSON.** Every device entry carries a `dataPathSize`
 *   that moves as the simulator writes to its own disk, so comparing what the tool printed would
 *   report a device change every poll, on an idle host, forever.
 * - **Order-insensitive**, because the order is the tool's: the device map is keyed by runtime and
 *   two polls that agree about every device could still disagree about which runtime came first.
 *
 * Compared by serialising the sorted set rather than field by field, so a field added to
 * {@link Device} is covered without an edit here — the way this comparison would otherwise fail
 * is by silently stopping to look at something. It errs deliberately: a false *difference* costs
 * one redundant delivery of the full current set, which the contract already asks a watcher to
 * accept, while a false *match* is a device change the host never hears about.
 */
function sameDeviceSet(before: readonly Device[], after: readonly Device[]): boolean {
	return signature(before) === signature(after);
}

function signature(devices: readonly Device[]): string {
	return JSON.stringify(
		[...devices].sort((left, right) => unwrap(left.serial).localeCompare(unwrap(right.serial))),
	);
}

/**
 * Run `use` against a directory on this host that is removed however it ends.
 *
 * `../android/backend.ts`'s helper of the same name, and the `finally` is the same whole point:
 * a `clearAppData` that throws part-way would otherwise leave a copy of somebody's application
 * behind, on a host that lends the same hardware to somebody else next. Removal is `force`d so
 * cleaning up after a failure cannot itself fail and replace the real error.
 */
async function inHostTempDirectory<Result>(
	prefix: string,
	use: (directory: string) => Promise<Result>,
): Promise<Result> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	try {
		return await use(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/**
 * What this host's `stat` says a path is, in the words a refusal can be read in.
 *
 * The counterpart of `../android/parsers/stat.ts`'s `%F`, except that the answer comes from
 * `node:fs` rather than from a device's `stat(1)` — so there is no output to parse and no
 * wording that could vary by platform, and the vocabulary is this function's own.
 */
function describeShape(shape: Awaited<ReturnType<typeof stat>>): string {
	if (shape.isDirectory()) return 'a directory';
	if (shape.isCharacterDevice()) return 'a character device';
	if (shape.isBlockDevice()) return 'a block device';
	if (shape.isFIFO()) return 'a fifo';
	if (shape.isSocket()) return 'a socket';
	return 'not a regular file';
}

/**
 * `get_app_container` having succeeded without naming anything.
 *
 * Not a captured failure — the tool exits 2 when the app is not installed, and printed a path on
 * every run of the bench — so this is the guard on the one exit-0 answer the reinstall cannot be
 * built on, rather than a wording anyone has seen. Both streams are quoted because whichever of
 * them carries an explanation, this is the only place a reader would find it.
 */
function namedNoBundle(serial: DeviceSerial, appId: AppId, result: SimctlResult): Error {
	return new Error(
		`simctl get_app_container ${unwrap(appId)} app succeeded on device '${unwrap(serial)}' ` +
			'without naming a bundle, and the reinstall this clear is made of has nothing to ' +
			`reinstall from.\nstdout: ${quoteStream(result.stdout)}\nstderr: ${quoteStream(result.stderr)}`,
	);
}

/**
 * A clear whose reinstall failed after the uninstall had already gone through.
 *
 * The one window this route has, and the caller has to be told what state it was left in: the
 * tool's own `simctl install … exited 1` says nothing about the app having been removed first, so
 * a caller reading it would take the clear for a no-op and the app for installed. There is nothing
 * to retry from either — the staged copy came off the device and `inHostTempDirectory` removes it
 * — which is the part that makes this worth a sentence rather than a rethrow. The tool's message
 * rides along as the `cause` (`ai/RULES.md` §2, never degrade silently).
 */
function reinstallFailed(serial: DeviceSerial, appId: AppId, cause: unknown): Error {
	return new Error(
		`'${unwrap(appId)}' was uninstalled from device '${unwrap(serial)}' and the reinstall this ` +
			'clear is made of failed: the app is **not** installed. The bundle was staged on the ' +
			'host lending the device and has been removed with the scratch directory, so there is ' +
			'nothing here to retry from — install it again from wherever it came.',
		{ cause },
	);
}

/**
 * A push whose destination is a directory the device already has.
 *
 * The contract's own rule (`DeviceBackend.pushFile`), and it needs stating as one here for a
 * sharper reason than on the platform it was written for: `node:fs`'s `copyFile` does not copy
 * *into* a directory at all, it fails with `EISDIR`. So the caller would be told about a host
 * path and an errno instead of about the thing it got wrong (D19), and the one refusal that
 * makes both backends behave alike would be an accident of which library each happens to use.
 */
function pushedIntoDirectory(serial: DeviceSerial, devicePath: string): Error {
	return new Error(
		`'${devicePath}' is a directory on device '${unwrap(serial)}', and a push names the file ` +
			'to write, not a directory to write it into — pushing to it would put the file inside ' +
			`under a name this host chose. Name the file: '${devicePath}/<name>'`,
	);
}

/**
 * A pull whose source is not one regular file, which is `DeviceBackend.pullFile`'s rule and what
 * keeps its byte bound meaningful.
 *
 * A directory's own `size` is a few hundred bytes whatever the tree under it holds, and a
 * character device reports zero and then reads without end — so a bound taken on the reported
 * number alone would admit either. Both are named by the same refusal because the caller's fix
 * is the same: name a file.
 */
function pulledNonRegularFile(serial: DeviceSerial, devicePath: string, shape: string): Error {
	return new Error(
		`'${devicePath}' on device '${unwrap(serial)}' is ${shape}, and a pull answers with the ` +
			'bytes of one regular file — a size is not a prediction of what reading anything else ' +
			'would fetch, so there is nothing to bound the read by. Recursive directory transfer ' +
			'is deliberately not in this contract.',
	);
}

/**
 * A pull whose source is not there, or will not be read.
 *
 * A throw rather than an empty answer, which the contract requires: an empty array is
 * indistinguishable from an empty file that really is there. **No host path**, not even in the
 * cause's own words — `node:fs` puts one in every message it writes, and this one is read on the
 * agent's machine (D19), so the code is carried across and the message is not.
 */
function noSuchFile(serial: DeviceSerial, devicePath: string, cause: unknown): Error {
	return new Error(
		`'${devicePath}' on device '${unwrap(serial)}' could not be read (${errnoOf(cause)}). On ` +
			"this platform that path is a file in the device's own storage on the host lending it, " +
			'so this is the file not being there, or not being readable by the user running the host.',
		{ cause },
	);
}

/**
 * A push this host would not carry out — {@link noSuchFile}'s counterpart on the write side, and
 * one vocabulary for "this host refused" across the two transfers.
 *
 * Same rule and same reason: `node:fs` names a path in every message it writes, and on this side
 * it names *two* — the daemon's own staged payload and the device's data root — so the code is
 * carried across and the message is not (D19). Without this the caller is handed the operator's
 * home directory and this host's CoreSimulator layout by a call that only ever named
 * `/Documents/…`, which is exactly what {@link hostPathOf}'s refusal one branch away declines to
 * do.
 */
function pushFailed(serial: DeviceSerial, devicePath: string, cause: unknown): Error {
	return new Error(
		`'${devicePath}' on device '${unwrap(serial)}' could not be written (${errnoOf(cause)}). ` +
			"On this platform that path is a file in the device's own storage on the host lending " +
			'it, so this is a parent directory that could not be created — one of the names on the ' +
			'way there is a file, most often — or the file not being writable by the user running ' +
			'the host, or the bytes to push no longer being where they were staged.',
		{ cause },
	);
}

/**
 * A capture asked of a device that is not running one — the refusal `docs/IOS.md` §8 trap 1 is
 * about.
 *
 * The state and the device, because both are what a caller acts on: one names what to fix and
 * the other names where. Nothing was run, and that is said outright, because the alternative
 * reading of a failure from this method is a capture that half happened.
 *
 * The state is the **neutral** word `./devices.js` mapped the tool's own onto, not the token
 * `simctl` printed: every state but `Booted` collapses to `offline` there, and that module owns
 * the vocabulary (this file's header).
 */
function notCapturable(serial: DeviceSerial, state: DeviceState): Error {
	return new Error(
		`Device '${unwrap(serial)}' is '${state}' rather than ready, so nothing was captured and ` +
			'nothing was run. A capture on this platform does not refuse a device that is not ' +
			'booted: it blocks for a minute waiting for a screen surface that will never be drawn ' +
			'and then reports a timeout, which is a minute of a lease spent on a call that was ' +
			'never going to work.',
	);
}

/**
 * `simctl io screenshot` having exited 0 without leaving the file behind that it was told to
 * write.
 *
 * Not a captured failure — every run of the bench printed `Wrote screenshot to: …` and produced
 * the PNG — so this is the guard on an exit-0 answer this method cannot be built on rather than a
 * wording anyone has seen. **No host path**, {@link noSuchFile}'s rule for its reason: the staged
 * file is one this host invented and has already removed by the time anyone reads this, so naming
 * it would name nothing on the machine the message is read on (D19).
 */
function captureUnreadable(serial: DeviceSerial, cause: unknown): Error {
	return new Error(
		`The capture of device '${unwrap(serial)}' could not be read back (${errnoOf(cause)}). ` +
			'simctl exited 0, so it reported having written the image; the file it was told to ' +
			'write is one the host lending the device staged for the purpose and removes ' +
			'afterwards, so this is that write not having happened.',
		{ cause },
	);
}

/**
 * Bytes that are not an image, refused rather than handed to an agent as one — `isPng`'s stance
 * on the Android side, at the one point on this platform where it can be taken.
 *
 * The bytes are *described* rather than quoted, because they are megabytes and are not text
 * (`./simctl.js`, `describeBytes`). Whether the image is *blank* is deliberately not asked here:
 * this platform has no way for an app to block a capture at all, so every one came back rendered
 * (`docs/IOS.md` §8, trap 8) and what is on the screen is the caller's to interpret.
 */
function notAnImage(serial: DeviceSerial, bytes: Uint8Array): Error {
	return new Error(
		`The capture of device '${unwrap(serial)}' is not a PNG ${describeBytes(bytes)}. simctl ` +
			'exited 0 and was asked for `--type png`, so these are the bytes it wrote and not an ' +
			'image — refused here rather than answered as a screenshot.',
	);
}

/**
 * A recording asked of a device that is not booted, refused before anything is started —
 * {@link notCapturable}'s counterpart, and the *sharper* of the two.
 *
 * A capture on a device that is not booted fails loudly after a minute (`docs/IOS.md` §8 trap 1),
 * so the check in front of it buys time. A **recording** on one reports success at every step and
 * produces nothing: measured on macOS 26.6.2 / Xcode 26.6 against a `Shutdown` iPhone 17,
 * 2026-09-08, `simctl io <device> recordVideo` printed `Recording started` at **0.228 s** — the
 * marker the whole start wait is built on — ran for the twelve seconds it was left to, and on
 * `SIGINT` exited **0** with `Recording completed. Writing to disk.` and `Wrote video to: …` on
 * stdout, leaving a **zero-byte file**. Every signal the tool gives says it worked.
 *
 * So this check is not an optimisation, it is the only thing between a caller and a recording of
 * nothing, and it is why it names the state rather than merely refusing.
 */
function notRecordable(serial: DeviceSerial, state: DeviceState): Error {
	return new Error(
		`Device '${unwrap(serial)}' is '${state}' rather than ready, so no recording was started. ` +
			'A recording on this platform does not refuse a device that is not booted: it reports ' +
			'that it started, runs for as long as it is left running, reports that it finished, and ' +
			'writes a file of zero bytes. Boot the device and ask again.',
	);
}

/**
 * A screen read asked of a device that is not booted — and the **least** urgent of the three
 * refusals here, which is why its reason is stated rather than assumed from its siblings.
 *
 * `idb_companion` refuses this one properly. Measured against a `Shutdown` iPhone 17 Pro
 * (companion v1.5.2, Xcode 26.4.1, 2026-09-08), `accessibility_info` came back at gRPC
 * `INTERNAL` in **13 ms** with *"Cannot run accessibility commands against &lt;udid&gt; | iPhone
 * 17 Pro | Shutdown | … as it is not booted"* — no minute-long block like a capture
 * ({@link notCapturable}) and no false success like a recording ({@link notRecordable}). So this
 * check is not what stands between a caller and a wrong answer.
 *
 * What it stands between them and is a **process**. Reaching that refusal means starting a
 * companion for the device first — 350 ms to the handshake on that same bench — and the companion
 * *stays running*, announcing on its own stderr that it "will stay alive if target goes offline".
 * A backend that skipped the check would leave one supervised `idb_companion` per non-bootable
 * device anybody asked about, for the lifetime of the daemon, to deliver an answer one
 * enumeration already had. That enumeration is 0.11–0.24 s and it doubles as the presence check,
 * so a device that has gone is {@link DeviceVanishedError} rather than a refusal about a state
 * nobody can read.
 *
 * It says the tool would have refused too, because that is the difference between this and its
 * two siblings and a caller reading all three should not have to guess which kind this is.
 */
function notReadable(serial: DeviceSerial, state: DeviceState): Error {
	return new Error(
		`Device '${unwrap(serial)}' is '${state}' rather than ready, so its screen was not read. ` +
			'A screen read on this platform needs an accessibility connection into a running ' +
			'system: the tool refuses one against a device that is not booted, and this host ' +
			'refuses first so that no companion process is started for a device that cannot answer.',
	);
}

/**
 * An injection asked of a device that is not booted — {@link notReadable}'s twin, and it is a twin
 * rather than a copy because the tool's answer was measured separately.
 *
 * `hid` refuses this one properly too. Measured against a `Shutdown` iPhone 17 Pro (companion
 * v1.5.2, Xcode 26.4.1, 2026-09-09), a tap and a `HOME` press each came back at gRPC `INTERNAL` in
 * 214 ms and 3 ms with *"Mach port not connected, device may not be ready yet"*. So this check is
 * not what stands between a caller and a wrong answer either — what it stands between them and is
 * the same **process** {@link notReadable} describes: reaching that refusal means starting a
 * companion for the device, and the companion then stays running.
 */
function notInputtable(serial: DeviceSerial, state: DeviceState): Error {
	return new Error(
		`Device '${unwrap(serial)}' is '${state}' rather than ready, so nothing was injected into ` +
			'it. Input on this platform goes into a running system through the same companion a ' +
			'screen read uses: the tool refuses it against a device that is not booted, and this ' +
			'host refuses first so that no companion process is started for a device that cannot ' +
			'answer.',
	);
}

/**
 * A recorder that ended before it said it had started, with everything it said attached.
 *
 * The one failure the start marker turns from a ten-second wait into an immediate answer, and it
 * covers three measured cases at once rather than a wording anyone parses:
 *
 * - **exit 16, `Host recording is already in progress`** — the tool's own refusal of a second
 *   recorder, which this backend normally pre-empts with {@link RecordingAlreadyRunningError}
 *   from the process table. It is still reachable, and the message is worth passing on verbatim
 *   because on this platform it also arrives when a *previous* recorder was killed rather than
 *   interrupted: CoreSimulator then holds that device's recording lock with no process left to
 *   release it, and only shutting the device down and booting it again clears it (`docs/IOS.md`
 *   §8);
 * - **exit 17, `cannot save recorded video output into a file that already exists`** — a
 *   leftover the removal in front of the recording could not take away;
 * - **anything that never ran at all**, which the runner reports as an end for the same reason.
 *
 * Both streams are quoted because whichever of them carries the explanation, this is the only
 * place a reader would find it — and on this tool that is as often stdout as stderr
 * (`./simctl.ts`).
 *
 * **The staged path reaches none of the three**, because this message is read on the agent's
 * machine (D19) and the path is one this host derived and has already removed. The two streams
 * are masked here ({@link quoteStream}); `reason` is masked where it is built, by the
 * `redactArgv` {@link launchRecorder} hands the runner (`./simctl.ts`,
 * `StreamSimctlOptions.redactArgv`) — it carries the recorder's whole argv, and the last entry of
 * that argv *is* the path.
 */
function recorderNeverStarted(
	serial: DeviceSerial,
	reason: string,
	streams: { stdout: string; stderr: string },
	path: string,
): Error {
	return new Error(
		`No recording was started on device '${unwrap(serial)}': the recorder ${reason} before it ` +
			'reported having started, so nothing was captured.\n' +
			`stdout: ${quoteStream(streams.stdout, [path])}\n` +
			`stderr: ${quoteStream(streams.stderr, [path])}`,
	);
}

/**
 * A recording this host wrote and then could not read back.
 *
 * {@link captureUnreadable}'s counterpart and its rule about host paths (D19): the file is one
 * this backend derived from the udid and has removed by the time anyone reads this, so naming it
 * would name nothing on the machine the message is read on.
 *
 * It is deliberately **not** {@link NoRecordingRunningError}: something was recording, and a file
 * that is missing where a recorder had just been asked to write one is this host's answer rather
 * than the device's. Nothing recorded at all is decided before the read, from the process table.
 */
function recordingUnreadable(serial: DeviceSerial, cause: unknown): Error {
	return new Error(
		`The recording of device '${unwrap(serial)}' could not be read back (${errnoOf(cause)}). ` +
			'The file it was written to is one the host lending the device derived for the purpose ' +
			'and removes afterwards, so this is that write not having happened.',
		{ cause },
	);
}

/**
 * A recorder this backend started, held for as long as the call that started it needs it.
 *
 * Two members, and the split between them is D6: {@link Recorder.stream} is a way to **act** on
 * the run — the signal that finishes a recording — while whether *this device* is recording is
 * never read off it. That question goes to the machine (`IosSimulatorDeviceBackend.recorderPids`),
 * which is what sees a recorder an earlier daemon started and what survives this one restarting.
 *
 * {@link Recorder.ended} is not an exception to that. It answers "has the run this call is
 * holding finished", which is an observation of this process's own child rather than a
 * remembered fact about the device — and it is exact, because Node reports `close` after the
 * process has gone and this tool writes the whole file before it exits
 * ({@link IosSimulatorDeviceBackend.recordVideo}).
 */
interface Recorder {
	readonly stream: SimctlStream;
	/** The reason the run ended, or `null` while it is still running. */
	ended(): string | null;
}

export class IosSimulatorDeviceBackend implements DeviceBackend {
	/**
	 * {@link exclusivelyOn}'s register, keyed by the recording path.
	 *
	 * It is a queue and not a cache, which is the distinction D6 draws: nothing about a device is
	 * remembered here, only whether a call is still holding its recording file. A path appears
	 * while one is in flight and is dropped again straight afterwards. Where
	 * `AndroidDeviceBackend` also holds an OS-version cache, this class has nothing to gain by
	 * one — that backend pays a query per device for a version, while here it is a field of the
	 * same listing the enumeration already read.
	 */
	private readonly recordingUse = new Map<string, Promise<void>>();

	/**
	 * The `idb_companion` processes this host is running, one per target — the transport
	 * {@link readScreen} goes through.
	 *
	 * Held for this backend's lifetime, which is what makes the channel worth having: the second
	 * read of a lease pays a gRPC call rather than a spawn (`./idb-client.js`). It is **not** a
	 * cache of anything about a device and so is not the exception to D6 the field above is
	 * careful about — a companion is a way to *reach* a simulator, and every fact this backend
	 * reports is still read again per call, from `simctl`.
	 *
	 * Nothing in it runs on its own: no timer, no health check, no eager respawn. A companion is
	 * started by a read and a companion that died is forgotten by one, so nothing here reaches a
	 * device outside the lease that asked.
	 */
	private readonly companions = new IdbCompanions();

	/**
	 * One `simctl list -j devices runtimes`, mapped onto the neutral vocabulary and narrowed to
	 * the simulators this host will lend right now (D41, `./devices.js`'s `borrowableNow`).
	 *
	 * **The narrowing is what makes this an inventory rather than a catalogue** (#267). `simctl`
	 * lists every simulator ever created on the machine, which answers *what could this host
	 * run*; `listDevices` answers *what can be borrowed now*, which is the question `adb devices`
	 * answers for the other half of the same list. Without it a Mac reports one usable simulator
	 * and ten rows nobody can act on.
	 *
	 * Nothing about the device set is held between calls, which is D6 one level down: every
	 * answer here is this listing, read again.
	 */
	async listDevices(): Promise<Device[]> {
		return borrowableNow(await this.enumerate());
	}

	/**
	 * One enumeration, filtered — D6's "the daemon is a cache, the platform is the truth"
	 * re-verification in its cheapest form, and the whole of what lifecycle means after D21.
	 * `null` rather than a throw: a device that is no longer there is a lookup miss
	 * (ai/CODING_STANDARDS.md "Error handling").
	 *
	 * **The one enumeration this backend does not narrow, and the reason is the question being
	 * asked** (#267). {@link listDevices} answers "what is there to borrow", where a simulator
	 * that is not running is nothing to borrow; this answers "what is *this* device", asked by a
	 * caller who already has one in mind — and the honest answer for a simulator somebody shut
	 * down is that it is `offline`, which is what the refusals naming a state are made of and what
	 * a lease grant then reports (`../../daemon/lease-handlers.js`). A `null` here is what it has
	 * always been: no such device on this host at all.
	 */
	async describeDevice(serial: DeviceSerial): Promise<Device | null> {
		const devices = await this.enumerate();
		return devices.find((device) => device.serial === serial) ?? null;
	}

	/**
	 * Every simulator this host has, whatever state it is in — the reading both enumerations
	 * above are made of, and the only place their one `simctl` invocation is spelled out.
	 */
	private async enumerate(): Promise<Device[]> {
		const result = await runSimctl([...ENUMERATE_ARGV]);
		const { devices, runtimes } = parseListings(ENUMERATE_ARGV, result, false);

		return toDevices(devices, runtimes);
	}

	/**
	 * Watch the device set, delivering the **full** current set on subscription and whenever it
	 * differs from the last set delivered — off `idb_companion --notify` where this host has a
	 * companion, and off the `simctl list` poll where it does not.
	 *
	 * **Two sources behind one contract, and only one of them delivers at a time.** The stream is
	 * preferred because it *is* the contract: the companion emits the whole target set on every
	 * change, with no polling anywhere (`docs/IOS.md` §7). The poll is the fallback rather than
	 * the design, which is what keeps a host with no idb watching the devices it has — and the
	 * two agree device for device, including on the `osVersion` spelling, because `./devices.js`
	 * normalises the notify path onto `simctl`'s rather than publishing two.
	 *
	 * **"The set" is {@link listDevices}' set — the booted simulators** (#267, D41), on both
	 * sources and for the same reason they agree about everything else. So a state change the
	 * narrowing collapses delivers nothing: `Shutdown → Booting` is two frames from the companion
	 * and one unchanged set here, which is the delivery rule this method already had rather than a
	 * dropped event. What a caller sees is a simulator arriving when it is up and leaving when it
	 * is not, never a row it can do nothing with.
	 *
	 * Synchronous and never rejecting, as the contract requires: whether either source can be
	 * established is reported through the listener, never as a rejection nothing is written to
	 * catch. {@link streamIdbCompanion} throwing `IdbCompanionNotFoundError` from the subscription
	 * itself is caught here for exactly that reason, and it is why that runner throws rather than
	 * reporting an end — it is the one failure worth naming a program in.
	 *
	 * **A lost view is one `onInterrupted`, never an empty set.** An empty set reads as every
	 * device having gone away, which for an inventory means releasing devices that never moved
	 * (`src/core/device.ts`), so only a decoded frame and a successful poll ever produce
	 * `onDevices`. The cause is {@link IDB_COMPANION_MISSING} when there is no companion to run
	 * and {@link SIMCTL_MISSING} when there is no `simctl`, the two ends that will not clear on
	 * their own (#168); everything else is `null`, which is the claim "this is expected to
	 * clear".
	 *
	 * **The view is whichever source is serving the caller, so the fallback is one interruption
	 * and not one per attempt.** Losing the stream interrupts once and hands over to the poll; a
	 * later attempt that fails again while the poll is delivering changes nothing the caller can
	 * observe and is silent. Retried on a backoff either way, so a companion installed on a
	 * running host is picked up without a restart — **a `setTimeout` whose callback does the next
	 * attempt, never a sleep** (ai/RULES.md §2, D12(b)), reset by a frame because a frame is the
	 * only evidence the view is healthy again.
	 *
	 * **An interruption clears what the caller was last told**, so the next delivery from either
	 * source is unconditional even when the set is unchanged. Suppressing it as "no change" would
	 * leave the caller holding a set it has been told is no longer known to be current, with
	 * nothing to lift that until a device happens to move. A *handover* is not an interruption,
	 * though — nothing was lost — so the stream coming back is silent when it agrees with the
	 * last set the poll delivered.
	 *
	 * `stop()` silences every handler **synchronously**, before its promise resolves, so no
	 * listener method can be called after it. It kills whichever companion is live, clears
	 * whichever timer is pending, and leaves a poll already in flight to finish and have its
	 * answer dropped — `runSimctl` hands back no process handle, and a `simctl list` that is
	 * already running costs a fifth of a second and touches no device state.
	 */
	watchDevices(watcher: DeviceWatcher): DeviceWatch {
		let stopped = false;
		// The last set handed to the caller, and `null` whenever the caller has nothing it can
		// still believe: before the first delivery, and after every interruption.
		let delivered: Device[] | null = null;

		/** The poll's own re-armed gap, and the stream's restart. Never both pending at once. */
		let next: NodeJS.Timeout | null = null;
		let restart: NodeJS.Timeout | null = null;
		/** The live companion, or `null` while none is running. */
		let companion: IdbCompanionStream | null = null;
		let backoffMs = NOTIFY_RESTART_MIN_DELAY_MS;
		/** Whether the poll is the source serving the caller — see the note on the handover. */
		let polling = false;

		/** One delivery rule for both sources, so they cannot come to disagree about a change. */
		const deliver = (devices: Device[]): void => {
			if (stopped) return;
			if (delivered === null || !sameDeviceSet(delivered, devices)) {
				delivered = devices;
				watcher.onDevices(devices);
			}
		};

		const interrupted = (reason: string, cause: InterruptionCause | null): void => {
			if (stopped) return;
			delivered = null;
			watcher.onInterrupted(reason, cause);
		};

		const schedulePoll = (): void => {
			if (stopped || !polling) return;
			next = setTimeout(() => {
				next = null;
				void poll();
			}, WATCH_POLL_INTERVAL_MS);
		};

		const poll = async (): Promise<void> => {
			let devices: Device[];
			try {
				devices = await this.listDevices();
			} catch (error) {
				// `!polling` as well as `stopped`: an answer from the poll that the stream has
				// already taken over from is dropped, because only one source delivers at a time.
				if (stopped || !polling) return;
				interrupted(message(error), error instanceof SimctlNotFoundError ? SIMCTL_MISSING : null);
				schedulePoll();
				return;
			}

			if (stopped || !polling) return;
			deliver(devices);
			schedulePoll();
		};

		const startPolling = (): void => {
			if (stopped || polling) return;
			polling = true;
			void poll();
		};

		const stopPolling = (): void => {
			polling = false;
			if (next !== null) {
				clearTimeout(next);
				next = null;
			}
		};

		const scheduleNotifyRestart = (): void => {
			const delayMs = backoffMs;
			backoffMs = Math.min(backoffMs * 2, NOTIFY_RESTART_MAX_DELAY_MS);
			restart = setTimeout(() => {
				restart = null;
				if (!stopped) startNotify();
			}, delayMs);
		};

		const startNotify = (): void => {
			const decoder = new IdbNotifyFrameDecoder();
			// Per attempt, so a chunk arriving from the companion that just ended cannot end the
			// one that replaced it.
			let over = false;
			let stderrTail = '';
			let handle: IdbCompanionStream | null = null;

			const end = (reason: string, cause: InterruptionCause | null): void => {
				if (over || stopped) return;
				over = true;
				companion = null;
				// A framing failure ends a companion that is still running; an `onEnd` ends one
				// that already stopped, where this resolves at once. Not awaited: the caller of
				// this path is a stdout handler, and the restart is scheduled either way.
				void handle?.stop();
				if (!polling) {
					interrupted(reason, cause);
					startPolling();
				}
				scheduleNotifyRestart();
			};

			try {
				handle = streamIdbCompanion([...IDB_NOTIFY_ARGV], {
					onStdout(chunk) {
						if (over || stopped) return;

						let frames: IdbTargetList[];
						try {
							frames = decoder.push(chunk);
						} catch (cause) {
							// Terminal for this run: framing that has lost sync cannot be
							// resynchronised, so the answer is one interruption and a restart
							// rather than a device set sliced at a guessed offset
							// (`./parsers/idb-notify.js`). Reported, never thrown — there is
							// nothing above a stdout handler to catch it.
							end(message(cause), null);
							return;
						}
						if (frames.length === 0) return;

						// A frame is the only evidence the view is healthy again, so it is what
						// resets the backoff and what takes the watch back off the poll — a
						// companion that starts and dies in a loop keeps backing off, and the
						// poll goes on delivering meanwhile.
						backoffMs = NOTIFY_RESTART_MIN_DELAY_MS;
						stopPolling();

						// Narrowed exactly as `listDevices` is, and by the same function: the watch
						// and the enumeration answer one question, so a simulator that is not
						// booted has to be absent from both or the poll and the stream would
						// disagree about what this host has (#267, `./devices.js`).
						for (const targets of frames) deliver(borrowableNow(toNotifiedDevices(targets)));
					},
					onStderr(chunk) {
						stderrTail = `${stderrTail}${chunk}`.slice(-IDB_COMPANION_STDERR_TAIL_CHARS);
					},
					onEnd(reason) {
						// The tail is quoted here rather than by the runner, which hands over every
						// byte and quotes nothing back (`./idb-companion.js`).
						end(`${reason}\nstderr: ${quoteStream(stderrTail)}`, null);
					},
				});
			} catch (cause) {
				// There is no companion on this host — the one end worth naming a program in, and
				// the reason that runner throws instead of reporting an end. It keeps being
				// retried anyway: an `idb_companion` unpacked onto a running host is exactly what
				// the backoff exists to pick up (`./idb-companion-path.js`, unmemoised).
				end(
					message(cause),
					cause instanceof IdbCompanionNotFoundError ? IDB_COMPANION_MISSING : null,
				);
				return;
			}

			// Assigned after the spawn, so a companion that ended inside it — `end` having already
			// stopped and forgotten this handle — cannot be revived here.
			if (!over) companion = handle;
		};

		startNotify();

		return {
			async stop(): Promise<void> {
				stopped = true;
				stopPolling();
				if (restart !== null) {
					clearTimeout(restart);
					restart = null;
				}
				const handle = companion;
				companion = null;
				await handle?.stop();
			},
		};
	}

	/**
	 * One invocation, then the device's own device-type profile read off disk.
	 *
	 * The screen comes from **the device type this simulator was created from**, never from a
	 * captured image (`docs/IOS.md` §8, trap 6): the profile states the scale, so nothing here
	 * derives one from a screenshot's width — an error that reads as a pile of small
	 * imperfections rather than as arithmetic, and that cost a day on the Android side. It is
	 * also what keeps `density` a dpi and `densityScale` a ratio, the two idb conflates.
	 *
	 * The join is `deviceTypeIdentifier` onto the `devicetypes` listing, whose `bundlePath` is
	 * taken from the tool rather than assembled: those bundles are not under `DEVELOPER_DIR`
	 * (`./screen.js`). Three failures throw, each naming what was missing, because the
	 * alternative is a plausible-looking screen — a device the enumeration does not name
	 * ({@link DeviceVanishedError}, the contract's own distinction from
	 * {@link describeDevice}'s `null`), a device type the listing does not resolve, and a profile
	 * that will not read or decode.
	 *
	 * **`model` is the device's own `name`, not the device type's.** The type's `name`
	 * (`iPhone 17 Pro`) and `modelIdentifier` (`iPhone18,1`) are the first hardware model
	 * available anywhere in this backend, and they are deliberately not reported here:
	 * `DeviceInfo.model` is the same field as `Device.model` under the same name — the shape is
	 * self-contained rather than a delta on an enumeration (`src/core/device.ts`) — and a
	 * simulator's `name` is operator-chosen, so reporting the hardware model here would make
	 * `list_devices` and `device_info` disagree about what one device is called. When a field for
	 * a hardware model exists, `modelIdentifier` is what goes in it.
	 *
	 * **The geometry is the device type's native one**, which is portrait on every type measured.
	 * Orientation is not a fact `simctl` reports and this backend has no verb that rotates
	 * anything, so a simulator somebody turned by hand is described by the screen its hardware
	 * has rather than by the one it is currently drawing.
	 */
	async deviceInfo(serial: DeviceSerial): Promise<DeviceInfo> {
		const result = await runSimctl([...DEVICE_FACTS_ARGV]);
		const { devices, runtimes, deviceTypes } = parseListings(DEVICE_FACTS_ARGV, result, true);

		const device = toDevices(devices, runtimes).find((candidate) => candidate.serial === serial);
		const entry = findEntry(devices, serial);
		if (device === undefined || entry === null) throw new DeviceVanishedError(serial);

		const profile = await readProfileOf(serial, entry, deviceTypes);

		return DeviceInfoSchema.parse({
			serial: unwrap(serial),
			platform: IOS_SIMULATOR_PLATFORM_ID,
			model: device.model,
			screen: toScreenInfo(profile),
			osVersion: device.osVersion,
			// Read off the enumeration rather than written as `null` here, so the two shapes cannot
			// come to disagree about a platform that has no API level (`./devices.js`).
			osApiLevel: device.osApiLevel,
		});
	}

	/**
	 * `simctl install <device> <packagePath>`, with `packagePath` read on the **host** (D19).
	 *
	 * **No staging, and that is measured rather than assumed** — the one place this diverges
	 * from `../android/backend.ts`, whose `withInstallablePackage` exists because `adb install`
	 * checks the *file name* and refuses anything not ending `.apk` or `.apex`. `simctl` looks
	 * at the contents instead: on macOS 26.6.2 (25G83) / Xcode 26.4.1 (17E202), 2026-09-08, the
	 * same zipped bundle installed at exit 0 as `payload`, as `payload.zip` and as `Rover.ipa`,
	 * which is exactly what the layer above hands down — the daemon writes a caller's bytes to a
	 * file it names `payload`, because a package format belongs to one platform and that layer
	 * names none (`src/daemon/verb-handlers.ts`). The name does matter for the other shape a
	 * package can arrive as, an unzipped `.app` **directory**: one copied to a name without the
	 * suffix was refused with *"The item being installed did not contain any installable apps"*.
	 * No staging fixes that — a directory arrives from a project hook's build output, which is
	 * named `.app` by the toolchain that produced it.
	 *
	 * It carries {@link INSTALL_SIMCTL_TIMEOUT_MS} rather than the default, and the host path is
	 * masked out of the failure message: `simctl` writes that path back out itself, `lstat of
	 * <path> failed: No such file or directory` on a package that is not there (same bench), and
	 * the message is read on a machine where the daemon's temporary file names nothing (D19).
	 *
	 * Nothing checks the wording of an exit-0 failure here, and that is stated rather than left
	 * to be found: no such failure has been captured from this subcommand, and a wording written
	 * from memory is what `./parsers/` and its fixtures exist to prevent (`./parsers/app-control.js`).
	 */
	async installApp(serial: DeviceSerial, packagePath: string): Promise<void> {
		await runSimctlOnDevice(serial, 'install', [packagePath], {
			timeoutMs: INSTALL_SIMCTL_TIMEOUT_MS,
			redactArgv: [packagePath],
		});
	}

	/**
	 * `simctl launch <device> <appId>`.
	 *
	 * One call, where `../android/backend.ts` needs two: there is no component to resolve,
	 * because a bundle identifier is what this platform launches by. `parseAppId` has already
	 * branded the value and nothing here reaches a shell (this file's header), so it is passed
	 * as the argv entry it is.
	 *
	 * The exit code is the whole of the check, and unusually for this repository that is enough:
	 * every launch failure measured on the bench exits non-zero and `./simctl.js` throws on it —
	 * **4** with `Simulator device failed to launch com.rover.nope.` for an app that is not
	 * installed, **149** with `Unable to lookup in current state: Shutdown` for a device that is
	 * not booted. A successful launch prints `<appId>: <pid>` on stdout; the pid is not read,
	 * because the contract answers `void` and a process that exited a moment later would make it
	 * a lie.
	 */
	async launchApp(serial: DeviceSerial, appId: AppId): Promise<void> {
		await runSimctlOnDevice(serial, 'launch', [unwrap(appId)]);
	}

	/**
	 * `simctl terminate <device> <appId>`, with **"it was not running" counted as done**.
	 *
	 * That case is a failure as far as the tool is concerned — exit 3, `found nothing to
	 * terminate` — and it is decided here from the **wording** rather than from the number,
	 * because the number means nothing on this tool (`./simctl.js`) and because the same
	 * sentence would have to keep meaning the same thing if it ever exited something else.
	 * `./parsers/app-control.js` owns the predicate, the fixture it is pinned against and the
	 * argument for treating it as a success.
	 *
	 * Every other terminate failure is still a failure and still throws, which is what the
	 * `Shutdown` capture beside it pins.
	 */
	async stopApp(serial: DeviceSerial, appId: AppId): Promise<void> {
		try {
			await runSimctlOnDevice(serial, 'terminate', [unwrap(appId)]);
		} catch (error) {
			if (error instanceof SimctlCommandError && saysNothingToTerminate(error.stderr)) return;
			throw error;
		}
	}

	/**
	 * Uninstall the app and install the same bundle back — **this platform has no `pm clear`**.
	 *
	 * The honest version of that, rather than a plausible-looking one. `docs/IOS.md` §2 records
	 * all three routes and does not need re-deriving: this one works and costs **0.79 s** there,
	 * **0.52 s** on this repository's own bench (macOS 26.6.2 / Xcode 26.4.1, 2026-09-08);
	 * emptying the container's contents host-side also works and keeps the binary installed; and
	 * `simctl install_app_data` with an empty `.xcappdata`, the route Apple documents for this,
	 * **could not be made to work** across three plist spellings.
	 *
	 * **The bundle to reinstall is resolved from the device, and then copied off it before
	 * anything is uninstalled.** `simctl get_app_container <device> <appId> app` names it, and on
	 * the bench that path is `<dataPath>/Containers/Bundle/Application/<uuid>/<Name>.app` —
	 * *inside the very storage the uninstall removes*, which was verified by doing it: after the
	 * uninstall the path the tool had just printed no longer exists. So the copy is not an
	 * optimisation, it is the only ordering that leaves an application installed at the end. It
	 * keeps the bundle's own basename, because `simctl install` refuses a directory not named
	 * `.app` ({@link installApp}).
	 *
	 * An app that is not installed fails at the first call — exit 2, `No such file or directory`
	 * — and nothing has been touched by then, which is the right shape for that answer: it is
	 * the same refusal `pm clear` gives for a package that does not exist.
	 *
	 * **Between the uninstall and the install the app is not on the device, and a failed reinstall
	 * leaves it that way.** That window is inherent to this route rather than a choice — the two
	 * others `docs/IOS.md` §2 records do not work — and the only copy of the bundle by then is the
	 * staged one on this host, which the `finally` removes, so there is nothing to retry from. The
	 * failure the caller reads therefore names that outcome ({@link reinstallFailed}) instead of
	 * a bare `simctl install … exited 1`, which reads as though nothing had happened.
	 *
	 * **What this cannot preserve is the app's identity to the rest of the device.** A reinstall
	 * gets a fresh data container UUID, and anything holding the old one — a keychain entry
	 * scoped to it, another app's bookmark — is looking at a container that is gone. Emptying the
	 * container in place would keep it; it would also leave whatever the caller's app wrote
	 * outside `Documents`, `Library` and `tmp`, which is the half `pm clear` does remove.
	 */
	async clearAppData(serial: DeviceSerial, appId: AppId): Promise<void> {
		const installed = await runSimctlOnDevice(serial, 'get_app_container', [
			unwrap(appId),
			APP_CONTAINER,
		]);
		const bundle = installed.stdout.trim();
		// Exit 0 with nothing to say is not a case captured from this subcommand, and it is caught
		// rather than trusted because of what the next two lines would do with it: an empty path
		// makes `basename` empty, which makes the staged copy the scratch directory itself, and the
		// uninstall would then run with nothing staged behind it.
		if (bundle.length === 0) throw namedNoBundle(serial, appId, installed);

		await inHostTempDirectory(CLEAR_PREFIX, async (directory) => {
			// Named after the bundle rather than by this host, so the reinstall is handed the
			// suffix `simctl install` insists on for a directory.
			const staged = join(directory, basename(bundle));
			await cp(bundle, staged, { recursive: true });

			await runSimctlOnDevice(serial, 'uninstall', [unwrap(appId)]);
			// From here the app is off the device, so a failure has to say so rather than read as
			// though nothing happened ({@link reinstallFailed}).
			await runSimctlOnDevice(serial, 'install', [staged], {
				timeoutMs: INSTALL_SIMCTL_TIMEOUT_MS,
				redactArgv: [staged],
			}).catch((cause: unknown) => {
				throw reinstallFailed(serial, appId, cause);
			});
		});
	}

	/**
	 * `simctl io <device> screenshot --type png --mask ignored <path>` — the device's own PNG, as
	 * **bytes** (D19).
	 *
	 * **The device's state is checked first, and the capture is bounded regardless.** Both halves
	 * are needed and neither is the other's substitute (`docs/IOS.md` §8, trap 1): against a
	 * device that is not booted this command blocks for **60.68 s** and then fails with *"Timeout
	 * waiting for screen surfaces"* (macOS 26.6.2 / Xcode 26.4.1, 2026-09-08), so the check is
	 * what turns a minute of a lease into an immediate refusal — and the state can change between
	 * the two calls, so {@link SCREENSHOT_SIMCTL_TIMEOUT_MS} is what bounds the race the check
	 * cannot close. The check is one enumeration, 0.11–0.24 s on that bench beside the capture's
	 * own 0.22–0.29 s; it is `describeDevice`, so a device that has gone is
	 * {@link DeviceVanishedError} rather than a refusal about a state nobody can read.
	 *
	 * **The PNG comes back through a file this backend stages and removes** — {@link
	 * SCREENSHOT_ARGV} carries why stdout is not available on this platform, and
	 * {@link inHostTempDirectory}'s `finally` is what keeps a capture of somebody's screen from
	 * being left on a host that lends the same device to somebody else next. The staged path is
	 * masked out of any failure message for `installApp`'s reason, and this call needs it more
	 * plainly than that one: the tool writes the path back out **on the success path**, `Wrote
	 * screenshot to: <path>` on stderr with stdout empty (same bench), so it is in the streams a
	 * failure here would quote as well as in the argv — and the message is read on the agent's
	 * machine, where a path this host has already removed names nothing (D19).
	 *
	 * **The bytes are checked to be a PNG before they are handed over** ({@link notAnImage}), and
	 * answered as bytes rather than as a path, which is D19 and the same rule the transfers
	 * follow. Whether the screen was *blank* is not asked — see that refusal's own note.
	 */
	async screenshot(serial: DeviceSerial): Promise<Uint8Array> {
		const device = await this.describeDevice(serial);
		if (device === null) throw new DeviceVanishedError(serial);
		if (device.state !== 'ready') throw notCapturable(serial, device.state);

		return inHostTempDirectory(SCREENSHOT_PREFIX, async (directory) => {
			// Absolute rather than relative: the tool resolves the destination against a directory
			// this process does not choose, and a relative one fails (SCREENSHOT_ARGV above).
			const staged = join(directory, SCREENSHOT_FILE);
			await runSimctlOnDevice(serial, 'io', [...SCREENSHOT_ARGV, staged], {
				timeoutMs: SCREENSHOT_SIMCTL_TIMEOUT_MS,
				redactArgv: [staged],
			});

			const bytes = await readFile(staged).catch((cause: unknown) => {
				throw captureUnreadable(serial, cause);
			});
			if (!isPng(bytes)) throw notAnImage(serial, bytes);

			return bytes;
		});
	}

	/**
	 * `simctl spawn <device> log show --style ndjson --info --debug --last <window>` — the
	 * device's own log, bounded, at the narrowest width that fills the caller's cap.
	 *
	 * **The bound is pushed down into the query**, which is the whole difference between this and
	 * a read that filters afterwards: {@link LOG_WINDOWS} carries the measurements and the argument
	 * for a window, and {@link readLogsArgv} carries what each flag is load-bearing for. The
	 * two things worth reading here rather than there are that `spawn` is *itself* half the
	 * pushdown — the query runs inside the simulator, so the answer is the device's log and not
	 * this Mac's — and that the read carries {@link READ_LOGS_SIMCTL_MAX_BUFFER_BYTES}, because a
	 * window bounds a duration and not a size.
	 *
	 * **The window widens until the cap binds, and that is what makes `truncated` mean what the
	 * contract says it means.** `log show` has no count bound at all — its own options are the
	 * window and a predicate (`log show --help`, Xcode 26.4.1) — so there is nothing to ask one
	 * more than the cap *of*, the way `../android/backend.ts` asks `logcat -t` for `maxEntries + 1`.
	 * Widening is this side's substitute for that `+ 1`: while the device said no more than the
	 * cap, the next width is tried, so a read that comes back full is full because the *cap* cut
	 * it and not because the lookback ran out. A single `30s` window could not do that at the
	 * contract's own ceiling of 5,000 entries, which is the measurement {@link LOG_WINDOWS}
	 * carries.
	 *
	 * **`maxEntries` is applied on this side, and the newest are the ones kept**, because a log
	 * read is asked *after* something happened.
	 *
	 * **A wider width that outgrew the buffer ends the widening rather than failing the read.**
	 * `SimctlCommandError.overflowedBuffer` is how that is told from an ordinary failure, and the
	 * narrower width's answer is what stands — sliced to the cap and flagged `truncated: true`,
	 * because a read too large for 64 MB is proof the device said far more than 5,000 entries.
	 * An overflow at the *narrowest* width throws instead: nothing came back to keep, and the
	 * partial buffer is the *oldest* bytes of the window rather than the newest, so it is not an
	 * answer to this call. {@link LOG_WINDOWS} carries the measurement and what would fix it.
	 *
	 * **What the widest window did not fetch, it does not report.** A `truncated: false` off the
	 * last width means the device said this much in the last of {@link LOG_WINDOWS}, not that its
	 * store holds nothing older — which is the same thing the Android side says when the ring
	 * buffer holds less than the cap. Reaching past that horizon is a bound the caller has no way
	 * to ask for, and giving it one is a contract change (`ReadLogsOptions`, `src/core/device.js`)
	 * rather than something to improvise here.
	 *
	 * **No state check, unlike {@link screenshot}, and that is measured too**: `log show` on a
	 * device that is not booted fails in **0.15 s** at exit 149 with *"Process spawn via launchd
	 * failed because device is not booted"* (same bench). There is nothing to pre-empt — the tool
	 * refuses loudly and immediately, so a check would be a second enumeration bought for
	 * nothing. It also means the escalation cannot turn one refusal into three: the first width
	 * throws.
	 *
	 * The default ten-second timeout bounds each width on its own: a read cost **0.9–1.8 s**
	 * across all three, and what it spends is `spawn`'s own start-up rather than the window — a
	 * one-second window cost 1.39 s and a five-minute one 1.75 s.
	 *
	 * `runSimctlOnDevice`, never `runSimctl`: an unpinned read is somebody else's device, and a
	 * log from the wrong device is worse than no log, since nothing about it looks wrong.
	 */
	async readLogs(serial: DeviceSerial, options: ReadLogsOptions): Promise<LogRead> {
		let entries: LogRead['entries'] = [];
		let answered = false;

		for (const window of LOG_WINDOWS) {
			let result: SimctlResult;
			try {
				result = await runSimctlOnDevice(serial, 'spawn', readLogsArgv(window), {
					maxBufferBytes: READ_LOGS_SIMCTL_MAX_BUFFER_BYTES,
				});
			} catch (cause) {
				// A width that outgrew the buffer says the device had far more to say than the cap,
				// which is the one thing the widening was asking. So it ends the escalation instead
				// of failing the read — but only once some width has answered: the narrowest has
				// nothing to fall back on, and every other failure is a failure (`LOG_WINDOWS`).
				if (!answered || !(cause instanceof SimctlCommandError) || !cause.overflowedBuffer) {
					throw cause;
				}
				return { entries: entries.slice(-options.maxEntries), truncated: true };
			}

			entries = parseUnifiedLog(result.stdout);
			answered = true;
			if (entries.length > options.maxEntries) {
				return { entries: entries.slice(-options.maxEntries), truncated: true };
			}
		}

		return { entries, truncated: false };
	}

	/**
	 * Copy the file at `hostPath` to where `devicePath` names on the device — **a host-to-host
	 * copy, because a simulator's storage is a host path**.
	 *
	 * No device protocol is involved and none is available: `./containers.js` carries why, and
	 * the short version is that `idb file push` crashes its companion, `simctl` has no generic
	 * transfer subcommand, and `simctl spawn`'s filesystem view is this Mac's rather than the
	 * device's. So the whole of the transfer is {@link hostPathOf} plus `copyFile`, and the whole
	 * of the risk is in the first of those — an unconfined join here is a remote write anywhere
	 * this host's user can write, which is why the resolution refuses a `..` that leaves the
	 * device's data root before this method has looked at anything.
	 *
	 * **A destination that is already a directory is refused**, which is the contract's own rule
	 * ({@link pushedIntoDirectory}). Nothing else about the destination is second-guessed: an
	 * existing file is overwritten, which is what the caller asked for.
	 *
	 * **Missing parent directories are created.** A container the app has not written to yet has
	 * no `Documents/reports/`, and there is no verb in this vocabulary that would make one — so
	 * without this a perfectly reasonable push fails with an errno about a path on a machine the
	 * caller cannot see. What is created stays inside the data root, because the destination
	 * already had to.
	 *
	 * **Whether those parents can be created, and whether the copy lands, are host answers whose
	 * wording does not cross the boundary** — the same rule {@link pullFile}'s probe follows. Both
	 * calls name host paths in every message `node:fs` writes, and here they name two of them: the
	 * daemon's staged payload and the device's data root. So both are caught and re-issued as
	 * {@link pushFailed}, carrying the errno and the caller's own `devicePath` (D19).
	 */
	async pushFile(serial: DeviceSerial, hostPath: string, devicePath: string): Promise<void> {
		const target = hostPathOf(serial, await this.dataRootOf(serial), devicePath);

		// `null` when there is nothing there, which is the *ordinary* case for a push — the file
		// about to be created. Only the one shape the contract refuses is read off the answer.
		const existing = await stat(target).catch(() => null);
		if (existing?.isDirectory() === true) throw pushedIntoDirectory(serial, devicePath);

		await mkdir(dirname(target), { recursive: true }).catch((cause: unknown) => {
			throw pushFailed(serial, devicePath, cause);
		});
		await copyFile(hostPath, target).catch((cause: unknown) => {
			throw pushFailed(serial, devicePath, cause);
		});
	}

	/**
	 * The bytes of a file in the device's own storage — {@link pushFile}'s mirror, and the same
	 * resolution and confinement before anything is read.
	 *
	 * **Bytes, never a path** (D19), and every refusal is issued before the read:
	 *
	 * - the probe is `node:fs`'s own `stat` **on this host**, so unlike the Android side it
	 *   cannot answer "the probe would not say". There is no device wording to be defeated by
	 *   and no second process between the question and the answer: a `stat` that fails means the
	 *   file is not there or cannot be read, and that is a throw rather than a `null`
	 *   ({@link noSuchFile}).
	 * - anything the probe does not call a **regular file** is refused, which is the contract's
	 *   rule and what keeps the bound below meaningful ({@link pulledNonRegularFile}).
	 * - `options.maxBytes` is checked against the size the probe reported, **before** the file is
	 *   read into the daemon's heap. The daemon holds every lease on this machine (D6, D17), so
	 *   an allocation a peer chose is not one tenant's mistake.
	 *
	 * The bound is asked again of what was actually read, and that second question is not the
	 * first one's spare: a file that grew between the `stat` and the `readFile` would otherwise
	 * be answered whole. It is a weaker check than the Android side's second one — the allocation
	 * has already happened by the time it fires — and it is here because refusing is still better
	 * than handing a caller more than it said it could take.
	 */
	async pullFile(
		serial: DeviceSerial,
		devicePath: string,
		options: PullFileOptions,
	): Promise<Uint8Array> {
		const source = hostPathOf(serial, await this.dataRootOf(serial), devicePath);

		const shape = await stat(source).catch((cause: unknown) => {
			throw noSuchFile(serial, devicePath, cause);
		});
		if (!shape.isFile()) throw pulledNonRegularFile(serial, devicePath, describeShape(shape));
		if (shape.size > options.maxBytes) {
			throw new FileTooLargeError(serial, devicePath, shape.size, options.maxBytes);
		}

		const bytes = await readFile(source).catch((cause: unknown) => {
			throw noSuchFile(serial, devicePath, cause);
		});
		if (bytes.byteLength > options.maxBytes) {
			throw new FileTooLargeError(serial, devicePath, bytes.byteLength, options.maxBytes);
		}

		return bytes;
	}

	/**
	 * The screen, semantically — idb's accessibility read, mapped onto `ScreenElement[]`.
	 *
	 * Three steps and no arithmetic: the state check every device-touching method here makes, one
	 * `accessibility_info` through the supervised companion, then the mapping. Each of the three
	 * is somebody else's — {@link notReadable}, `./idb-client.js`, `./screen.js` — and what is
	 * worth reading here is the four things this method is *not* doing.
	 *
	 * - **It converts no coordinates.** The frames come back in points, which is the same space
	 *   `deviceInfo().screen.widthDp`/`heightDp` are in, so `toScreenElements` divides by nothing.
	 *   That absence is a stated decision rather than a missing line, and it is stated there
	 *   because that is where a reader looking for the division `../android/screen.ts` performs
	 *   will look.
	 * - **It reads the screen, not an app.** The read has no application argument and cannot be
	 *   scoped to one: what comes back is whatever is frontmost, system UI included — a read taken
	 *   while Springboard was in front listed every icon on the home screen (`docs/IOS.md` §2).
	 *   So `readScreen` immediately after `launchApp` can answer with the *previous* app's tree if
	 *   the launch has not finished coming to the front, which is D12(c)'s "every action returns
	 *   the state after itself" being unavailable on this platform for launches, and is why the
	 *   verb layer's waits are on conditions rather than on a call having returned.
	 * - **It filters nothing and sorts nothing.** Every node the tool listed, in its order,
	 *   including the ones carrying neither a label nor a value.
	 * - **It takes no lock.** Nothing about a read is exclusive: two overlapping reads of one
	 *   device share the companion and its channel, which is what {@link exclusivelyOn}'s
	 *   counterpart on the recording path exists for and this one does not need.
	 *
	 * **The companion is started by this call if there is none, and outlives it.** That is
	 * `./idb-client.js`'s whole shape — the second read of a lease pays the channel rather than a
	 * spawn — and the cost it moves onto the first one is measured: on this bench a companion
	 * starts in 350–423 ms and the **first** accessibility read of its life then takes **3.34 s**,
	 * because that read is what loads the simulator's `AccessibilityPlatformTranslation`. Every
	 * later read on the same companion came back in **34–47 ms** (companion v1.5.2, Xcode 26.4.1 /
	 * iOS 26.4.1, 2026-09-08). Both are inside {@link IDB_CALL_TIMEOUT_MS} by two orders of
	 * magnitude, and the first-read cost is worth stating because it is the one number a caller
	 * would otherwise mistake for a hang.
	 *
	 * **The bound a caller meets first is not that one, though — it is `wait_for`'s.** `wait_for`
	 * polls this method (`src/verbs/wait-for.ts` requires `canReadScreen`, which this platform now
	 * declares), and its `DEFAULT_WAIT_TIMEOUT_MS` is **5 s**. So the first `wait_for` of a lease
	 * spends roughly 3.7 s of that budget inside its own first probe — companion start plus first
	 * read — and has about 1.3 s and a handful of 34–47 ms samples left for the condition, where
	 * the same default on Android spends about 0.2 s getting to its first sample. No wait becomes
	 * vacuous (`waitForCondition` probes before it waits, so the first sample always happens) and
	 * the 5 s promise is kept; what shrinks is how many samples fit inside it, so a caller that
	 * needs the whole window on a freshly leased simulator passes its own `timeoutMs`. Pre-warming
	 * would belong on a lease grant and nowhere else — a timer of the transport's own is what
	 * `./idb-client.js`' header rules out for its own reason — and documenting the cost is what
	 * this phase owes.
	 *
	 * A companion that died mid-read fails this call as an **interruption**, never as a device
	 * fault (`IdbCompanionInterruptedError`): killing one leaves the simulator booted, so what was
	 * lost is this host's way of talking to a device that is fine, and the next read starts a
	 * fresh companion.
	 *
	 * **The pool is not invalidated when a device leaves `ready`, and that is measured rather than
	 * assumed.** It is the one state change `./idb-client.js` cannot observe for itself — it runs
	 * no timer and no health check — so a companion started for a booted device is still in the
	 * pool after that device is shut down, and is handed the next read once it is booted again.
	 * Driven on a throwaway simulator created and deleted for the run, 2026-09-09 (`docs/IOS.md`
	 * §4 has the table): the read in between is the same well-behaved `INTERNAL` refusal the state
	 * check above pre-empts, and the read *after* the reboot is answered correctly over the same
	 * channel in 163–801 ms, then 24 ms warm — so the reuse is right and an eviction here would
	 * only buy back the 3.34 s.
	 */
	async readScreen(serial: DeviceSerial): Promise<ScreenElement[]> {
		const device = await this.describeDevice(serial);
		if (device === null) throw new DeviceVanishedError(serial);
		if (device.state !== 'ready') throw notReadable(serial, device.state);

		const answer = await this.companions.call(serial, READ_SCREEN_RPC, READ_SCREEN_REQUEST);

		return toScreenElements(parseAccessibilityRead(answer));
	}

	/**
	 * A tap, as the two HID events a press is — `./input.js` holds the arithmetic and the reason
	 * nothing is converted on the way.
	 *
	 * **What comes back proves nothing about the device**, and that is the whole shape of input on
	 * this transport: `hid` answers an empty `HIDResponse`, and the bench watched it answer that
	 * for a keycode that does not exist, a touch at `NaN` and a touch a hundred thousand points
	 * off the panel. So the checks that can be made before the stream are made in `./input.js`,
	 * and the only real evidence a tap landed is a screen read after it — which is what
	 * `src/verbs/input.ts` returns as the post-state and what
	 * `tests/device/ios-simulator/input.test.ts` asserts on.
	 *
	 * The events are built **before** the device is checked, so a programmer error costs no round
	 * trip and reads as itself (`../android/backend.ts`'s ordering, for its reason).
	 */
	async tap(serial: DeviceSerial, at: Point): Promise<void> {
		const events = tapEvents(at);
		await this.refuseUnlessInputtable(serial);

		await this.companions.stream(serial, HID_RPC, events);
	}

	/**
	 * A drag from `from` to `to` over `durationMs` — one `HIDSwipe`, and also the long press
	 * (`./input.js`'s `swipeEvents` carries what was measured for both).
	 *
	 * The call **blocks for the gesture**: the companion holds the stream open until the swipe has
	 * finished, measured at about 100 ms over the duration asked for. That is a call this backend
	 * can spend a second and a half inside, well within `IDB_CALL_TIMEOUT_MS` and the reason it is
	 * worth saying out loud.
	 */
	async swipe(serial: DeviceSerial, from: Point, to: Point, durationMs: number): Promise<void> {
		const events = swipeEvents(from, to, durationMs);
		await this.refuseUnlessInputtable(serial);

		await this.companions.stream(serial, HID_RPC, events);
	}

	/**
	 * `text`, as key presses, in one stream.
	 *
	 * **What this device will not type is refused before anything is sent** — `./input.js` carries
	 * the measurements, and the short version is that outside printable ASCII there is either no
	 * key at all, or a key that does something other than insert the character: a tab left a field
	 * exactly as it was, and a newline is Return, which submitted. That refusal is an
	 * `UnsupportedTextError` rather than a plain one because it is a caller's string that is wrong
	 * rather than the host: `src/verbs/failure.ts` carries it to the agent as `unsupported-text`
	 * naming the characters to change, where a plain `Error` would arrive as `internal_error`. The
	 * words for what this device *can* take are this platform's and are passed in, because that
	 * class names no platform's particulars.
	 *
	 * **One call however long the text is.** All 95 printable ASCII characters went in a single
	 * stream in 114 ms and came back out of a text field byte-identical, so there is no analogue
	 * of the Android side's `%s` cut and no run in which half the text lands.
	 */
	async typeText(serial: DeviceSerial, text: string): Promise<void> {
		const unsupported = untypeableCharacters(text);
		if (unsupported.length > 0) {
			throw new UnsupportedTextError(serial, text, unsupported, TYPEABLE_TEXT);
		}
		const events = typeTextEvents(text);
		await this.refuseUnlessInputtable(serial);

		await this.companions.stream(serial, HID_RPC, events);
	}

	/**
	 * Press one of the four keys of the neutral vocabulary — or refuse it by name, which two of
	 * them are.
	 *
	 * **The refusal comes first, before any round trip**, and that ordering is deliberate: `back`
	 * and `recents` have no answer on this platform in *any* device state, so asking the
	 * enumeration about the device first would spend a call to reach the same sentence. What the
	 * caller is told is which key and why (`./input.js`'s `DEVICE_KEYS`), through
	 * `UnsupportedKeyError` — never `MissingCapabilityError`, because this device does take input
	 * and tapping, swiping and typing all work (`src/core/device.ts`).
	 *
	 * **`wake` reads the screen state before it presses, and that is the whole of it being
	 * idempotent.** The button idb exposes is `LOCK`, which *toggles*: pressing it on a woken
	 * device puts it to sleep, which is the silent inversion this vocabulary exists to avoid. So
	 * the press is conditional on {@link screenIsBlanked}, and a `wake` on a device that is
	 * already awake sends nothing at all — measured three times in a row on the bench, leaving the
	 * flag at `0` each time (`PROJECT.md` R46). `home` presses unconditionally, because `HOME` is
	 * not a toggle.
	 *
	 * The state check on the device is *after* the key lookup and *before* either of those, so a
	 * key that will be pressed is pressed on a device that can take it.
	 */
	async pressKey(serial: DeviceSerial, key: DeviceKey): Promise<void> {
		const answer = DEVICE_KEYS[key];
		if ('noEquivalent' in answer) {
			throw new UnsupportedKeyError(serial, key, answer.noEquivalent);
		}
		await this.refuseUnlessInputtable(serial);
		if (answer.onlyWhenBlanked && !(await this.screenIsBlanked(serial))) return;

		await this.companions.stream(serial, HID_RPC, buttonEvents(answer.button));
	}

	/**
	 * Record for `options.durationMs` and answer with the bytes — **the recorder is a process on
	 * this host, and everything below follows from that.**
	 *
	 * The order is fixed: **check the device, ask whether it is recording, remove, record, wait
	 * for the marker, arm the deadline, wait for the recorder to be gone, read, check, answer.**
	 *
	 * - **The device's state is checked first, and it is load-bearing rather than an
	 *   optimisation** — {@link notRecordable} carries the measurement, and the short version is
	 *   that a recording on a device that is not booted reports success at every step and writes
	 *   zero bytes. {@link screenshot}'s check buys a minute; this one is the difference between
	 *   an answer and a plausible-looking nothing (`ai/RULES.md` §2).
	 * - **"Is this device recording" is asked of the machine** ({@link refuseIfRecording}), never
	 *   remembered (D6). A second recorder is refused by name before anything is started, which
	 *   is also what the tool would do — exit 16, `Host recording is already in progress`
	 *   (measured) — except that the tool's answer arrives as a failed recorder rather than as
	 *   *this device is already recording, stop that one first*.
	 * - **The file is removed before the recorder starts**, so a leftover from a run that died
	 *   before its cleanup can never be the file that is read — `../android/backend.ts`'s
	 *   freshness guarantee, bought the same way. There is no `--force`, so a leftover this
	 *   removal could not take away is a loud refusal rather than a silent overwrite
	 *   ({@link RECORD_VIDEO_ARGV}).
	 * - **The start is a condition on the marker, never a duration** (D12(b)). `simctl` writes
	 *   `Recording started` to *stderr* once the first frame has been processed, and that line
	 *   specifically: an ordinary successful run prints `Note: No display specified…` to the same
	 *   stream first (`./parsers/recording.ts`), so a wait on "anything on stderr" would return
	 *   before a frame existed.
	 * - **The window is a deadline timer whose callback sends the signal, which is the opposite
	 *   of a sleep** (D12, `tests/helpers/no-sleep-scan.ts`). It has to be, because `simctl io
	 *   recordVideo` has **no `--time-limit`**: there is nothing on the device that stops it, so
	 *   the only thing that can is something here. What is *awaited* is the recorder being gone —
	 *   a condition — with the window plus {@link RECORDING_FINISH_TIMEOUT_MS} to happen in,
	 *   which is `../android/backend.ts`'s budget for the same wait.
	 * - **The recorder being gone is asked of the run this call is holding**, and that is exact
	 *   rather than approximate: Node reports `close` after the process has exited, and this tool
	 *   writes the whole file *before* it exits — `Recording completed. Writing to disk.` then
	 *   `Wrote video to: …` on stdout, then exit 0, measured 20–30 ms after the signal. So there
	 *   is no equivalent of the Android side's 0.265 s during which `pidof` still names a recorder
	 *   that has written nothing, and no second wait to cover it.
	 * - **The container is checked on the bytes that actually arrived**, not on an exit code — the
	 *   zero-byte file above exits 0. {@link UnfinishedRecordingError} names the device and the
	 *   byte length rather than handing over something no player will open.
	 * - **Two nested `finally` blocks, one per obligation, and neither's own failure replaces the
	 *   answer.** The inner one signals again, which is not a formality: this platform's kill
	 *   switch is on the host, so a wait that timed out or a read that failed must not leave a
	 *   recorder running on hardware somebody else gets next. It is a no-op once the run has
	 *   ended. The outer one removes the file, and it wraps the launch as well, so a recorder
	 *   that never reported having started leaves nothing behind either — the split is what lets
	 *   the removal cover a path where there is no recorder to signal.
	 *
	 * **Exclusive on the recording path** ({@link exclusivelyOn}), because that path is derived
	 * from the udid and two overlapping calls would therefore share one file. On the path rather
	 * than on the device, `../android/backend.ts`'s choice and for its reason (#184).
	 */
	async recordVideo(serial: DeviceSerial, options: RecordVideoOptions): Promise<Uint8Array> {
		const path = recordingPathOf(serial);

		return this.exclusivelyOn(path, async () => {
			await this.refuseUnlessRecordable(serial);
			await this.refuseIfRecording(serial);
			await this.removeRecording(path);

			// Two obligations, two blocks: the outer one owns the *file*, so it is taken away on
			// every path out of here — including a launch that never reported a start, which is
			// `../android/backend.ts`'s spawn-inside-the-block shape and for its reason. The inner
			// one owns the *recorder*, and there is nothing to stop until the launch has answered
			// (a launch that fails signals its own, {@link launchRecorder}).
			try {
				const recorder = await this.launchRecorder(serial, path);
				// A deadline whose callback does work, which is a deadline and not a sleep: nothing
				// on the device stops this recorder, so this is the whole of the window.
				const deadline = setTimeout(
					() => recorder.stream.signal(RECORDING_SIGNAL),
					options.durationMs,
				);
				deadline.unref();

				try {
					await waitForCondition({
						what: `the recording on device '${unwrap(serial)}' to finish`,
						timeoutMs: options.durationMs + RECORDING_FINISH_TIMEOUT_MS,
						probe: () =>
							recorder.ended() === null
								? { found: 'the recorder is still running', met: false }
								: { met: true, value: undefined },
					});

					return await this.readFinishedRecording(serial, path);
				} finally {
					clearTimeout(deadline);
					recorder.stream.signal(RECORDING_SIGNAL);
				}
			} finally {
				await this.removeRecording(path).catch(() => undefined);
			}
		});
	}

	/**
	 * Start recording and **return while the recorder is still running** (#190).
	 *
	 * Everything {@link recordVideo}'s docblock records still applies — the state check, the
	 * refusal, the removal, the marker. What is different is the two things that outlive the call:
	 *
	 * - **the recorder itself**, which is why the handle is released rather than held
	 *   ({@link SimctlStream.release}): the run has to survive this method returning, and the
	 *   event loop must stop counting it as work this process owes. Nothing is destroyed, so the
	 *   two lines the recorder writes as it finalises the file still arrive;
	 * - **`maxDurationMs`, as a deadline timer on this host** — and this is the one place where a
	 *   platform difference costs something a caller can feel. On Android that limit is
	 *   `screenrecord --time-limit`, *on the device*, so a daemon that dies leaves a recorder that
	 *   still stops itself. `simctl io recordVideo` has no such flag, so here the switch is a
	 *   timer in this process: **a daemon that dies takes the limit with it, and the recorder runs
	 *   on until somebody stops it.** What covers the ordinary case is the lease-end teardown
	 *   ({@link discardRecording}, D9), which runs on release and on expiry alike — and what does
	 *   not cover it is a host that is no longer there. `docs/IOS.md` §8 records the gap.
	 *
	 * The timer is unreferenced, for the reason `src/daemon/restore.ts`'s is: it exists to *stop*
	 * a recording, never to keep this process alive. It is not cleared when the recorder ends on
	 * its own — a stop of its own, or a `stopRecording` that got there first — because
	 * {@link SimctlStream.signal} is a no-op by then and an unreferenced timer firing into one
	 * costs nothing.
	 *
	 * A non-positive `maxDurationMs` stops the recorder on the next tick rather than removing the
	 * limit, which is the opposite of the trap `RecordVideoOptions.durationMs` records for
	 * `--time-limit 0` and the safe direction to fail in: the wire schema refuses it and an
	 * in-process caller that passes one gets a recording of nothing rather than an unbounded
	 * recorder on borrowed hardware. A value past `setTimeout`'s own 2³¹−1 ms ceiling is clamped
	 * by Node to the next tick, which fails in the same direction; the verb layer passes
	 * `MAX_RECORDING_MS` (`src/verbs/recording-session.ts`), so neither is reachable over the
	 * wire.
	 */
	async startRecording(serial: DeviceSerial, options: StartRecordingOptions): Promise<void> {
		const path = recordingPathOf(serial);

		return this.exclusivelyOn(path, async () => {
			await this.refuseUnlessRecordable(serial);
			await this.refuseIfRecording(serial);
			await this.removeRecording(path);

			// A `catch` and not a `finally`, and that is the whole difference from
			// {@link recordVideo}: this method's success leaves the recording behind on purpose, so
			// only the failure may take the file away. What it takes away is the zero-byte file a
			// recorder signalled during the start wait leaves (`./parsers/recording.ts`), which
			// would otherwise sit there until the lease ended and make the next `stop_recording` on
			// this device an `UnfinishedRecordingError` about a recording that never existed.
			try {
				const recorder = await this.launchRecorder(serial, path);
				// The recorder's own kill switch, host-side because this platform offers no other —
				// see the docblock for what that costs. A callback that does work, not a sleep.
				const limit = setTimeout(
					() => recorder.stream.signal(RECORDING_SIGNAL),
					options.maxDurationMs,
				);
				limit.unref();
				recorder.stream.release();
			} catch (failure) {
				await this.removeRecording(path).catch(() => undefined);
				throw failure;
			}
		});
	}

	/**
	 * Stop the recording this device is holding open and answer with the bytes.
	 *
	 * The order is **ask, signal, wait on the condition, read, check, answer** — and the whole of
	 * it goes through the process table rather than through a handle, which is the difference this
	 * method makes to the design. `startRecording` returned and let its handle go, so there is
	 * nothing here to hold: the recorder is found by matching `simctl io <udid> recordVideo` in
	 * this host's own process table (`./parsers/recording.ts`) and signalled by pid. That is what
	 * lets this stop a recorder an earlier daemon started, and a recorder some other program on
	 * the machine started, rather than only one this process remembers.
	 *
	 * **The wait after the signal is on the machine's answer, not on a handle**, for the same
	 * reason, and it is quick: `ps` stopped naming the recorder on the first probe 39 ms after the
	 * signal (measured, macOS 26.6.2 / Xcode 26.6, 2026-09-08). It is a condition with a timeout
	 * all the same — a recorder finalising a long capture has megabytes to flush.
	 *
	 * **A recorder that already stopped is not a failure and not a special case.** It reached the
	 * limit `startRecording` armed, its file is complete, and the read below is the same read. So
	 * this branches on whether there is anything to signal, not on whether anything went wrong.
	 *
	 * **Which leaves one genuine failure, and the two are told apart by the file rather than by
	 * the signal.** Nothing recording *and* nothing written is {@link NoRecordingRunningError}:
	 * there was no recorder and there is nothing to hand back, so a caller that stopped something
	 * it never started is told so rather than handed an empty answer. Anything else is read, and
	 * the container is checked on the bytes that arrived — a recording that ran against a device
	 * which had gone down is exactly a zero-byte file that is really there, which is
	 * {@link UnfinishedRecordingError} naming the length.
	 *
	 * **The `finally` removes the file and its own failure never replaces the answer**, which is
	 * `../android/backend.ts`'s rule: this method has an answer to protect, and it runs on the
	 * refusal paths too, where a multi-megabyte file left on borrowed hardware does the most harm.
	 */
	async stopRecording(serial: DeviceSerial): Promise<Uint8Array> {
		const path = recordingPathOf(serial);

		return this.exclusivelyOn(path, async () => {
			try {
				const running = await this.stopRecorders(serial);
				const bytes = await readFile(path).catch(() => null);

				// Nothing recording and nothing written: nothing happened, so there is nothing to
				// explain about the bytes. Decided from the two facts together rather than from
				// either — a recorder that stopped itself leaves a perfectly good file behind, and a
				// recorder that ran against a device which had gone leaves an empty one.
				if (bytes === null) {
					if (running.length === 0) throw new NoRecordingRunningError(serial);
					throw new UnfinishedRecordingError(serial, 0);
				}
				if (!isFinishedRecording(bytes)) {
					throw new UnfinishedRecordingError(serial, bytes.byteLength);
				}

				return bytes;
			} finally {
				await this.removeRecording(path).catch(() => undefined);
			}
		});
	}

	/**
	 * Stop whatever recorder this device is running and remove the file — the lease-end teardown's
	 * own method, never a verb's (`src/daemon/restore.ts`, D9).
	 *
	 * {@link stopRecording} with everything after the wait taken out: no read, no container check
	 * and no bytes. A lease that ended has no caller to hand a recording to, so reading megabytes
	 * nobody is waiting on would buy nothing, and refusing an unfinished file — which is what a
	 * recorder abandoned mid-lease usually leaves — would turn the ordinary case into a failure the
	 * teardown then has to swallow.
	 *
	 * **Nothing recording is a silent success.** This runs for every lease that ends and most
	 * leases never record anything: no recorder means nothing to signal and nothing to wait for,
	 * and removing a path that is not there is not an error ({@link removeRecording}).
	 *
	 * **It matters more here than on the other platform**, and that is the one thing worth reading
	 * twice: `startRecording`'s limit lives in this process, so this teardown is what stops a
	 * recorder whose lease ended inside a daemon that is still alive — which is every case except
	 * the one where the daemon itself died.
	 *
	 * **The `rm` is in a `finally` and its failure is not swallowed**, `../android/backend.ts`'s
	 * one deliberate departure from the stop and for its reason: this method has no answer to
	 * protect, and a recording left on hardware that goes to somebody else next is precisely what
	 * it exists to prevent.
	 */
	async discardRecording(serial: DeviceSerial): Promise<void> {
		const path = recordingPathOf(serial);

		return this.exclusivelyOn(path, async () => {
			try {
				await this.stopRecorders(serial);
			} finally {
				await this.removeRecording(path);
			}
		});
	}

	// --- Not part of the contract: this backend's own second program, stopped ---

	/**
	 * Kill every `idb_companion` this backend started and wait until the host is tidy.
	 *
	 * **Not on `DeviceBackend`, because that interface has no teardown at all** — every method on
	 * it is a call about a device, and the daemon's own lifecycle reaches a backend only through
	 * the restorer, which calls capability-gated *verbs* (`src/daemon/restore.ts`). It is instead
	 * registered as this backend's `stopHostProcesses` (`./index.js`, `../manifest.js`), which is
	 * where a teardown that is about *this host* rather than about a device belongs.
	 *
	 * **Two things call it.** The daemon's shutdown, through that registration and bounded by
	 * `BACKEND_STOP_TIMEOUT_MS` (`src/daemon/listen.ts`) — last of all, once the watches are gone
	 * and the restorations have settled, because a companion is the transport a verb call rides
	 * and ending one earlier would let the next call start a replacement the shutdown has already
	 * walked past. And the device suite, which would otherwise leave a live `idb_companion` behind
	 * per device it touched. A stray one is not harmless either way: two companions on one udid
	 * both bind and both accept commands (`docs/IOS.md` §4), so the leftovers are exactly the
	 * arbitration the lease layer is the only lock for — and without a caller on the daemon's path
	 * the count grows to one per simulator anybody has read, held for the daemon's whole life,
	 * with no operator route to releasing them short of killing it. There is still no timer, no
	 * health check and no eager respawn of this backend's own (`./idb-client.js`).
	 *
	 * Idempotent and safe on a backend that never started one: a device with no companion is not
	 * an error.
	 */
	async stopIdbCompanions(): Promise<void> {
		await this.companions.stopAll();
	}

	/**
	 * Spawn the recorder and answer once it has said it is recording — the half
	 * {@link recordVideo} and {@link startRecording} share.
	 *
	 * **Both streams are accumulated only until the marker arrives, and then dropped.** What they
	 * are for is the one failure that needs them — {@link recorderNeverStarted}, where the useful
	 * half is as often on stdout as on stderr — and once the recorder has started they are two
	 * lines nobody reads and an unbounded buffer on a run that may outlive its call. So this is a
	 * bound by construction rather than a tail that has to be sliced, and there is no truncation
	 * to reason about.
	 *
	 * **The wait ends early when the run does.** A probe that throws propagates unchanged
	 * (`src/core/wait.ts`), which is what turns exit 16 and exit 17 from a ten-second timeout into
	 * the tool's own sentence. The marker is checked *before* the end, so a run that both said it
	 * started and then stopped counts as started — its file is what decides the answer.
	 *
	 * A wait that times out signals the recorder before it gives up, because nothing else will: a
	 * recorder that never produced a frame is still a process holding this device's recording lock.
	 */
	private async launchRecorder(serial: DeviceSerial, path: string): Promise<Recorder> {
		let started = false;
		let ended: string | null = null;
		const streams = { stdout: '', stderr: '' };

		const stream = streamSimctlOnDevice(
			serial,
			'io',
			[...RECORD_VIDEO_ARGV, path],
			{
				onStdout: (chunk) => {
					if (!started) streams.stdout += chunk;
				},
				onStderr: (chunk) => {
					if (started) return;
					streams.stderr += chunk;
					started = saysRecordingStarted(streams.stderr);
				},
				onEnd: (reason) => {
					ended = reason;
				},
			},
			// The last argv entry is the file this host chose, and the end reason names the argv:
			// masked by the same value the streams are, so all three agree (D19).
			{ redactArgv: [path] },
		);

		try {
			await waitForCondition({
				what: `the recording on device '${unwrap(serial)}' to start`,
				timeoutMs: RECORDING_START_TIMEOUT_MS,
				probe: () => {
					if (started) return { met: true, value: undefined };
					if (ended !== null) throw recorderNeverStarted(serial, ended, streams, path);
					return { found: 'nothing on stderr saying the recording had started', met: false };
				},
			});
		} catch (failure) {
			stream.signal(RECORDING_SIGNAL);
			throw failure;
		}

		return { ended: () => ended, stream };
	}

	/**
	 * The pids of every recorder this host is running for `serial`, empty when there is none.
	 *
	 * One place asks the machine this question, because four callers act on the same answer and a
	 * copy that drifted would make two of them disagree about what "already recording" means —
	 * `../android/backend.ts`'s `recorderPids` and its reasoning, with the process table in place
	 * of `pidof` because the recorder is a host process (`./parsers/recording.ts`).
	 */
	private async recorderPids(serial: DeviceSerial): Promise<string[]> {
		return recorderPids(await readProcessTable(), unwrap(serial));
	}

	/**
	 * Refuse by name if this device is already recording — what both ways of starting one ask
	 * before they start anything.
	 *
	 * @throws RecordingAlreadyRunningError naming the device and the pids that were there.
	 */
	private async refuseIfRecording(serial: DeviceSerial): Promise<void> {
		const pids = await this.recorderPids(serial);
		if (pids.length > 0) throw new RecordingAlreadyRunningError(serial, pids);
	}

	/**
	 * Refuse unless the device can actually record — {@link notRecordable} carries why this is
	 * not an optimisation.
	 *
	 * `describeDevice`, so a device this host no longer has is {@link DeviceVanishedError} rather
	 * than a refusal about a state nobody can read — {@link screenshot}'s check, same shape.
	 */
	private async refuseUnlessRecordable(serial: DeviceSerial): Promise<void> {
		const device = await this.describeDevice(serial);
		if (device === null) throw new DeviceVanishedError(serial);
		if (device.state !== 'ready') throw notRecordable(serial, device.state);
	}

	/**
	 * Refuse unless the device can take input — {@link notInputtable} carries what the tool does
	 * without it, which is refuse properly and leave a companion running.
	 *
	 * {@link refuseUnlessRecordable}'s shape, and {@link readScreen}'s reason: a device this host
	 * no longer has is {@link DeviceVanishedError} rather than a refusal about a state nobody can
	 * read.
	 */
	private async refuseUnlessInputtable(serial: DeviceSerial): Promise<void> {
		const device = await this.describeDevice(serial);
		if (device === null) throw new DeviceVanishedError(serial);
		if (device.state !== 'ready') throw notInputtable(serial, device.state);
	}

	/**
	 * Whether this device's screen is currently off — the read that makes `wake` idempotent.
	 *
	 * `simctl spawn <udid> notifyutil -g <name>`, which is the second call in this backend to run
	 * a program *inside* the device ({@link readLogs} is the first) and, like it, hands the guest
	 * program its own argv with no shell on either side. The name, the parse and the measurement
	 * behind all three are `./input.js`'s; what is here is the invocation.
	 *
	 * It costs about 360 ms, which is two orders of magnitude more than the press it guards — and
	 * it is paid anyway, because the alternative is a `wake` that sleeps a woken device.
	 */
	private async screenIsBlanked(serial: DeviceSerial): Promise<boolean> {
		const { stdout } = await runSimctlOnDevice(serial, 'spawn', [...READ_SCREEN_BLANKED_ARGV]);
		return isScreenBlanked(stdout);
	}

	/**
	 * Signal every recorder this host is running for `serial`, wait until the machine says they
	 * are gone, and answer with the pids that were there — {@link stopRecording} and
	 * {@link discardRecording}'s shared middle.
	 *
	 * Signalled **by pid** rather than through a handle, which is what makes both methods work on
	 * a recorder this process did not start (see {@link stopRecording}). `ESRCH` is tolerated for
	 * the reason `../android/backend.ts` carries a `|| true` on its own kill: the pids were read a
	 * moment earlier, so a recorder that reached the limit `startRecording` armed in the gap
	 * leaves a signal with nothing to deliver to — which is not a broken device, and the wait
	 * below is what catches a recorder that really would not go.
	 */
	private async stopRecorders(serial: DeviceSerial): Promise<string[]> {
		const running = await this.recorderPids(serial);
		if (running.length === 0) return running;

		for (const pid of running) {
			try {
				process.kill(Number(pid), RECORDING_SIGNAL);
			} catch {
				// Gone between the read and the signal. The wait below is the check that matters.
			}
		}

		await waitForCondition({
			what: `the recording on device '${unwrap(serial)}' to stop`,
			timeoutMs: RECORDING_FINISH_TIMEOUT_MS,
			probe: async () => {
				const pids = await this.recorderPids(serial);
				if (pids.length === 0) return { met: true, value: undefined };
				return { found: `simctl still recording as pid ${pids.join(', ')}`, met: false };
			},
		});

		return running;
	}

	/**
	 * The bytes of a finished recording, or the refusal that says why they are not one.
	 *
	 * Its own step because the two ways of ending a recording ask it differently:
	 * {@link recordVideo} knows a recorder just ran, so a file that is not there is this host's
	 * failure ({@link recordingUnreadable}), while {@link stopRecording} has to tell that case
	 * from a stop nobody started and reads the file itself.
	 */
	private async readFinishedRecording(serial: DeviceSerial, path: string): Promise<Uint8Array> {
		const bytes = await readFile(path).catch((cause: unknown) => {
			throw recordingUnreadable(serial, cause);
		});
		if (!isFinishedRecording(bytes)) {
			throw new UnfinishedRecordingError(serial, bytes.byteLength);
		}

		return bytes;
	}

	/** The recording, gone — run before every recording and again after it, on every path. */
	private async removeRecording(path: string): Promise<void> {
		await rm(path, { force: true });
	}

	/**
	 * Run `work` after every call already queued for `path` on this host, and never beside one.
	 *
	 * `../android/backend.ts`'s register, with one simplification the platform allows: the subject
	 * there is a (device, path) pair because the paths are device-side literals, while here the
	 * only scratch path a call holds across another call is the recording, and it already carries
	 * the udid ({@link RECORDING_PATH_PREFIX}). So the path *is* the key.
	 *
	 * Two overlapping recording calls would otherwise share one file and spoil both answers, and
	 * nothing above this excludes them — `src/daemon/verb-traffic.ts` registers concurrent calls
	 * on one device rather than preventing them, on purpose. A promise chain per path rather than
	 * a lock, because there is nothing to unlock: the entry *is* the tail of the queue.
	 *
	 * The chain never rejects and never carries a value: a call that threw has still finished with
	 * the file, and letting its rejection through would fail the *next* caller with the previous
	 * caller's error. The entry is dropped once this call is the last one queued for that path, so
	 * the map is bounded by the devices being recorded right now rather than by every device this
	 * host has ever touched.
	 *
	 * It bounds nothing else, and on this platform that is worth one sentence: a recording held
	 * open by `startRecording` is **not** holding this queue — that call returns, and the recorder
	 * it left running is found again through the process table. What is excluded is two *calls*.
	 */
	private async exclusivelyOn<T>(path: string, work: () => Promise<T>): Promise<T> {
		const queued = (this.recordingUse.get(path) ?? Promise.resolve()).then(work);
		const settled = queued.then(
			() => undefined,
			() => undefined,
		);
		this.recordingUse.set(path, settled);

		try {
			return await queued;
		} finally {
			if (this.recordingUse.get(path) === settled) this.recordingUse.delete(path);
		}
	}

	/**
	 * The device's own storage root on this host, out of its `simctl list -j devices` entry.
	 *
	 * One invocation per transfer rather than a value held between them, which is D6 one level
	 * down and this class's own stance (see {@link listDevices}): a `dataPath` remembered from an
	 * earlier call is a cache of somebody else's filesystem. It costs the listing — 0.11–0.24 s
	 * across this backend's benches — and it doubles as the presence check, so a transfer to a
	 * device that has been deleted is {@link DeviceVanishedError} rather than an `ENOENT` about a
	 * directory on this host.
	 *
	 * Read off the **raw entry** rather than the mapped {@link Device}, for the reason
	 * {@link findEntry} exists: this is a path on the machine holding the device and the neutral
	 * shape deliberately carries no such thing.
	 */
	private async dataRootOf(serial: DeviceSerial): Promise<string> {
		const result = await runSimctl([...DEVICE_PATHS_ARGV]);

		let devices: SimctlDeviceList;
		try {
			devices = parseSimctlDevices(result.stdout);
		} catch (cause) {
			throw unparseable(DEVICE_PATHS_ARGV, result, cause);
		}

		const entry = findEntry(devices, serial);
		if (entry === null) throw new DeviceVanishedError(serial);

		return entry.dataPath;
	}
}

/**
 * The profile of the device type `entry` was created from, read off disk and decoded.
 *
 * Both failures name the device, the device type and — where there is one — the file, because a
 * caller holding neither the listing nor this host's disk has no other way to learn which of the
 * two it was. The read and the decode share one refusal on purpose: a bundle that has gone and a
 * bundle whose profile is not the binary property list every one of the 124 types on the bench is
 * (`./parsers/device-type-profile.js`) are the same answer to the caller — there is no screen to
 * report — and the underlying message is what tells them apart.
 */
async function readProfileOf(
	serial: DeviceSerial,
	entry: SimctlDevice,
	types: readonly SimctlDeviceType[],
): Promise<DeviceTypeProfile> {
	const type = types.find((candidate) => candidate.identifier === entry.deviceTypeIdentifier);
	if (type === undefined) {
		throw new Error(
			`Device '${unwrap(serial)}' was created from device type ` +
				`'${entry.deviceTypeIdentifier}', which simctl does not list: that type's own profile ` +
				'is where this platform states a screen, and there is no second place to read one from',
		);
	}

	const profilePath = deviceTypeProfilePath(type.bundlePath);
	try {
		return readDeviceTypeProfile(await readFile(profilePath));
	} catch (cause) {
		throw new Error(
			`Device '${unwrap(serial)}' is a '${type.identifier}', whose screen is described by ` +
				`${profilePath} — which could not be read: ${message(cause)}`,
			{ cause },
		);
	}
}
