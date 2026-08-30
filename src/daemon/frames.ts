/**
 * The frame extractor — the host tool behind `record_video`'s second half (PROJECT.md §4,
 * "Reading"; backlog row R14, phase 2).
 *
 * **It lives here rather than in `src/verbs/` because it starts a process.** The verb layer
 * is in every client's module graph — `src/ipc/verb-methods.ts` imports the schemas a client
 * parses answers with — so a spawn anywhere in it would put `node:child_process` in a CLI,
 * which is the shape D19 rules out and `tests/unit/daemon/remote-never-spawns.test.ts` gates.
 * So `src/verbs/record.ts` declares what it needs (`FrameExtractor`, a function from a
 * finished recording to frames) and the daemon — the process that holds the hardware and runs
 * the verbs — is what supplies this. Exactly the arrangement `context.backend` already has:
 * the verb layer names the shape, the host resolves the implementation.
 *
 * **Extraction needs a decoder and there is none in this tree.** Nothing in `package.json`
 * decodes a compressed video stream and writing something that does is out of the question,
 * so this drives `ffmpeg`, resolved from `PATH` exactly as this repository's other external
 * tools are, and for their reason: a configurable path is a real request, but it is a
 * configuration option (ai/RULES.md §7) and nothing needs one yet.
 *
 * **It is not a `Capabilities` flag.** Capabilities describe what a *device backend* can do
 * (D11); this is a program on the host, and a host missing it is a different answer with a
 * different remedy — install it here, rather than stop asking this device. So a host that
 * cannot extract says so by name ({@link FrameExtractionUnavailableError}) instead of
 * answering with an empty frame list, which is the plausible-looking empty result
 * ai/RULES.md §2 forbids. **No path out of this module returns an empty list at all**: a
 * decoder that could not start, one that exited non-zero, one that wrote a stream this host
 * cannot read and one that exited 0 having written nothing are four named failures, so
 * `result.frames` on an `ok` answer is never empty (`withinFrameCount`).
 *
 * **No host temp file.** The recording goes in on stdin and the images come back on stdout,
 * so no path on the host's disk exists for an answer to leak (D19) and nothing is left behind
 * when the process is killed part-way.
 */

import { spawn } from 'node:child_process';
import type { DeviceSerial } from '../core/ids.js';
import { FrameExtractionFailedError, FrameExtractionUnavailableError } from '../verbs/errors.js';
import {
	FRAME_EXTRACTION_TIMEOUT_MS,
	FRAME_WIDTH_PX,
	type FrameExtractor,
	MAX_FRAMES,
} from '../verbs/record.js';

/** The program name, looked up on `PATH`. */
export const FFMPEG = 'ffmpeg';

/**
 * How much of the decoder's stdout is held before the run is abandoned.
 *
 * Set explicitly rather than left to a default nobody chose, the way this repository's other
 * process runners set theirs, and set well clear of anything a healthy run produces:
 * `MAX_FRAMES` images at `FRAME_WIDTH_PX` is a few megabytes, so reaching this is a decoder
 * that has stopped honouring the count it was given rather than a large recording. That is
 * why it is a *failure* and not the byte-budget refusal — the budget is `MAX_FRAMES_BYTES`,
 * checked by the verb on a run that finished (`src/verbs/record.ts`).
 */
export const FRAME_STREAM_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * How much of the decoder's stderr travels in a failure.
 *
 * The tail rather than the head, for the reason the device bridge's stream runner keeps a
 * tail: what it said last is what explains the end, and a failure is not a place to put a
 * megabyte of warnings a client has to render.
 */
export const FFMPEG_STDERR_TAIL_CHARS = 4096;

/** The eight bytes every PNG starts with (PNG 1.2 §3.1). */
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** `length:uint32` and the four-character type, ahead of every chunk's data (PNG 1.2 §3.2). */
const PNG_CHUNK_HEADER_BYTES = 8;

/** The CRC after every chunk's data. */
const PNG_CHUNK_CRC_BYTES = 4;

/** The chunk that ends an image, and the only place one image may end (PNG 1.2 §3.2). */
const PNG_END_CHUNK = 'IEND';

/**
 * Slice a finished recording into PNG frames, in the order they were recorded.
 *
 * The {@link FrameExtractor} `src/verbs/record.ts` declares, and the only implementation of
 * it that runs a program. It is handed the bytes rather than a device: by the time it is
 * called the recording has finished, been pulled and been bounded, which is the whole of what
 * phase 1 promised.
 *
 * @throws FrameExtractionUnavailableError when the decoder could not be started at all.
 * @throws FrameExtractionFailedError when it ran and refused, answered with a stream this host
 *   could not read, produced no images at all, or produced more than one answer may carry.
 */
export const extractFrames: FrameExtractor = async (serial, recording, options) => {
	const stream = await runFfmpeg(serial, recording, options.framesPerSecond);
	return withinFrameCount(serial, splitPngStream(serial, stream));
};

/**
 * The frames, or the failure that says the decoder did not produce a readable sample of this
 * recording.
 *
 * Both branches exist because the alternative to each is a **plausible-looking empty or short
 * list** (ai/RULES.md §2), which is the one answer this verb must never give:
 *
 * - **None at all.** The recording that reaches this module has already been proved finished
 *   and non-empty by phase 1, and `round=up` covers the one case that legitimately sampled to
 *   nothing (a still screen). Every remaining way ffmpeg writes no images — an undecodable
 *   input, a rejected filter — exits non-zero and never reaches here, so a run that exited 0
 *   with an empty stdout is a decoder that did something this host did not anticipate, not a
 *   recording with nothing in it.
 * - **More than {@link MAX_FRAMES}.** Reachable by a call the wire admits, because the sampling
 *   follows the *container's* timeline and a capture of a still screen declares one far longer
 *   than it was asked for (PROJECT.md §6). The decoder is asked for one frame more than the cap
 *   precisely so this is visible: `-frames:v` at the cap itself stops ffmpeg and exits 0, which
 *   is a trimmed list nothing downstream can tell from a complete one.
 *
 * @throws FrameExtractionFailedError in both cases, in the shape the unreadable-stream branch
 *   already uses — the exit code that was seen, and an outcome saying what was wrong with it.
 */
function withinFrameCount(serial: DeviceSerial, frames: Uint8Array[]): Uint8Array[] {
	if (frames.length === 0) {
		throw new FrameExtractionFailedError(
			serial,
			FFMPEG,
			0,
			'',
			'exited 0 without writing a single image, for a recording that was already proved ' +
				'finished and non-empty — an empty frame list is not an answer this host will give',
		);
	}
	if (frames.length > MAX_FRAMES) {
		throw new FrameExtractionFailedError(
			serial,
			FFMPEG,
			0,
			'',
			`wrote more than the ${MAX_FRAMES} frames one answer may carry. The recording's ` +
				'container claims a longer timeline than the recording was asked for, which a ' +
				'capture of a screen that barely changed does (PROJECT.md §6), and the sampling ' +
				'follows the container. Record for less time, or ask for fewer frames a second — ' +
				'they are refused together rather than returned as a list quietly stopping at the ' +
				'bound',
		);
	}
	return frames;
}

/**
 * The argv, written out here rather than assembled at the call site so there is one place
 * that knows what this host asks of the decoder.
 *
 * `round=up` on the `fps` filter is not a rounding preference, it is what keeps an empty frame
 * list from ever being the answer to a recording that has frames: a screen that never changed
 * produces a single sample with no duration, and plain `fps=n` over a stream of zero duration
 * emits **nothing at all** — measured on ffmpeg 8.0 against a real capture of a still screen
 * (PROJECT.md §6). `-loglevel error` keeps the banner and the per-frame progress out of the
 * stderr a failure carries.
 *
 * `-frames:v` is the guard `MAX_FRAMES` describes, and it is set **one above** it on purpose.
 * The flag makes ffmpeg stop writing and exit 0, so a bound set at the cap itself is a silent
 * trim: the answer would be exactly `MAX_FRAMES` frames of a recording that had more, with
 * nothing in it saying so. One higher turns that into something {@link splitPngStream}'s
 * caller can see — a run that overran comes back over the cap and is refused by name, and a
 * run that did not is untouched.
 */
function ffmpegArgs(framesPerSecond: number): string[] {
	return [
		'-hide_banner',
		'-loglevel',
		'error',
		'-i',
		'pipe:0',
		'-vf',
		`fps=${framesPerSecond}:round=up,scale=${FRAME_WIDTH_PX}:-2`,
		'-frames:v',
		String(MAX_FRAMES + 1),
		'-f',
		'image2pipe',
		'-vcodec',
		'png',
		'pipe:1',
	];
}

/** Run the decoder over `recording` and hand back whatever it wrote to stdout. */
async function runFfmpeg(
	serial: DeviceSerial,
	recording: Uint8Array,
	framesPerSecond: number,
): Promise<Buffer> {
	const args = ffmpegArgs(framesPerSecond);

	return new Promise<Buffer>((resolve, reject) => {
		const child = spawn(FFMPEG, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: FRAME_EXTRACTION_TIMEOUT_MS,
		});

		const chunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrTail = '';
		/** Set by whichever of the three endings arrives first; suppresses the other two. */
		let settled = false;

		const finish = (end: () => void): void => {
			if (settled) return;
			settled = true;
			end();
		};

		child.stdout.on('data', (chunk: Buffer) => {
			stdoutBytes += chunk.byteLength;
			if (stdoutBytes > FRAME_STREAM_MAX_BUFFER_BYTES) {
				// Abandoned rather than accumulated: past this the run is not producing frames
				// any more, and the alternative to stopping it is a host that runs out of memory
				// on a device's behalf.
				child.kill();
				finish(() =>
					reject(
						new FrameExtractionFailedError(
							serial,
							FFMPEG,
							null,
							stderrTail,
							`wrote more than ${FRAME_STREAM_MAX_BUFFER_BYTES} bytes of frames and was stopped`,
						),
					),
				);
				return;
			}
			chunks.push(chunk);
		});
		// Decoded by the stream itself, so a chunk boundary inside a multi-byte character
		// cannot become a replacement character in the message a human reads.
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderrTail = `${stderrTail}${chunk}`.slice(-FFMPEG_STDERR_TAIL_CHARS);
		});
		// The recording is written in one go and the pipe closed, because the decoder reads its
		// input to the end before it has produced every frame. A decoder that gave up early
		// leaves nobody reading this pipe, and the EPIPE that follows is *its* exit code's story
		// to tell — surfacing it here would report a broken pipe for a file it refused to open.
		child.stdin.on('error', () => {});
		child.stdin.end(recording);

		child.on('error', (error: Error) => {
			// Nothing ran at all — the program absent from PATH is the common one, and it is the
			// one case with a remedy on the host rather than in the call.
			finish(() => reject(new FrameExtractionUnavailableError(serial, FFMPEG, error.message)));
		});
		child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
			finish(() => {
				if (code === 0) {
					resolve(Buffer.concat(chunks));
					return;
				}
				reject(
					new FrameExtractionFailedError(serial, FFMPEG, code, stderrTail, endOfRun(code, signal)),
				);
			});
		});
	});
}

/** How a run that produced no frames ended, in words a human reads before the stderr. */
function endOfRun(code: number | null, signal: NodeJS.Signals | null): string {
	if (code !== null) return `exited ${code}`;
	if (signal !== null) {
		return `was killed by ${signal} — its ${FRAME_EXTRACTION_TIMEOUT_MS}ms budget is the likely reason`;
	}
	return 'ended without an exit code';
}

/**
 * Split the concatenated PNG stream the decoder writes into one buffer per image.
 *
 * **Walked as chunks rather than searched for the signature.** A PNG's compressed data is
 * arbitrary bytes, so the eight-byte signature turns up inside one often enough to matter, and
 * a split on it would cut a frame in half and call the halves two frames — each of which still
 * looks like a plausible payload from the outside. Every chunk declares its own length (PNG
 * 1.2 §3.2), so walking them lands exactly on the `IEND` that ends the image and exactly on the
 * signature that starts the next.
 *
 * @throws FrameExtractionFailedError when the stream is not a run of whole PNGs — a decoder
 *   that exited 0 having written something this host cannot read is still a failed extraction,
 *   and reporting the frames it *could* read would be the quietly trimmed list.
 */
function splitPngStream(serial: DeviceSerial, stream: Buffer): Uint8Array[] {
	const frames: Uint8Array[] = [];
	let at = 0;

	while (at < stream.length) {
		const end = endOfImage(serial, stream, at);
		frames.push(new Uint8Array(stream.subarray(at, end)));
		at = end;
	}

	return frames;
}

/** Where the image starting at `start` ends: one past its `IEND` chunk's CRC. */
function endOfImage(serial: DeviceSerial, stream: Buffer, start: number): number {
	const unreadable = (why: string): FrameExtractionFailedError =>
		new FrameExtractionFailedError(
			serial,
			FFMPEG,
			0,
			'',
			`exited 0 but wrote a frame stream this host cannot read: ${why} at byte ${start} of ${stream.length}`,
		);

	if (!hasSignatureAt(stream, start)) throw unreadable('no PNG signature');

	let at = start + PNG_SIGNATURE.length;
	while (at + PNG_CHUNK_HEADER_BYTES <= stream.length) {
		const length = stream.readUInt32BE(at);
		const type = stream.toString('latin1', at + 4, at + PNG_CHUNK_HEADER_BYTES);
		at += PNG_CHUNK_HEADER_BYTES + length + PNG_CHUNK_CRC_BYTES;
		if (at > stream.length) throw unreadable(`a '${type}' chunk running past the end`);
		if (type === PNG_END_CHUNK) return at;
	}

	throw unreadable(`no '${PNG_END_CHUNK}' chunk`);
}

/** Whether a PNG signature sits at `offset` — bounds checked, never a short read. */
function hasSignatureAt(stream: Buffer, offset: number): boolean {
	if (stream.length < offset + PNG_SIGNATURE.length) return false;
	return PNG_SIGNATURE.every((byte, index) => stream[offset + index] === byte);
}
