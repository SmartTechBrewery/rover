/**
 * `record_video` — a recording of the screen, finished before it is pulled (PROJECT.md §4,
 * "Reading"; backlog row R14, phases 1 and 2).
 *
 * **The whole verb is one promise: the bytes an agent receives are a file a player will
 * open.** A recorder writes its container index last, so a recording copied off a device
 * while the encoder is still running is not a shorter video — it is a file no decoder will
 * accept at all, which reads to an agent as a broken tool rather than as a race. The backend
 * behind this waits on a *condition* for the recorder to be gone (D12(b) — never a sleep),
 * checks the index on the bytes that actually arrived, and refuses them by name
 * (`unfinished-recording`, `./failure.ts`) rather than handing over something unreadable.
 * Nothing about that is this layer's to redo; what this layer does is make sure the verb
 * cannot be dispatched to a backend that never made the promise.
 *
 * **`requires: ['canRecordVideo']`, for `read_screen`'s reason.** The payload *is* the
 * answer here, so a backend without it must fail loudly before anything is dispatched rather
 * than return a result whose `artifact` is null and whose after-state looks like a success
 * (D11). Recording is a genuine divergence rather than a universal: one platform records a
 * simulator with a command-line tool and has no cheap equivalent for a physical device
 * (PROJECT.md §5).
 *
 * **The recording rides on `ActionResult.artifact`**, exactly as `screenshot`'s capture does
 * — same encoding, same bound, same `artifact-too-large` refusal, and never a path (D19).
 * Phase 2 added the frames beside it as an `ActionResultSchema.extend(…)` in the shape
 * `ReadLogsResultSchema` established ({@link RecordVideoResultSchema}), with the recording
 * left exactly where phase 1 put it.
 *
 * **The frames come out of the finished recording, on the host** (`src/daemon/frames.ts`) — after the
 * completion condition and the pull, never sampled during the capture and never a second pass
 * over the device. The verb answers with both or with neither: a host that cannot slice the
 * recording refuses by name rather than answering with an empty list, because an empty list
 * reads as a screen on which nothing happened (ai/RULES.md §2).
 *
 * **The after-state is the screen when the recording *ended*, not during it.** Every verb
 * answers with the state after itself (D12(c)) and this one is no exception, but the gap
 * between "after" and "throughout" is wider here than anywhere else: several seconds of the
 * device's life happened inside this call, and the one screen read at the end describes none
 * of it.
 *
 * **What a recording is honest about** (PROJECT.md §8): it samples motion, and the frames
 * sample it again, more coarsely. Both can say something moved and roughly when; neither can
 * say how the movement eased, whether a frame was dropped, or whether what a person would
 * call jank happened. An agent asking "is this animation smooth" is asking a question this
 * verb does not answer, and reading an answer out of it anyway is the plausible-looking wrong
 * result the whole design is against.
 */

import { z } from 'zod';
import type { DeviceSerial } from '../core/ids.js';
import { capabilityMethod, type VerbContext } from './context.js';
import { FramesTooLargeError } from './errors.js';
import { performAction } from './perform.js';
import { ActionResultSchema, type Artifact, ArtifactSchema, artifactFrom } from './result.js';

/**
 * How long a caller who did not say records for.
 *
 * The default lives here rather than in a backend, so no two backends can pick different
 * ones, and it is a constant rather than configuration (ai/RULES.md §7) — the reasoning
 * `DEFAULT_MAX_LOG_ENTRIES` records, verbatim. Five seconds is long enough to hold a
 * transition, a load and the screen that follows it, and short enough that a caller who
 * asked for "a recording" without thinking about it is not billed several megabytes.
 */
export const DEFAULT_RECORDING_MS = 5_000;

/**
 * The longest recording one answer can carry — fifteen seconds.
 *
 * **A bound on what fits in one message, not an opinion about recordings.** The answer
 * travels on `ActionResult.artifact` under `MAX_ARTIFACT_BYTES` (4 MiB, `./result.ts`), and
 * a backend recording at 2 Mbps — 250 KB/s — fills about 3.6 MiB of that in fifteen seconds,
 * with room to spare. The first backend to implement this asserts that relationship against
 * its own bit rate in its own suite, because a constant derived from another by hand is one
 * the other is free to drift away from.
 *
 * A longer recording is R24's chunked transfer, not this bound quietly raised: going over
 * `MAX_ARTIFACT_BYTES` is still the `artifact-too-large` refusal naming both numbers, never
 * a file cut short. And a caller asking for one near this bound has a second bound to raise
 * at its own end — `IpcRequestOptions.timeoutMs`, which defaults to 30 s
 * (`src/ipc/client.ts`), against a call that spends fifteen of them recording before it
 * starts transferring anything.
 */
export const MAX_RECORDING_MS = 15_000;

/**
 * How many frames a second a caller who did not say gets.
 *
 * A constant rather than configuration (ai/RULES.md §7) for {@link DEFAULT_RECORDING_MS}'s
 * reason, and it lives beside it so the two defaults that decide the size of an answer are
 * read together. Two a second is dense enough to catch a transition inside the five seconds a
 * default recording lasts, and sparse enough that a caller who asked for "a recording"
 * without thinking about it gets ten readable frames rather than a hundred near-identical
 * ones.
 */
export const DEFAULT_FRAMES_PER_SECOND = 2;

/**
 * The densest sampling one answer can carry.
 *
 * A bound on the payload rather than an opinion about motion: past this the frames stop being
 * a sample and start being the recording again, at several times its size, since a lossless
 * image of a screen compresses nothing like an inter-frame-coded video of the same screen. A
 * caller who wants every frame already has the recording on `ActionResult.artifact`.
 */
export const MAX_FRAMES_PER_SECOND = 4;

/**
 * The most frames one answer may carry — {@link MAX_RECORDING_MS} at
 * {@link MAX_FRAMES_PER_SECOND}, **plus one for the round-up**.
 *
 * The derivation is what a recording whose timeline matches the call can produce. Sampling
 * rounds *up* (`fps=n:round=up`, `src/daemon/frames.ts`), mapping an input sample at time `t`
 * to output slot `ceil(t × n)`: a stream whose last sample sits anywhere above `(k − 1) / n`
 * fills slots `0…k`, one more frame than `duration × rate`. So a fifteen-second recording at
 * four frames a second is 61 frames and not 60. `tests/unit/verbs/record.test.ts` asserts that
 * relationship, because a constant derived from another by hand is one the other is free to
 * drift away from.
 *
 * **A real bound, not a guard that cannot bite** — this was measured, and the measurement is in
 * PROJECT.md §6. A recording of a screen that barely changed carries a container duration far
 * longer than the recording was asked for: fifteen seconds asked for came back declaring
 * **27.61 s** across two encoded samples, because a recorder that emits a buffer only when the
 * screen changes can leave its last sample's timestamp well past the end of the window. The
 * sampling follows the timeline the container declares, not the one the caller asked for, so at
 * four frames a second that is a hundred-odd slots for a call the wire admits.
 *
 * So it is **enforced as a refusal**. The extractor asks the decoder for one frame more than
 * this and fails by name when that many come back (`src/daemon/frames.ts`), because the one
 * thing that must never happen here is a list arriving quietly cut short: `-frames:v` at the
 * bound itself would stop ffmpeg and exit 0, and nothing downstream could tell that answer from
 * a complete one. {@link MAX_FRAMES_BYTES} stops an over-sized answer the same way, naming both
 * numbers, and in practice usually first.
 */
export const MAX_FRAMES = 61;

/**
 * How long the host may spend slicing one recording into frames.
 *
 * **A verb-layer bound rather than the runner's own**, even though the only thing that reads
 * it is `src/daemon/frames.ts`. Every external invocation has a timeout
 * (ai/CODING_STANDARDS.md) — a hung decoder with no timeout wedges a lease until it expires,
 * and this one runs while a lease is held — but the number also has to be visible to the
 * *client*, whose request timeout covers the whole call and has to be larger than every
 * budget inside it (`src/cli/commands/record.ts`). A client cannot import a daemon module
 * without putting a process spawn in its module graph (D19,
 * `tests/unit/no-backend-in-a-client.test.ts`), so the bound lives here beside the other
 * numbers that decide how long this verb takes, and both ends import it.
 *
 * Generous rather than tuned, for the reason the device bridge's own budgets are: it exists
 * to stop a wedged process holding a lease forever, not to bound a slow but healthy decode.
 * Three seconds of a 1080×2400 screen became four images in well under a second on an
 * ordinary host (PROJECT.md §6); a fifteen-second recording of a busy screen on a loaded
 * machine is what the rest of the budget is for.
 */
export const FRAME_EXTRACTION_TIMEOUT_MS = 60_000;

/**
 * How wide a frame is, in pixels; the height follows the recording's aspect ratio.
 *
 * **Frames are scaled down on purpose.** A frame is for reading *what changed* — a dialog
 * appeared, the screen rotated, a list moved — and the full-resolution read of a single moment
 * is `screenshot`, which is the verb for anything measured off pixels. Small matters twice
 * over, because these are lossless images: a full-width encode of a photographic wallpaper is
 * over a megabyte a frame, and ten of those are an answer that cannot be sent at all.
 *
 * Measured rather than guessed: 320 px wide frames of a launcher screen with a gradient
 * wallpaper — close to the worst case for this encoding — came back at about 100 KB each
 * (PROJECT.md §6), so a default five-second recording's ten frames sit comfortably inside
 * {@link MAX_FRAMES_BYTES}.
 */
export const FRAME_WIDTH_PX = 320;

/**
 * The most frame **bytes** one answer may carry — 1.5 MiB, before base64.
 *
 * Derived from the 8 MiB frame cap (`src/ipc/framing.ts`) the way `MAX_ARTIFACT_BYTES` and
 * `MAX_LOG_BYTES` are, and this derivation has one more term than either of theirs: the
 * recording travels in the **same** message as the frames cut out of it. A 4 MiB recording
 * (`MAX_ARTIFACT_BYTES`) base64-encodes to 5⅓ MiB, these 1.5 MiB encode to 2 MiB, and the two
 * together leave two thirds of a mebibyte for the screen read and the JSON around it.
 * `tests/unit/verbs/record.test.ts` asserts that relationship rather than trusting this
 * paragraph.
 *
 * Going over it is {@link FramesTooLargeError} — a refusal naming both numbers, never a
 * shorter list. Trimming here would be worse than trimming a log: entries have an order a
 * caller understands and `truncated` to say some went, while a frame list silently missing its
 * middle reads as a recording in which nothing happened between two moments that are no longer
 * adjacent. The way out is a shorter recording or a lower rate, and the numbers in the refusal
 * are what say which.
 */
export const MAX_FRAMES_BYTES = 3 * 512 * 1024;

/**
 * How a finished recording becomes frames — declared here, implemented on the host.
 *
 * **The verb layer names the shape and never the tool.** Slicing a recording needs a decoder,
 * this tree has none, and the one that exists is a program on the host — so the
 * implementation starts a process, and a process started anywhere under `src/verbs/` would
 * put `node:child_process` in every client's module graph, since `src/ipc/verb-methods.ts`
 * imports these schemas (D19, `tests/unit/daemon/remote-never-spawns.test.ts`). So the daemon
 * supplies it (`src/daemon/frames.ts`), exactly as it supplies `context.backend`.
 *
 * It is a parameter rather than a `Capabilities` flag because it is a fact about the **host**,
 * not about the device: capabilities describe what a backend can do (D11), and a host missing
 * a program has a different remedy — install it here, rather than stop asking this device.
 */
export type FrameExtractor = (
	serial: DeviceSerial,
	recording: Uint8Array,
	options: { readonly framesPerSecond: number },
) => Promise<Uint8Array[]>;

/**
 * What `record_video` answers with: everything every verb answers with, **plus the frames**.
 *
 * `ActionResultSchema.extend(…)` rather than a shape of its own, the way
 * `ReadLogsResultSchema` already does it, so the common half cannot drift from what the other
 * verbs produce and a client parses one `ActionResult` whichever verb it called. The recording
 * stays on `artifact` where phase 1 put it — the frames are the one field added, not a second
 * home for the bytes.
 *
 * `frames` is **required rather than optional** — `undefined` does not survive JSON — and on an
 * `ok` answer it is **never empty**. There is no recording left that legitimately samples to
 * nothing: the one case there was, a screen that never changed and so produced a single sample
 * with no duration, is covered by `round=up` (`src/daemon/frames.ts`), and every other way a
 * host produces no images is one of the `frame-extraction-…` failures (`./errors.ts`). An
 * empty list would be the plausible-looking empty result ai/RULES.md §2 forbids, so it is
 * refused by name at the extractor instead.
 *
 * The schema still admits one, deliberately: a `.min(1)` here would be a second bound on the
 * same fact, and the answer it produces is worse — a client failing to *parse* a host's reply,
 * rather than the named failure the host already sent. The guarantee is enforced where it can
 * be given a name.
 */
export const RecordVideoResultSchema = ActionResultSchema.extend({
	frames: z.array(ArtifactSchema),
}).strict();
export type RecordVideoResult = z.infer<typeof RecordVideoResultSchema>;

export interface RecordVideoVerbOptions {
	/**
	 * How the host slices the recording ({@link FrameExtractor}).
	 *
	 * **Required, and deliberately without a default**, which is the one thing keeping the
	 * decoder out of every client's module graph: a default would be an import, and the import
	 * is what puts a process spawn in a CLI. It is also what makes an empty frame list
	 * impossible to reach by accident — there is no way to call this verb without saying who
	 * extracts, and an extractor that found nothing to extract says so by throwing rather than
	 * by answering with an empty array (`src/daemon/frames.ts`).
	 */
	readonly extractFrames: FrameExtractor;
	/**
	 * Defaults to {@link DEFAULT_RECORDING_MS}. Bounded by {@link MAX_RECORDING_MS} and held
	 * positive on the wire (`RecordVideoParamsSchema`), the way `read_logs` bounds `maxEntries`
	 * there rather than here. A duration the caller did send travels unaltered — including a
	 * zero, which is why a backend floors it at its own granularity rather than passing it on
	 * (`RecordVideoOptions` in `src/core/device.ts`).
	 */
	readonly durationMs?: number;
	/**
	 * How densely the recording is sampled into frames. Defaults to
	 * {@link DEFAULT_FRAMES_PER_SECOND} and bounded by {@link MAX_FRAMES_PER_SECOND} on the
	 * wire (`RecordVideoParamsSchema`), for the reason `durationMs` is bounded there rather
	 * than here.
	 */
	readonly framesPerSecond?: number;
}

/**
 * Record the screen for a while and answer with the video **and the frames sliced out of it**.
 *
 * The recording comes back on `result.artifact`, base64-encoded, with `mediaType` read off the
 * bytes themselves and `byteLength` the length of what decodes; the frames come back on
 * `result.frames`, in the order they were recorded, each one an `Artifact` in exactly that
 * shape. **Never a path**, on either: the recording happens on the host and the answer is read
 * wherever the agent is, so a filesystem location would name a file that is not there — or,
 * worse, one that is (D19).
 *
 * A recording too large for one answer is refused by name rather than trimmed, one that came
 * off the device unfinished is refused by name rather than handed over, a host that cannot
 * slice one refuses by name rather than answering with an empty list, and frames that would
 * not fit beside the recording are refused whole — see this module's header and `./errors.ts`
 * for why each is worth a branch of its own.
 */
export async function recordVideo(
	context: VerbContext,
	options: RecordVideoVerbOptions,
): Promise<RecordVideoResult> {
	const durationMs = options.durationMs ?? DEFAULT_RECORDING_MS;
	const framesPerSecond = options.framesPerSecond ?? DEFAULT_FRAMES_PER_SECOND;
	let captured: Artifact | null = null;
	let frames: Artifact[] = [];

	const result = await performAction(context, {
		verb: 'record_video',
		requires: ['canRecordVideo'],
		act: async () => {
			// `capabilityMethod` rather than `context.backend.recordVideo?.(…)`: it is the only
			// path this layer may reach an optional method by, so the manifest is consulted
			// before the dispatch rather than wherever a verb author remembered to (`./context.ts`).
			const record = capabilityMethod(context, 'canRecordVideo', 'recordVideo');
			const recording = await record(context.serial, { durationMs });
			// Encoded here, inside the action, for `screenshot`'s stated reason: a recording too
			// large to answer with refuses before the spine spends a screen read reaching the
			// same refusal. The extraction is inside it for the same reason, and it runs on the
			// bytes rather than on the device — the recording is finished and pulled by the time
			// this line is reached, which is the whole of what phase 1 promised.
			captured = artifactFrom(context.serial, recording);
			frames = withinByteBudget(
				context.serial,
				await options.extractFrames(context.serial, recording, { framesPerSecond }),
			).map((frame) => artifactFrom(context.serial, frame));
		},
	});

	// Re-parsed rather than spread and returned, so both payloads are held to the same schema
	// the spine's own answer was — the shape `screenshot` established and `read_logs` extended.
	return RecordVideoResultSchema.parse({ ...result, artifact: captured, frames });
}

/**
 * The frames, or the refusal that says they do not fit.
 *
 * Checked **here** rather than inside an extractor, so the bound holds whichever
 * {@link FrameExtractor} the host supplied: what one answer may carry is the verb layer's
 * question, not a host tool's, and a bound enforced in the implementation is one a second
 * implementation is free to forget. Checked before the encoding for the reason `artifactFrom`
 * checks before its own: base64 of an over-sized payload is a copy a third larger again, built
 * only to be thrown away.
 *
 * @throws FramesTooLargeError when the frames are over {@link MAX_FRAMES_BYTES} together.
 */
function withinByteBudget(
	serial: DeviceSerial,
	frames: readonly Uint8Array[],
): readonly Uint8Array[] {
	const byteLength = frames.reduce((total, frame) => total + frame.byteLength, 0);
	if (byteLength > MAX_FRAMES_BYTES) {
		throw new FramesTooLargeError(serial, frames.length, byteLength, MAX_FRAMES_BYTES);
	}
	return frames;
}
