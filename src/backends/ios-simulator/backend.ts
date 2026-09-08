/**
 * The device backend for this platform, at the phase that adds *the app lifecycle and the two
 * file transfers* to the enumeration.
 *
 * Ten methods are real — the four the enumeration phase brought, plus
 * {@link IosSimulatorDeviceBackend.installApp}, {@link IosSimulatorDeviceBackend.launchApp},
 * {@link IosSimulatorDeviceBackend.stopApp}, {@link IosSimulatorDeviceBackend.clearAppData},
 * {@link IosSimulatorDeviceBackend.pushFile} and {@link IosSimulatorDeviceBackend.pullFile}.
 * `screenshot` and `readLogs` are still `not implemented yet` stubs, which is what lets the class
 * declare `implements DeviceBackend` and have its signatures typechecked while the next phase
 * fills them in. The capability-gated methods are absent rather than stubbed: a manifest is what
 * declares those, and there is none yet.
 *
 * **This backend registers nothing** (`ai/TESTING.md`, "A backend under construction registers
 * nothing"): no `./capabilities.ts`, no `./index.ts` and no line in `../index.ts`, so
 * `tests/unit/backends/barrel.test.ts` and `tests/unit/backends/conformance.test.ts` still read
 * `['android']` after this phase. That is deliberate rather than unfinished — registering a
 * stub-bearing manifest fails the conformance gate for the backend that already passes it, so the
 * manifest lands with the last stub.
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
 * command. A later phase that routes something through `simctl spawn <device> sh -c …` puts that
 * question back on the table.
 */

import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
	type Device,
	type DeviceBackend,
	type DeviceInfo,
	DeviceInfoSchema,
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
import {
	parseSimctlDevices,
	parseSimctlDeviceTypes,
	parseSimctlRuntimes,
	type SimctlDevice,
	type SimctlDeviceList,
	type SimctlDeviceType,
	type SimctlRuntimeList,
} from './parsers/simctl-list.js';
import { deviceTypeProfilePath, toScreenInfo } from './screen.js';
import {
	INSTALL_SIMCTL_TIMEOUT_MS,
	quoteStream,
	runSimctl,
	runSimctlOnDevice,
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
	const code = cause instanceof Error && 'code' in cause ? String(cause.code) : 'unknown';
	return new Error(
		`'${devicePath}' on device '${unwrap(serial)}' could not be read (${code}). On this ` +
			"platform that path is a file in the device's own storage on the host lending it, so " +
			'this is the file not being there, or not being readable by the user running the host.',
		{ cause },
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
			await runSimctlOnDevice(serial, 'install', [staged], {
				timeoutMs: INSTALL_SIMCTL_TIMEOUT_MS,
				redactArgv: [staged],
			});
		});
	}

	async screenshot(_serial: DeviceSerial): Promise<Uint8Array> {
		throw new Error(`${IOS_SIMULATOR_PLATFORM_ID}: screenshot is not implemented yet`);
	}

	async readLogs(_serial: DeviceSerial, _options: ReadLogsOptions): Promise<LogRead> {
		throw new Error(`${IOS_SIMULATOR_PLATFORM_ID}: readLogs is not implemented yet`);
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
	 */
	async pushFile(serial: DeviceSerial, hostPath: string, devicePath: string): Promise<void> {
		const target = hostPathOf(serial, await this.dataRootOf(serial), devicePath);

		// `null` when there is nothing there, which is the *ordinary* case for a push — the file
		// about to be created. Only the one shape the contract refuses is read off the answer.
		const existing = await stat(target).catch(() => null);
		if (existing?.isDirectory() === true) throw pushedIntoDirectory(serial, devicePath);

		await mkdir(dirname(target), { recursive: true });
		await copyFile(hostPath, target);
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
