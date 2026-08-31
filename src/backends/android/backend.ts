/**
 * The device backend for this platform.
 *
 * It answers every required method of the contract — enumeration, presence, the device
 * facts, the app lifecycle, the capture, the log read, the recording and the two file
 * transfers — with no stub, which is what lets it declare `implements DeviceBackend` and what
 * lets `./index.ts` register it (ai/TESTING.md, "A backend under construction registers
 * nothing"), plus **every** capability-gated method: the environment pair behind
 * `canControlNetwork`, the four input primitives behind `canInput`, `readScreen` behind
 * `canReadScreen` (#13) and `recordVideo` behind `canRecordVideo` (#14). No flag in
 * `./capabilities.ts` is a declared opt-out any more.
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
 *
 * There is one more kind of value and it takes **no** quoter on purpose: a path handed to
 * `install`, `push` or `pull`. Those are adb subcommands taking argv entries, so nothing in
 * them reaches a shell on either machine — the quoting question does not arise, and the
 * check that does belongs at the boundary as a shape (`src/ipc/verb-methods.ts`). A future
 * transfer routed through `shell` instead would move it back onto this list.
 */

import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
	type PullFileOptions,
	type ReadLogsOptions,
	type RecordVideoOptions,
	type ScreenElement,
} from '../../core/device.js';
import {
	FileTooLargeError,
	UnfinishedRecordingError,
	UnsupportedTextError,
} from '../../core/errors.js';
import {
	type AppId,
	type DeviceSerial,
	parseAppId,
	parseDeviceSerial,
	unwrap,
} from '../../core/ids.js';
import { waitForCondition } from '../../core/wait.js';
import {
	type AdbBinaryResult,
	AdbCommandError,
	type AdbResult,
	type AdbStream,
	describeBytes,
	INSTALL_ADB_TIMEOUT_MS,
	OS_VERSION_ADB_TIMEOUT_MS,
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
	TRANSFER_ADB_TIMEOUT_MS,
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
import {
	OS_VERSION_PROPERTIES,
	type OsVersion,
	parseGetprop,
	parseOsVersion,
} from './parsers/getprop.js';
import { parseUiHierarchy, type UiHierarchy } from './parsers/hierarchy.js';
import { acceptedInput } from './parsers/input.js';
import { parseLogcat } from './parsers/logcat.js';
import { acceptedNetworkChange } from './parsers/network.js';
import { isPng } from './parsers/screencap.js';
import { isFinishedRecording, isRecorderRunning, recorderPids } from './parsers/screenrecord.js';
import { type DeviceStat, parseDeviceStat } from './parsers/stat.js';
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
 * What each device is asked for its OS version with — one round trip for both properties.
 *
 * `getprop` takes a *single* key: a second argument is the **default value** to print when
 * the property is absent, not a second key (measured on API 37 — PROJECT.md §6). So two
 * properties is two calls, joined onto one device-side command line, and the two bare
 * values come back on their own lines in this order.
 *
 * The key names come from `./parsers/getprop.js` rather than being written out again here,
 * so the line this builds and the parser that reads it positionally cannot drift apart. A
 * literal this file owns, so it is neither `shellArg`- nor `shellText`-quoted — the rule
 * this module's header already states for {@link DUMP_PATH} and the environment pair.
 *
 * Exported so the unit suite pins the command line this host sends rather than asserting
 * that *something* was sent, the way it pins the tracker's argv.
 */
export const OS_VERSION_ARGV = [
	'shell',
	OS_VERSION_PROPERTIES.map((property) => `getprop ${property}`).join('; '),
] as const;

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
 *
 * The OS version is not in that tail at all, for any device in any state, which is why it
 * arrives here as an argument: {@link OsVersionCache} asked the device for it at
 * enumeration and this is whatever it learned. `undefined` for a device that has not
 * answered one — a device waiting on an authorisation prompt never will — and that becomes
 * a `null` on the wire rather than a device left out of the list (`DeviceSchema`).
 */
function toDevice(entry: AdbDevice, version: OsVersion | undefined): Device {
	return DeviceSchema.parse({
		serial: entry.serial,
		platform: ANDROID_PLATFORM_ID,
		model: entry.properties.model ?? null,
		osVersion: version?.androidRelease ?? null,
		osApiLevel: version?.apiLevel ?? null,
		state: toDeviceState(entry),
		// The serial is the only discriminator adb offers — see `./attachment.js` for what
		// was measured before accepting that.
		attachment: attachmentOfSerial(entry.serial),
	});
}

/**
 * The OS version of each attached device, keyed by serial — read from the device once and
 * remembered for as long as it stays attached.
 *
 * A cache and not a fact, which is the distinction D6 draws: it is filled from the platform
 * at **every** enumeration and a serial that leaves the device set takes its entry with it,
 * so it holds nothing it cannot re-derive. What makes that affordable is that the version is
 * a *static* per-device fact — unlike the screen, it does not change while a device is
 * plugged in — so one read per attached device beats a read per enumeration, and it is never
 * on a verb's path at all.
 *
 * Five rules keep the cost where {@link DeviceBackend.listDevices}' callers can afford it,
 * a lease grant's re-verification among them (D6):
 *
 * 1. **Only a usable device is asked.** The state came from `adb devices -l` and is already
 *    parsed, so an `unauthorized` or `offline` device costs no process at all — which is
 *    both the faster answer and the honest one, since it could not have answered.
 * 2. **Only a device attached to *this* host is asked**, which is the same information and
 *    already decided (`./attachment.js`). A device reached over a network transport never
 *    enters an inventory and is never leased (D18), so its version is a round trip to
 *    another machine that nothing will read — and the round trip most likely to be the slow
 *    one. It is listed without a version, exactly as a device that could not answer is.
 * 3. **Devices are asked in parallel**, so a host with several attached pays one round trip
 *    rather than one each.
 * 4. **Nothing here ever throws or rejects.** A device that went away mid-enumeration, an
 *    adb that refused, output that would not parse — each is one device answering no
 *    version. Losing the whole device list because one device is waiting on an RSA prompt
 *    is the failure mode this class is shaped around.
 * 5. **One read is bounded by {@link OS_VERSION_ADB_TIMEOUT_MS}, not by the query
 *    default**, which is what bounds `listDevices`' own latency: rules 1–3 bound how *many*
 *    reads a call may issue, and without this nothing bounded how long the slowest of them
 *    could hold a lease grant. A device that adb reports as `device` but whose shell does
 *    not answer costs three seconds, not ten.
 *
 * A version learned on **any** path is announced through {@link onLearned}. That seam is
 * what stops two host surfaces disclosing different values for one fact: the enumeration a
 * lease grant runs and a live `watchDevices` share this cache, so whichever of them gets an
 * answer first hands it to the other, and a watcher whose own frame read failed does not
 * have to wait for the device set to change to be told.
 */
class OsVersionCache {
	/** What each attached device answered. A serial absent from here has not answered. */
	private readonly known = new Map<string, OsVersion>();

	/**
	 * The read in flight per serial, so two enumerations close together — which is what the
	 * watch delivers on every plug and unplug — spawn one process rather than two. Dropped
	 * as soon as the read settles, like {@link AndroidDeviceBackend.exclusivelyOn}'s queue.
	 */
	private readonly reading = new Map<string, Promise<void>>();

	/** Who to tell when a version lands — see {@link onLearned}. */
	private readonly learned = new Set<(serial: string) => void>();

	get(serial: string): OsVersion | undefined {
		return this.known.get(serial);
	}

	/**
	 * Be told, with the serial, whenever this cache records a version — on whichever path
	 * read it — and answer with the way to stop being told.
	 *
	 * This exists for {@link AndroidDeviceBackend.watchDevices}. A watch delivers a frame
	 * before the read that fills it in, so something has to deliver the frame *again* once
	 * the version arrives; making that depend on the frame's own read is what leaves a
	 * device permanently versionless after one transient failure, because nothing in this
	 * host re-enumerates on a timer and an unchanged device set produces no further frame.
	 * Announcing every version instead means the enumeration a lease grant runs also heals a
	 * live watch, so `list_devices` and a granted lease cannot disclose different versions
	 * for one device.
	 */
	onLearned(listener: (serial: string) => void): () => void {
		this.learned.add(listener);
		return () => {
			this.learned.delete(listener);
		};
	}

	/** Bring this cache up to date for one enumerated set. */
	async fill(entries: readonly AdbDevice[]): Promise<void> {
		const attached = new Set(entries.map((entry) => entry.serial));
		for (const serial of [...this.known.keys()]) {
			if (!attached.has(serial)) this.known.delete(serial);
		}

		const missing = entries.filter(
			(entry) =>
				isUsable(entry) &&
				attachmentOfSerial(entry.serial) === 'this-host' &&
				!this.known.has(entry.serial),
		);

		await Promise.all(missing.map((entry) => this.read(entry.serial)));
	}

	/** One device's read, deduplicated against a read of the same device already running. */
	private async read(serial: string): Promise<void> {
		const running = this.reading.get(serial);
		if (running !== undefined) return running;

		const attempt = this.ask(serial).then((version) => {
			// Only a success is remembered. A failure is left absent rather than cached as a
			// null, so the next enumeration asks again — a device that was still booting is
			// the case that would otherwise stay versionless until it was unplugged.
			if (version === null) return;
			this.known.set(serial, version);
			// Copied first: a listener that unsubscribes itself must not shorten the walk.
			for (const listener of [...this.learned]) listener(serial);
		});
		// Rule 4, and this is where it is actually enforced rather than assumed. `ask` answers
		// `null` rather than throwing, but a listener above is somebody else's code running
		// inside this chain — and a caller of {@link fill} is a stdout handler with nothing
		// above it to catch. A watcher that throws surfaces on the watch's own synchronous
		// delivery instead, where there is something to report it.
		const settled = attempt
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				if (this.reading.get(serial) === settled) this.reading.delete(serial);
			});
		this.reading.set(serial, settled);
		return settled;
	}

	/** The read itself. `null` for every way it can fail — see the class comment. */
	private async ask(serial: string): Promise<OsVersion | null> {
		try {
			const result = await runAdbOnDevice(parseDeviceSerial(serial), [...OS_VERSION_ARGV], {
				timeoutMs: OS_VERSION_ADB_TIMEOUT_MS,
			});
			const version = parseOsVersion(result.stdout);
			// A read that came back with neither property told this host nothing, so it is a
			// failure rather than an answer of "no version" — remembering it would be the one
			// way a device ends up permanently versionless without anything ever asking again.
			// A read that answered *one* of them is a real, partial answer and is kept.
			return version.androidRelease === null && version.apiLevel === null ? null : version;
		} catch {
			return null;
		}
	}
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
 *
 * `redact` is the same list the run itself was given, for the same reason and against the
 * same hazard: the streams quoted here are the streams `AdbCommandError` would have quoted
 * had the exit code been honest, and a host path in them crosses the boundary either way
 * (D19). Only the transfers pass one; every other caller quotes device output only.
 */
function refused(
	what: string,
	serial: DeviceSerial,
	result: AdbResult,
	redact: readonly string[] = [],
): Error {
	return new Error(
		[
			`${what} on device '${unwrap(serial)}' reported a failure`,
			`stdout: ${quoteStream(result.stdout, redact)}`,
			`stderr: ${quoteStream(result.stderr, redact)}`,
		].join('\n'),
	);
}

/**
 * The file-name suffixes `adb install` accepts, checked by **adb itself** on the string
 * before the device is reached at all: a package under any other name is refused with
 * `filename doesn't end .apk or .apex`, whatever the bytes in it are.
 *
 * That matters because the host-side layer that writes the caller's payload to a file
 * (`src/daemon/verb-handlers.ts`) names it neutrally — a package format belongs to one
 * platform, and that layer names none (ai/RULES.md §2) — so the name arriving here is
 * routinely not one adb will take. {@link withInstallablePackage} gives it one.
 *
 * **Not re-verified against a device in this change** — none was attached — which is
 * precisely why the staging is unconditional in shape rather than a branch on an error
 * message: it costs one copy of an already-bounded payload when the name is wrong, nothing
 * at all when it is right, and it is harmless if adb turns out to accept any name.
 */
const INSTALLABLE_SUFFIXES = ['.apk', '.apex'] as const;

/** What a staged package is called. Only the suffix is load-bearing; see above. */
const STAGED_PACKAGE_NAME = 'package.apk';

/** What a pulled file is called on the way through this host. Never seen by a caller. */
const PULLED_FILE_NAME = 'pulled';

/**
 * `stat`'s format string — the size, then the kind. See `./parsers/stat.js` for the order.
 *
 * A literal of this backend's own rather than a caller's value, so it is `shellArg`'d (the
 * shape check that refuses a `'`) where the path beside it is `shellText`'d.
 */
const STAT_FORMAT = '%s %F';

/** Prefixes for this backend's own scratch directories, so a stray one is attributable. */
const STAGING_PREFIX = 'rover-install-';
const PULL_PREFIX = 'rover-pull-';

/**
 * Run `use` against a directory on this host that is removed however it ends.
 *
 * The `finally` is the whole point: a transfer that throws part-way leaves the payload
 * behind otherwise, on a host that lends the same hardware to somebody else next. Removal
 * is `force`d so cleaning up after a failure cannot itself fail and replace the real error.
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
 * Hand `install` a path adb will accept, copying the package under a name it takes when the
 * one it was given is not (see {@link INSTALLABLE_SUFFIXES}).
 *
 * The copy is made only when it is needed, so a caller that already has a `.apk` pays
 * nothing, and it lives inside a directory that is removed whether the install worked or
 * not. The device is never told either name — `adb install` reads the file here.
 */
async function withInstallablePackage<Result>(
	packagePath: string,
	install: (path: string) => Promise<Result>,
): Promise<Result> {
	const named = packagePath.toLowerCase();
	if (INSTALLABLE_SUFFIXES.some((suffix) => named.endsWith(suffix))) {
		return install(packagePath);
	}

	return inHostTempDirectory(STAGING_PREFIX, async (directory) => {
		const staged = join(directory, STAGED_PACKAGE_NAME);
		await copyFile(packagePath, staged);
		return install(staged);
	});
}

/**
 * A push whose destination is a directory the device already has.
 *
 * `adb push` treats that as a request to copy the file *into* it, under the basename of
 * the path on **this host** — a name the daemon invented for a temporary file — and reports
 * `1 file pushed` (measured on API 37, PROJECT.md §6). So the caller is told `ok` about
 * bytes that are not where it asked, under a name that appears in no schema, no result and
 * no document, on hardware this host lends to somebody else next. This is the refusal that
 * makes it loud instead (ai/RULES.md §2).
 *
 * Named as a rule rather than quoted from adb, because adb never says it: its success line
 * carries the *local* path (`/tmp/…/payload: 1 file pushed, 0 skipped`), so there is
 * nothing in the output a parser could read the real destination out of.
 */
function pushedIntoDirectory(serial: DeviceSerial, devicePath: string): Error {
	return new Error(
		`'${devicePath}' is a directory on device '${unwrap(serial)}', and a push names the ` +
			'file to write, not a directory to write it into — pushing to it would put the ' +
			'file inside under a name this host chose, and report success. Name the file: ' +
			`'${devicePath}/<name>'`,
	);
}

/**
 * A pull whose source is a directory.
 *
 * The counterpart of {@link pushedIntoDirectory}, and the refusal that keeps `pull_file`'s
 * byte bound meaningful. `adb pull <dir>` is a **recursive** copy of the whole tree
 * (measured on API 37, PROJECT.md §6), while `stat` answers for the directory inode alone
 * — 4096 bytes on ext4 whatever is underneath it. So the size the probe returns says
 * nothing about what the transfer would fetch, and a caller naming `/sdcard/DCIM/Camera`
 * would have every recording on this host's temp filesystem before any check could look at
 * it. The daemon holds every lease on this machine (D6, D17), so that filesystem is not
 * one tenant's to fill.
 *
 * Refused on the *kind*, before the transfer, rather than bounded harder afterwards: there
 * is no bound that helps, because the bytes are already on the disk by the time anything
 * downstream of `adb pull` can count them.
 */
function pulledDirectory(serial: DeviceSerial, devicePath: string): Error {
	return new Error(
		`'${devicePath}' is a directory on device '${unwrap(serial)}', and a pull answers ` +
			'with the bytes of one file — pulling a directory would copy the whole tree onto ' +
			`this host before its size could be checked. Name the file: '${devicePath}/<name>'`,
	);
}

/**
 * A pull whose source is neither a regular file nor a directory.
 *
 * The other half of {@link pulledDirectory}, and the same defect on the shape that looks
 * harmless because its size is small. `%F` calls a character device, a fifo, a socket and a
 * block device something other than `regular file`, and for every one of them `%s` says
 * nothing about what a pull would fetch: `/dev/urandom` stats as **`0 character device`**,
 * so the byte bound compares 0 against the cap and lets it through, and `adb pull` then
 * writes until the transfer timeout — 769,196,032 bytes onto this host in five seconds on
 * API 37 (PROJECT.md §6). The staged-size check downstream cannot help, because it does not
 * run until that pull has returned: it bounds the daemon's heap, never its disk.
 *
 * So the refusal is on the *kind*, and it is stated positively — a pull needs a **regular
 * file**, rather than "anything that is not a directory". The device's own `%F` phrase goes
 * into the message, because the useful thing to tell a caller that named `/dev/urandom` is
 * what the device says it actually is.
 */
function pulledNonRegularFile(
	serial: DeviceSerial,
	devicePath: string,
	description: string,
): Error {
	return new Error(
		`'${devicePath}' is a ${description} on device '${unwrap(serial)}', and a pull answers ` +
			'with the bytes of one file — a path that is not a regular file has a size that says ' +
			'nothing about how much it would transfer, so it is refused rather than bounded ' +
			'afterwards. Name a regular file.',
	);
}

/**
 * A pull that exited 0 and produced no file on this host.
 *
 * The **structural** counterpart of {@link refused}, and it is what this backend asserts on
 * instead of a wording: a transfer either put the bytes on the disk or it did not, and that
 * question needs no fixture to answer — which is what makes it safe to ask on a repository
 * with no capture of a failed `adb pull` in it. Both streams are quoted anyway, because
 * whichever of them carries the reason (a missing remote object, a permission the shell
 * user does not have) is the only thing that says *why*.
 *
 * **The staging failure is described, not quoted**, and the `cause` is what keeps it: an
 * `ENOENT` from `node:fs` names the host path it was given, and this message is read on the
 * agent's machine where that path is somebody else's filesystem (D19). The cause is still
 * attached, so a host-side log has the whole of it.
 *
 * `staged` is masked out of the quoted streams for the same reason one line up: `adb pull`
 * names the destination it was writing to when it complains about it, and that destination
 * is this host's own scratch file.
 */
function pulledNothing(
	serial: DeviceSerial,
	devicePath: string,
	staged: string,
	result: AdbResult,
	cause: unknown,
): Error {
	return new Error(
		[
			`adb pull '${devicePath}' from device '${unwrap(serial)}' produced no file on this host`,
			`stdout: ${quoteStream(result.stdout, [staged])}`,
			`stderr: ${quoteStream(result.stderr, [staged])}`,
			`nothing was left where this host staged it (${nameOf(cause)})`,
		].join('\n'),
		{ cause },
	);
}

/**
 * A failure named by its *kind* rather than by its text.
 *
 * `Error.name`, or a Node `code` when there is one — `ENOENT` says everything the caller
 * needs and, unlike `message`, carries no path. The whole error is still attached as a
 * `cause` for whoever is on this host.
 */
function nameOf(cause: unknown): string {
	if (typeof cause === 'object' && cause !== null && 'code' in cause) {
		const { code } = cause as { code: unknown };
		if (typeof code === 'string') return code;
	}
	return cause instanceof Error ? cause.name : 'a non-Error value';
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
	 * {@link exclusivelyOn}'s register, and one of the two things this class holds.
	 *
	 * It is a queue and not a cache, which is the distinction D6 draws: nothing about a
	 * device is remembered here between calls, only whether a call is still running. A serial
	 * appears while one is in flight and is dropped again straight afterwards. The other
	 * thing held, {@link osVersions}, *is* a cache — and stays inside D6 by re-deriving
	 * itself at every enumeration.
	 */
	private readonly scratchUse = new Map<DeviceSerial, Promise<void>>();

	/** See {@link OsVersionCache}: one read per attached device, re-derived at enumeration. */
	private readonly osVersions = new OsVersionCache();

	/**
	 * One `adb devices -l`, then the OS version of every usable device it named.
	 *
	 * The version is filled *before* the answer is built rather than left out of it: this is
	 * the only path that reads it, and a device list that sometimes carried a version and
	 * sometimes did not would push the retry into every client. What keeps that affordable is
	 * {@link OsVersionCache} — one read per device for as long as it stays attached, in
	 * parallel across devices, and none at all for a device that could not answer.
	 */
	async listDevices(): Promise<Device[]> {
		const result = await runAdb(['devices', '-l']);

		let entries: AdbDevice[];
		try {
			entries = parseAdbDevices(result.stdout);
		} catch (cause) {
			throw unparseable('adb devices -l', result, cause);
		}

		await this.osVersions.fill(entries);
		return entries.map((entry) => toDevice(entry, this.osVersions.get(entry.serial)));
	}

	/**
	 * Watch the attached set with `adb track-devices -l`, restarting the tracker whenever it
	 * ends.
	 *
	 * The tracker re-emits the **whole** list on every change rather than a delta (verified
	 * on adb 37.0.1, 2026-08-29 — PROJECT.md §6), which is exactly what the contract asks
	 * for, so each decoded frame becomes an `onDevices` carrying that whole frame and
	 * nothing here accumulates a device set between frames.
	 *
	 * A frame is delivered **again** for every OS version this host learns while it is the
	 * latest one decoded: once immediately without the versions, and then once more per
	 * version that lands. The order is what buys it — this handler is how the host learns a
	 * device was unplugged, so it may not wait on a query, and the contract already asks a
	 * watcher to accept the full current set repeatedly.
	 *
	 * Deliberately *not* limited to what this frame's own read answered. A read that failed
	 * is retried at the next enumeration, and that enumeration is usually somebody else's —
	 * a lease grant's re-verification — so a watch that only re-delivered its own findings
	 * would keep answering `null` for a device the host had already read, with no
	 * self-correction short of unplugging it. {@link OsVersionCache.onLearned} is the seam
	 * that makes any path's answer this watch's answer too.
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
		const versions = this.osVersions;
		let stopped = false;
		let current: AdbStream | null = null;
		let restart: NodeJS.Timeout | null = null;
		let backoffMs = TRACK_RESTART_MIN_DELAY_MS;
		// The latest frame decoded, with the way to ask whether the tracker that produced it is
		// still the live one. Per watch, not per tracker: a version may land long after the
		// frame that named the device, and a restart does not make an older frame current
		// again. `null` until the first frame — there is nothing to re-deliver before then.
		let latest: { readonly entries: AdbDevice[]; readonly live: () => boolean } | null = null;

		/**
		 * The latest frame, mapped onto the neutral vocabulary with whatever versions are known
		 * *now*. Silent when there is no frame, when the watch has been stopped, or when the
		 * tracker that produced the frame has ended — an `onDevices` after an `onInterrupted`
		 * would tell an inventory its dead view had come back to life.
		 */
		const deliverLatest = (): void => {
			const frame = latest;
			if (frame === null || stopped || !frame.live()) return;
			watcher.onDevices(frame.entries.map((entry) => toDevice(entry, versions.get(entry.serial))));
		};

		// A version learned on any path — this watch's own read, or the enumeration a lease
		// grant runs — re-delivers the frame that names the device. Dropped in `stop()`, so a
		// stopped watch cannot be woken by another caller's read.
		const forgetLearned = versions.onLearned((serial) => {
			if (latest?.entries.some((entry) => entry.serial === serial)) deliverLatest();
		});

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

					// The decode is what may throw and what `end(...)` has to catch; mapping onto
					// the neutral vocabulary happens per delivery below, because the same set is
					// delivered twice when a version arrives after it.
					let snapshots: AdbDevice[][];
					try {
						snapshots = decoder.push(chunk).map((payload) => parseAdbDeviceLines(payload));
					} catch (cause) {
						end(`adb ${TRACK_DEVICES_ARGV.join(' ')}: ${message(cause)}`);
						return;
					}

					// A frame is the only evidence the view is healthy again, so it is what resets
					// the backoff — an adb that starts and dies in a loop keeps backing off.
					if (snapshots.length > 0) backoffMs = TRACK_RESTART_MIN_DELAY_MS;

					for (const entries of snapshots) {
						latest = { entries, live: () => !over };

						// Delivered the instant it is decoded, and never behind a query. This handler
						// is how the host learns a device was unplugged, and holding it for a read
						// that may take adb's whole timeout would be a regression in the one thing
						// this watch exists for — so a device whose version is not known yet is
						// delivered without one.
						deliverLatest();

						// The versions then arrive as further **full** sets, which is what a watcher
						// is already written to accept (`DeviceWatcher.onDevices`: never a delta) —
						// through `onLearned` above rather than from this call's own result, so a
						// read that answers on another path counts too. Only while this frame is
						// still the latest, though: re-delivering a superseded set would move an
						// inventory backwards. `fill` never rejects, so nothing escapes into a
						// stdout handler that has nothing above it to catch.
						void versions.fill(entries);
					}
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
				forgetLearned();
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
	 *
	 * What the *name* of that file has to be is adb's own requirement rather than the
	 * device's, and {@link withInstallablePackage} is what satisfies it without the layer
	 * above having to know a package format.
	 */
	async installApp(serial: DeviceSerial, packagePath: string): Promise<void> {
		// The wording check lives *inside* the staging closure so the path adb was handed is
		// still in scope for the refusal's own redaction: `adb install` writes that path back
		// out itself — `adb: filename doesn't end .apk or .apex: <path>`, measured (PROJECT.md §6)
		// — and the streams `refused` quotes are the streams that carry it.
		await withInstallablePackage(packagePath, async (path) => {
			const result = await runAdbOnDevice(serial, ['install', '-r', path], {
				timeoutMs: INSTALL_ADB_TIMEOUT_MS,
				redactArgv: [path],
			});

			// **No path at all**, not even the caller's own. `packagePath` is not the caller's:
			// the caller sent bytes and the daemon wrote them to a temporary file of its own
			// (`src/daemon/verb-handlers.ts`), which this call's `finally` deletes moments later.
			// This message is read on the agent's machine, where a `/var/folders/…` path names
			// nothing (D19, PROJECT.md §4) — so what identifies the package here is that the
			// caller sent it, and the device's own words say the rest.
			if (!saysSuccess(result.stdout)) {
				throw refused('adb install -r (the package you sent)', serial, result, [path]);
			}
		});
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
	 * `adb push <hostPath> <devicePath>` — the file, straight across the link.
	 *
	 * **No device shell is involved, and that is deliberate.** `push` is an adb subcommand
	 * whose arguments stay argv entries: neither path is joined into a string the device's
	 * `sh` reads, so neither takes `shellArg` and a metacharacter in a device path is a
	 * character in a file name rather than a second command (`./adb.js`, `shellArg`). Routing
	 * this through `shell cat` instead — the recipe that circulates for it — would hand a
	 * caller's path to that shell and put the payload through a pty on the way.
	 * `src/ipc/verb-methods.ts` checks the path's *shape* at the boundary, which is the
	 * check that belongs to a value nothing here interprets.
	 *
	 * **A destination that is already a directory is refused before anything moves.**
	 * Measured on API 37 (PROJECT.md §6): `adb push <file> <existing-dir>` prints `1 file
	 * pushed, 0 skipped`, exits 0, and leaves the bytes at `<existing-dir>/<host basename>`
	 * — a name the daemon made up for a temporary file. There is nothing in adb's output to
	 * catch that with, either: the line names the **local** path, never the remote one it
	 * resolved. So the check is a question put to the device first ({@link statOnDevice}),
	 * and the contract it enforces is stated on `DeviceBackend.pushFile`.
	 *
	 * **Only a directory is refused, and the asymmetry with {@link pullFile} is deliberate.**
	 * A push to a character device, a fifo or a socket is relayed, because the reason the
	 * directory case is refused does not apply to it: there the daemon's own temporary
	 * basename becomes device state under a name the caller never chose, while a push to
	 * `/dev/null` writes exactly where the caller said, and the bytes are the caller's own
	 * already-bounded upload rather than something this host has to hold. What the device
	 * makes of them is the device's answer, and it comes back as one. The rule is stated on
	 * `DeviceBackend.pushFile` so it binds every backend.
	 *
	 * **What this still does not assert, said out loud rather than left to be discovered:**
	 * the wording of an exit-0 `push` failure. `./adb.js` throws on a non-zero exit, and
	 * every other verb in this file additionally checks the *wording* of an exit-0 failure —
	 * because adb reports plenty of them that way (PROJECT.md §6). No such failure has been
	 * captured from `push`, and a wording asserted from memory is exactly what `./parsers/`
	 * and its captures exist to prevent (ai/RULES.md §6). When one is captured, the check
	 * belongs beside the others as a parser with a fixture, not as a regex inlined here.
	 */
	async pushFile(serial: DeviceSerial, hostPath: string, devicePath: string): Promise<void> {
		const existing = await this.statOnDevice(serial, devicePath);
		if (existing?.kind === 'directory') {
			throw pushedIntoDirectory(serial, devicePath);
		}

		await runAdbOnDevice(serial, ['push', hostPath, devicePath], {
			timeoutMs: TRANSFER_ADB_TIMEOUT_MS,
			redactArgv: [hostPath],
		});
	}

	/**
	 * `adb pull <devicePath>` into a directory on this host, and then the bytes.
	 *
	 * **`pull`, never `exec-out cat`**, for two reasons that both cost bytes. A `cat` puts
	 * the payload through the device's shell, where a pty can translate every `\n` into
	 * `\r\n` and silently corrupt anything that is not text — the same trap
	 * {@link screenshot} records — and it answers a missing file with an empty stream that
	 * looks exactly like an empty file. `pull` writes a file or does not, which is a question
	 * this side can answer without knowing what adb prints ({@link pulledNothing}).
	 *
	 * The staging directory is this backend's own and is removed in a `finally`: the bytes
	 * cross the boundary from the layer above, and a path on this host is never part of the
	 * answer (D19) — nor of a failure about it, which is why the pull's own argv is redacted
	 * and {@link pulledNothing} names a `code` rather than quoting `node:fs`.
	 *
	 * **Bounded twice, and neither check is the other's spare.** `options.maxBytes` is what
	 * the caller can be given, and it is asked of the *device* before the transfer starts —
	 * a 2 GB recording is refused for the price of one `stat` instead of filling this host's
	 * temp filesystem — and again of what landed, before the file is read into the daemon's
	 * heap. The daemon holds every lease on this machine (D6, D17), so an allocation a peer
	 * chose is not one tenant's mistake.
	 *
	 * **A source the probe does not call a regular file is refused before either bound**,
	 * because for every other shape a size is not an answer. `adb pull` copies a directory's
	 * tree recursively while `stat` reports the directory inode's own few kilobytes, so both
	 * bounds pass and the whole of `/sdcard/DCIM` lands here first ({@link pulledDirectory});
	 * a character device stats as `0` and pulls until the transfer timeout
	 * ({@link pulledNonRegularFile}). The staged check below is not the spare for either one —
	 * it does not run until `adb pull` has returned, so it bounds this daemon's heap and not
	 * its disk. It is the same probe `pushFile` asks and the same rule stated on
	 * `DeviceBackend.pullFile`.
	 */
	async pullFile(
		serial: DeviceSerial,
		devicePath: string,
		options: PullFileOptions,
	): Promise<Uint8Array> {
		// Asked of the device first, so a file that was never going to fit costs one `stat`
		// rather than a full transfer onto this host's disk. Both halves of the probe's answer
		// are acted on, and the *kind* has to come first: only a regular file's size predicts
		// what a pull would fetch. A directory's own size says nothing about the recursive copy
		// `adb pull` would make of it ({@link pulledDirectory}), and a character device reports
		// zero while pulling without end ({@link pulledNonRegularFile}) — the bound below would
		// admit either. A probe that answered `null` leaves the transfer where it was before
		// the probe existed, which is what keeps a device wording `%F` differently working.
		const onDevice = await this.statOnDevice(serial, devicePath);
		if (onDevice?.kind === 'directory') {
			throw pulledDirectory(serial, devicePath);
		}
		if (onDevice !== null && onDevice.kind !== 'regular-file') {
			throw pulledNonRegularFile(serial, devicePath, onDevice.description);
		}
		if (onDevice !== null && onDevice.byteLength > options.maxBytes) {
			throw new FileTooLargeError(serial, devicePath, onDevice.byteLength, options.maxBytes);
		}

		return inHostTempDirectory(PULL_PREFIX, async (directory) => {
			const staged = join(directory, PULLED_FILE_NAME);
			const result = await runAdbOnDevice(serial, ['pull', devicePath, staged], {
				timeoutMs: TRANSFER_ADB_TIMEOUT_MS,
				redactArgv: [staged],
			});

			// And again on what actually landed, **before** it is read into memory. The probe
			// above can be missed — a device whose `stat` words itself differently, a file that
			// grew between the two calls — and this one cannot: it is a `stat` of a file on this
			// host's own disk, and it is the difference between refusing an allocation and
			// making it first. The staged copy is removed by `inHostTempDirectory` either way.
			const landed = await stat(staged).catch((cause: unknown) => {
				throw pulledNothing(serial, devicePath, staged, result, cause);
			});
			if (landed.size > options.maxBytes) {
				throw new FileTooLargeError(serial, devicePath, landed.size, options.maxBytes);
			}

			// The read is guarded too, and the `stat` above is not its spare: a staged object can
			// answer a `stat` and still refuse to be read — a permission this host does not have,
			// a file that went away between the two calls — and those are the cases
			// {@link pulledNothing} was written for. Left bare, they reach the caller as whatever
			// `node:fs` said, which is a message with no device in it and a host path in it.
			return await readFile(staged).catch((cause: unknown) => {
				throw pulledNothing(serial, devicePath, staged, result, cause);
			});
		});
	}

	/**
	 * What the device says `devicePath` is, or `null` when it would not say.
	 *
	 * One `stat` standing behind both transfers, for the two questions each of them has to
	 * settle before it moves any bytes — see `./parsers/stat.js` for the command and why it
	 * follows symlinks.
	 *
	 * **`null` on any failure, and that is not laziness.** A missing path is the *ordinary*
	 * case for a push — it is the file about to be created — and toybox answers it with exit
	 * 1 and `No such file or directory` on stderr, which `./adb.js` turns into an exception.
	 * A probe that threw would make the common push fail. So a run that did not exit 0, and
	 * output this repository has no capture for, both mean the same thing here: *this probe
	 * has nothing to add*, and the caller proceeds exactly as it would have without it. Both
	 * callers keep a check that does not depend on the answer.
	 *
	 * A timeout is deliberately **not** swallowed: an adb that hung is a failing call, not a
	 * device declining to answer, and passing it on is what keeps a wedged link from looking
	 * like an unremarkable transfer.
	 */
	private async statOnDevice(serial: DeviceSerial, devicePath: string): Promise<DeviceStat | null> {
		try {
			const result = await runAdbOnDevice(serial, [
				'shell',
				'stat',
				'-L',
				'-c',
				shellArg(STAT_FORMAT),
				// `shellText`, not `shellArg`: a device path is the caller's data, and an
				// apostrophe in a file name is an ordinary character rather than a failed shape
				// check (`./adb.js`). This is the only place a transfer's path reaches a shell —
				// `push` and `pull` take theirs as argv entries and never quote them.
				shellText(devicePath),
			]);
			return parseDeviceStat(result.stdout);
		} catch (error) {
			if (error instanceof AdbCommandError && !error.timedOut) return null;
			throw error;
		}
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
