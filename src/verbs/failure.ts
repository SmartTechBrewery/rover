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
import {
	MissingCapabilityError,
	UnfinishedRecordingError,
	UnsupportedTextError,
	WaitTimeoutError,
} from '../core/errors.js';
import { DeviceSerialSchema, PlatformIdSchema } from '../core/ids.js';
import {
	AmbiguousTargetError,
	ArtifactTooLargeError,
	FrameExtractionFailedError,
	FrameExtractionUnavailableError,
	FramesTooLargeError,
	InstallHookFailedError,
	InstallHookUndeclaredError,
	OffScreenPointError,
	ProjectNotRegisteredError,
	RecordingNormalisationFailedError,
	RecordingNormalisationUnavailableError,
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
	 * The verb ran, the device answered, and what it answered with does not fit one message.
	 *
	 * Both numbers travel because the pair is what makes it actionable: `byteLength` says how
	 * far over the line this capture was, and `maxBytes` says where the line is, so an agent
	 * can tell "this screen is unusually large" from "this bound is too low for any screen".
	 * Without the branch this would arrive as `internal_error` — "the host broke" — for a
	 * device that is merely showing a big screen.
	 */
	z
		.object({
			kind: z.literal('artifact-too-large'),
			serial: DeviceSerialSchema,
			byteLength: z.number().int().nonnegative(),
			maxBytes: z.number().int().positive(),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * The recording came off the device without its container index — it was still being
	 * written when it was copied.
	 *
	 * Its own kind rather than a shape of `artifact-too-large`, because the two ask opposite
	 * things of the caller: that one says the answer will never fit, this one says ask again.
	 * `byteLength` is what makes it actionable — a few kilobytes is a recording caught at its
	 * very start, megabytes is one whose writer was killed at the end — and without the branch
	 * this would arrive as `internal_error`, i.e. "the host broke", for a device that merely
	 * got cut off (`src/core/errors.ts`, `UnfinishedRecordingError`).
	 */
	z
		.object({
			kind: z.literal('unfinished-recording'),
			serial: DeviceSerialSchema,
			byteLength: z.number().int().nonnegative(),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * The frames could not be extracted because the program that extracts them is not on this
	 * host.
	 *
	 * **The branch that keeps an empty frame list from ever being an answer.** Without it a
	 * host without `ffmpeg` would have two ways to reply, and both would be wrong: `frames: []`,
	 * which reads as a recording in which nothing happened, or `internal_error`, which reads as
	 * a broken host for a machine that is merely missing a program. `program` and `reason` are
	 * what make it actionable — the name to install, and Node's own words for why the spawn
	 * failed, since a program present but not executable fails here too.
	 *
	 * Not a `missing-capability`: that one is about a *device backend* (D11), and a host tool
	 * says nothing about the hardware. Same answer shape, different machine, different remedy.
	 */
	z
		.object({
			kind: z.literal('frame-extraction-unavailable'),
			serial: DeviceSerialSchema,
			program: z.string().min(1),
			reason: z.string().min(1),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * The extractor ran and produced no frames — a recording it would not read, a filter it
	 * refused, or a run that outlived its budget.
	 *
	 * Kept apart from the branch above because the two are fixed in different places: that one
	 * says install a program, this one says something about *these bytes*. The exit code and the
	 * stderr travel together because "a non-zero exit is data" (ai/CODING_STANDARDS.md) and
	 * neither half is worth much alone, and `outcome` says how the run ended in words, since an
	 * exit, a signal and a stream this host could not read are indistinguishable from a code.
	 */
	z
		.object({
			kind: z.literal('frame-extraction-failed'),
			serial: DeviceSerialSchema,
			program: z.string().min(1),
			exitCode: z.number().int().nullable(),
			stderr: z.string(),
			outcome: z.string().min(1),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * The recording could not be normalised into a file that plays, because this host cannot run
	 * the program that normalises it at all — it is not on `PATH`, or the encoder has nowhere on
	 * this host to write (#185).
	 *
	 * **The branch that keeps a silently un-normalised file from ever being the answer.** What
	 * the recorder writes is not a constant-rate video — a still screen is one sample declaring
	 * no duration, and an ordinary capture declares a timeline that is not the requested one —
	 * so a host without the program has two wrong ways to reply: hand over bytes no player will
	 * show anything for, or `internal_error`, which reads as a broken host for a machine that is
	 * merely missing a program. `program` and `reason` are what make it actionable, exactly as
	 * on `frame-extraction-unavailable`, whose shape this is field for field.
	 *
	 * The second condition has no counterpart on `frame-extraction-unavailable` because only
	 * this tool needs a file: a temp directory the daemon cannot create (full, read-only, or
	 * private to a sandbox) reaches the agent here rather than as the `internal_error` an
	 * unmapped `mkdtemp` rejection would otherwise become. `reason` names the condition and
	 * never the directory, which is D19's business.
	 *
	 * Not a `missing-capability`: that one is about a *device backend* (D11), and a host tool
	 * says nothing about the hardware.
	 */
	z
		.object({
			kind: z.literal('recording-normalisation-unavailable'),
			serial: DeviceSerialSchema,
			program: z.string().min(1),
			reason: z.string().min(1),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * The normaliser ran and produced no normalised recording — a file it would not read, a
	 * filter or encoder it refused, a run that outlived its budget, or one that exited 0 having
	 * written nothing.
	 *
	 * Kept apart from the branch above because the two are fixed in different places: that one
	 * says install a program, this one says something about *these bytes* or about this build of
	 * it — a build without the H.264 encoder lands here, and its stderr names what is missing.
	 * The exit code and the stderr travel together because "a non-zero exit is data"
	 * (ai/CODING_STANDARDS.md), and `outcome` says how the run ended in words, since an exit, a
	 * signal and an exit-0 that wrote no file are indistinguishable from a code.
	 */
	z
		.object({
			kind: z.literal('recording-normalisation-failed'),
			serial: DeviceSerialSchema,
			program: z.string().min(1),
			exitCode: z.number().int().nullable(),
			stderr: z.string(),
			outcome: z.string().min(1),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * The frames were extracted and do not fit one answer beside the recording they came from.
	 *
	 * Its own kind rather than a shape of `artifact-too-large`, because the way out differs:
	 * that one is a capture that will never fit, while this has two knobs — a shorter recording
	 * or a lower `framesPerSecond` — and `frames` beside the two byte counts is what says which
	 * is worth turning. Refused whole rather than trimmed, for the reason
	 * `FramesTooLargeError` records: a frame list missing its middle reads as a recording in
	 * which nothing happened between two moments that are no longer adjacent.
	 */
	z
		.object({
			kind: z.literal('frames-too-large'),
			serial: DeviceSerialSchema,
			frames: z.number().int().nonnegative(),
			byteLength: z.number().int().nonnegative(),
			maxBytes: z.number().int().positive(),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * `install_app` was asked for the project's own install and this host has no hook file for
	 * that project.
	 *
	 * The first of the three ways a project install can answer "no", and all three are here
	 * rather than in `internal_error` for one reason: a host that has never been told about a
	 * project is a fact about somebody's configuration, not a daemon that broke, and the caller
	 * has two ways out — send the bytes, or have the project registered. `project` travels back
	 * because it is the caller's own string, and no path does: where hook files live is the
	 * host's own directory layout and names nothing on the machine reading this (D19).
	 */
	z
		.object({
			kind: z.literal('project-not-registered'),
			serial: DeviceSerialSchema,
			project: z.string().min(1),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * The project is registered and its hook file declares no `install` command.
	 *
	 * Kept apart from the branch above because the two are fixed in different places — a file
	 * that is not there, against a file that is there and says nothing about installing — and an
	 * agent that cannot tell them apart retries the call that already failed. Its existence is
	 * also what keeps `ok` from being reachable with nothing installed: there is no default
	 * command, because a default here would be the core naming an application (D13).
	 */
	z
		.object({
			kind: z.literal('install-hook-undeclared'),
			serial: DeviceSerialSchema,
			project: z.string().min(1),
			message: z.string().min(1),
		})
		.strict(),
	/**
	 * The project's install command ran and did not succeed — a build that failed, a program
	 * that is not on this host, or one that outlived its budget.
	 *
	 * The exit code and the stderr tail travel together because "a non-zero exit is data"
	 * (ai/CODING_STANDARDS.md) and neither half is worth much alone; `signal` separates a command
	 * killed at its bound from one that exited on its own and from one that never started, since
	 * all three read the same from a null exit code, and `outcome` is that distinction in words.
	 * `command` is what the hook file named — the one piece of host-side configuration in this
	 * union, and it is here because a failure that cannot say what failed leaves an operator
	 * grepping their own hook files.
	 */
	z
		.object({
			kind: z.literal('install-hook-failed'),
			serial: DeviceSerialSchema,
			project: z.string().min(1),
			command: z.string().min(1),
			exitCode: z.number().int().nullable(),
			signal: z.string().nullable(),
			stderr: z.string(),
			outcome: z.string().min(1),
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
 * Adding a further error class to the verb layer without a branch here surfaces as that
 * class's own test seeing an internal error instead of an answer, which is the loud version
 * of this drifting.
 *
 * The four failures that are about a **host tool** rather than a device are delegated to
 * {@link hostToolFailure} — one list this long is harder to read than two, and those four
 * genuinely belong together.
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
	if (error instanceof ArtifactTooLargeError) {
		return {
			kind: 'artifact-too-large',
			serial: error.serial,
			byteLength: error.byteLength,
			maxBytes: error.maxBytes,
			message: error.message,
		};
	}
	if (error instanceof UnfinishedRecordingError) {
		return {
			kind: 'unfinished-recording',
			serial: error.serial,
			byteLength: error.byteLength,
			message: error.message,
		};
	}
	const hostTool = hostToolFailure(error);
	if (hostTool !== null) return hostTool;
	if (error instanceof FramesTooLargeError) {
		return {
			kind: 'frames-too-large',
			serial: error.serial,
			frames: error.frames,
			byteLength: error.byteLength,
			maxBytes: error.maxBytes,
			message: error.message,
		};
	}
	if (error instanceof ProjectNotRegisteredError) {
		return {
			kind: 'project-not-registered',
			serial: error.serial,
			project: error.project,
			message: error.message,
		};
	}
	if (error instanceof InstallHookUndeclaredError) {
		return {
			kind: 'install-hook-undeclared',
			serial: error.serial,
			project: error.project,
			message: error.message,
		};
	}
	if (error instanceof InstallHookFailedError) {
		return {
			kind: 'install-hook-failed',
			serial: error.serial,
			project: error.project,
			command: error.command,
			exitCode: error.exitCode,
			signal: error.signal,
			stderr: error.stderr,
			outcome: error.outcome,
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

/**
 * The four failures that are about a **host tool** rather than about a device, split out of
 * {@link toVerbFailure} so neither function is a wall of branches.
 *
 * They belong together on their own terms and not only for the line count: each says something
 * about the machine holding the device rather than about the hardware, so none of them is a
 * `missing-capability` (D11) and none may ever be an `internal_error` — a host that is merely
 * missing a program is not a broken one. `record_video` is the one verb that reaches two host
 * tools, and both answer in the same two shapes: one for a program that never started, one for
 * a run that produced nothing.
 *
 * Returns `null` for anything else, so the caller carries on down its own list.
 */
function hostToolFailure(error: unknown): VerbFailure | null {
	if (error instanceof FrameExtractionUnavailableError) {
		return {
			kind: 'frame-extraction-unavailable',
			serial: error.serial,
			program: error.program,
			reason: error.reason,
			message: error.message,
		};
	}
	if (error instanceof FrameExtractionFailedError) {
		return {
			kind: 'frame-extraction-failed',
			serial: error.serial,
			program: error.program,
			exitCode: error.exitCode,
			stderr: error.stderr,
			outcome: error.outcome,
			message: error.message,
		};
	}
	if (error instanceof RecordingNormalisationUnavailableError) {
		return {
			kind: 'recording-normalisation-unavailable',
			serial: error.serial,
			program: error.program,
			reason: error.reason,
			message: error.message,
		};
	}
	if (error instanceof RecordingNormalisationFailedError) {
		return {
			kind: 'recording-normalisation-failed',
			serial: error.serial,
			program: error.program,
			exitCode: error.exitCode,
			stderr: error.stderr,
			outcome: error.outcome,
			message: error.message,
		};
	}
	return null;
}
