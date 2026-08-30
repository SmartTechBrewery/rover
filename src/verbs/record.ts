/**
 * `record_video` — a recording of the screen, finished before it is pulled (PROJECT.md §4,
 * "Reading"; backlog row R14, phase 1).
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
 * There is no new result schema, because there is no new field: what phase 2 adds is
 * extracted frames, and they will be an `ActionResultSchema.extend(…)` in the shape
 * `ReadLogsResultSchema` established, with the recording staying where this phase put it.
 *
 * **The after-state is the screen when the recording *ended*, not during it.** Every verb
 * answers with the state after itself (D12(c)) and this one is no exception, but the gap
 * between "after" and "throughout" is wider here than anywhere else: several seconds of the
 * device's life happened inside this call, and the one screen read at the end describes none
 * of it.
 *
 * **What a recording is honest about** (PROJECT.md §8): it samples motion. It can say
 * something moved and roughly when; it cannot say how the movement eased, whether a frame
 * was dropped, or whether what a person would call jank happened. An agent asking "is this
 * animation smooth" is asking a question this verb does not answer, and reading an answer
 * out of it anyway is the plausible-looking wrong result the whole design is against.
 */

import { capabilityMethod, type VerbContext } from './context.js';
import { performAction } from './perform.js';
import { type ActionResult, ActionResultSchema, type Artifact, artifactFrom } from './result.js';

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

export interface RecordVideoVerbOptions {
	/**
	 * Defaults to {@link DEFAULT_RECORDING_MS}. Bounded by {@link MAX_RECORDING_MS} and held
	 * positive on the wire (`RecordVideoParamsSchema`), the way `read_logs` bounds `maxEntries`
	 * there rather than here. A duration the caller did send travels unaltered — including a
	 * zero, which is why a backend floors it at its own granularity rather than passing it on
	 * (`RecordVideoOptions` in `src/core/device.ts`).
	 */
	readonly durationMs?: number;
}

/**
 * Record the screen for a while and answer with the video.
 *
 * The bytes come back on `result.artifact`, base64-encoded, with `mediaType` read off the
 * bytes themselves and `byteLength` the length of what decodes. **Never a path**: the
 * recording happens on the host and the answer is read wherever the agent is, so a
 * filesystem location would name a file that is not there — or, worse, one that is (D19).
 *
 * A recording too large for one answer is refused by name rather than trimmed, and one that
 * came off the device unfinished is refused by name rather than handed over — see this
 * module's header for why the second refusal is worth a branch of its own.
 */
export async function recordVideo(
	context: VerbContext,
	options: RecordVideoVerbOptions = {},
): Promise<ActionResult> {
	const durationMs = options.durationMs ?? DEFAULT_RECORDING_MS;
	let captured: Artifact | null = null;

	const result = await performAction(context, {
		verb: 'record_video',
		requires: ['canRecordVideo'],
		act: async () => {
			// `capabilityMethod` rather than `context.backend.recordVideo?.(…)`: it is the only
			// path this layer may reach an optional method by, so the manifest is consulted
			// before the dispatch rather than wherever a verb author remembered to (`./context.ts`).
			const record = capabilityMethod(context, 'canRecordVideo', 'recordVideo');
			// Encoded here, inside the action, for `screenshot`'s stated reason: a recording too
			// large to answer with refuses before the spine spends a screen read reaching the
			// same refusal.
			captured = artifactFrom(context.serial, await record(context.serial, { durationMs }));
		},
	});

	// Re-parsed rather than spread and returned, so the artifact is held to the same schema
	// the spine's own answer was — the shape `screenshot` established.
	return ActionResultSchema.parse({ ...result, artifact: captured });
}
