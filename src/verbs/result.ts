/**
 * What a verb answers with — and the capture of the state after the action (D12(c), D14).
 *
 * Every shape here is a Zod schema of **plain data**, because a verb runs on the host and its
 * result is read on the agent's machine (D19): no live handle, no stream, and no host-local
 * path survives that trip. Bytes do, and only in one form —
 * {@link ArtifactSchema} carries them base64-encoded, because raw ones do not.
 * `tests/unit/verbs/serializable.test.ts` holds the line by round-tripping each of them
 * through JSON.
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
import { ArtifactTooLargeError } from './errors.js';

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
 * The bytes a verb produced, in the one form that means the same thing on the agent's
 * machine as it does on the host (D19).
 *
 * **Base64, never a path.** A verb runs on the host and its answer is read somewhere else,
 * so a filesystem location is meaningless there — and worse than meaningless, because it
 * names a file that may well exist on the reader's own disk and be something entirely
 * different. Raw bytes are no better: `JSON.stringify` turns a `Uint8Array` into an object
 * of numeric keys, which survives a local round trip and arrives as nonsense over a socket,
 * which is why `tests/unit/verbs/serializable.test.ts` fails one deliberately. Any path a
 * client later writes these bytes to is the client's own; the host returns none.
 *
 * `byteLength` is the length of the **decoded** bytes, not of the string carrying them, so
 * a client can check what it decoded against what the host encoded without decoding twice.
 *
 * The durable host-side copy of the same bytes (D23) and the chunked transfer of ones too
 * big for this shape are separate rows (R24, R25); this is the payload, whole, in one
 * answer.
 */
export const ArtifactSchema = z
	.object({
		mediaType: z.string().min(1),
		base64: z.string(),
		byteLength: z.number().int().nonnegative(),
	})
	.strict();
export type Artifact = z.infer<typeof ArtifactSchema>;

/**
 * The largest artifact one verb answer may carry — 4 MiB of bytes.
 *
 * Derived from the 8 MiB frame cap (`src/ipc/framing.ts`) rather than picked: an answer
 * travels as one message, base64 inflates the payload by four thirds, and the rest of the
 * result — a screen read of a few hundred elements among it — travels in the same frame. 4
 * MiB encodes to about 5.4 MiB and leaves the remainder to everything else. The
 * relationship is asserted in `tests/unit/verbs/read.test.ts`, because a constant derived
 * from another constant by hand is one the other is free to drift away from.
 *
 * There is real headroom in it: the largest capture measured on a device so far is 1.7 MB
 * (PROJECT.md §6). It is a bound against a screen nobody anticipated, not a routine limit —
 * and reaching it is {@link ArtifactTooLargeError}, a refusal naming both numbers, never a
 * payload quietly cut to fit.
 */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

/** The eight bytes every PNG starts with (PNG 1.2 §3.1). */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The four bytes at offset 4 of every ISO base media file — an MP4's `ftyp` box type
 * (ISO/IEC 14496-12 §4.3). The first four bytes are that box's *length*, which varies, so
 * the signature is at an offset rather than at the start.
 */
const FTYP_BOX = [0x66, 0x74, 0x79, 0x70];

/** Where {@link FTYP_BOX} sits: after the leading `size:uint32`. */
const FTYP_BOX_OFFSET = 4;

/** What bytes nothing here recognises are called — honestly unlabelled, not guessed at. */
const UNKNOWN_MEDIA_TYPE = 'application/octet-stream';

/**
 * What kind of file these bytes are, read **off the bytes** rather than assumed.
 *
 * `DeviceBackend.screenshot` promises image bytes and does not say which encoding, so a
 * media type stamped on here from the verb's own expectations would be a claim nobody
 * checked — decoded by a client that has only this label to go on. Sniffing the signature
 * is the cheap version of checking, and the same check a backend already makes about its
 * own capture before handing it over. Unrecognised bytes get {@link UNKNOWN_MEDIA_TYPE},
 * which is the true statement about them; it is not a failure, and it is not a guess.
 *
 * `record_video`'s bytes are the second signature here, and they are read the same way for
 * the same reason: `DeviceBackend.recordVideo` promises video bytes without saying in which
 * container, so `video/mp4` is a claim this function checks rather than one the verb makes.
 * It says nothing about whether the recording is *finished* — that is a different question,
 * asked of a different box, by the backend that pulled the bytes (`UnfinishedRecordingError`).
 */
function mediaTypeOf(bytes: Uint8Array): string {
	if (hasSignature(bytes, PNG_SIGNATURE, 0)) return 'image/png';
	if (hasSignature(bytes, FTYP_BOX, FTYP_BOX_OFFSET)) return 'video/mp4';
	return UNKNOWN_MEDIA_TYPE;
}

/** Whether `signature` sits at `offset` of `bytes` — bounds checked, never a short read. */
function hasSignature(bytes: Uint8Array, signature: number[], offset: number): boolean {
	if (bytes.length < offset + signature.length) return false;
	return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Turn captured bytes into the {@link Artifact} an answer carries, or refuse them for being
 * too large.
 *
 * The bound is checked **before** the encoding rather than after it: base64 of an
 * over-sized capture is a copy a third larger again, built only to be thrown away.
 *
 * @throws ArtifactTooLargeError when `bytes` is over {@link MAX_ARTIFACT_BYTES}.
 */
export function artifactFrom(serial: DeviceSerial, bytes: Uint8Array): Artifact {
	if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
		throw new ArtifactTooLargeError(serial, bytes.byteLength, MAX_ARTIFACT_BYTES);
	}

	return ArtifactSchema.parse({
		mediaType: mediaTypeOf(bytes),
		base64: Buffer.from(bytes).toString('base64'),
		byteLength: bytes.byteLength,
	});
}

/**
 * What every verb answers with: what it did, on which device, to what, what the screen
 * looked like afterwards, and the bytes it produced if it produced any.
 *
 * `target` is null for a verb that addresses no element — a key press, a screen read — and
 * that is a fact about the verb rather than a failure to resolve one.
 *
 * `artifact` is null for every verb that produces no bytes, which is nearly all of them. It
 * is **required-and-nullable rather than optional**, the rule the rest of this protocol
 * already follows (`heldBy: null` for a free device): `undefined` does not survive JSON, so
 * an optional field would make "this verb produced nothing" a case every client has to
 * special-case instead of a value it can read. And it lives on this schema rather than on a
 * wider sibling because this one is `.strict()` and `VerbCallResultSchema`'s `ok` branch
 * parses *it* — an extended schema carrying a payload would be rejected on arrival as an
 * invalid result, which is the protocol working correctly.
 */
export const ActionResultSchema = z
	.object({
		verb: z.string().trim().min(1),
		device: DeviceInfoSchema,
		target: ResolvedTargetSchema.nullable(),
		after: AfterStateSchema,
		artifact: ArtifactSchema.nullable(),
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
 *
 * **`artifact: null` here, always.** A verb that produced bytes attaches them to what this
 * returns (`./read.ts`'s `screenshot` does) rather than handing them down through the
 * spine: one verb in a dozen carries a payload, and widening `PerformActionOptions` for it
 * would put a parameter on every call site that will never use it — the same reason
 * `./perform.ts` declined to widen for `swipe`'s second target.
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

	return ActionResultSchema.parse({ verb, device, target, after, artifact: null });
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
