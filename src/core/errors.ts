/**
 * Device-layer error types.
 *
 * "This device cannot do that" and "this broke" call for opposite responses from an
 * agent, so a missing capability is its own type rather than a generic `Error`
 * (ai/CODING_STANDARDS.md "Error handling", D11). The same test admits the two below:
 * "the device went away" and "the device is not attached to this host" are each an answer
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
 * Thrown when a device is visible to this host but not physically attached to it.
 *
 * Every platform this targets has a network transport, so hardware that is not this
 * machine's can be reached over one and show up here, indistinguishable from a local
 * device in everything but `Device.attachment`. Leasing one out hands an agent a device
 * this host does not control: it can vanish without warning, and whatever process put it
 * there is still using it (D18, revised 2026-08-29). So it never enters the inventory,
 * and asking for it by name gets this rather than silence.
 */
export class ForeignDeviceError extends Error {
	readonly serial: DeviceSerial;

	constructor(serial: DeviceSerial) {
		super(
			`Device '${serial}' is not physically attached to this host — it is only reachable ` +
				`over a network transport, so this host never leases it (D18)`,
		);
		this.name = 'ForeignDeviceError';
		this.serial = serial;
	}
}

/**
 * Thrown when a wait's condition was still unmet at its deadline.
 *
 * `waitedFor` and `found` are the two halves ai/CODING_STANDARDS.md "Error handling"
 * demands: *a verb that timed out reports what it was waiting for and what was on screen
 * instead*. A bare "timeout" makes the agent guess, and it will guess wrong. `polls` is
 * here because "checked once" and "checked two hundred times" are different diagnoses of
 * the same elapsed time — the first says the poll interval swallowed the wait.
 *
 * **Every field is plain data on purpose.** Verb execution happens on the host, so this
 * error is serialized and sent back over a socket that may be a network one (D19) — see
 * `src/verbs/failure.ts`, which is where it becomes an answer a client can parse.
 * Hanging a device handle, a stream or a host-local path off it would produce a value
 * that cannot cross that boundary, and the failure would surface only once the client is
 * on another machine.
 */
export class WaitTimeoutError extends Error {
	readonly waitedFor: string;
	readonly found: string;
	readonly timeoutMs: number;
	readonly polls: number;

	constructor(waitedFor: string, found: string, timeoutMs: number, polls: number) {
		super(
			`Timed out after ${timeoutMs}ms waiting for ${waitedFor} — found ${found} instead ` +
				`(${polls} checks)`,
		);
		this.name = 'WaitTimeoutError';
		this.waitedFor = waitedFor;
		this.found = found;
		this.timeoutMs = timeoutMs;
		this.polls = polls;
	}
}
