/**
 * The device backend for this platform.
 *
 * Under construction: it answers enumeration, presence and the device facts, and the
 * remaining contract methods land in the phases after this one. So it declares
 * `implements Pick<DeviceBackend, …>` rather than `implements DeviceBackend` — the three
 * signatures are checked against the shared contract from day one, while the compiler is
 * never satisfied with a stub standing in for a method nobody has written. A stub written
 * to satisfy `implements` is precisely what the conformance gate exists to catch
 * (ai/TESTING.md), and nothing registers this class until it is whole.
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
import { type AdbResult, runAdb, runAdbOnDevice } from './adb.js';
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

export class AndroidDeviceBackend
	implements Pick<DeviceBackend, 'listDevices' | 'describeDevice' | 'deviceInfo'>
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
}
