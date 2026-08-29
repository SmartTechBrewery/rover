/**
 * What a verb answers with — and the capture of the state after the action (D12(c), D14).
 *
 * Every shape here is a Zod schema of **plain data**, because a verb result is executed on
 * the host and read on the agent's machine (D19, R21): no live handle, no stream, and no
 * host-local path survives that trip. `tests/unit/verbs/serializable.test.ts` holds the
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
 * The screen after the action — or an honest statement that this device cannot say.
 *
 * The `unavailable` branch is the whole point of the union. A backend with input but no
 * screen reading still has to answer D12(c), and the two candidate answers are an empty
 * element list or the truth. An empty list is indistinguishable from a blank screen and
 * would be read as one, which is the plausible-looking empty result ai/RULES.md §2
 * forbids; this branch names the capability that would have answered instead.
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
 * Called by `performAction` (`./perform.ts`) once the action has returned, and never
 * before it: a post-state captured early is a pre-state wearing the wrong label, and it
 * would be believed.
 */
export async function captureAfterState(context: VerbContext): Promise<AfterState> {
	if (!supportsCapability(context.manifest, 'canReadScreen')) {
		return {
			kind: 'unavailable',
			capability: 'canReadScreen',
			message: cannotReadScreen(context.serial, context.manifest),
		};
	}

	const readScreen = capabilityMethod(context, 'canReadScreen', 'readScreen');
	return { kind: 'screen', elements: await readScreen(context.serial) };
}
