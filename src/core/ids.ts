/**
 * Branded ID types for the device layer.
 *
 * Mirrors Swarm's `src/pm/ids.ts` (see ai/CODING_STANDARDS.md "Naming"). A device
 * serial, a backend's platform id and an on-screen element id are all bare strings
 * that look interchangeable but are not: passing an element id where a serial is
 * expected would compile and then address the wrong thing at runtime. Branded types
 * make each of those a compile error.
 *
 * Usage:
 *
 *   // At the boundary (a manifest literal, an IPC payload, a CLI argument), parse once:
 *   const serial = parseDeviceSerial(request.serial);
 *
 *   // Internally, everything accepts only the branded id:
 *   backend.screenshot(serial);            // compiles
 *   backend.screenshot(request.serial);    // compile error
 *
 *   // At the outbound boundary (an external command's argv, a log line), unwrap:
 *   argv.push(unwrap(serial));
 */

/**
 * The identifier a host uses to address one attached device. Opaque: never parse it
 * to infer platform, model or anything else — those come from queries
 * (ai/CODING_STANDARDS.md "Parsing external tool output").
 */
export type DeviceSerial = string & { readonly __brand: 'DeviceSerial' };

/**
 * A device backend's registry key — the value a manifest declares and
 * `getDeviceBackend()` looks up.
 *
 * Deliberately an open string rather than a closed union of known values: a closed
 * union would have to enumerate every platform in shared code, which is exactly what
 * ai/RULES.md §2 forbids.
 */
export type PlatformId = string & { readonly __brand: 'PlatformId' };

/** A single element in a screen read — the stable handle a verb taps or waits on. */
export type ElementId = string & { readonly __brand: 'ElementId' };

/** Thrown by the `parse*` factories when the input is empty or whitespace. */
export class InvalidIdError extends Error {
	readonly kind: string;
	readonly attempted: string;

	constructor(kind: string, attempted: string) {
		super(`Invalid ${kind}: '${attempted}' — expected a non-empty, non-whitespace string`);
		this.name = 'InvalidIdError';
		this.kind = kind;
		this.attempted = attempted;
	}
}

function requireNonEmpty(raw: string, kind: string): string {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		throw new InvalidIdError(kind, raw);
	}
	return raw;
}

/** Parse and brand a device serial. Throws `InvalidIdError` on empty/whitespace input. */
export function parseDeviceSerial(raw: string): DeviceSerial {
	return requireNonEmpty(raw, 'DeviceSerial') as DeviceSerial;
}

/** Parse and brand a backend platform id. Throws `InvalidIdError` on empty/whitespace input. */
export function parsePlatformId(raw: string): PlatformId {
	return requireNonEmpty(raw, 'PlatformId') as PlatformId;
}

/** Parse and brand a screen element id. Throws `InvalidIdError` on empty/whitespace input. */
export function parseElementId(raw: string): ElementId {
	return requireNonEmpty(raw, 'ElementId') as ElementId;
}

/** Strip the brand for an outbound boundary — an argv entry, a log line, a wire payload. */
export function unwrap(id: DeviceSerial | PlatformId | ElementId): string {
	return id;
}
