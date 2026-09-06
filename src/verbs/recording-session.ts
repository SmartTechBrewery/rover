/**
 * `start_recording` and `stop_recording` — one recording across two calls, with the device
 * driven in between (#190, backlog row R43 phase 2).
 *
 * **Beside `./record.ts` rather than inside it, because the two are different lifecycles.**
 * `record_video` is a window fixed before anything happens: one call starts a recorder, waits
 * for it and answers with the whole file, so the only recording an agent can ask for is one it
 * has already decided the length of. This pair is the other shape — *record while I do this* —
 * and what it costs is that the recording outlives the call that started it. Everything below
 * follows from that one difference, and none of it belongs in a header that opens with "the
 * whole verb is one promise".
 *
 * **What is not different is the promise about the bytes.** The recording still comes back
 * finished or not at all, still on `ActionResult.artifact`, still under `MAX_ARTIFACT_BYTES`,
 * still sliced into frames by the host's own extractor under `MAX_FRAMES`,
 * `MAX_FRAMES_PER_SECOND` and `MAX_FRAMES_BYTES`, still described by `container` in exactly the
 * words #183 gave it, and still normalised so the file plays (#185). Every one of those is
 * imported from `./record.ts` rather than restated, and {@link RecordVideoResultSchema} is
 * reused whole rather than copied under a second name: a caller that has learned to read one
 * recording answer reads both, and a second shape carrying the same four fields is a second
 * shape free to drift.
 *
 * **`requires: ['canControlRecording']`, and deliberately not `canRecordVideo`.** Holding a
 * recording open needs a recorder that can be started, left running and signalled; a platform
 * whose recorder is one command taking a duration gives a perfectly good `record_video` and
 * cannot give this at all. That is a narrower backend, not a broken one, and D11 says it fails
 * loudly by name rather than at the call (`src/core/capabilities.ts`).
 *
 * **There is no host-side record that a recording is open** (D6). Neither verb keeps one and
 * neither asks for one: whether a device is recording is a question for the device, and the
 * backend asks it at the moment it matters. A map of open recordings here would be exactly the
 * stale daemon state D6 exists to prevent — wrong after a restart, after a recorder that
 * reached its own limit, and after a recorder some other program on the host started.
 *
 * **Which leaves one thing this pair genuinely cannot say, and it says so rather than
 * inventing it.** A recording's length here is the time between two calls, and nothing times
 * that: not the host, which remembers nothing, and not the device, which has no birth time to
 * subtract (PROJECT.md §6). So {@link stopRecording} normalises with **no requested window**,
 * the file keeps the recorder's own timeline, and `normalisation.message` says why. The one
 * case where that is visible is a screen nobody drove — which comes back as a single sample
 * declaring no duration, `container.kind: 'still-screen'`, exactly as `record_video`'s does.
 * `record_video` can hold that across the window its caller asked for; this cannot, because
 * there is no such window, and a length made up here would be a number nobody measured. What
 * the agent does about it is drive the device, which is what the tool description tells it to
 * do.
 *
 * **The after-state of a start is the screen the recording begins on** (D12(c)) — and unlike
 * `record_video`, where the one screen read at the end describes none of the seconds inside the
 * call, here the two after-states bracket the recording: the start's is what the device looked
 * like when the recorder came up, and the stop's is what it looked like when it went down.
 */

import { capabilityMethod, type VerbContext } from './context.js';
import { performAction } from './perform.js';
import {
	DEFAULT_FRAMES_PER_SECOND,
	type FrameExtractor,
	MAX_RECORDING_MS,
	type RecordingNormaliser,
	type RecordVideoResult,
	RecordVideoResultSchema,
	withinByteBudget,
} from './record.js';
import { type RecordingContainer, readRecordingContainer } from './recording-container.js';
import { planNormalisation, type RecordingNormalisation } from './recording-normalisation.js';
import { type ActionResult, type Artifact, artifactFrom } from './result.js';

/**
 * Start recording the screen and answer with the state the recording begins on.
 *
 * The call returns while the recorder runs, so the device is the caller's to drive from here
 * until it stops the recording — every input verb and `read_screen` work on it under the same
 * lease, and what they do is what the recording will contain (#184 phase 1 is what makes that
 * true: a screen read no longer queues behind a recording on the same device).
 *
 * **The recorder is started with a kill switch and it is not negotiable.** Nothing waits on this
 * recording, so until a lease's end tears one down (R43 phase 3) that limit is the only thing
 * standing between a caller that walked away and a recorder running on under the next lease. It
 * is {@link MAX_RECORDING_MS} — the same bound that caps `record_video`, because it is the same
 * bound for the same reason: what one answer can carry. A recording that reaches it stops
 * itself, and stopping afterwards still answers with the file it left, which is complete.
 *
 * **A device already recording is refused by name** — `recording-already-running`, naming the
 * device and the pids that were there — rather than queued behind the recording that is already
 * open or allowed to become a second recorder writing the same file. That covers this verb
 * twice over and `record_video` during an open session, because it is one fact about the device
 * rather than a rule about a call.
 *
 * There is deliberately **no duration argument**. The length is decided by when the caller
 * stops, which is the whole of what this pair is for, and a second number here would be a
 * second thing that could disagree with the recorder's own limit.
 */
export async function startRecording(context: VerbContext): Promise<ActionResult> {
	return performAction(context, {
		verb: 'start_recording',
		requires: ['canControlRecording'],
		act: async () => {
			// `capabilityMethod` rather than `context.backend.startRecording?.(…)`: it is the only
			// path this layer may reach an optional method by, so the manifest is consulted before
			// the dispatch rather than wherever a verb author remembered to (`./context.ts`).
			const start = capabilityMethod(context, 'canControlRecording', 'startRecording');
			await start(context.serial, { maxDurationMs: MAX_RECORDING_MS });
		},
	});
}

export interface StopRecordingVerbOptions {
	/**
	 * How the host slices the recording ({@link FrameExtractor}).
	 *
	 * **Required, and deliberately without a default**, for the reason `RecordVideoVerbOptions`
	 * states and this module inherits whole: a default would be an import, and the import is what
	 * puts a process spawn in every client's module graph (D19).
	 */
	readonly extractFrames: FrameExtractor;
	/**
	 * How the host turns the pulled recording into a file that plays
	 * ({@link RecordingNormaliser}). Required, and without a default, for
	 * {@link extractFrames}' reason to the letter.
	 */
	readonly normaliseRecording: RecordingNormaliser;
	/**
	 * How densely the recording is sampled into frames. Defaults to
	 * `DEFAULT_FRAMES_PER_SECOND` and bounded by `MAX_FRAMES_PER_SECOND` on the wire
	 * (`StopRecordingParamsSchema`), exactly where `record_video` bounds its own.
	 */
	readonly framesPerSecond?: number;
}

/**
 * Stop the recording this device is holding open and answer with the video and its frames.
 *
 * The answer is `record_video`'s, field for field ({@link RecordVideoResultSchema}): the
 * normalised recording on `result.artifact`, the frames sliced out of the pulled bytes on
 * `result.frames`, what the recording holds on `result.container`, and which timeline the
 * answered file follows on `result.normalisation`. Never a path, on any of them (D19).
 *
 * **A recorder that already stopped itself is not a failure.** It reached the limit
 * {@link startRecording} gave it; the file is complete and this answers with it, and `container`
 * is what says how much of the session it holds. The named failure is *nothing recorded at all*
 * — `no-recording-running`, for a stop with no recorder and nothing left behind — and a
 * recording that came off mid-write is still `unfinished-recording` naming the byte length,
 * never a file handed over.
 *
 * **`normalisation.timeline` is always `container` here**, and that is this verb's one
 * substantive difference from `record_video`: there is no requested window to hold anything
 * across — see this module's header — so the file carries the recorder's own timeline whatever
 * the recording turned out to be, and the message says so.
 */
export async function stopRecording(
	context: VerbContext,
	options: StopRecordingVerbOptions,
): Promise<RecordVideoResult> {
	const framesPerSecond = options.framesPerSecond ?? DEFAULT_FRAMES_PER_SECOND;
	let captured: Artifact | null = null;
	let frames: Artifact[] = [];
	let container: RecordingContainer | null = null;
	let normalisation: RecordingNormalisation | null = null;

	const result = await performAction(context, {
		verb: 'stop_recording',
		requires: ['canControlRecording'],
		act: async () => {
			const stop = capabilityMethod(context, 'canControlRecording', 'stopRecording');
			const recording = await stop(context.serial);
			// Read off the pulled bytes before anything re-encodes them, for `record_video`'s
			// stated reason: this is the only moment the recording the *device* produced exists,
			// and reading it off the normalised copy would erase the still-screen naming the field
			// is for (#183).
			container = readRecordingContainer(recording);
			// `null` rather than a duration: this call named no window, and there is none to
			// reconstruct — see this module's header (`./recording-normalisation.ts` is where the
			// two branches and their wording live).
			const plan = planNormalisation(container, null);
			const normalised = await options.normaliseRecording(context.serial, recording, {
				holdForMs: plan.holdForMs,
			});
			normalisation = plan.report;
			// The **normalised** bytes are what is bounded and answered with, because re-encoding
			// changes the byte count and `MAX_ARTIFACT_BYTES` is a bound on what is actually sent.
			captured = artifactFrom(context.serial, normalised);
			// Sliced from the **pulled** recording, which is what keeps the sampling following the
			// container's own timeline and so keeps `MAX_FRAMES`' derivation where it is.
			frames = withinByteBudget(
				context.serial,
				await options.extractFrames(context.serial, recording, { framesPerSecond }),
			).map((frame) => artifactFrom(context.serial, frame));
		},
	});

	// Re-parsed rather than spread and returned, so both payloads are held to the same schema the
	// spine's own answer was — `record_video`'s pattern, against `record_video`'s schema.
	return RecordVideoResultSchema.parse({
		...result,
		artifact: captured,
		frames,
		container,
		normalisation,
	});
}
