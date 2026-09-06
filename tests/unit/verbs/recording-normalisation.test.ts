/**
 * The normalisation policy: which of two timelines the answered file follows, and what the
 * answer says about it (#185).
 *
 * The decision is pure — a function of what the pulled container declared and what was asked
 * for — so this suite is the whole of it. Whether a real encoder produces the file this plan
 * describes is `tests/device/android/recording.test.ts`'s question, and the argv that asks for
 * it is `tests/unit/daemon/normalise.test.ts`'s.
 *
 * The two assertions that carry this module are about answers that would otherwise look fine:
 *
 * - **A recording that declared no timeline is held for the window that was asked for.** The
 *   alternative is the file this whole change exists against: one sample of zero duration,
 *   structurally valid, and nothing a player will show.
 * - **A recording that declared one keeps it, and the answer says so.** Compressing a container
 *   that declares 27.61 s into the 15 s that were requested would mean dropping a sample the
 *   recorder wrote or re-timing it, and both are the plausible-looking wrong answer
 *   ai/RULES.md §2 exists against — so the honest move is to keep the timeline and *name* it.
 *
 * Nothing here relates a frame count to a duration times a rate, and nothing may: PROJECT.md §6
 * rules that out as an assertion about a device's timing.
 */

import { describe, expect, it } from 'vitest';
import { MAX_FRAMES_PER_SECOND, MAX_RECORDING_MS } from '@/verbs/record.js';
import type { RecordingContainer } from '@/verbs/recording-container.js';
import {
	NORMALISED_FRAME_RATE,
	NORMALISED_MAX_BIT_RATE_BPS,
	planNormalisation,
	RECORDING_NORMALISATION_TIMEOUT_MS,
	RecordingNormalisationSchema,
} from '@/verbs/recording-normalisation.js';
import { MAX_ARTIFACT_BYTES } from '@/verbs/result.js';

/** The still-screen container, in the shape `readRecordingContainer` names it. */
const stillScreen: RecordingContainer = {
	kind: 'still-screen',
	sampleCount: 1,
	durationMs: 0,
	message: 'nothing on the screen changed while it was recording',
};

/** The same fact in the other shape it arrives in: more than one sample, still no duration. */
const samplesWithNoDuration: RecordingContainer = {
	kind: 'samples',
	sampleCount: 3,
	durationMs: 0,
};

/** PROJECT.md §6's measured case: a 15 s capture whose container declares 27.61 s. */
const declaresTwentySeven: RecordingContainer = {
	kind: 'samples',
	sampleCount: 2,
	durationMs: 27_610,
};

const unreadable: RecordingContainer = {
	kind: 'unreadable',
	message: "it has no 'moov' box",
};

describe('a recording that declared no timeline is held for the window that was asked for', () => {
	it('holds a still screen across the requested duration and says the timeline is the requested one', () => {
		const plan = planNormalisation(stillScreen, 6_000);

		expect(plan.holdForMs).toBe(6_000);
		expect(plan.report).toMatchObject({
			timeline: 'requested',
			durationMs: 6_000,
			framesPerSecond: NORMALISED_FRAME_RATE,
		});
	});

	/**
	 * The same fact with more samples in it. The test is on the container declaring *no*
	 * duration rather than on `kind`, because a recording of several samples that still declares
	 * a zero timeline is the same unplayable file — and branching on `kind` alone would leave it
	 * un-normalised while looking like it had been handled.
	 */
	it('holds a multi-sample recording that still declares no duration', () => {
		const plan = planNormalisation(samplesWithNoDuration, 5_000);

		expect(plan.holdForMs).toBe(5_000);
		expect(plan.report.timeline).toBe('requested');
	});

	/**
	 * A zero the caller really sent travels to the container branch rather than becoming a hold
	 * of zero: `-t 0` writes an empty file, which is a worse answer than the un-normalised
	 * timeline. The wire refuses a zero duration outright (`RecordVideoParamsSchema`), so this is
	 * about the core being callable in process.
	 */
	it('never holds for a requested duration of zero', () => {
		const plan = planNormalisation(stillScreen, 0);

		expect(plan.holdForMs).toBeNull();
		expect(plan.report.timeline).toBe('container');
	});
});

describe('a recording that declared a timeline keeps it, and the answer names it', () => {
	it('keeps the container’s own duration rather than the one that was requested', () => {
		const plan = planNormalisation(declaresTwentySeven, MAX_RECORDING_MS);

		// Every sample the recorder wrote survives: no `-t` and no padding on this branch.
		expect(plan.holdForMs).toBeNull();
		expect(plan.report).toMatchObject({
			timeline: 'container',
			durationMs: 27_610,
			framesPerSecond: NORMALISED_FRAME_RATE,
		});
		// And emphatically not the number that was asked for, which is the whole point of
		// reporting it at all.
		expect(plan.report.durationMs).not.toBe(MAX_RECORDING_MS);
	});

	/**
	 * A container this host could not parse is still normalised — the recording may play
	 * perfectly, and refusing to touch it would leave the one file most likely to be odd as the
	 * only un-normalised one. What it cannot do is claim a length nobody read, so `durationMs` is
	 * `null` rather than a zero that would read as an empty video.
	 */
	it('normalises an unreadable container on its own timeline, claiming no duration', () => {
		const plan = planNormalisation(unreadable, 5_000);

		expect(plan.holdForMs).toBeNull();
		expect(plan.report.timeline).toBe('container');
		expect(plan.report.durationMs).toBeNull();
	});
});

describe('the report is data a client can parse and a human can act on', () => {
	it('parses as the schema on every branch', () => {
		for (const container of [stillScreen, samplesWithNoDuration, declaresTwentySeven, unreadable]) {
			const plan = planNormalisation(container, 5_000);
			expect(RecordingNormalisationSchema.parse(plan.report)).toEqual(plan.report);
		}
	});

	/**
	 * Both messages have to survive being the only thing an agent reads. The held one says the
	 * content was not invented; the kept one says the length is the recorder's rather than the
	 * request, which is the number that would otherwise be filed as a defect the way #183 was.
	 */
	it('says what makes each branch actionable rather than only which branch it is', () => {
		const held = planNormalisation(stillScreen, 6_000).report.message;
		const kept = planNormalisation(declaresTwentySeven, MAX_RECORDING_MS).report.message;

		expect(held).toContain('declared no timeline');
		expect(held).toContain('held across the window');
		expect(kept).toContain('not the window that was asked for');
		expect(kept).toContain('PROJECT.md §6');
		expect(held).not.toBe(kept);
	});
});

describe('the constants are derived rather than picked', () => {
	/**
	 * The bit-rate ceiling's whole job: normalising must not turn a call that works today into
	 * an `artifact-too-large` refusal. A re-encode is free to be larger than its input — a 15 s
	 * worst case measured at 10 099 915 bytes without the ceiling (PROJECT.md §6) — so the
	 * longest recording the wire admits has to fit one answer at this rate, with the container's
	 * own boxes and the encoder's buffering slack inside the margin.
	 */
	it('keeps the longest recording the wire admits inside one answer at the rate ceiling', () => {
		const bytesAtTheCeiling = (MAX_RECORDING_MS / 1_000) * (NORMALISED_MAX_BIT_RATE_BPS / 8);

		expect(bytesAtTheCeiling).toBeLessThan(MAX_ARTIFACT_BYTES);
		// With real headroom rather than by a byte, since the measured file carries boxes the
		// bit rate does not account for.
		expect(bytesAtTheCeiling).toBeLessThan(MAX_ARTIFACT_BYTES * 0.95);
	});

	/**
	 * The rate the normalised file declares is a property of the *video*, and the rate a caller
	 * asks for is a property of the *frame list*. They are unrelated numbers, and reading one as
	 * the other is what would quietly re-derive `MAX_FRAMES` — asserted so a later change that
	 * conflates them has to come through here.
	 */
	it('declares a video frame rate unrelated to the frame-sampling bound', () => {
		expect(NORMALISED_FRAME_RATE).toBeGreaterThan(MAX_FRAMES_PER_SECOND);
	});

	// Every external invocation has a bound (ai/CODING_STANDARDS.md), and this one runs while a
	// lease is held.
	it('bounds the host’s work with a timeout', () => {
		expect(RECORDING_NORMALISATION_TIMEOUT_MS).toBeGreaterThan(MAX_RECORDING_MS);
	});
});
