/**
 * The device backend for this platform.
 *
 * Under construction: it answers enumeration, presence, the device facts and the app
 * lifecycle, and `screenshot` lands in the phase after this one. So it declares
 * `implements Pick<DeviceBackend, …>` rather than `implements DeviceBackend` — every
 * signature it does answer is checked against the shared contract from day one, while the
 * compiler is never satisfied with a stub standing in for a method nobody has written. A
 * stub written to satisfy `implements` is precisely what the conformance gate exists to
 * catch (ai/TESTING.md), and nothing registers this class until it is whole.
 *
 * Everything that touches the device goes through `./adb.js`, and everything that reads
 * its output goes through `./parsers/`. This file is the join between them and holds no
 * text-shaped knowledge of its own.
 */

import {
	type Device,
	type DeviceBackend,
	type DeviceInfo,
	DeviceInfoSchema,
	DeviceSchema,
	type DeviceState,
} from '../../core/device.js';
import { type DeviceSerial, unwrap } from '../../core/ids.js';
import {
	type AdbResult,
	INSTALL_ADB_TIMEOUT_MS,
	quoteStream,
	runAdb,
	runAdbOnDevice,
} from './adb.js';
import { ANDROID_PLATFORM_ID } from './capabilities.js';
import { type AdbDevice, isUsable, parseAdbDevices } from './parsers/devices.js';
import { parseGetprop } from './parsers/getprop.js';
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
 * The word `adb install` and `pm clear` both print, on a line of their own, when the work
 * was actually done. Matched as a whole line rather than against the trimmed stream: a
 * successful `adb install` on adb 37.0.1 prints four lines, of which this is the third
 * (PROJECT.md §6).
 */
const SUCCESS_LINE = 'Success';

/** `am start` names the intent it dispatched before anything can have gone wrong with it. */
const START_DISPATCHED = 'Starting: Intent';

/**
 * How `am` announces a refusal — with a line, never with an exit code it can be trusted on.
 *
 * `Warning: Activity not started, …` is deliberately absent: it means the app was already
 * the top-most instance, which is a launch that succeeded. `Error type 3` and `Error: …`
 * are the two `am` prints for a component it will not start, and a shell command that
 * threw prints `Exception occurred while executing 'start':` above a Java stack trace
 * whose head line is the exception class (PROJECT.md §6).
 */
const AM_REFUSAL = /^(?:Error\b|Exception occurred\b|java\.[\w.]+(?:Exception|Error)\b)/;

/** A `<package>/<class>` component name, the only shape `am start -n` accepts. */
const COMPONENT = /^[^\s/]+\/\S+$/;

/**
 * The meaningful lines of one captured stream.
 *
 * The `\r` is why this trims rather than splits alone: nothing on an API 37 emulator over
 * the v2 shell protocol carries one, but a device that falls back to a pty-backed shell
 * ends every line `\r\n`, and an equality test against `Success` is exactly the assertion
 * that would then silently stop matching.
 */
function outputLines(stream: string): string[] {
	return stream
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
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

export class AndroidDeviceBackend
	implements
		Pick<
			DeviceBackend,
			| 'listDevices'
			| 'describeDevice'
			| 'deviceInfo'
			| 'installApp'
			| 'launchApp'
			| 'stopApp'
			| 'clearAppData'
		>
{
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
	 * The success test is a `Success` **line**, not the trimmed stream and not an empty
	 * stderr — adb 37.0.1 wraps it in `Serving…`, `Performing Incremental Install` and
	 * `Install command complete in N ms`, and writes `All files should be loaded. Notifying
	 * the device.` to stderr on the way through (PROJECT.md §6). Either shortcut would
	 * reject a install that worked.
	 */
	async installApp(serial: DeviceSerial, packagePath: string): Promise<void> {
		const result = await runAdbOnDevice(serial, ['install', '-r', packagePath], {
			timeoutMs: INSTALL_ADB_TIMEOUT_MS,
		});

		if (!outputLines(result.stdout).includes(SUCCESS_LINE)) {
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
	async launchApp(serial: DeviceSerial, appId: string): Promise<void> {
		const component = await this.resolveLaunchComponent(serial, appId);
		const result = await runAdbOnDevice(serial, ['shell', 'am', 'start', '-n', component]);

		const dispatched = outputLines(result.stdout).some((line) => line.startsWith(START_DISPATCHED));
		const refusal = [...outputLines(result.stdout), ...outputLines(result.stderr)].some((line) =>
			AM_REFUSAL.test(line),
		);
		if (!dispatched || refusal) throw refused(`am start -n ${component}`, serial, result);
	}

	/**
	 * `am force-stop <appId>`.
	 *
	 * **This is the one verb here with no success wording to assert**, so silence is the
	 * assertion: on API 37 a force-stop that worked prints zero bytes on both streams, and
	 * anything printed at all is therefore something going wrong. The cost is stated rather
	 * than papered over — an app id no package has is *also* zero bytes and exit 0, so this
	 * cannot tell "stopped it" from "there was nothing by that name" (PROJECT.md §6).
	 * Answering whether the app is really gone is the verb layer's post-state (#11), which
	 * reads the device rather than adb's opinion of it.
	 */
	async stopApp(serial: DeviceSerial, appId: string): Promise<void> {
		const result = await runAdbOnDevice(serial, ['shell', 'am', 'force-stop', appId]);

		if (outputLines(result.stdout).length > 0 || outputLines(result.stderr).length > 0) {
			throw refused(`am force-stop ${appId}`, serial, result);
		}
	}

	/** `pm clear <appId>` — `Success` on stdout, or the `Failed` this refuses to swallow. */
	async clearAppData(serial: DeviceSerial, appId: string): Promise<void> {
		const result = await runAdbOnDevice(serial, ['shell', 'pm', 'clear', appId]);

		if (!outputLines(result.stdout).includes(SUCCESS_LINE)) {
			throw refused(`pm clear ${appId}`, serial, result);
		}
	}

	/**
	 * The `<package>/<class>` component to launch an app id by, asked of the device.
	 *
	 * `cmd package resolve-activity --brief` prints a `priority=… isDefault=true` header
	 * line above its answer, so the answer is the **last** line — and it answers
	 * `No activity found` on stdout with exit 0 both for a package that is not installed
	 * and for one that is installed but has nothing launchable (PROJECT.md §6). Neither is
	 * a component, which is why the shape is checked rather than the wording: the day that
	 * sentence changes, an unlaunchable app must still fail here rather than be handed to
	 * `am start -n` as a component name.
	 */
	private async resolveLaunchComponent(serial: DeviceSerial, appId: string): Promise<string> {
		const result = await runAdbOnDevice(serial, [
			'shell',
			'cmd',
			'package',
			'resolve-activity',
			'--brief',
			appId,
		]);

		const answer = outputLines(result.stdout).at(-1) ?? '';
		if (!COMPONENT.test(answer)) {
			throw refused(`resolving a launchable activity of '${appId}'`, serial, result);
		}

		return answer;
	}
}
