/**
 * The device backend for this platform, at the phase that adds *the screen capture and the log
 * read* to the app lifecycle and the transfers.
 *
 * **Every required method of `DeviceBackend` is answered now**, and there is no `not implemented
 * yet` stub left in the class: the four the enumeration phase brought, the six the lifecycle and
 * the transfers brought, and {@link IosSimulatorDeviceBackend.screenshot} and
 * {@link IosSimulatorDeviceBackend.readLogs} here. The capability-gated methods are absent rather
 * than stubbed: a manifest is what declares those, and there is none yet.
 *
 * **This backend registers nothing** (`ai/TESTING.md`, "A backend under construction registers
 * nothing"): no `./capabilities.ts`, no `./index.ts` and no line in `../index.ts`, so
 * `tests/unit/backends/barrel.test.ts` and `tests/unit/backends/conformance.test.ts` still read
 * `['android']` after this phase. That is deliberate rather than unfinished, and this is the phase
 * where the *reason* changes: it was that a stub-bearing manifest fails the conformance gate for
 * the backend that already passes it, and the stubs are gone. What a manifest would now be
 * waiting on is what it would have to declare beside these twelve methods — the recorder and its
 * two capabilities — so it lands with those, in the phase after this one (`PROJECT.md` R45).
 *
 * Everything that touches a simulator goes through `./simctl.js`, everything that reads its
 * output through `./parsers/`, and the three pure modules beside this one own the vocabulary, the
 * arithmetic and the path mapping — `./devices.js` on the enumeration, `./screen.js` on the
 * screen, `./containers.js` on where a device path is on this host. This file is the join between
 * them and holds no text-shaped knowledge of its own: no key name, no state token, no plist path
 * and no failure wording appears here.
 *
 * **The two transfers reach no simulator at all**, which is the one thing about this backend that
 * has no counterpart on the Android side: a simulator's storage *is* a directory on this host, so
 * a push is a file copy and a pull is a file read. `./containers.js` carries why that is the only
 * route available and what confines it.
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
	type DeviceState,
	type DeviceWatch,
	type DeviceWatcher,
	type LogRead,
	type PullFileOptions,
	type ReadLogsOptions,
} from '../../core/device.js';
import { DeviceVanishedError, FileTooLargeError } from '../../core/errors.js';
import { type AppId, type DeviceSerial, unwrap } from '../../core/ids.js';
import { hostPathOf } from './containers.js';
import { SIMCTL_MISSING, SimctlNotFoundError } from './developer-dir.js';
import { IOS_SIMULATOR_PLATFORM_ID, toDevices } from './devices.js';
import { saysNothingToTerminate } from './parsers/app-control.js';
import { type DeviceTypeProfile, readDeviceTypeProfile } from './parsers/device-type-profile.js';
import { isPng } from './parsers/png.js';
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
import { deviceTypeProfilePath, toScreenInfo } from './screen.js';
import {
	describeBytes,
	INSTALL_SIMCTL_TIMEOUT_MS,
	quoteStream,
	READ_LOGS_SIMCTL_MAX_BUFFER_BYTES,
	runSimctl,
	runSimctlOnDevice,
	SCREENSHOT_SIMCTL_TIMEOUT_MS,
	SimctlCommandError,
	type SimctlResult,
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
 * **The poll is the deliberate first step, not the design.** `idb_companion --notify` emits the
 * full target set on every change with no polling at all (`docs/IOS.md` §7), and swapping this
 * onto it changes nothing a caller can see: the contract is the full current set on subscription
 * and on every change either way.
 */
export const WATCH_POLL_INTERVAL_MS = 2_000;

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

export class IosSimulatorDeviceBackend implements DeviceBackend {
	/**
	 * One `simctl list -j devices runtimes`, mapped onto the neutral vocabulary.
	 *
	 * This class holds **nothing** between calls, which is D6 one level down, and unlike
	 * `AndroidDeviceBackend` it has nothing to gain by holding anything: the OS version that
	 * backend caches costs it a query per device, while here it is a field of the same listing
	 * the enumeration already read.
	 */
	async listDevices(): Promise<Device[]> {
		const result = await runSimctl([...ENUMERATE_ARGV]);
		const { devices, runtimes } = parseListings(ENUMERATE_ARGV, result, false);

		return toDevices(devices, runtimes);
	}

	/**
	 * One enumeration, filtered — D6's "the daemon is a cache, the platform is the truth"
	 * re-verification in its cheapest form, and the whole of what lifecycle means after D21.
	 * `null` rather than a throw: a device that is no longer there is a lookup miss
	 * (ai/CODING_STANDARDS.md "Error handling").
	 */
	async describeDevice(serial: DeviceSerial): Promise<Device | null> {
		const devices = await this.listDevices();
		return devices.find((device) => device.serial === serial) ?? null;
	}

	/**
	 * Poll the device set, delivering the **full** current set on subscription and whenever it
	 * differs from the last set delivered.
	 *
	 * Synchronous and never rejecting, as the contract requires: the first poll is started rather
	 * than awaited, so a failure that happens immediately reaches the caller through
	 * `onInterrupted` like every later one rather than as a rejection nothing is written to catch.
	 *
	 * **A failed poll is one `onInterrupted` and the poll continues.** Only
	 * `SimctlNotFoundError` is classified, and it carries {@link SIMCTL_MISSING} — the end that
	 * will not clear on its own (#168): a Command Line Tools selection does not start carrying
	 * `simctl`, so without a cause every surface would repeat "the host's view was interrupted"
	 * about a host that needs somebody to install Xcode. It keeps polling anyway, because
	 * `DEVELOPER_DIR` being fixed on a running daemon is exactly what the next poll picks up —
	 * the search is re-run per call and deliberately unmemoised (`./developer-dir.js`).
	 *
	 * **An interruption clears what the caller was last told**, so the next successful poll
	 * delivers unconditionally even when the set is unchanged. Suppressing it as "no change"
	 * would leave the caller holding a set it has been told is no longer known to be current,
	 * with nothing to lift that until a device happens to move.
	 *
	 * `stop()` silences every handler **synchronously**, before its promise resolves, so no
	 * listener method can be called after it — including from a poll already in flight, which is
	 * left to finish and have its answer dropped. There is nothing to cancel: `runSimctl` hands
	 * back no process handle, and a `simctl list` that is already running costs a fifth of a
	 * second and touches no device state.
	 */
	watchDevices(watcher: DeviceWatcher): DeviceWatch {
		let stopped = false;
		let next: NodeJS.Timeout | null = null;
		// The last set handed to the caller, and `null` whenever the caller has nothing it can
		// still believe: before the first delivery, and after every interruption.
		let delivered: Device[] | null = null;

		const schedule = (): void => {
			if (stopped) return;
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
				if (stopped) return;
				delivered = null;
				watcher.onInterrupted(
					message(error),
					error instanceof SimctlNotFoundError ? SIMCTL_MISSING : null,
				);
				schedule();
				return;
			}

			if (stopped) return;
			if (delivered === null || !sameDeviceSet(delivered, devices)) {
				delivered = devices;
				watcher.onDevices(devices);
			}
			schedule();
		};

		void poll();

		return {
			async stop(): Promise<void> {
				stopped = true;
				if (next !== null) {
					clearTimeout(next);
					next = null;
				}
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
