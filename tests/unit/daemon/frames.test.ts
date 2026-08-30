import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { parseDeviceSerial } from '@/core/ids.js';
import {
	extractFrames,
	FFMPEG,
	FRAME_EXTRACTION_TIMEOUT_MS,
	FRAME_STREAM_MAX_BUFFER_BYTES,
} from '@/daemon/frames.js';
import { FrameExtractionFailedError, FrameExtractionUnavailableError } from '@/verbs/errors.js';
import { FRAME_WIDTH_PX, MAX_FRAMES } from '@/verbs/record.js';
import { createMockPngBytes, createMockPngStream } from '../../helpers/factories.js';

/**
 * The frame extractor's own suite: the argv, the two ways a run fails, and the split of the
 * stream it writes. Nothing here proves anything about a real decoder — that is
 * `tests/device/`'s job, and the reason the two exist separately (ai/TESTING.md).
 *
 * The two assertions that carry this module are about answers that would otherwise look fine:
 *
 * - **A host without the program refuses by name.** The alternative is `frames: []`, which
 *   reads as a recording in which nothing happened — a statement about the device made by a
 *   host that never looked (ai/RULES.md §2).
 * - **The split walks chunks rather than searching for the signature.** A compressed image
 *   contains those eight bytes often enough to matter, and a naive split cuts a frame in half
 *   and calls the halves two frames. Both halves still look like plausible payloads.
 *
 * The mock is declared through `vi.hoisted` so it can be referenced from the factory, the
 * shape `tests/unit/backends/android/adb.test.ts` established.
 */
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const SERIAL = parseDeviceSerial('device-under-test');

/**
 * A stand-in for the child process: real streams, so the chunking and the encoding are the
 * ones Node would produce, and an emitter for the lifecycle events the runner listens to.
 */
class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly kill = vi.fn((): boolean => {
		queueMicrotask(() => this.emit('close', null, 'SIGTERM'));
		return true;
	});
}

function spawns(): FakeChild {
	const child = new FakeChild();
	spawnMock.mockReturnValue(child);
	return child;
}

/** Lets every pending stream event land before the run is ended. */
async function settled(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

/** The same, ended the way a healthy run ends — exit 0 — and awaited. */
async function extracting(
	write: (child: FakeChild) => void,
	options: { framesPerSecond?: number } = {},
): Promise<Uint8Array[]> {
	const child = spawns();
	const run = extractFrames(SERIAL, RECORDING, {
		framesPerSecond: options.framesPerSecond ?? 2,
	});
	await settled();
	write(child);
	await settled();
	child.emit('close', 0, null);
	return run;
}

/**
 * The same run, but the refusal it produced rather than the frames — as the value it is,
 * because `rejects.toThrow` proves no field.
 *
 * The rejection is captured **before** the writer plays the run out, since a rejection nobody
 * is holding a handler for by the end of a turn is an unhandled rejection rather than an
 * assertion. The trailing `close` is ignored by a run that has already ended, so a writer that
 * ends the run its own way needs to do nothing else.
 */
async function refusalOf(
	write: (child: FakeChild) => void,
	options: { framesPerSecond?: number } = {},
): Promise<unknown> {
	const child = spawns();
	const captured = extractFrames(SERIAL, RECORDING, {
		framesPerSecond: options.framesPerSecond ?? 2,
	}).then(
		() => {
			throw new Error('the extraction resolved where it was expected to refuse');
		},
		(thrown: unknown) => thrown,
	);
	await settled();
	write(child);
	await settled();
	child.emit('close', 0, null);
	return captured;
}

const RECORDING = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]);

/** The payload a naive split gets wrong: a frame whose image data carries the signature. */
const SIGNATURE_IN_THE_PAYLOAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42];

describe('the frame extractor drives one program over the recording', () => {
	it('asks for the sampling rate, the frame width and the frame cap it was told to', async () => {
		await extracting((child) => child.stdout.end(), { framesPerSecond: 3 });

		expect(spawnMock.mock.calls[0]?.[0]).toBe(FFMPEG);
		const args = spawnMock.mock.calls[0]?.[1] as string[];
		expect(args).toContain(`fps=3:round=up,scale=${FRAME_WIDTH_PX}:-2`);
		expect(args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2)).toEqual([
			'-frames:v',
			String(MAX_FRAMES),
		]);
	});

	/**
	 * D19, on a host tool rather than on a device one: the recording goes in on stdin and the
	 * images come back on stdout, so no path on this host's disk ever exists to leak into an
	 * answer — or to be left behind when the process is killed part-way.
	 */
	it('passes the recording on stdin and takes the frames off stdout, with no file anywhere', async () => {
		const child = spawns();
		const run = extractFrames(SERIAL, RECORDING, { framesPerSecond: 2 });
		await settled();
		const written = child.stdin.read() as Buffer;
		child.stdout.end(createMockPngStream([createMockPngBytes()]));
		await settled();
		child.emit('close', 0, null);
		await run;

		expect(new Uint8Array(written)).toEqual(RECORDING);
		expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'] });
		// No argument names a place on disk: the only two paths are the pipes.
		expect((spawnMock.mock.calls[0]?.[1] as string[]).filter((arg) => arg.includes('/'))).toEqual(
			[],
		);
	});

	// Every external invocation has a timeout (ai/CODING_STANDARDS.md) — a hung decoder with
	// none of its own would wedge a lease until it expires.
	it('gives the run a timeout', async () => {
		await extracting((child) => child.stdout.end());

		expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ timeout: FRAME_EXTRACTION_TIMEOUT_MS });
	});

	/**
	 * The split, over the case that separates a chunk walk from a signature search. Two whole
	 * images arrive; the first one's image data contains the eight signature bytes, which is
	 * what a search would cut on — producing three "frames", two of them halves of one image.
	 */
	it('splits the stream on the chunk structure, not on the signature bytes', async () => {
		const first = createMockPngBytes({ payload: SIGNATURE_IN_THE_PAYLOAD });
		const second = createMockPngBytes({ payload: [0x11, 0x22] });

		const frames = await extracting((child) =>
			child.stdout.end(createMockPngStream([first, second])),
		);

		expect(frames).toEqual([first, second]);
	});

	// Chunk boundaries are not frame boundaries: the runner concatenates before it splits, so a
	// frame arriving across two writes is still one frame.
	it('reassembles a frame that arrived across several chunks', async () => {
		const image = createMockPngBytes({ payload: SIGNATURE_IN_THE_PAYLOAD });

		const frames = await extracting((child) => {
			child.stdout.write(Buffer.from(image.subarray(0, 20)));
			child.stdout.end(Buffer.from(image.subarray(20)));
		});

		expect(frames).toEqual([image]);
	});

	// A recording with nothing in it to sample is a real answer — and the only one an empty
	// list may ever mean, which is what the refusals below are for.
	it('answers with no frames when the decoder wrote none', async () => {
		expect(await extracting((child) => child.stdout.end())).toEqual([]);
	});

	/**
	 * The branch that keeps an empty frame list from ever being an answer: a host without the
	 * program says so by name, and never resolves.
	 */
	it('refuses by name when the program could not be started, and never with an empty list', async () => {
		const thrown = await refusalOf((child) =>
			child.emit('error', new Error('spawn ffmpeg ENOENT')),
		);

		expect(thrown).toBeInstanceOf(FrameExtractionUnavailableError);
		expect(thrown).toMatchObject({
			serial: SERIAL,
			program: FFMPEG,
			reason: 'spawn ffmpeg ENOENT',
		});
		// And it says what to do about it, because a name without a remedy is half an answer.
		expect((thrown as Error).message).toContain('Install it on this host');
	});

	// A non-zero exit is data (ai/CODING_STANDARDS.md): the code says a decoder refused and
	// only its stderr says why — a recording it would not read reads nothing like a filter it
	// rejected.
	it('refuses with the exit code and the stderr when the run failed', async () => {
		const thrown = await refusalOf((child) => {
			child.stderr.write('pipe:0: Invalid data found when processing input\n');
			queueMicrotask(() => child.emit('close', 183, null));
		});

		expect(thrown).toBeInstanceOf(FrameExtractionFailedError);
		expect(thrown).toMatchObject({ serial: SERIAL, program: FFMPEG, exitCode: 183 });
		expect((thrown as FrameExtractionFailedError).stderr).toContain('Invalid data found');
		expect((thrown as Error).message).toContain('exited 183');
	});

	// A run killed at its deadline has no exit code, and "ended" alone would send the next
	// reader looking for a broken recording instead of a slow one.
	it('names the signal and the budget when the run was killed rather than exited', async () => {
		const thrown = await refusalOf((child) =>
			queueMicrotask(() => child.emit('close', null, 'SIGTERM')),
		);

		expect(thrown).toMatchObject({ exitCode: null });
		expect((thrown as Error).message).toContain('was killed by SIGTERM');
		expect((thrown as Error).message).toContain(`${FRAME_EXTRACTION_TIMEOUT_MS}ms`);
	});

	/**
	 * A decoder that exits 0 having written something unreadable is still a failed extraction.
	 * Reporting the frames that *did* parse would be the quietly trimmed list — and the frames
	 * that parse are the early ones, so the list would be missing its end with nothing saying so.
	 */
	it('refuses a stream that is not whole frames rather than reporting the ones it could read', async () => {
		const whole = createMockPngBytes();
		const cut = createMockPngBytes({ payload: [1, 2, 3, 4, 5, 6] }).subarray(0, 30);

		const thrown = await refusalOf((child) =>
			child.stdout.end(Buffer.concat([Buffer.from(whole), Buffer.from(cut)])),
		);

		expect(thrown).toBeInstanceOf(FrameExtractionFailedError);
		expect((thrown as Error).message).toContain('cannot read');
	});

	it('refuses a stream that never starts with a frame at all', async () => {
		const thrown = await refusalOf((child) => child.stdout.end(Buffer.from('not an image at all')));

		expect(thrown).toBeInstanceOf(FrameExtractionFailedError);
		expect((thrown as Error).message).toContain('no PNG signature');
	});

	/**
	 * The buffer bound, set explicitly rather than taken from a default nobody chose. It is a
	 * backstop rather than the payload budget — that one is `MAX_FRAMES_BYTES`, checked by the
	 * verb — so reaching it is a decoder that stopped honouring its frame cap, and the run is
	 * stopped rather than accumulated into a host that runs out of memory on a device's behalf.
	 */
	it('stops a run that writes more than the buffer bound', async () => {
		let stopped: FakeChild | undefined;

		const thrown = await refusalOf((child) => {
			stopped = child;
			child.stdout.write(Buffer.alloc(FRAME_STREAM_MAX_BUFFER_BYTES + 1));
		});

		expect(thrown).toBeInstanceOf(FrameExtractionFailedError);
		expect((thrown as Error).message).toContain('and was stopped');
		expect(stopped?.kill).toHaveBeenCalled();
	});
});
