/**
 * Device-layer error types.
 *
 * "This device cannot do that" and "this broke" call for opposite responses from an
 * agent, so a missing capability is its own type rather than a generic `Error`
 * (ai/CODING_STANDARDS.md "Error handling", D11). The same test admits the two below:
 * "the device went away" and "the device is not this host's to lend" are each an answer
 * a caller acts on differently, and neither is a bug. Everything else in this layer
 * throws plain `Error` for a programmer or validation bug, and returns `null` for
 * not-found.
 *
 * Imports from `./capabilities.js` are type-only on purpose: that module imports this
 * one for its value, so an erased edge is what keeps the pair free of a runtime cycle.
 */

import type { CapabilityId } from './capabilities.js';
import type { DeviceSerial, PlatformId } from './ids.js';

/**
 * Thrown when a verb needs a capability the device's backend does not declare.
 *
 * Names the capability, the device and the backend, because that is what tells the
 * caller whether to try another device or stop asking (D11). Never degrade instead of
 * throwing this: a plausible-looking empty result where the honest answer is "this
 * device cannot do that" is the failure the capability model exists to prevent.
 */
export class MissingCapabilityError extends Error {
	readonly capability: CapabilityId;
	readonly serial: DeviceSerial;
	readonly platform: PlatformId;
	readonly backendLabel: string;

	constructor(
		capability: CapabilityId,
		serial: DeviceSerial,
		platform: PlatformId,
		backendLabel: string,
	) {
		super(
			`Device '${serial}' cannot do '${capability}': the ${backendLabel} backend ` +
				`('${platform}') does not declare that capability`,
		);
		this.name = 'MissingCapabilityError';
		this.capability = capability;
		this.serial = serial;
		this.platform = platform;
		this.backendLabel = backendLabel;
	}
}

/**
 * Thrown when a device that was in the host's inventory is no longer attached to it.
 *
 * A device disappearing between the enumeration that put it in the cache and the moment
 * someone asks to be granted it is an **ordinary case with a name**, not an exception
 * path (D6): the daemon is a cache, the platform is the truth, and the gap between the
 * two is exactly what re-verification exists to find. Answering with a stale entry
 * instead would hand out a device that is not there, and the failure would surface as a
 * verb timing out against nothing.
 */
export class DeviceVanishedError extends Error {
	readonly serial: DeviceSerial;

	constructor(serial: DeviceSerial) {
		super(
			`Device '${serial}' is no longer attached to this host — it was there when the host ` +
				`last enumerated its devices and it is not there now`,
		);
		this.name = 'DeviceVanishedError';
		this.serial = serial;
	}
}

/**
 * Thrown when a device is visible to this host but attached to another one.
 *
 * A device belongs to exactly one host — the one it is attached to (D18) — and every
 * platform this targets has a network transport that makes another machine's device
 * appear here, indistinguishable from a local one in everything but
 * `Device.attachment`. Treating such an entry as this host's to lend is the
 * two-agents-one-device failure in its worst form: two hosts each grant a lease on the
 * same hardware and both report success. So it never enters the inventory, and asking
 * for it by name gets this rather than silence.
 */
export class ForeignDeviceError extends Error {
	readonly serial: DeviceSerial;

	constructor(serial: DeviceSerial) {
		super(
			`Device '${serial}' is attached to another host, so it is that host's to lend (D18) — ` +
				`ask the host it is attached to, not this one`,
		);
		this.name = 'ForeignDeviceError';
		this.serial = serial;
	}
}
