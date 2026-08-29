/**
 * Verb-layer error types — the three ways a target fails to become one point.
 *
 * Device-layer errors (a missing capability, a device that vanished) stay in
 * `src/core/errors.ts`; these are about what the caller asked for, and every one of them
 * exists because the alternative is a **silent** answer: a first match among two, a tap
 * into nowhere, or an empty result where the honest answer is that the screen no longer
 * holds what was named (ai/RULES.md §2).
 *
 * **Every field is plain data on purpose**, for the reason `WaitTimeoutError` states: R21
 * moves verb execution onto the host, so these are serialized and sent back over a socket
 * that may be a network one (D19). A `ScreenElement` is itself plain data, which is why
 * the candidates can travel whole rather than as a formatted string.
 */

import type { ScreenElement } from '../core/device.js';
import type { DeviceSerial } from '../core/ids.js';

/** How many elements an excerpt names before it says how many more there were. */
const EXCERPT_LIMIT = 8;

/** One element in the words an agent asked in — its text, its label, and where it is. */
export function describeElement(element: ScreenElement): string {
	const named = [element.text, element.label]
		.filter((value): value is string => value !== null)
		.map((value) => `'${value}'`);
	const { x, y, width, height } = element.bounds;
	return `${named.length > 0 ? named.join(' / ') : '(no text)'} [${element.id}] at ${x},${y} ${width}×${height}`;
}

/**
 * What was on screen instead — the second half ai/CODING_STANDARDS.md demands of every
 * failed lookup, bounded so a two-hundred-element screen is still readable.
 */
export function describeScreen(elements: readonly ScreenElement[]): string {
	if (elements.length === 0) {
		return 'an empty screen';
	}
	const excerpt = elements.slice(0, EXCERPT_LIMIT).map(describeElement);
	const remaining = elements.length - excerpt.length;
	const more = remaining > 0 ? `, and ${remaining} more` : '';
	const noun = elements.length === 1 ? 'element' : 'elements';
	return `${elements.length} ${noun}: ${excerpt.join('; ')}${more}`;
}

/**
 * Thrown when nothing on the freshly read screen matched the target.
 *
 * Carries what was looked for *and* what was there instead, because "not found" alone
 * makes the agent guess whether the screen had not loaded, had moved on, or never had
 * that element at all — three different next moves.
 */
export class TargetNotFoundError extends Error {
	readonly serial: DeviceSerial;
	readonly lookedFor: string;
	readonly found: string;

	constructor(serial: DeviceSerial, lookedFor: string, found: string) {
		super(`Nothing on device '${serial}' matches ${lookedFor} — found ${found} instead`);
		this.name = 'TargetNotFoundError';
		this.serial = serial;
		this.lookedFor = lookedFor;
		this.found = found;
	}
}

/**
 * Thrown when more than one element matched, naming **every** candidate.
 *
 * Two identical labels are exactly the false green the verb layer exists to prevent: a
 * silent first match taps one of them, reports success, and is right half the time. An
 * explicit `index` on the target is how a caller chooses deliberately, and the message
 * says so because being told what is wrong without being told the way out is half an
 * error.
 */
export class AmbiguousTargetError extends Error {
	readonly serial: DeviceSerial;
	readonly lookedFor: string;
	readonly candidates: readonly ScreenElement[];

	constructor(serial: DeviceSerial, lookedFor: string, candidates: readonly ScreenElement[]) {
		super(
			`${candidates.length} elements on device '${serial}' match ${lookedFor}: ` +
				`${candidates.map((candidate, at) => `[${at}] ${describeElement(candidate)}`).join('; ')} ` +
				'— name one with an explicit index rather than letting the first win',
		);
		this.name = 'AmbiguousTargetError';
		this.serial = serial;
		this.lookedFor = lookedFor;
		this.candidates = candidates;
	}
}

/**
 * Thrown when a caller-supplied point lies outside the device's screen.
 *
 * A coordinate is the documented fallback (PROJECT.md §4) and the one address the verb
 * layer cannot re-derive from a screen read, so it is the one that has to be *range
 * checked* instead: an off-screen point otherwise dispatches an input event into nowhere,
 * which the device accepts without complaint and reports as having happened.
 *
 * Distinct from {@link TargetNotFoundError} because the answers differ — this is the
 * caller's arithmetic, not the screen's contents.
 */
export class OffScreenPointError extends Error {
	readonly serial: DeviceSerial;
	readonly x: number;
	readonly y: number;
	readonly widthDp: number;
	readonly heightDp: number;

	constructor(serial: DeviceSerial, x: number, y: number, widthDp: number, heightDp: number) {
		super(
			`Point (${x}, ${y}) is outside device '${serial}': its screen is ${widthDp}×${heightDp} ` +
				'in the coordinate space a screen read reports',
		);
		this.name = 'OffScreenPointError';
		this.serial = serial;
		this.x = x;
		this.y = y;
		this.widthDp = widthDp;
		this.heightDp = heightDp;
	}
}
