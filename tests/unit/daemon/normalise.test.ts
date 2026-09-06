/**
 * The recording normaliser's own suite: the argv on both branches, the four ways a run fails,
 * and the scratch directory it must never leave behind. Nothing here proves anything about a
 * real encoder — that is `tests/device/`'s job, and the reason the two exist separately
 * (ai/TESTING.md).
 *
 * The assertions that carry this module are about answers that would otherwise look fine:
 *
 * - **No path out of it hands the un-normalised recording back.** A host without the program,
 *   one whose encoder refused, one killed by its own budget, and one that exited 0 having
 *   written nothing are all refusals by name. Returning the input on any of them would put a
 *   structurally valid MP4 that no player shows anything for onto a client's disk and into the
 *   durable archive, with nothing in the answer saying so (ai/RULES.md §2).
 * - **The scratch directory is removed on every one of those paths**, and no path ever reaches
 *   an answer (D19). This module is the one place under `src/daemon/` that writes a host file
 *   for a verb, and the muxer is why (`src/daemon/normalise.ts`'s header).
 *
 * The mocks are declared through `vi.hoisted` so they can be referenced from the factories, the
 * shape `tests/unit/daemon/frames.test.ts` established. `node:fs/promises` is mocked as well as
 * `node:child_process`, because a suite that really wrote into the OS temp directory would be
 * asserting the filesystem's behaviour rather than this module's.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDeviceSerial } from '@/core/ids.js';
import { FFMPEG } from '@/daemon/frames.js';
import { normaliseRecording } from '@/daemon/normalise.js';
import {
	RecordingNormalisationFailedError,
	RecordingNormalisationUnavailableError,
} from '@/verbs/errors.js';
import {
	NORMALISED_FRAME_RATE,
	NORMALISED_MAX_BIT_RATE_BPS,
	RECORDING_NORMALISATION_TIMEOUT_MS,
} from '@/verbs/recording-normalisation.js';

const { spawnMock, mkdtempMock, readFileMock, rmMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	mkdtempMock: vi.fn(),
	readFileMock: vi.fn(),
	rmMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs/promises', () => ({
	mkdtemp: mkdtempMock,
	readFile: readFileMock,
	rm: rmMock,
}));

const SERIAL = parseDeviceSerial('device-under-test');

/** The bytes that came off the device: an `ftyp` header and a little payload behind it. */
const RECORDING = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]);

/** What a healthy run is taken to have written — distinguishable from its input, byte for byte. */
const NORMALISED = Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 9, 8, 7, 6, 5]);

/** The directory `mkdtemp` is taken to have made; nothing may ever answer with it. */
const TEMP_DIRECTORY = '/tmp/rover-normalise-abc123';

/**
 * A stand-in for the child process: real streams, so the chunking and the encoding are the ones
 * Node would produce, and an emitter for the lifecycle events the runner listens to.
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

/** A run played out the way a healthy one ends — exit 0 — and awaited. */
async function normalising(
	holdForMs: number | null,
	write: (child: FakeChild) => void = () => {},
): Promise<Uint8Array> {
	const child = spawns();
	const run = normaliseRecording(SERIAL, RECORDING, { holdForMs });
	await settled();
	write(child);
	await settled();
	child.emit('close', 0, null);
	return run;
}

/**
 * The same run, but the refusal it produced rather than the bytes — as the value it is, because
 * `rejects.toThrow` proves no field.
 *
 * The rejection is captured **before** the writer plays the run out, since a rejection nobody is
 * holding a handler for by the end of a turn is an unhandled rejection rather than an assertion.
 */
async function refusalOf(end: (child: FakeChild) => void): Promise<unknown> {
	const child = spawns();
	const captured = normaliseRecording(SERIAL, RECORDING, { holdForMs: null }).then(
		() => {
			throw new Error('the normalisation resolved where it was expected to refuse');
		},
		(thrown: unknown) => thrown,
	);
	await settled();
	end(child);
	return captured;
}

/** The argv one run was given, as the flat list ffmpeg would receive. */
function argsOf(): string[] {
	return spawnMock.mock.calls[0]?.[1] as string[];
}

/** The value of a flag on that argv — the one thing after it. */
function flagValue(flag: string): string | undefined {
	const args = argsOf();
	return args[args.indexOf(flag) + 1];
}

beforeEach(() => {
	spawnMock.mockReset();
	mkdtempMock.mockReset();
	readFileMock.mockReset();
	rmMock.mockReset();
	mkdtempMock.mockResolvedValue(TEMP_DIRECTORY);
	readFileMock.mockResolvedValue(NORMALISED);
	rmMock.mockResolvedValue(undefined);
});

describe('the normaliser drives one program over the recording', () => {
	/**
	 * The hold branch, and the two flags that make it exact: `tpad` repeats the last frame
	 * indefinitely and `-t` is what stops it, both at the same number. `round=up` is the measured
	 * necessity `src/daemon/frames.ts` records — plain `fps=n` over a stream of zero duration
	 * emits nothing at all, and a stream of zero duration is the case this module exists for.
	 */
	it('pads and cuts to the requested window when the recording declared no timeline', async () => {
		await normalising(6_000);

		expect(spawnMock.mock.calls[0]?.[0]).toBe(FFMPEG);
		expect(flagValue('-vf')).toBe(
			`fps=${NORMALISED_FRAME_RATE}:round=up,tpad=stop_mode=clone:stop_duration=6`,
		);
		expect(flagValue('-t')).toBe('6');
	});

	/**
	 * The container branch, and it is defined by what it does *not* carry: no `tpad` and no `-t`,
	 * so every sample the recorder wrote survives. A `-t` here would cut a recording whose
	 * container legitimately runs past the window that was asked for (PROJECT.md §6).
	 */
	it('neither pads nor cuts when the recording keeps its own timeline', async () => {
		await normalising(null);

		expect(flagValue('-vf')).toBe(`fps=${NORMALISED_FRAME_RATE}:round=up`);
		expect(argsOf()).not.toContain('-t');
		expect(argsOf().join(' ')).not.toContain('tpad');
	});

	/**
	 * `+faststart` is what keeps the answered file decodable the way the one it read was:
	 * PROJECT.md §6 records that a `moov` written *before* the payload is the only reason
	 * `ffmpeg -i pipe:0` works on these recordings at all, and a general-purpose muxer writes it
	 * at the end. Without this flag the normalised recording would be a file nothing downstream
	 * could stream.
	 */
	it('asks for the index before the payload, so what it writes is still decodable from a pipe', async () => {
		await normalising(null);

		expect(flagValue('-movflags')).toBe('+faststart');
	});

	/**
	 * The rate ceiling, which is what stops a re-encode of a busy screen coming back several
	 * times the size of what arrived — an `artifact-too-large` refusal for a call that works
	 * today. Asserted here rather than only on the constant, because a ceiling that is never put
	 * on the argv is not a ceiling.
	 */
	it('caps the bit rate at what one answer can carry', async () => {
		await normalising(null);

		expect(flagValue('-maxrate')).toBe(String(NORMALISED_MAX_BIT_RATE_BPS));
		expect(flagValue('-bufsize')).toBe(String(NORMALISED_MAX_BIT_RATE_BPS));
	});

	/**
	 * A wedged encoder must not hold a lease until it expires (ai/CODING_STANDARDS.md), and this
	 * one runs while a lease is held.
	 */
	it('bounds the run with its own budget', async () => {
		await normalising(null);

		expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
			timeout: RECORDING_NORMALISATION_TIMEOUT_MS,
		});
	});

	/**
	 * The input still arrives on `pipe:0`, so the bytes that came off the device never touch this
	 * host's disk — it is only the *output* that needs a file, because the mp4 muxer refuses a
	 * non-seekable one.
	 */
	it('passes the recording on stdin, byte for byte, and writes no input file', async () => {
		const child = spawns();
		const run = normaliseRecording(SERIAL, RECORDING, { holdForMs: null });
		await settled();
		const written = child.stdin.read() as Buffer;
		child.emit('close', 0, null);
		await run;

		expect(new Uint8Array(written)).toEqual(RECORDING);
		expect(argsOf()).toContain('pipe:0');
	});

	it('answers with the file the run wrote rather than with what it was given', async () => {
		const normalised = await normalising(null);

		expect(normalised).toEqual(new Uint8Array(NORMALISED));
		expect(normalised).not.toEqual(RECORDING);
	});
});

describe('a host that cannot normalise refuses by name', () => {
	/**
	 * The program absent from PATH is the common one and the one case with a remedy on the host
	 * rather than in the call, so it is kept apart from a run that refused.
	 */
	it('names the program and Node’s own reason when nothing ran at all', async () => {
		const thrown = await refusalOf((child) =>
			child.emit('error', new Error('spawn ffmpeg ENOENT')),
		);

		expect(thrown).toBeInstanceOf(RecordingNormalisationUnavailableError);
		expect(thrown).toMatchObject({
			serial: SERIAL,
			program: FFMPEG,
			reason: 'spawn ffmpeg ENOENT',
		});
		// And it says the recording itself survived, so an agent does not read this as a device
		// that failed to record.
		expect((thrown as Error).message).toContain('pulled intact');
	});

	it('carries the exit code and the stderr tail when the run refused', async () => {
		const thrown = await refusalOf((child) => {
			child.stderr.end('Unknown encoder libx264\n');
			queueMicrotask(() => child.emit('close', 183, null));
		});

		expect(thrown).toBeInstanceOf(RecordingNormalisationFailedError);
		expect(thrown).toMatchObject({ serial: SERIAL, program: FFMPEG, exitCode: 183 });
		expect((thrown as RecordingNormalisationFailedError).stderr).toContain('Unknown encoder');
		expect((thrown as RecordingNormalisationFailedError).outcome).toBe('exited 183');
	});

	// A run killed by its own budget reads identically to any other signal from an exit code, so
	// the outcome says which and names the budget that is the likely reason.
	it('names the budget when a signal ended the run', async () => {
		const thrown = await refusalOf((child) => child.emit('close', null, 'SIGTERM'));

		expect(thrown).toBeInstanceOf(RecordingNormalisationFailedError);
		expect(thrown).toMatchObject({ exitCode: null });
		expect((thrown as Error).message).toContain(`${RECORDING_NORMALISATION_TIMEOUT_MS}ms`);
	});

	/**
	 * The branch that keeps a silently un-normalised file from ever being the answer. The bytes
	 * that went in were already proved a finished, non-empty recording, so an exit 0 with nothing
	 * written is an encoder that did something this host did not anticipate — the shape a build
	 * of `ffmpeg` without the H.264 encoder takes.
	 */
	it('refuses an exit 0 that wrote no file, rather than handing the recording back', async () => {
		readFileMock.mockRejectedValue(new Error('ENOENT'));

		const thrown = await refusalOf((child) => child.emit('close', 0, null));

		expect(thrown).toBeInstanceOf(RecordingNormalisationFailedError);
		expect((thrown as RecordingNormalisationFailedError).outcome).toContain(
			'without writing a recording',
		);
	});

	it('refuses an exit 0 that wrote an empty file the same way', async () => {
		readFileMock.mockResolvedValue(Buffer.alloc(0));

		const thrown = await refusalOf((child) => child.emit('close', 0, null));

		expect(thrown).toBeInstanceOf(RecordingNormalisationFailedError);
		expect((thrown as RecordingNormalisationFailedError).outcome).toContain('empty recording');
	});
});

describe('the scratch directory is this run’s own and never anybody else’s business', () => {
	it('removes it after a run that succeeded', async () => {
		await normalising(null);

		expect(rmMock).toHaveBeenCalledWith(TEMP_DIRECTORY, { recursive: true, force: true });
	});

	// Every refusal path too, including the one where the file was never written: a multi-megabyte
	// file left in the OS temp directory for every recording is what this `finally` prevents.
	it('removes it after every way a run can fail', async () => {
		const endings: Array<(child: FakeChild) => void> = [
			(child) => child.emit('error', new Error('spawn ffmpeg ENOENT')),
			(child) => child.emit('close', 1, null),
			(child) => child.emit('close', null, 'SIGKILL'),
		];

		for (const ending of endings) {
			rmMock.mockClear();
			await refusalOf(ending);
			expect(rmMock).toHaveBeenCalledWith(TEMP_DIRECTORY, { recursive: true, force: true });
		}
	});

	/**
	 * D19, on the host tool that has a file where `src/daemon/frames.ts` has none: the path is an
	 * implementation detail of this machine, and an answer that carried it would name something
	 * that is not on the agent's disk — or, worse, something that is.
	 */
	it('never puts the path in a refusal or in the bytes it answers with', async () => {
		const thrown = await refusalOf((child) => {
			child.stderr.end('Invalid data found when processing input\n');
			queueMicrotask(() => child.emit('close', 183, null));
		});

		expect((thrown as Error).message).not.toContain(TEMP_DIRECTORY);
		expect((thrown as RecordingNormalisationFailedError).stderr).not.toContain(TEMP_DIRECTORY);
	});
});
