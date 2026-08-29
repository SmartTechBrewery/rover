/**
 * Verb-layer error types — the four ways a target fails to become one point.
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

import type { Point, ScreenElement } from '../core/device.js';
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
 * silent first match taps one of them, reports success, and is right half the time. Being
 * told what is wrong without being told the way out is half an error, so the way out is
 * part of the message — and it is passed **in** rather than written here, because it is not
 * the same way out for every target. Only a text target has an `index` to disambiguate
 * with; two elements sharing one id is the backend contradicting itself, and advising an
 * `index` there would name a field `TargetSchema` rejects.
 */
export class AmbiguousTargetError extends Error {
	readonly serial: DeviceSerial;
	readonly lookedFor: string;
	readonly candidates: readonly ScreenElement[];
	readonly remedy: string;

	constructor(
		serial: DeviceSerial,
		lookedFor: string,
		candidates: readonly ScreenElement[],
		remedy: string,
	) {
		super(
			`${candidates.length} elements on device '${serial}' match ${lookedFor}: ` +
				`${candidates.map((candidate, at) => `[${at}] ${describeElement(candidate)}`).join('; ')} ` +
				`— ${remedy}`,
		);
		this.name = 'AmbiguousTargetError';
		this.serial = serial;
		this.lookedFor = lookedFor;
		this.candidates = candidates;
		this.remedy = remedy;
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

/** Why the element a target named has no point on it that can be acted on. */
export type UnaddressableReason = 'clipped' | 'off-screen';

/**
 * Thrown when the element a target matched cannot be turned into a point to act on.
 *
 * Two shapes of the same failure, kept in one error because the caller's next move is the
 * same for both — bring the element into view and target it again:
 *
 * - `clipped` — the rectangle has no interior. A node scrolled past the edge of its
 *   container reports bounds whose second corner is *before* the first, so the width or
 *   the height comes back negative or zero (`PROJECT.md` §6, where the hierarchy parser
 *   that subtracts those corners deliberately hands the question on to this layer). Its
 *   midpoint is arithmetic, not a location.
 * - `off-screen` — the rectangle is well-formed but its centre is not on the device.
 *
 * Distinct from {@link OffScreenPointError} because the two name different culprits: that
 * one is the caller's arithmetic, this one is an element the screen read really did
 * report. Distinct from {@link TargetNotFoundError} because the element *was* found —
 * saying "not found" while listing it among what was on screen instead is the confusing
 * half-truth, not the honest answer.
 */
export class UnaddressableElementError extends Error {
	readonly serial: DeviceSerial;
	readonly lookedFor: string;
	readonly element: ScreenElement;
	readonly point: Point;
	readonly widthDp: number;
	readonly heightDp: number;
	readonly reason: UnaddressableReason;

	constructor(
		serial: DeviceSerial,
		lookedFor: string,
		element: ScreenElement,
		point: Point,
		widthDp: number,
		heightDp: number,
		reason: UnaddressableReason,
	) {
		const why =
			reason === 'clipped'
				? 'its bounds have no interior — a node clipped out of its scrolling container ' +
					'reports a negative or zero size, so its midpoint is not a place on the screen'
				: `its centre (${point.x}, ${point.y}) is outside the device's ${widthDp}×${heightDp} screen`;
		super(
			`${describeElement(element)} on device '${serial}' matches ${lookedFor} but cannot be ` +
				`acted on: ${why}. Bring it into view — by scrolling, or by dismissing whatever ` +
				'covers it — and target it again',
		);
		this.name = 'UnaddressableElementError';
		this.serial = serial;
		this.lookedFor = lookedFor;
		this.element = element;
		this.point = point;
		this.widthDp = widthDp;
		this.heightDp = heightDp;
		this.reason = reason;
	}
}
