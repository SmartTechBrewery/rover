/**
 * What the host does to a recording so the file it hands back always **plays** (#185).
 *
 * `screenrecord` writes a variable-frame-rate stream whose samples exist only where the screen
 * changed, and two files come out of that — both structurally valid, both passing every check
 * `record_video` makes, and neither one a video a person can open:
 *
 * - a capture of a screen that did not change is **one sample declaring a duration of zero**,
 *   which no player shows anything for. There is nothing to scrub and no timeline;
 * - an ordinary capture declares a timeline that is not the one that was asked for. PROJECT.md
 *   §6 has a 15 s capture coming back declaring **27.61 s** across two samples, because the
 *   last sample's timestamp can sit far past the end of the window.
 *
 * So the artifact was faithful to the encoder and unusable as a video, and it is written to a
 * client's disk (R24) and filed in the durable archive (R25, D23), where whoever opens it is
 * not the agent that recorded it and has no way to tell a broken file from a still screen.
 * The fix is one host-side pass that re-encodes the pulled recording at a constant frame rate
 * over a real timeline (`src/daemon/normalise.ts`), before the bytes become `result.artifact`.
 *
 * **This module is the policy and none of the work.** It decides, from what the pulled
 * container declares (#183, `./recording-container.ts`), which of two timelines the answered
 * file carries and what the answer says about it. That is a pure function over data already in
 * hand — no process, no filesystem — so it stays in the verb layer and costs no client's module
 * graph anything, exactly as `./recording-container.ts` does and for its reason.
 *
 * **Two timelines, and the answer names which one it is showing:**
 *
 * - a container that declares **no duration at all** — a still screen, in either of the two
 *   shapes it arrives in — is held for the window that was **requested**. Holding the last
 *   frame is faithful rather than invented: a virtual display emits a buffer only when the
 *   screen changes, so "the screen looked like this for the rest of the window" is precisely
 *   what the absence of a sample *means*, and it is the same fact `STILL_SCREEN_MESSAGE`
 *   already states. Padding can destroy nothing here, because there is nothing past the cut.
 * - a container that declares a timeline keeps **its own**, made constant-rate, with every
 *   sample intact. The 27.61 s case comes back as a 27.61 s file that is scrubbable and
 *   trustworthy against its own content, and the answer says the length is the recorder's
 *   rather than the window that was asked for. Compressing it into the requested window would
 *   have to either drop the late sample or re-time it, and both are the plausible-looking wrong
 *   answer ai/RULES.md §2 exists against.
 *
 * **`result.container` still describes the pulled bytes and this describes the answered ones.**
 * Reading the container off the normalised file instead would erase the still-screen naming
 * #183 exists for — a normalised still screen is N samples over the window, indistinguishable
 * from a busy one — so the two fields are deliberately about two different files, and
 * {@link RecordingNormalisation}'s message is what bridges them.
 */

import { z } from 'zod';
import type { RecordingContainer } from './recording-container.js';

/**
 * The constant rate the normalised recording carries.
 *
 * **A rate a player can rely on rather than an opinion about motion.** The source has no rate
 * at all — `r_frame_rate` comes back `1/0` on a still capture (PROJECT.md §6) — so this is not
 * a resampling of something that had one, it is the first one the file has ever declared.
 * Thirty is the ordinary rate for screen content: high enough that a transition normalised out
 * of a busy capture still reads as motion, and low enough that the constant-rate re-encode of a
 * mostly-still screen costs almost nothing, because a duplicated frame is nearly free in H.264.
 *
 * It is not `MAX_FRAMES_PER_SECOND` and has nothing to do with it: that one bounds how
 * many *images* one answer may carry, and the frames are sliced from the pulled recording
 * rather than from this one (`./record.ts`).
 */
export const NORMALISED_FRAME_RATE = 30;

/**
 * The ceiling on the normalised recording's bit rate — 2 Mbit/s.
 *
 * **Derived from what one answer can carry, so normalising cannot turn a call that worked into
 * a refusal.** The pulled recording is already bounded by whatever rate the backend recorded
 * at; a re-encode is free to be *larger* than its input, and a quality-targeted one of a busy
 * 1080p screen is dramatically larger — a 15 s worst case measured at **10 099 915 bytes**
 * unbounded against the 4 MiB `MAX_ARTIFACT_BYTES` (PROJECT.md §6). Left uncapped, this change
 * would answer `artifact-too-large` for recordings that are handed over fine today, which is
 * the opposite of the point.
 *
 * So the encoder is given a rate ceiling under which the longest recording the wire admits
 * still fits one answer: `MAX_RECORDING_MS` at this rate is 3.75 MB against
 * `MAX_ARTIFACT_BYTES`' 4 MiB, with the container's own boxes and the encoder's buffering slack
 * inside the margin — the same worst case measured **3 772 368 bytes** with it.
 * `tests/unit/verbs/recording-normalisation.test.ts` asserts that relationship rather than
 * trusting this paragraph.
 *
 * It is a ceiling and not a target: a still screen held for its window is tens of kilobytes,
 * because what the file costs still follows the content. And it is not a guarantee — a
 * container declaring a timeline *longer* than the request (PROJECT.md §6's 27.61 s) keeps that
 * timeline and can still go over, which stays the existing `artifact-too-large` refusal naming
 * both numbers, checked on the bytes that are actually answered with.
 */
export const NORMALISED_MAX_BIT_RATE_BPS = 2_000_000;

/**
 * How long the host may spend normalising one recording.
 *
 * Every external invocation has a timeout (ai/CODING_STANDARDS.md) and this one runs while a
 * lease is held, so a wedged encoder must not hold that lease until it expires. Generous rather
 * than tuned, for the reason `FRAME_EXTRACTION_TIMEOUT_MS` is: it exists to stop a wedged
 * process, not to bound a slow but healthy encode on a loaded machine.
 *
 * It lives here rather than in `src/daemon/normalise.ts` for exactly that constant's reason —
 * both clients' request timeouts have to be larger than every host budget inside the call, and
 * a client may not import a daemon module (D19). It is in *this* module rather than beside it
 * in `./record.ts` only to keep the imports acyclic: `./record.ts` imports this one.
 */
export const RECORDING_NORMALISATION_TIMEOUT_MS = 60_000;

/**
 * What the answer says about the file it is handing over.
 *
 * `RecordingContainerSchema`'s idiom (`./recording-container.ts`): `timeline` is what an agent
 * branches on, `message` is what it reads. The two are deliberately about the **normalised**
 * recording, where `container` is about the bytes that came off the device — a still screen is
 * `container.kind: 'still-screen'` and `normalisation.timeline: 'requested'` on the same
 * answer, and that pair is the whole story of what happened to the file.
 */
export const RecordingNormalisationSchema = z
	.object({
		/**
		 * `requested` — the content is held across the window the caller asked for, because the
		 * recorder declared no timeline to keep. `container` — the recorder's own timeline is
		 * what the file follows, which is **not** the requested one and can be much longer.
		 */
		timeline: z.enum(['requested', 'container']),
		/**
		 * How long the answered file runs, in milliseconds. `null` only when this host could not
		 * read the container it came from, so there was no number to carry — required and
		 * nullable rather than optional, because `undefined` does not survive JSON.
		 */
		durationMs: z.number().nonnegative().nullable(),
		/** The constant rate the answered file declares ({@link NORMALISED_FRAME_RATE}). */
		framesPerSecond: z.number().positive(),
		/** Which of the two timelines this is, in a sentence, and why it is that one. */
		message: z.string().min(1),
	})
	.strict();
export type RecordingNormalisation = z.infer<typeof RecordingNormalisationSchema>;

/** What the host is asked to produce, and what the answer will say it produced. */
export interface NormalisationPlan {
	/**
	 * Non-null: hold the content across this many milliseconds, because the source declares no
	 * timeline of its own. Null: keep the container's timeline exactly as it is, every sample
	 * intact.
	 */
	readonly holdForMs: number | null;
	/** The field that goes on the answer beside `container`. */
	readonly report: RecordingNormalisation;
}

/**
 * The sentence a person reads when the file they were handed is the requested window rather
 * than anything the recorder timed.
 *
 * Written the way `STILL_SCREEN_MESSAGE` is, and pointing at it: an agent that reads this one
 * and `container` together has the whole of what happened, and neither sentence needs the other
 * to be actionable.
 */
const HELD_FOR_REQUESTED_WINDOW_MESSAGE =
	`The recording that came off the device declared no timeline at all — see 'container' — so ` +
	`no player would have shown anything for it. What is in the answer is that unchanged screen ` +
	`held across the window that was asked for, at a constant frame rate, so it opens and ` +
	`scrubs like an ordinary video. Nothing was invented to fill it: a device's virtual display ` +
	`emits a buffer only when the screen changes, so "the screen looked like this for the rest ` +
	`of the window" is what the absence of any further sample means.`;

/**
 * The sentence for the other branch, and it exists because the number on the file is genuinely
 * surprising.
 *
 * A caller who asked for fifteen seconds and got a file declaring 27.61 s needs to be told that
 * this is the recorder's own timing rather than a fault, and where the explanation lives —
 * otherwise the length reads as the same class of defect #183 was filed as.
 */
const KEPT_CONTAINER_TIMELINE_MESSAGE =
	`This file's length is what the recorder's own timestamps declare, made constant-rate — it ` +
	`is not the window that was asked for, and the two are routinely different. A device's ` +
	`virtual display emits a buffer only when the screen changes, so the last sample's ` +
	`timestamp can sit well past the end of the requested window; PROJECT.md §6 has a 15 s ` +
	`capture declaring 27.61 s. Every sample the recorder wrote is still in the file — ` +
	`compressing it into the requested window would mean dropping one or re-timing it.`;

/**
 * How this recording is normalised, and what the answer will say about it.
 *
 * Never throws and never refuses: every recording is normalised, including one whose container
 * this host could not read at all. That one keeps its own timeline — there is no requested
 * window to hold it across that could be justified from bytes nobody parsed — and says so with
 * a `durationMs` of `null` rather than a number nobody measured.
 */
export function planNormalisation(
	container: RecordingContainer,
	requestedMs: number,
): NormalisationPlan {
	// The hold is on the container declaring *no* duration, which is the still-screen fact in
	// both shapes it arrives in: `still-screen` is one sample of zero duration, and a `samples`
	// container of zero duration is the same fact with more samples in it. A requested zero
	// never holds — `-t 0` writes an empty file, and the core is callable in process, so a
	// caller that really sent one gets the container branch rather than nothing at all.
	if (container.kind !== 'unreadable' && container.durationMs === 0 && requestedMs > 0) {
		return {
			holdForMs: requestedMs,
			report: RecordingNormalisationSchema.parse({
				timeline: 'requested',
				durationMs: requestedMs,
				framesPerSecond: NORMALISED_FRAME_RATE,
				message: HELD_FOR_REQUESTED_WINDOW_MESSAGE,
			}),
		};
	}

	return {
		holdForMs: null,
		report: RecordingNormalisationSchema.parse({
			timeline: 'container',
			durationMs: container.kind === 'unreadable' ? null : container.durationMs,
			framesPerSecond: NORMALISED_FRAME_RATE,
			message: KEPT_CONTAINER_TIMELINE_MESSAGE,
		}),
	};
}
