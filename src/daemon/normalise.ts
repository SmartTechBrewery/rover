/**
 * The recording normaliser — the host tool that turns what the recorder wrote into a file that
 * plays (#185, backlog row R14).
 *
 * **It lives here rather than in `src/verbs/` because it starts a process**, which is
 * `./frames.ts`'s reason word for word: the verb layer is in every client's module graph —
 * `src/ipc/verb-methods.ts` imports the schemas a client parses answers with — so a spawn
 * anywhere in it would put `node:child_process` in a CLI, the shape D19 rules out and
 * `tests/unit/daemon/remote-never-spawns.test.ts` gates. So `src/verbs/record.ts` declares what
 * it needs (`RecordingNormaliser`, a function from a pulled recording to a normalised one) and
 * the daemon supplies it.
 *
 * **It drives the same `ffmpeg` off `PATH` that `./frames.ts` does**, and imports {@link FFMPEG}
 * from there rather than re-declaring it, so the two runs cannot come to name different programs
 * and `tests/device/setup.ts`'s single probe keeps gating both. A host that can slice a
 * recording can normalise one.
 *
 * **It writes a host temp file, where the frame extractor deliberately writes none.** That is
 * not an inconsistency, it is what the mp4 muxer requires: writing a non-fragmented MP4 needs a
 * **seekable** output, and ffmpeg refuses a pipe outright ("muxer does not support non seekable
 * output") unless it is given `-movflags frag_keyframe+empty_moov` — and a fragmented MP4's
 * `stsz` declares no encoded samples at all, which was measured and makes
 * `readRecordingContainer` answer `unreadable` for every recording Rover would produce
 * (PROJECT.md §6). So the
 * output goes into a `mkdtemp` directory, is read back, and the directory is removed in a
 * `finally` on **every** path, refusals and timeout kills included. No path ever reaches an
 * answer, which is what D19 forbids; the input still arrives on `pipe:0`, so the pulled bytes
 * never touch this host's disk at all.
 *
 * The same seekability buys the property PROJECT.md §6 records as load-bearing: `+faststart`
 * moves the `moov` **before** the payload, which is the only reason `ffmpeg -i pipe:0` works on
 * these recordings — and therefore the only reason the file this module writes is still
 * decodable the way the one it read was. Without it the normalised recording would be a file
 * nothing downstream could stream.
 *
 * **A host that cannot normalise says so by name** ({@link RecordingNormalisationUnavailableError},
 * {@link RecordingNormalisationFailedError}) rather than handing its input back. No path out of
 * this module returns the un-normalised recording: a run that could not start, one that exited
 * non-zero, one killed by its own budget, and one that exited 0 having written nothing are all
 * refusals, because a silently un-normalised file is the plausible-looking wrong answer here —
 * it is a structurally valid MP4 that no player will show anything for, written to a client's
 * disk and filed in the durable archive where nobody can tell it from a broken one.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceSerial } from '../core/ids.js';
import {
	RecordingNormalisationFailedError,
	RecordingNormalisationUnavailableError,
} from '../verbs/errors.js';
import type { RecordingNormaliser } from '../verbs/record.js';
import {
	NORMALISED_FRAME_RATE,
	NORMALISED_MAX_BIT_RATE_BPS,
	RECORDING_NORMALISATION_TIMEOUT_MS,
} from '../verbs/recording-normalisation.js';
import { FFMPEG, FFMPEG_STDERR_TAIL_CHARS } from './frames.js';

/** The prefix of the scratch directory one run owns, so a stray one is attributable. */
const TEMP_DIRECTORY_PREFIX = 'rover-normalise-';

/** What the run writes inside its own directory; never a name any answer carries. */
const NORMALISED_FILE = 'normalised.mp4';

/**
 * How many milliseconds a second is — the unit the wire speaks in against the unit `ffmpeg`'s
 * `-t` and `tpad` take.
 */
const MS_PER_SECOND = 1000;

/**
 * Re-encode a pulled recording into a constant-rate file over a real timeline.
 *
 * The {@link RecordingNormaliser} `src/verbs/record.ts` declares. It is handed the bytes rather
 * than a device: by the time it is called the recording has finished and been pulled, which is
 * the whole of what `record_video` phase 1 promised, so normalising costs no second pass over
 * the device and nothing here talks to one.
 *
 * @throws RecordingNormalisationUnavailableError when the program could not be started at all.
 * @throws RecordingNormalisationFailedError when it ran and did not produce a normalised
 *   recording — a refusal, a signal, or an exit 0 that wrote no file or an empty one.
 */
export const normaliseRecording: RecordingNormaliser = async (serial, recording, options) => {
	const directory = await mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX));
	const output = join(directory, NORMALISED_FILE);
	try {
		return await runFfmpeg(serial, recording, options.holdForMs, output);
	} finally {
		// On every path, including the refusals above and a run killed by its own budget: a
		// multi-megabyte file left in the OS temp directory for every recording is exactly the
		// thing the frame extractor gets to avoid by having no file at all.
		await rm(directory, { recursive: true, force: true });
	}
};

/**
 * The argv, written out here rather than assembled at the call site so there is one place that
 * knows what this host asks of the encoder. Measured against a real capture on ffmpeg 8.1.1
 * before it was written down (PROJECT.md §6), not recalled.
 *
 * `round=up` on the `fps` filter is the same measured necessity `./frames.ts` records, and it
 * matters more here: plain `fps=n` over a stream of zero duration emits **nothing at all** while
 * exiting 0, and a stream of zero duration is precisely the still-screen case this whole module
 * exists for — so without it the normalisation of the one recording that most needs it would be
 * an empty file.
 *
 * `tpad` and `-t` appear together or not at all, at the same number, and only on the hold
 * branch. Pad-then-cut is what makes the output exactly the requested window for a stream that
 * ends before it: `tpad=stop_mode=clone` repeats the last frame indefinitely and `-t` is what
 * stops it. Neither is safe on a recording that declares a timeline — `-t` there would cut
 * samples the recorder actually wrote — which is why the plan decides this and not this module
 * (`src/verbs/recording-normalisation.ts`).
 *
 * `-crf` under a `-maxrate`/`-bufsize` ceiling rather than a bitrate target: a held still frame
 * and a duplicated frame cost almost nothing in H.264, so the file tracks its content's own cost
 * and the common cases stay far inside `MAX_ARTIFACT_BYTES`, while the ceiling is what stops a
 * busy 1080p capture re-encoding to several times what it arrived as. Both halves were measured;
 * the numbers are on {@link NORMALISED_MAX_BIT_RATE_BPS}.
 *
 * `-y` so a run can never block on ffmpeg's overwrite prompt — the directory is this run's own,
 * so there is nothing there to protect — and `-an` because there is no audio to carry.
 */
export function normaliseArgs(holdForMs: number | null, output: string): string[] {
	const filters = [`fps=${NORMALISED_FRAME_RATE}:round=up`];
	const hold: string[] = [];
	if (holdForMs !== null) {
		const seconds = holdForMs / MS_PER_SECOND;
		filters.push(`tpad=stop_mode=clone:stop_duration=${seconds}`);
		hold.push('-t', String(seconds));
	}

	return [
		'-hide_banner',
		'-loglevel',
		'error',
		'-i',
		'pipe:0',
		'-vf',
		filters.join(','),
		...hold,
		'-an',
		'-c:v',
		'libx264',
		'-preset',
		'veryfast',
		'-crf',
		'23',
		'-maxrate',
		String(NORMALISED_MAX_BIT_RATE_BPS),
		'-bufsize',
		String(NORMALISED_MAX_BIT_RATE_BPS),
		'-pix_fmt',
		'yuv420p',
		'-movflags',
		'+faststart',
		'-y',
		output,
	];
}

/** Run the encoder over `recording` and hand back the file it wrote. */
async function runFfmpeg(
	serial: DeviceSerial,
	recording: Uint8Array,
	holdForMs: number | null,
	output: string,
): Promise<Uint8Array> {
	const args = normaliseArgs(holdForMs, output);

	await new Promise<void>((resolve, reject) => {
		const child = spawn(FFMPEG, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: RECORDING_NORMALISATION_TIMEOUT_MS,
		});

		let stderrTail = '';
		/** Set by whichever of the two endings arrives first; suppresses the other. */
		let settled = false;

		const finish = (end: () => void): void => {
			if (settled) return;
			settled = true;
			end();
		};

		// Nothing useful comes back on stdout — the output is the file — but it is read and
		// discarded rather than left unconsumed, so a build that writes something there cannot
		// fill the pipe's buffer and wedge the run against its own timeout.
		child.stdout.resume();
		// Decoded by the stream itself, so a chunk boundary inside a multi-byte character cannot
		// become a replacement character in the message a human reads.
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderrTail = `${stderrTail}${chunk}`.slice(-FFMPEG_STDERR_TAIL_CHARS);
		});
		// Written in one go and the pipe closed, for `./frames.ts`'s reason: an encoder that gave
		// up early leaves nobody reading this pipe, and the EPIPE that follows is *its* exit
		// code's story to tell rather than a broken pipe reported for a file it refused to open.
		child.stdin.on('error', () => {});
		child.stdin.end(recording);

		child.on('error', (error: Error) => {
			// Nothing ran at all — the program absent from PATH is the common one, and it is the
			// one case with a remedy on the host rather than in the call.
			finish(() =>
				reject(new RecordingNormalisationUnavailableError(serial, FFMPEG, error.message)),
			);
		});
		child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
			finish(() => {
				if (code === 0) {
					resolve();
					return;
				}
				reject(
					new RecordingNormalisationFailedError(
						serial,
						FFMPEG,
						code,
						stderrTail,
						endOfRun(code, signal),
					),
				);
			});
		});
	});

	return readNormalised(serial, output);
}

/**
 * The file the run wrote, or the refusal that says it did not write one.
 *
 * **The branch that keeps an un-normalised recording from ever being the answer.** An exit 0
 * that produced no file, or an empty one, is not a recording with nothing in it — the bytes that
 * went in were already proved a finished, non-empty recording by phase 1. It is an encoder that
 * did something this host did not anticipate, and the shape a build of `ffmpeg` without the
 * H.264 encoder takes. Handing the input back there would put a file on a client's disk and in
 * the durable archive that no player will show anything for, with nothing in the answer saying
 * so.
 *
 * @throws RecordingNormalisationFailedError in both cases, in the shape the endings above use.
 */
async function readNormalised(serial: DeviceSerial, output: string): Promise<Uint8Array> {
	const failed = (outcome: string): RecordingNormalisationFailedError =>
		new RecordingNormalisationFailedError(serial, FFMPEG, 0, '', outcome);

	const written = await readFile(output).catch(() => null);
	if (written === null) {
		throw failed(
			'exited 0 without writing a recording at all — an un-normalised file is not ' +
				'something this host will hand over in its place',
		);
	}
	if (written.byteLength === 0) {
		throw failed(
			'exited 0 having written an empty recording — an un-normalised file is not ' +
				'something this host will hand over in its place',
		);
	}
	return new Uint8Array(written);
}

/** How a run that produced no recording ended, in words a human reads before the stderr. */
function endOfRun(code: number | null, signal: NodeJS.Signals | null): string {
	if (code !== null) return `exited ${code}`;
	if (signal !== null) {
		return `was killed by ${signal} — its ${RECORDING_NORMALISATION_TIMEOUT_MS}ms budget is the likely reason`;
	}
	return 'ended without an exit code';
}
