/**
 * The mapping from this platform's device vocabularies onto the neutral `Device[]` of
 * `src/core/device.ts`.
 *
 * Its own pure module rather than private helpers inside a backend class — which is where
 * the Android equivalents live — because there is no backend class here yet: this layer
 * ships with **no process spawning and no registration** at all, so what it is is a
 * function from parsed listings to a validated inventory.
 *
 * **Two sources, one file.** {@link toDevices} reads `simctl list`'s two listings and
 * {@link toNotifiedDevices} reads one frame of `idb_companion --notify`. They live together
 * because they have to agree about three things — this backend's platform id, what `ready`
 * means, and the attachment — and a second module would be a second place for each of those to
 * be decided. Where they cannot agree, this file is where the reconciliation is written down and
 * argued: `osVersion` is the one that needed it.
 *
 * **A third export, {@link borrowableNow}, is what the inventory narrows through** — and both
 * mappings go through the same one, for the same reason they share `toDeviceState`.
 *
 * The platform's vocabulary stops at this file. Everything above it sees only
 * `Device`, and `DeviceSchema.parse` on every result is what makes that a checked claim
 * rather than a convention.
 */

import { type Device, DeviceSchema, type DeviceState } from '../../core/device.js';
import { SIMULATOR_ATTACHMENT } from './attachment.js';
import type { IdbTarget, IdbTargetList } from './parsers/idb-notify.js';
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

/** The one `type` an idb target may carry and still be a device this backend addresses. */
const SIMULATOR_TARGET_TYPE = 'Simulator';

/**
 * How idb spells the platform in front of a target's version — `iOS 26.5`, where `simctl`'s
 * runtime reports a bare `26.5` for that same runtime.
 *
 * Captured on `idb_companion` v1.5.2 / Xcode 26.6 / iOS 26.5, 2026-09-08
 * (`tests/fixtures/ios-simulator/README.md`). The trailing space is part of the pattern: it is
 * what separates the platform word from the version, and a target whose `os_version` is just
 * `iOS` names no version at all.
 */
const IOS_VERSION_PREFIX = `${IOS_PLATFORM} `;

/**
 * `Booted` is the only `ready`; everything else is `offline`.
 *
 * **One rule for both sources**, which is why it takes a bare token rather than one source's
 * entry: `simctl list` and `idb_companion --notify` print the same state words for the same
 * device, and the moment they were read separately a lease grant and the watch could disagree
 * about whether one device is usable.
 *
 * **`unauthorized` is unreachable here, and that is worth a sentence.** A simulator has no
 * pairing prompt, so nothing this module enumerates can be in that state — the neutral
 * value exists for hardware this backend does not admit (`./attachment.js`). Everything
 * that is not `Booted` collapses to `offline` because the token list these tools can print
 * (`Shutdown`, `Booting`, `Shutting Down`, `Creating`, …) is longer than the fixtures pin
 * (`tests/fixtures/ios-simulator/README.md`) and the conservative answer for an unpinned
 * token is the true one either way: visible to the host, and no verb can run on it. A
 * `Booting` device in particular is not usable — capture on a device that is not `Booted`
 * hangs for a minute and then fails (`docs/IOS.md` §8, trap 1).
 *
 * What the **inventory** does with an `offline` simulator is a separate decision, one level up:
 * it does not list it at all ({@link borrowableNow}). This function is still what decides that,
 * and it is still the one place the tokens are read.
 */
function toDeviceState(state: string): DeviceState {
	return state === BOOTED_STATE ? 'ready' : 'offline';
}

/**
 * The devices of a mapped set this host will lend **right now** — every `Booted` simulator, and
 * nothing else (#267).
 *
 * **The narrowing belongs to the inventory, not to the vocabulary**, which is why it is a
 * function here rather than a `continue` inside the two mappings below. `simctl list devices`
 * answers *what could this machine run* — every simulator ever created, eleven rows on the bench
 * this was written against with one of them usable — while `adb devices` answers *what can you
 * borrow now*: an unplugged phone simply stops being listed. Those are two different questions,
 * and the device list is the second one, so this platform's enumeration is narrowed onto it
 * rather than the other half of the list being widened (`PROJECT.md` D41 records the symmetric
 * alternative and why it was rejected).
 *
 * **This is not a rule about devices that are not `ready`, and it is not applied anywhere else.**
 * An Android phone plugged in with USB debugging unauthorized is `unauthorized`, and that row is
 * the only clue its operator gets about why the phone is unusable — a device that is present but
 * unusable is still present, and still says so. What makes the narrowing honest on *this*
 * platform is narrower than the state: the only thing that makes a simulator not `ready` is not
 * running, and a simulator that is not running is not a device this host has, in the same way an
 * unplugged phone is not.
 *
 * **A simulator in a transitional state is out, deliberately.** `Booting` and `Shutting Down` are
 * not `Booted`, so neither is listed, and that is a choice between two consistent answers rather
 * than an accident of the mapping. A `Booting` device cannot be borrowed — a capture on one hangs
 * for a minute and then fails (`docs/IOS.md` §8, trap 1) — so listing it would put a row in the
 * list that an `acquire` would refuse, and it would then appear and vanish across a single boot,
 * which is worse than either answer. The cost is the boot's own duration of not seeing a
 * simulator somebody is starting; the watch delivers it the moment it is up.
 *
 * Applied to the **inventory** — `listDevices` and the watch — and never to a question asked
 * about a *named* device. `describeDevice` and `deviceInfo` are asked by a caller who already has
 * one device in mind, where the honest answer is what that device is: a lease grant that says
 * *'offline' rather than ready* names something to fix, and `deviceInfo` reads its screen off the
 * device type rather than off a running system, so it needs no booted simulator at all
 * (`./backend.js`).
 */
export function borrowableNow(devices: Device[]): Device[] {
	// The state {@link toDeviceState} already decided, rather than the token read a second time:
	// `ready` is exactly `Booted` here, and two readings of one fact is how they come to disagree.
	return devices.filter((device) => device.state === 'ready');
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
		state: toDeviceState(entry.state),
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

/**
 * The version alone, out of the platform-qualified spelling idb reports — or `null` when the value
 * is not that shape.
 *
 * **This is the one real trap in this mapping.** `simctl`'s runtime reports `26.5` while the idb
 * target for the same device reports `iOS 26.5`. If the watch published one spelling and
 * `listDevices` the other, `list_devices` and the inventory would disclose two different OS
 * versions for one device — the disagreement `deviceInfo`'s `model` note already refuses on the
 * model field. So this path is normalised onto the other one rather than the other way round:
 * `simctl`'s answer is what a lease grant re-verifies against (D6), and stripping a prefix is a
 * claim that can be checked while inventing one is not.
 *
 * A value that is not the expected shape answers `null` rather than a guess. It does **not** reach
 * a device with a `null` version, though — {@link toNotifiedDevices} drops that target, because on
 * this path the platform word is also the only evidence there is about which platform the target
 * belongs to. The two are the same fact read for two purposes, which is why the exclusion is
 * argued there rather than here.
 */
function toNotifiedOsVersion(target: IdbTarget): string | null {
	if (!target.os_version.startsWith(IOS_VERSION_PREFIX)) return null;
	const version = target.os_version.slice(IOS_VERSION_PREFIX.length);
	return version === '' ? null : version;
}

/**
 * Every target of one `idb_companion --notify` frame that this platform id addresses, mapped onto
 * the neutral shape.
 *
 * A second entry point beside {@link toDevices} rather than a module of its own, because the two
 * have to agree about three things — the platform id, what `ready` means and the attachment — and
 * a second module would be a second place for each of them to be decided.
 *
 * **Only a simulator under an iOS runtime is admitted, and it is an allowlist.** idb enumerates
 * physical targets as well as simulators, and a physical iPhone is outside this backend
 * entirely: it cannot answer `screenshot`, which is a *required* method rather than a gated
 * capability (`docs/IOS.md` §6), and `./attachment.js` records that a paired-but-absent iPhone is
 * served by this platform's tooling by default, forever. An allowlist rather than a blocklist
 * because the direction of the mistake is not symmetric — an unrecognised target excluded is a
 * device this host declines to lend, while one admitted by default is D18's
 * two-agents-one-device failure wearing a disguise.
 *
 * The two conditions are separate on purpose: `type` excludes hardware, and the `iOS ` prefix
 * excludes a watchOS or tvOS simulator, which is the same exclusion {@link toDevices} makes from
 * the runtime's `platform` field. A target failing either is dropped rather than reported with a
 * `null` version — where an unresolved *runtime* leaves a device this host can see (so it is
 * reported), an unrecognised platform word is the evidence that it is not this platform's device.
 *
 * `DeviceSchema.parse` on the way out, as {@link toDevices} does: the platform's vocabulary stops
 * at this file, and that call is what makes it a checked claim rather than a convention.
 */
export function toNotifiedDevices(targets: IdbTargetList): Device[] {
	const mapped: Device[] = [];

	for (const target of targets) {
		if (target.type !== SIMULATOR_TARGET_TYPE) continue;

		const osVersion = toNotifiedOsVersion(target);
		if (osVersion === null) continue;

		mapped.push(
			DeviceSchema.parse({
				serial: target.udid,
				platform: IOS_SIMULATOR_PLATFORM_ID,
				// `name`, not `model`: the same field under the same name as on the simctl path, and
				// operator-chosen on both. idb reports the device type separately as `model`, which
				// `simctl list devices` does not carry at all — taking it here would make the two paths
				// disagree about one device the moment anyone renames a simulator.
				model: target.name,
				osVersion,
				// This platform has no API level, on either path.
				osApiLevel: null,
				// The same predicate the simctl path uses, not a second copy of the rule: two device
				// sources that disagreed about what `ready` means would make a lease grant and the
				// watch disagree about one device, which is the failure D6's re-verification exists to
				// catch rather than to tolerate. The token spellings match — the notify capture carries
				// `Booted`, `Booting`, `Shutting Down` and `Shutdown`, the same words `simctl` prints.
				state: toDeviceState(target.state),
				attachment: SIMULATOR_ATTACHMENT,
			}),
		);
	}

	return mapped;
}
