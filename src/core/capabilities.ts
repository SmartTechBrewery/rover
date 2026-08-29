/**
 * The capability manifest — what a backend declares it can do, and the queries shared
 * code asks before dispatching a verb.
 *
 * D11: backends are genuinely asymmetric, and flattening that to a lowest common
 * denominator is the design mistake to avoid. So a missing ability is a **declared
 * capability**, not a missing method: a backend says what it can do, the verb layer
 * asks first, and a verb with no backing fails loudly naming the capability and the
 * device (ai/RULES.md §2).
 *
 * A Zod schema rather than a plain interface because the manifest crosses two
 * boundaries — `acquire_device` returns it to a client over IPC (PROJECT.md §4), and the
 * MCP tool layer reads it — which is boundary #4 of ai/CODING_STANDARDS.md "Zod is the
 * source of truth". `registerDeviceBackend()` parses with it, so a malformed manifest
 * fails at module load rather than at the first verb call.
 *
 * Only genuinely divergent abilities get a flag; a capability that is always `true`
 * would be noise. The three below are the divergences PROJECT.md §5 and
 * ai/ARCHITECTURE.md actually name.
 */

import { z } from 'zod';
import type { DeviceBackend } from './device.js';
import { MissingCapabilityError } from './errors.js';
import { type DeviceSerial, parsePlatformId } from './ids.js';

/**
 * The capability vocabulary. `.strict()` so a typo'd flag is a load-time failure rather
 * than a silently-absent capability, which would read to the verb layer as an honest
 * opt-out.
 */
export const CapabilitiesSchema = z
	.object({
		/**
		 * Semantic screen reading. On some platforms this is the one read that survives an
		 * application blocking screen capture; on others there is no cheap equivalent, or
		 * none at all (PROJECT.md §5).
		 */
		canReadScreen: z.boolean(),
		/**
		 * Synthetic input — taps, swipes, text, keys. On some platforms this needs a second
		 * external program with a lifecycle of its own, which is why it is not assumed
		 * (ai/ARCHITECTURE.md, on where the seam runs).
		 */
		canInput: z.boolean(),
		/** Airplane mode and wifi toggles — the "environment" half of the device abstraction. */
		canControlNetwork: z.boolean(),
	})
	.strict();
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** One flag of {@link CapabilitiesSchema}, derived so there is no second list to drift. */
export type CapabilityId = keyof Capabilities;

/**
 * A backend's declaration of itself: who it is and what it can do.
 *
 * `platform` is branded on parse, so a backend author writes a plain string literal in
 * its own folder while everything downstream holds a `PlatformId` — parse once at the
 * boundary, as Swarm's adapters brand at theirs.
 */
export const CapabilityManifestSchema = z
	.object({
		/** Registry key. Unique across registered backends. */
		platform: z.string().trim().min(1).transform(parsePlatformId),
		/** Human-readable backend name, for logs and error messages. */
		label: z.string().trim().min(1),
		capabilities: CapabilitiesSchema,
	})
	.strict();

/** A parsed manifest — `platform` is a branded `PlatformId` (see `./ids.js`). */
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

/** What a backend's own module writes: the same shape with `platform` as a plain string. */
export type CapabilityManifestInput = z.input<typeof CapabilityManifestSchema>;

/**
 * The optional members of {@link DeviceBackend} — the ones a capability gates. Typing
 * {@link CAPABILITY_METHODS} against this makes "a declared capability is never a
 * required method" a compile-time fact rather than a review comment.
 */
export type CapabilityGatedMethod = {
	[Key in keyof DeviceBackend]-?: undefined extends DeviceBackend[Key] ? Key : never;
}[keyof DeviceBackend];

/**
 * Which interface methods each capability gates.
 *
 * Exists as data so the conformance suite can check "every declared capability is one
 * the backend actually dispatches" without hardcoding the mapping in the test — a
 * declared-but-unanswered capability otherwise surfaces at the worst moment, in front of
 * an agent that was told it was available (ai/TESTING.md "Backend conformance").
 *
 * `as const satisfies` rather than a type annotation: the annotation alone widens each
 * tuple back to `CapabilityGatedMethod[]`, which erases the very thing the conformance
 * suite reads it for — that the union of these lists covers every gated method, so an
 * optional method named by no capability (one the verb layer could never reach, and the
 * suite would never scan) is a compile error rather than a quiet omission.
 */
export const CAPABILITY_METHODS = {
	canReadScreen: ['readScreen'],
	canInput: ['tap', 'swipe', 'typeText', 'pressKey'],
	canControlNetwork: ['setAirplaneMode', 'setWifiEnabled'],
} as const satisfies Record<CapabilityId, readonly CapabilityGatedMethod[]>;

/** Non-throwing query — what the verb layer asks before dispatching. */
export function supportsCapability(
	manifest: CapabilityManifest,
	capability: CapabilityId,
): boolean {
	return manifest.capabilities[capability];
}

/**
 * Assert a capability, throwing {@link MissingCapabilityError} when the backend does not
 * declare it. The loud failure of D11 — call this rather than returning an empty result.
 */
export function requireCapability(
	manifest: CapabilityManifest,
	capability: CapabilityId,
	serial: DeviceSerial,
): void {
	if (!supportsCapability(manifest, capability)) {
		throw new MissingCapabilityError(capability, serial, manifest.platform, manifest.label);
	}
}
