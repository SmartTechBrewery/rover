/**
 * The device backend for this platform.
 *
 * It answers every required method of the contract — enumeration, presence, the device
 * facts, the app lifecycle and the capture — with no stub, which is what lets it declare
 * `implements DeviceBackend` and what lets `./index.ts` register it (ai/TESTING.md, "A
 * backend under construction registers nothing"). The three capability-gated groups are a
 * declared opt-out in `./capabilities.ts` rather than an omission, and each flips in the
 * change that lands its methods.
 *
 * Everything that touches the device goes through `./adb.js`, and everything that reads
 * its output goes through `./parsers/`. This file is the join between them and holds no
 * text-shaped knowledge of its own — the wording every app verb asserts on lives in
 * `./parsers/app-control.js`, pinned against captures, and every value that enters a
 * device-side command line is quoted by `./adb.js`'s `shellArg`.
 */

import {
	type Device,
	type DeviceBackend,
	type DeviceInfo,
	DeviceInfoSchema,
	DeviceSchema,
	type DeviceState,
} from '../../core/device.js';
import { type AppId, type DeviceSerial, parseAppId, unwrap } from '../../core/ids.js';
import {
	type AdbBinaryResult,
	type AdbResult,
	describeBytes,
	INSTALL_ADB_TIMEOUT_MS,
	quoteStream,
	runAdb,
	runAdbBinaryOnDevice,
	runAdbOnDevice,
	SCREENSHOT_ADB_TIMEOUT_MS,
	shellArg,
} from './adb.js';
import { ANDROID_PLATFORM_ID } from './capabilities.js';
import {
	isSilent,
	parseResolvedActivity,
	saysSuccess,
	startedActivity,
} from './parsers/app-control.js';
import { type AdbDevice, isUsable, parseAdbDevices } from './parsers/devices.js';
import { parseGetprop } from './parsers/getprop.js';
import { isPng } from './parsers/screencap.js';
import { parseWmDensity, parseWmSize } from './parsers/wm.js';

/** The state token adb prints for a device whose authorisation was refused or not granted. */
const UNAUTHORIZED_STATE = 'unauthorized';

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
function unparseable(command: string, result: AdbResult, cause: unknown): Error {
	const reason = cause instanceof Error ? cause.message : String(cause);
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
	async listDevices(): Promise<Device[]> {
		const result = await runAdb(['devices', '-l']);

		try {
			return parseAdbDevices(result.stdout).map(toDevice);
		} catch (cause) {
			throw unparseable('adb devices -l', result, cause);
		}
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
