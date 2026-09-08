/**
 * The device backend for this platform, at the phase that answers *which devices are there and
 * what they are*.
 *
 * Four methods are real — {@link IosSimulatorDeviceBackend.listDevices},
 * {@link IosSimulatorDeviceBackend.describeDevice}, {@link IosSimulatorDeviceBackend.watchDevices}
 * and {@link IosSimulatorDeviceBackend.deviceInfo} — and every other **required** method of the
 * contract is a `not implemented yet` stub, which is what lets the class declare
 * `implements DeviceBackend` and have its signatures typechecked while the later phases fill them
 * in. The capability-gated methods are absent rather than stubbed: a manifest is what declares
 * those, and there is none yet.
 *
 * **This backend registers nothing** (`ai/TESTING.md`, "A backend under construction registers
 * nothing"): no `./capabilities.ts`, no `./index.ts` and no line in `../index.ts`, so
 * `tests/unit/backends/barrel.test.ts` and `tests/unit/backends/conformance.test.ts` still read
 * `['android']` after this phase. That is deliberate rather than unfinished — registering a
 * stub-bearing manifest fails the conformance gate for the backend that already passes it, so the
 * manifest lands with the last stub.
 *
 * Everything that touches a simulator goes through `./simctl.js`, everything that reads its
 * output through `./parsers/`, and the two pure modules beside this one own the vocabulary and
 * the arithmetic — `./devices.js` on the enumeration, `./screen.js` on the screen. This file is
 * the join between them and holds no text-shaped knowledge of its own: no key name, no state
 * token and no plist path appears here.
 *
 * **Nothing here quotes an argument, and that is a property of the tool rather than an
 * omission** — the counterpart to `../android/backend.ts`'s header, which has to choose a quoter
 * per value. `simctl` takes argv entries and there is no shell on either side of it
 * (`./simctl.js`), so every value this file passes is an argument and cannot become a second
 * command. A later phase that routes something through `simctl spawn <device> sh -c …` puts that
 * question back on the table.
 */

import { readFile } from 'node:fs/promises';
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
import { DeviceVanishedError } from '../../core/errors.js';
import { type AppId, type DeviceSerial, unwrap } from '../../core/ids.js';
import { SIMCTL_MISSING, SimctlNotFoundError } from './developer-dir.js';
import { IOS_SIMULATOR_PLATFORM_ID, toDevices } from './devices.js';
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
import { quoteStream, runSimctl, type SimctlResult } from './simctl.js';

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

	/*
	 * The required methods the later phases own: the app lifecycle and the two transfers (phase
	 * 3), the capture and the log read (phase 4). Present so the class declares
	 * `implements DeviceBackend` and has its signatures checked against the contract now rather
	 * than one phase at a time; each throws the `not implemented yet` sentinel
	 * `tests/helpers/backend-conformance.ts` scans for, which is harmless while nothing is
	 * registered and is what would fail the gate the moment something were.
	 */

	async installApp(_serial: DeviceSerial, _packagePath: string): Promise<void> {
		throw new Error(`${IOS_SIMULATOR_PLATFORM_ID}: installApp is not implemented yet`);
	}

	async launchApp(_serial: DeviceSerial, _appId: AppId): Promise<void> {
		throw new Error(`${IOS_SIMULATOR_PLATFORM_ID}: launchApp is not implemented yet`);
	}

	async stopApp(_serial: DeviceSerial, _appId: AppId): Promise<void> {
		throw new Error(`${IOS_SIMULATOR_PLATFORM_ID}: stopApp is not implemented yet`);
	}

	async clearAppData(_serial: DeviceSerial, _appId: AppId): Promise<void> {
		throw new Error(`${IOS_SIMULATOR_PLATFORM_ID}: clearAppData is not implemented yet`);
	}

	async screenshot(_serial: DeviceSerial): Promise<Uint8Array> {
		throw new Error(`${IOS_SIMULATOR_PLATFORM_ID}: screenshot is not implemented yet`);
	}

	async readLogs(_serial: DeviceSerial, _options: ReadLogsOptions): Promise<LogRead> {
		throw new Error(`${IOS_SIMULATOR_PLATFORM_ID}: readLogs is not implemented yet`);
	}

	async pushFile(_serial: DeviceSerial, _hostPath: string, _devicePath: string): Promise<void> {
		throw new Error(`${IOS_SIMULATOR_PLATFORM_ID}: pushFile is not implemented yet`);
	}

	async pullFile(
		_serial: DeviceSerial,
		_devicePath: string,
		_options: PullFileOptions,
	): Promise<Uint8Array> {
		throw new Error(`${IOS_SIMULATOR_PLATFORM_ID}: pullFile is not implemented yet`);
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
