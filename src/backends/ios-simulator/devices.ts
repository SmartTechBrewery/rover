/**
 * The mapping from `simctl`'s device listing onto the neutral `Device[]` of
 * `src/core/device.ts`.
 *
 * Its own pure module rather than private helpers inside a backend class — which is where
 * the Android equivalents live — because there is no backend class here yet: this layer
 * ships with **no process spawning and no registration** at all, so what it is is a
 * function from two parsed listings to a validated inventory.
 *
 * The platform's vocabulary stops at this file. Everything above it sees only
 * `Device`, and `DeviceSchema.parse` on every result is what makes that a checked claim
 * rather than a convention.
 */

import { type Device, DeviceSchema, type DeviceState } from '../../core/device.js';
import { SIMULATOR_ATTACHMENT } from './attachment.js';
import type {
	SimctlDevice,
	SimctlDeviceList,
	SimctlRuntime,
	SimctlRuntimeList,
} from './parsers/simctl-list.js';

/**
 * This backend's registry key.
 *
 * **`ios-simulator`, not `ios`** — deliberately, and this is the reason the whole folder
 * carries that name. A physical iPhone cannot answer `screenshot`, which is a *required*
 * method of `DeviceBackend` rather than a gated capability: Apple's supported path to one
 * has no screenshot subcommand at all, so hardware needs a WebDriverAgent-class in-device
 * agent before it is a device this contract can lend (`docs/IOS.md` §6, §10). A backend
 * named after the platform would promise it. This one promises the simulator, which it can
 * deliver.
 */
export const IOS_SIMULATOR_PLATFORM_ID = 'ios-simulator';

/** The `platform` a runtime reports for the devices this backend addresses. */
const IOS_PLATFORM = 'iOS';

/** The one state token that means a verb can run on this device. */
const BOOTED_STATE = 'Booted';

/**
 * `Booted` is the only `ready`; everything else is `offline`.
 *
 * **`unauthorized` is unreachable here, and that is worth a sentence.** A simulator has no
 * pairing prompt, so nothing this module enumerates can be in that state — the neutral
 * value exists for hardware this backend does not admit (`./attachment.js`). Everything
 * that is not `Booted` collapses to `offline` because the token list `simctl` can print
 * (`Shutdown`, `Booting`, `Shutting Down`, `Creating`, …) is longer than the fixtures pin
 * (`tests/fixtures/ios-simulator/README.md`) and the conservative answer for an unpinned
 * token is the true one either way: visible to the host, and no verb can run on it. A
 * `Booting` device in particular is not usable — capture on a device that is not `Booted`
 * hangs for a minute and then fails (`docs/IOS.md` §8, trap 1).
 */
function toDeviceState(entry: SimctlDevice): DeviceState {
	return entry.state === BOOTED_STATE ? 'ready' : 'offline';
}

/**
 * One device, under the runtime its map key resolved to.
 *
 * Field by field, where each value comes from and why:
 *
 * - **`serial`** ← `udid`. Opaque and unparsed; `DeviceSchema` brands it.
 * - **`model`** ← `name`. The only device-facing name the *device* listing carries, and it
 *   is **operator-chosen**: a renamed simulator reports the new name, and two simulators of
 *   the same hardware can carry different ones. The device *type*'s own name and its
 *   `modelIdentifier` need the `devicetypes` listing, which a later phase of this split
 *   introduces — so this is not a hardware model that was read, and saying so plainly beats
 *   implying otherwise.
 * - **`osVersion`** ← the joined runtime's `version`, and **never** the runtime identifier.
 *   Measured on Xcode 26.4.1, 2026-09-08: the device map's key is
 *   `com.apple.CoreSimulator.SimRuntime.iOS-26-4` while that runtime reports `26.4.1`, so
 *   reading the key would report a version no installed runtime has.
 * - **`osApiLevel`** ← `null`, always. This platform has no API level, and deriving one
 *   from the version string would be inventing data and then handing it over as if the
 *   device had said it.
 * - **`attachment`** ← `./attachment.js`, which carries the reasoning.
 */
function toDevice(entry: SimctlDevice, runtime: SimctlRuntime | undefined): Device {
	return DeviceSchema.parse({
		serial: entry.udid,
		platform: IOS_SIMULATOR_PLATFORM_ID,
		model: entry.name,
		osVersion: runtime?.version ?? null,
		osApiLevel: null,
		state: toDeviceState(entry),
		attachment: SIMULATOR_ATTACHMENT,
	});
}

/**
 * Every device of the `devices` listing that this platform id addresses, mapped onto the
 * neutral shape.
 *
 * Two decisions about which devices come out, which look contradictory and are not:
 *
 * 1. **A device under a non-iOS runtime is excluded.** That is data from the tool, not an
 *    inference: the runtime's own `platform` field says `watchOS` or `tvOS`, so an Apple
 *    Watch simulator is not a device this platform id addresses and reporting one as
 *    `ios-simulator` would be a wrong answer this module has the evidence to avoid. It is
 *    decided from that field rather than from a name or an identifier for the usual reason
 *    (`./parsers/simctl-list.js`).
 * 2. **A device whose runtime key does not resolve is kept**, with `osVersion: null`. That
 *    is `DeviceSchema`'s own rule: an unresolved key — an uninstalled or renamed runtime —
 *    is not evidence that the device is *not* one of this platform's, so the device is
 *    reported without a version rather than dropped. A device the host can see is a device
 *    the host reports.
 *
 * Both listings are arguments because both are needed and neither is derivable from the
 * other; how they were captured, and in how many invocations, is the caller's business.
 */
export function toDevices(devices: SimctlDeviceList, runtimes: SimctlRuntimeList): Device[] {
	const byIdentifier = new Map(runtimes.runtimes.map((runtime) => [runtime.identifier, runtime]));
	const mapped: Device[] = [];

	for (const [identifier, entries] of Object.entries(devices.devices)) {
		const runtime = byIdentifier.get(identifier);
		if (runtime !== undefined && runtime.platform !== IOS_PLATFORM) continue;

		for (const entry of entries) {
			mapped.push(toDevice(entry, runtime));
		}
	}

	return mapped;
}
