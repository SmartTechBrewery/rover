/**
 * What a recording actually **contains**, read off the container the recorder wrote (#183).
 *
 * `record_video` used to answer `ok` with a video artifact and a frame list and say nothing at
 * all about the file it was handing over. That is fine right up until the screen did not move:
 * the recorder emits a buffer only when something changes, so a still screen comes back as
 * **one encoded sample declaring a duration of zero**, `isFinishedRecording` passes it (it has
 * an `ftyp` and a `moov`, and deliberately judges nothing else), `fps=n:round=up` extracts the
 * single frame, and the answer is indistinguishable from a five-second capture of a busy
 * screen. An agent that then reaches for `ffprobe`, finds `nb_frames=1` / `duration=0.000000`
 * and cannot square it with an `ok` concludes that Rover does not record video — which
 * happened, and was filed as a defect against a tool that was working. ai/RULES.md §2: the
 * recording is honest, the answer about it was not.
 *
 * **This is reporting, not a refusal.** A capture of a still screen is a true answer about the
 * device and stays `ok` with its one frame; what changes is that the answer now says so.
 *
 * **Why it lives in the verb layer rather than behind `FrameExtractor`.** #183 suggests
 * widening the extractor, and the reason not to is the reason `ai/ARCHITECTURE.md` gives for
 * host tools living under `src/daemon/` at all: they **start a process or touch the host
 * filesystem**, and a spawn reached from `src/verbs/` would be `node:child_process` in every
 * client's module graph. This is a bounded walk over bytes already in hand — no decoder, no
 * process, no filesystem, no second pass over the device — so it needs nothing the daemon has,
 * and `src/verbs/result.ts` already reads MP4 box bytes here (`mediaTypeOf` sniffs the `ftyp`
 * at offset 4). Widening the extractor would instead change one signature at every call site
 * and in seven suites that mock it, to move a pure function to where it cannot be used.
 *
 * **Nothing here imports a backend.** One backend's own recording parser knows the same 8-byte
 * header format, and shared code reaching into a backend folder is exactly what ai/RULES.md §2
 * forbids — the duplication is one box header, and what a container declares is a property of
 * the file format rather than of any one platform.
 *
 * **Offsets, verified against a committed recording fixture** rather than recalled from the
 * spec. That capture is `ftyp`, `moov`, `free`, `mdat`, with `moov` holding an `mvhd` (v0,
 * timescale 10000, duration 0) and **three** `trak`s — one `vide` and two `meta`, each with an
 * `stsz` of sample_count 1. Three tracks is why the video one is selected by its `mdia/hdlr`
 * handler type: taking the first `trak` is right on that file by luck and wrong on the next
 * one. The fixture is itself the still-screen case, which is what lets
 * `tests/unit/verbs/recording-container.test.ts` — where it is named — assert this parse
 * against a real device's bytes rather than against a hand-built file.
 *
 * **`unreadable` is a branch rather than a throw or a zero**, and it is load-bearing:
 * `DeviceBackend.recordVideo` "promises video bytes without saying in which container"
 * (`src/verbs/result.ts`), so bytes this walk cannot read are an anticipated future rather
 * than a bug. Throwing would add the refusal path #183 rules out — a still screen must not
 * become a failed verb — and answering `sampleCount: 0` would be the plausible-looking empty
 * result ai/RULES.md §2 exists against. So it names what was missing, and the verb still
 * answers with the recording.
 */

import { z } from 'zod';

/**
 * What the answer says a recording holds.
 *
 * `AfterStateSchema`'s idiom (`./result.ts`): the discriminator is what an agent branches on,
 * the message is what it reads. The two numbers ride on **both** readable branches, so a
 * caller that only wants the sample count and the duration never has to know which one it got.
 */
export const RecordingContainerSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('samples'),
			/** How many encoded samples the video track's `stsz` declares. */
			sampleCount: z.number().int().positive(),
			/**
			 * The duration the **container** declares, in milliseconds — never the duration the
			 * caller asked for. The two are different facts and both can be surprising: a 15 s
			 * capture of a barely-changing screen came back declaring 27.61 s (PROJECT.md §6),
			 * and the frame sampling follows this one rather than the request.
			 */
			durationMs: z.number().nonnegative(),
		})
		.strict(),
	z
		.object({
			kind: z.literal('still-screen'),
			sampleCount: z.number().int().positive(),
			durationMs: z.number().nonnegative(),
			/** Why one sample of no duration is a true answer about the device (#183). */
			message: z.string().min(1),
		})
		.strict(),
	z.object({ kind: z.literal('unreadable'), message: z.string().min(1) }).strict(),
]);
export type RecordingContainer = z.infer<typeof RecordingContainerSchema>;

/** Every box header is `size:uint32` then `type:4 chars` (ISO/IEC 14496-12 §4.2). */
const BOX_HEADER_BYTES = 8;

/** `size === 1` means the real length is a `uint64` in the eight bytes after the header. */
const EXTENDED_SIZE_MARKER = 1;

/** How long a header plus its 64-bit extended size is. */
const EXTENDED_HEADER_BYTES = 16;

/** The handler type of the one track a recording is about; the rest are timed metadata. */
const VIDEO_HANDLER = 'vide';

/** How many milliseconds a second is, for `duration / timescale` in the unit the wire uses. */
const MS_PER_SECOND = 1000;

/** One box, as the far side of a header: its type and the bounds of its body. */
interface Box {
	readonly type: string;
	/** First byte after the header — where a container's children start. */
	readonly start: number;
	/** One past the last byte of this box. */
	readonly end: number;
}

/**
 * The movie timeline `mvhd` declares, or the reason it could not be read.
 *
 * `noDuration` is the **declared** value being exactly zero rather than the rounded
 * millisecond one, and it is carried separately for that reason: a recording a tenth of a
 * millisecond long rounds to `durationMs: 0` and is not a still screen.
 */
type Timeline =
	| { readonly durationMs: number; readonly noDuration: boolean }
	| { readonly problem: string };

/**
 * What the recording in `bytes` contains — its encoded sample count and the duration its
 * container declares — or an honest statement that this walk could not tell.
 *
 * Never throws, for the reason this module's header gives: a recording nothing here recognises
 * is still a recording the verb answers with.
 */
export function readRecordingContainer(bytes: Uint8Array): RecordingContainer {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const moov = boxesIn(bytes, view, 0, bytes.byteLength).find((box) => box.type === 'moov');
	if (moov === undefined) {
		return unreadable(`it has no 'moov' box, so it declares no timeline and no sample table`);
	}

	const inMoov = boxesIn(bytes, view, moov.start, moov.end);
	const mvhd = inMoov.find((box) => box.type === 'mvhd');
	if (mvhd === undefined) {
		return unreadable(`its 'moov' box carries no 'mvhd', so it declares no duration`);
	}
	const timeline = movieTimelineOf(view, mvhd);
	if ('problem' in timeline) return unreadable(timeline.problem);

	const sampleCount = videoSampleCountIn(bytes, view, inMoov);
	if (typeof sampleCount === 'string') return unreadable(sampleCount);

	const { durationMs, noDuration } = timeline;
	// The still-screen test is on the **declared** duration being exactly zero rather than on
	// the rounded millisecond value, so a real recording under half a millisecond long is
	// reported as the samples it holds instead of being rounded into a case it is not.
	if (sampleCount === 1 && noDuration) {
		return RecordingContainerSchema.parse({
			kind: 'still-screen',
			sampleCount,
			durationMs,
			message: STILL_SCREEN_MESSAGE,
		});
	}

	return RecordingContainerSchema.parse({ kind: 'samples', sampleCount, durationMs });
}

/**
 * The sentence an agent reads before it starts debugging Rover (#183).
 *
 * It has to carry three things and does: nothing on the screen changed during the window; the
 * device's virtual display emits a buffer only when the screen changes, so this is what a
 * still screen *looks like* rather than a short or broken capture; and it is a true answer
 * about the device rather than a fault to be investigated. Naming the mechanism in prose is
 * not a platform branch — nothing here reads `device.platform`, and a recorder that behaves
 * this way is not peculiar to one.
 */
const STILL_SCREEN_MESSAGE =
	`This recording holds one encoded sample and declares a duration of 0 ms, which means ` +
	`nothing on the screen changed while it was recording. A device's virtual display produces ` +
	`a buffer only when the screen changes, so a still screen is recorded as exactly one ` +
	`sample with no timeline — this is a true answer about the device rather than a fault in ` +
	`the recording or in the tool, and the single frame beside it is that unchanged screen. If ` +
	`you expected motion, drive the screen during the capture rather than recording again.`;

/** The `unreadable` branch, phrased so the message says what was missing. */
function unreadable(because: string): RecordingContainer {
	return RecordingContainerSchema.parse({
		kind: 'unreadable',
		message:
			`This recording's container could not be read here: ${because}. The video itself is ` +
			`in the answer and may play perfectly — what is unknown is how many encoded samples ` +
			`it holds and what duration it declares, not whether it recorded.`,
	});
}

/**
 * The movie duration `mvhd` declares, in milliseconds.
 *
 * A `FullBox`, so the body opens with `version:uint8` and three flag bytes; v0 puts a 32-bit
 * creation and modification time before `timescale` and `duration`, v1 puts 64-bit ones and a
 * 64-bit duration. Both offsets are verified against the committed fixture (this module's
 * header).
 *
 * An all-ones duration is the format's "unknown" rather than a very long movie, and a
 * timescale of zero would make the division meaningless; both answer with a problem instead of
 * a number nobody could act on.
 */
function movieTimelineOf(view: DataView, mvhd: Box): Timeline {
	const version = view.getUint8(mvhd.start);
	const wide = version === 1;
	const timescaleAt = mvhd.start + (wide ? 20 : 12);
	const durationAt = mvhd.start + (wide ? 24 : 16);
	const needed = durationAt + (wide ? 8 : 4);
	if (needed > mvhd.end) {
		return { problem: `its 'mvhd' box is shorter than the version ${version} header it declares` };
	}

	const timescale = view.getUint32(timescaleAt);
	if (timescale === 0) {
		return { problem: `its 'mvhd' declares a timescale of zero, so no duration follows from it` };
	}

	const duration = wide ? view.getBigUint64(durationAt) : BigInt(view.getUint32(durationAt));
	if (duration === (wide ? 0xffff_ffff_ffff_ffffn : 0xffff_ffffn)) {
		return { problem: `its 'mvhd' declares a duration of "unknown", which is not a length` };
	}

	return {
		durationMs: Math.round((Number(duration) / timescale) * MS_PER_SECOND),
		noDuration: duration === 0n,
	};
}

/**
 * How many samples the **video** track's `stsz` declares, or why it could not be found.
 *
 * The track is selected by its `mdia/hdlr` handler type rather than by position: the fixture
 * carries one `vide` track and two `meta` ones, so taking the first `trak` happens to be right
 * there and would be wrong on a file that ordered them differently.
 *
 * A track that declares no samples answers with a problem rather than `sampleCount: 0` — the
 * numbers on this answer say what a recording *contains*, and zero read off a table this walk
 * may simply have misunderstood is the plausible-looking empty result ai/RULES.md §2 forbids.
 */
function videoSampleCountIn(bytes: Uint8Array, view: DataView, inMoov: Box[]): number | string {
	for (const trak of inMoov.filter((box) => box.type === 'trak')) {
		const mdia = boxesIn(bytes, view, trak.start, trak.end).find((box) => box.type === 'mdia');
		if (mdia === undefined) continue;
		const inMdia = boxesIn(bytes, view, mdia.start, mdia.end);
		if (handlerTypeOf(bytes, inMdia) !== VIDEO_HANDLER) continue;

		const stsz = sampleTableEntryIn(bytes, view, inMdia, 'stsz');
		if (stsz === undefined || stsz.start + 12 > stsz.end) {
			return `its video track carries no readable 'stsz', so it declares no sample count`;
		}
		const sampleCount = view.getUint32(stsz.start + 8);
		return sampleCount > 0
			? sampleCount
			: `its video track's 'stsz' declares no encoded samples at all`;
	}

	return `it carries no '${VIDEO_HANDLER}' track, so nothing in it is a recording of a screen`;
}

/** The four characters of `hdlr`'s handler type, at body+8 after the `FullBox` header. */
function handlerTypeOf(bytes: Uint8Array, inMdia: Box[]): string | null {
	const hdlr = inMdia.find((box) => box.type === 'hdlr');
	if (hdlr === undefined || hdlr.start + 12 > hdlr.end) return null;
	return charactersAt(bytes, hdlr.start + 8);
}

/** One box of the sample table, reached through the `minf`/`stbl` pair that always wraps it. */
function sampleTableEntryIn(
	bytes: Uint8Array,
	view: DataView,
	inMdia: Box[],
	type: string,
): Box | undefined {
	const minf = inMdia.find((box) => box.type === 'minf');
	if (minf === undefined) return undefined;
	const stbl = boxesIn(bytes, view, minf.start, minf.end).find((box) => box.type === 'stbl');
	if (stbl === undefined) return undefined;
	return boxesIn(bytes, view, stbl.start, stbl.end).find((box) => box.type === type);
}

/**
 * The boxes between `from` and `to`, header by header.
 *
 * **Every exit is bounded**, in `isFinishedRecording`'s discipline: a length below a header, one
 * that runs past the bytes there are, an extended size that does not fit, and a `size === 0`
 * box (the format's "to the end of this container", so nothing follows it) all stop the walk
 * rather than loop or read past the end. A malformed file is a short list, never a hang.
 */
function boxesIn(bytes: Uint8Array, view: DataView, from: number, to: number): Box[] {
	const boxes: Box[] = [];
	let offset = from;

	while (offset + BOX_HEADER_BYTES <= to) {
		const declared = view.getUint32(offset);
		const type = charactersAt(bytes, offset + 4);
		let header = BOX_HEADER_BYTES;
		let size = declared;

		if (declared === EXTENDED_SIZE_MARKER) {
			if (offset + EXTENDED_HEADER_BYTES > to) break;
			const extended = view.getBigUint64(offset + BOX_HEADER_BYTES);
			if (extended < BigInt(EXTENDED_HEADER_BYTES) || extended > BigInt(to - offset)) break;
			size = Number(extended);
			header = EXTENDED_HEADER_BYTES;
		} else if (declared === 0) {
			size = to - offset;
		} else if (declared < BOX_HEADER_BYTES || offset + declared > to) {
			break;
		}

		boxes.push({ type, start: offset + header, end: offset + size });
		offset += size;
	}

	return boxes;
}

/** The four ASCII characters at `offset` — a box type or a handler type. */
function charactersAt(bytes: Uint8Array, offset: number): string {
	return String.fromCharCode(
		bytes[offset] ?? 0,
		bytes[offset + 1] ?? 0,
		bytes[offset + 2] ?? 0,
		bytes[offset + 3] ?? 0,
	);
}
