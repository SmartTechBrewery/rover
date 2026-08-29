/**
 * What a verb answers with — and the capture of the state after the action (D12(c), D14).
 *
 * Every shape here is a Zod schema of **plain data**, because a verb runs on the host and its
 * result is read on the agent's machine (D19): no live handle, no stream, and no host-local
 * path survives that trip. `tests/unit/verbs/serializable.test.ts` holds the
 * line by round-tripping each of them through JSON.
 *
 * `DeviceInfoSchema` is reused rather than restated. It already carries the serial, the
 * platform, the model and the density, so D14 — *every result names the device and its
 * density* — is one existing shape rather than a second one that can disagree with it.
 */

import { z } from 'zod';
import {
	CapabilityIdSchema,
	type CapabilityManifest,
	supportsCapability,
} from '../core/capabilities.js';
import { DeviceInfoSchema, PointSchema, ScreenElementSchema } from '../core/device.js';
import type { DeviceSerial } from '../core/ids.js';
import { capabilityMethod, type VerbContext } from './context.js';

/**
 * Where a resolved point came from.
 *
 * `caller-point` is not a lesser kind of success, it is a **different** one, and the
 * result says which: a point that arrived from the caller was never checked against
 * anything on screen, so an agent reading the result can tell a tap that hit a named
 * element from one that hit a coordinate somebody worked out a turn ago (D12(a)).
 */
export const TargetSourceSchema = z.enum(['screen', 'caller-point']);
export type TargetSource = z.infer<typeof TargetSourceSchema>;

/**
 * One target, turned into one point.
 *
 * `element` is null exactly when `source` is `caller-point` — there was no screen read to
 * name an element from.
 */
export const ResolvedTargetSchema = z
	.object({
		source: TargetSourceSchema,
		point: PointSchema,
		element: ScreenElementSchema.nullable(),
	})
	.strict();
export type ResolvedTarget = z.infer<typeof ResolvedTargetSchema>;

/**
 * The screen after the action — or an honest statement of why it could not be read.
 *
 * The two non-`screen` branches are the whole point of the union, and they are kept apart
 * because the caller's next move differs. A backend with input but no screen reading still
 * has to answer D12(c), and the two candidate answers are an empty element list or the
 * truth; an empty list is indistinguishable from a blank screen and would be read as one,
 * which is the plausible-looking empty result ai/RULES.md §2 forbids. So `unavailable`
 * names the capability that would have answered — this device will never answer, stop
 * asking. `failed` is the read that was declared, attempted and rejected: worth retrying,
 * and a different thing to be told.
 */
export const AfterStateSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('screen'), elements: z.array(ScreenElementSchema) }).strict(),
	z
		.object({
			kind: z.literal('unavailable'),
			capability: CapabilityIdSchema,
			message: z.string().min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal('failed'),
			capability: CapabilityIdSchema,
			message: z.string().min(1),
		})
		.strict(),
]);
export type AfterState = z.infer<typeof AfterStateSchema>;

/**
 * What every verb answers with: what it did, on which device, to what, and what the screen
 * looked like afterwards.
 *
 * `target` is null for a verb that addresses no element — a key press, a screen read — and
 * that is a fact about the verb rather than a failure to resolve one.
 */
export const ActionResultSchema = z
	.object({
		verb: z.string().trim().min(1),
		device: DeviceInfoSchema,
		target: ResolvedTargetSchema.nullable(),
		after: AfterStateSchema,
	})
	.strict();
export type ActionResult = z.infer<typeof ActionResultSchema>;

/**
 * The answer every verb ends with: what it did, on which device, to what, and what the
 * screen looks like now (D12(c), D14).
 *
 * One function rather than a shape each verb assembles, because "every action answers the
 * same way" is only true while there is one place deciding what the same way is. Called by
 * `performAction` (`./perform.ts`) and directly by the waits (`./wait-for.ts`), which
 * cannot go through the spine: their work *is* the resolution, and a spine that resolves
 * the target before running the action would resolve it before the wait had happened.
 */
export async function resultAfterAction(
	context: VerbContext,
	verb: string,
	target: ResolvedTarget | null,
): Promise<ActionResult> {
	// Past this line the action has happened, so the after-state is captured rather than
	// risked: `captureAfterState` below answers a `failed` branch instead of throwing,
	// because an exception here would take the whole result with it and leave the agent
	// unable to tell whether the action landed — the one thing D12(c) exists to rule out.
	const after = await captureAfterState(context);

	// `deviceInfo` is read again, after the action, and is deliberately *not* the value
	// target resolution used: an action can rotate the device, and a result pairing
	// post-action elements with pre-action screen dimensions describes a coordinate space
	// that never existed. It is also the one call here that may throw, and rightly — D14
	// makes the device half of a result mandatory, so a device that can no longer say what
	// it is has nothing left to report an action about.
	const device = await context.backend.deviceInfo(context.serial);

	return ActionResultSchema.parse({ verb, device, target, after });
}

/** Why a `failed` after-state happened — the action ran, the read did not. */
function screenReadFailed(serial: DeviceSerial, error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return (
		`The action ran on device '${serial}', but reading the screen afterwards failed: ` +
		`${reason} — what is on screen now is unknown, not unchanged`
	);
}

/** Why an `unavailable` after-state happened, in the same words `MissingCapabilityError` uses. */
function cannotReadScreen(serial: DeviceSerial, manifest: CapabilityManifest): string {
	return (
		`Device '${serial}' cannot report what is on screen after an action: the ` +
		`${manifest.label} backend ('${manifest.platform}') does not declare 'canReadScreen'`
	);
}

/**
 * Read the screen **after** an action has been performed.
 *
 * Called by {@link resultAfterAction} once the action has returned, and never before it: a
 * post-state captured early is a pre-state wearing the wrong label, and it would be
 * believed.
 *
 * **Never throws**, and that is the point rather than defensive habit. By the time this
 * runs the action has already happened, so a rejection escaping here would replace the one
 * answer D12(c) promises — *this is what the screen looks like now* — with an exception
 * that leaves the agent unable to tell whether the action landed. A read that failed is
 * still an answer about the screen; it is the `failed` branch, carrying the reason. That
 * includes a manifest promising `canReadScreen` over a backend that has no `readScreen`:
 * it is a wiring bug and its message says so, but once the action has run there is nowhere
 * better to put it than the answer the caller is waiting for.
 */
export async function captureAfterState(context: VerbContext): Promise<AfterState> {
	if (!supportsCapability(context.manifest, 'canReadScreen')) {
		return {
			kind: 'unavailable',
			capability: 'canReadScreen',
			message: cannotReadScreen(context.serial, context.manifest),
		};
	}

	try {
		const readScreen = capabilityMethod(context, 'canReadScreen', 'readScreen');
		return { kind: 'screen', elements: await readScreen(context.serial) };
	} catch (error) {
		return {
			kind: 'failed',
			capability: 'canReadScreen',
			message: screenReadFailed(context.serial, error),
		};
	}
}
