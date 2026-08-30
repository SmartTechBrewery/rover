/**
 * A verb-layer failure as **data** — the shape a refusal from a verb takes once the caller
 * is somewhere else (D19, R21).
 *
 * The error classes in `./errors.ts` and `src/core/errors.ts` already carry nothing but
 * plain fields, and every one of them says in its own header that it does so because this
 * row would serialize it. This module is the other half of that promise: one parseable
 * union over those classes, so an agent reading a failure can branch on a `kind` and read
 * the fields, rather than matching on the text of a message.
 *
 * **Both halves are here on purpose.** Every branch carries `message` — the error's own
 * words, which already name the device and say what was on screen instead — so a client can
 * print one honest line without reassembling it, *and* the structured fields, so a client
 * that wants to act rather than print does not have to parse that line back apart.
 *
 * **{@link toVerbFailure} answers `null` for anything it does not know**, and the caller
 * rethrows. A catch-all branch would dress a genuine host bug up as an answer about the
 * device, which is the opposite of what a failure shape is for: "this broke" and "the thing
 * you asked for is not there" call for different moves from an agent
 * (ai/CODING_STANDARDS.md "Error handling").
 *
 * It knows nothing about leases, and lives here rather than in `src/ipc/` for that reason —
 * "the verb layer never knows that leases exist" stays true. Whether a *call* was allowed to
 * reach a verb at all is a separate question with a separate shape, owned by
 * `src/ipc/verb-methods.ts`.
 */

import { z } from 'zod';
import { CapabilityIdSchema } from '../core/capabilities.js';
import { PointSchema, ScreenElementSchema } from '../core/device.js';
import { MissingCapabilityError, UnsupportedTextError, WaitTimeoutError } from '../core/errors.js';
import { DeviceSerialSchema, PlatformIdSchema } from '../core/ids.js';
import {
	AmbiguousTargetError,
	OffScreenPointError,
	TargetNotFoundError,
	UnaddressableElementError,
} from './errors.js';

/**
 * Every way a verb that ran can answer "no", discriminated on `kind`.
 *
 * Kebab-case, matching `AcquireRefusalReasonSchema` and `TargetSourceSchema`, so the wire
 * reads in one style rather than in the casing of whichever class each branch came from.
 * `.strict()` on every member for the reason the whole protocol is strict: a field nobody
 * parses is a field that silently stops arriving.
 */
export const VerbFailureSchema = z.discriminatedUnion('kind', [
	/** The device's backend does not declare what the verb needs (D11). Stop asking. */
	z
		.object({
			kind: z.literal('missing-capability'),
			capability: CapabilityIdSchema,
			serial: DeviceSerialSchema,
			platform: PlatformIdSchema,
			backendLabel: z.string().min(1),
			message: z.string().min(1),
		})
		.strict(),
	/** Nothing on a screen read taken now matched — and what was there instead. */
	z
		.object({
			kind: z.literal('target-not-found'),
			serial: DeviceSerialSchema,
			lookedFor: z.string().min(1),
			found: z.string().min(1),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * Several elements matched and the request did not say which. The candidates travel
	 * whole — a `ScreenElement` is itself plain data — so the caller can pick one by index
	 * without reading them back out of a formatted string.
	 */
	z
		.object({
			kind: z.literal('ambiguous-target'),
			serial: DeviceSerialSchema,
			lookedFor: z.string().min(1),
			candidates: z.array(ScreenElementSchema),
			remedy: z.string().min(1),
			message: z.string().min(1),
		})
		.strict(),
	/** A caller-supplied coordinate that is not on the device. */
	z
		.object({
			kind: z.literal('off-screen-point'),
			serial: DeviceSerialSchema,
			x: z.number(),
			y: z.number(),
			widthDp: z.number(),
			heightDp: z.number(),
			message: z.string().min(1),
		})
		.strict(),
	/** The element was found and still has no point on it a verb could act on. */
	z
		.object({
			kind: z.literal('unaddressable-element'),
			serial: DeviceSerialSchema,
			lookedFor: z.string().min(1),
			element: ScreenElementSchema,
			point: PointSchema,
			widthDp: z.number(),
			heightDp: z.number(),
			reason: z.enum(['clipped', 'off-screen']),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * The device takes text, and not this text.
	 *
	 * Kept apart from `missing-capability` even though both are "the device cannot", because
	 * the two ask opposite things of the caller: that one says stop, this one says send a
	 * different string. Named for the *text* rather than for the input capability for the
	 * same reason — a kind called `unsupported-input` beside a `missing-capability` carrying
	 * `canInput` would read as the same answer twice.
	 *
	 * `unsupported` is the offending characters as readable escapes, so a caller can act on
	 * a tab or a zero-width space it cannot see in `text`.
	 */
	z
		.object({
			kind: z.literal('unsupported-text'),
			serial: DeviceSerialSchema,
			text: z.string(),
			unsupported: z.array(z.string().min(1)).min(1),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * The condition was still unmet at the deadline. Carries no serial: a wait is over a
	 * condition rather than over a device, and the host names the device in the refusal's
	 * message and in the call that asked for it.
	 */
	z
		.object({
			kind: z.literal('wait-timeout'),
			waitedFor: z.string().min(1),
			found: z.string().min(1),
			timeoutMs: z.number().int().nonnegative(),
			polls: z.number().int().nonnegative(),
			message: z.string().min(1),
		})
		.strict(),
]);
export type VerbFailure = z.infer<typeof VerbFailureSchema>;

/**
 * The failure `error` is, or `null` when it is not one of them — the caller then rethrows,
 * and the host reports a host failure as one.
 *
 * Adding an eighth error class to the verb layer without a branch here surfaces as that
 * class's own test seeing an internal error instead of an answer, which is the loud version
 * of this drifting.
 */
export function toVerbFailure(error: unknown): VerbFailure | null {
	if (error instanceof MissingCapabilityError) {
		return {
			kind: 'missing-capability',
			capability: error.capability,
			serial: error.serial,
			platform: error.platform,
			backendLabel: error.backendLabel,
			message: error.message,
		};
	}
	if (error instanceof TargetNotFoundError) {
		return {
			kind: 'target-not-found',
			serial: error.serial,
			lookedFor: error.lookedFor,
			found: error.found,
			message: error.message,
		};
	}
	if (error instanceof AmbiguousTargetError) {
		return {
			kind: 'ambiguous-target',
			serial: error.serial,
			lookedFor: error.lookedFor,
			// Copied rather than handed over: the union's own type is a mutable array, and the
			// error holds a `readonly` one it has already published to whoever caught it.
			candidates: [...error.candidates],
			remedy: error.remedy,
			message: error.message,
		};
	}
	if (error instanceof OffScreenPointError) {
		return {
			kind: 'off-screen-point',
			serial: error.serial,
			x: error.x,
			y: error.y,
			widthDp: error.widthDp,
			heightDp: error.heightDp,
			message: error.message,
		};
	}
	if (error instanceof UnaddressableElementError) {
		return {
			kind: 'unaddressable-element',
			serial: error.serial,
			lookedFor: error.lookedFor,
			element: error.element,
			point: error.point,
			widthDp: error.widthDp,
			heightDp: error.heightDp,
			reason: error.reason,
			message: error.message,
		};
	}
	if (error instanceof UnsupportedTextError) {
		return {
			kind: 'unsupported-text',
			serial: error.serial,
			text: error.text,
			// Copied for the reason the candidates above are: the union's own type is a mutable
			// array and the error published a `readonly` one to whoever caught it.
			unsupported: [...error.unsupported],
			message: error.message,
		};
	}
	if (error instanceof WaitTimeoutError) {
		return {
			kind: 'wait-timeout',
			waitedFor: error.waitedFor,
			found: error.found,
			timeoutMs: error.timeoutMs,
			polls: error.polls,
			message: error.message,
		};
	}
	return null;
}
