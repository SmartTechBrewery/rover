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

/**
 * The identifier of one application on a device — the reverse-DNS name a platform knows
 * an installed app by.
 *
 * Branded for the usual reason and for a second one the others do not have: of every id
 * here, this is the one a caller supplies that a backend is most likely to hand to a
 * host-side tool which relays it into a command line the **device itself** interprets.
 * Where that happens, an unchecked value stops being an argument and becomes a second
 * command, run on hardware lent out for one lease and with effects that outlive it. Which
 * backends that applies to is theirs to say (PROJECT.md §6); making the id a parsed value
 * everywhere is what means none of them has to be the only thing standing in the way.
 * {@link parseAppId} is that parse, and the brand is what makes skipping it a compile
 * error.
 */
export type AppId = string & { readonly __brand: 'AppId' };

/** Thrown by the `parse*` factories when the input is not the shape that id has. */
export class InvalidIdError extends Error {
	readonly kind: string;
	readonly attempted: string;

	constructor(kind: string, attempted: string, expected = 'a non-empty, non-whitespace string') {
		super(`Invalid ${kind}: '${attempted}' — expected ${expected}`);
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

/**
 * Two or more dot-separated segments, each beginning with a letter — the reverse-DNS shape
 * every mobile platform requires of an application identifier.
 *
 * A hyphen is allowed **inside** a segment because some platforms permit one; a leading
 * one is not, so no app id can be read as an option by a command it is passed to. This is
 * deliberately narrower than "a string with no metacharacters in it": a shape says what is
 * allowed, a blocklist says what someone thought of.
 */
const APP_ID = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;

/**
 * Parse and brand an application id. Throws `InvalidIdError` on anything that is not the
 * shape above — which is bad input, not a lookup miss (ai/CODING_STANDARDS.md
 * "Error handling").
 */
export function parseAppId(raw: string): AppId {
	if (typeof raw !== 'string' || !APP_ID.test(raw)) {
		throw new InvalidIdError(
			'AppId',
			raw,
			'two or more dot-separated segments, each starting with a letter (e.g. com.example.app)',
		);
	}
	return raw as AppId;
}

/** Strip the brand for an outbound boundary — an argv entry, a log line, a wire payload. */
export function unwrap(id: DeviceSerial | PlatformId | ElementId | AppId): string {
	return id;
}
