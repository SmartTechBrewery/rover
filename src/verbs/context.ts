/**
 * What a verb is handed, and how it reaches a capability-gated backend method.
 *
 * A {@link VerbContext} is a plain value its **caller** constructs — `src/daemon/verb-handlers.ts`,
 * which has already resolved the device the lease names (D19). The verb layer never
 * looks a device up, never consults an inventory and never knows that leases exist
 * (ai/ARCHITECTURE.md, "The core owns everything about *a* device and nothing about
 * *which* device").
 *
 * {@link capabilityMethod} is the only way this layer reaches an optional method, so the
 * manifest is consulted before every dispatch rather than wherever a verb author
 * remembered to (D11).
 */

import {
	type CAPABILITY_METHODS,
	type CapabilityId,
	type CapabilityManifest,
	requireCapability,
} from '../core/capabilities.js';
import type { DeviceBackend } from '../core/device.js';
import type { DeviceSerial } from '../core/ids.js';

/** The device a verb acts on, the backend that can act on it, and what that backend can do. */
export interface VerbContext {
	readonly serial: DeviceSerial;
	readonly backend: DeviceBackend;
	readonly manifest: CapabilityManifest;
}

/**
 * The methods one capability gates — `'readScreen'` for `canReadScreen`, and so on.
 *
 * Read off {@link CAPABILITY_METHODS} rather than written out again, which makes
 * `capabilityMethod(context, 'canInput', 'readScreen')` a compile error instead of a
 * capability check that passes while the wrong method is fetched.
 */
export type CapabilityMethodOf<Capability extends CapabilityId> =
	(typeof CAPABILITY_METHODS)[Capability][number];

/**
 * The backend method behind `capability`, bound to the backend, after asserting the
 * manifest declares it.
 *
 * Throws `MissingCapabilityError` when the manifest says no — the loud failure of D11,
 * naming the capability, the device and the backend. Throws a plain `Error` when the
 * manifest says yes and the method is absent, because that is a wiring bug rather than a
 * device limitation: the conformance suite gates it at test time (ai/TESTING.md), and
 * `undefined is not a function` is the wrong thing for an agent to read at runtime.
 */
export function capabilityMethod<
	Capability extends CapabilityId,
	Method extends CapabilityMethodOf<Capability>,
>(
	context: VerbContext,
	capability: Capability,
	method: Method,
): NonNullable<DeviceBackend[Method]> {
	requireCapability(context.manifest, capability, context.serial);

	const implementation = context.backend[method];
	if (typeof implementation !== 'function') {
		throw new Error(
			`Backend '${context.manifest.label}' ('${context.manifest.platform}') declares ` +
				`'${capability}' but has no '${method}' method — the manifest and the backend disagree`,
		);
	}

	return implementation.bind(context.backend) as NonNullable<DeviceBackend[Method]>;
}
