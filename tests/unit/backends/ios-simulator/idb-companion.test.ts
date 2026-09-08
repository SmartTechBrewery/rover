import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type IdbCompanionStream,
	type IdbCompanionStreamHandlers,
	streamIdbCompanion,
} from '@/backends/ios-simulator/idb-companion.js';
import { IdbCompanionNotFoundError } from '@/backends/ios-simulator/idb-companion-path.js';
import { IdbNotifyFrameDecoder } from '@/backends/ios-simulator/parsers/idb-notify.js';
import { createGate, drainEventLoop } from '../../../helpers/timing.js';

/**
 * The companion runner, driven against **real stub executables** built in a `mkdtemp` directory
 * — `../android/adb-path.test.ts`' technique, and here for the sharper version of its reason:
 * what this module is is a spawn, two pipes and a kill, so a mocked `child_process` would leave
 * every claim in this file asserting the mock's own behaviour. The stubs are `sh` scripts, so the
 * suite needs no idb and passes on a machine that has never had one — and on Linux.
 *
 * **Which companion gets run is stubbed out**, exactly as `./simctl.test.ts` stubs
 * `resolveDeveloperDir`: finding one is `./idb-companion-path.test.ts`' subject and needs a real
 * filesystem to be about anything, while what this suite is about is what happens once one has
 * been found. The one case that does not stub it out is the one about a resolution that fails,
 * because a failure surfacing *synchronously* is this module's contract with its caller.
 *
 * Nothing here waits on a duration: every case waits on a handler being reached
 * (`tests/helpers/timing.ts`), and every stub that stays open blocks on a read rather than
 * sleeping (ai/RULES.md §2).
 */

const { resolveDeveloperDirMock, resolveIdbCompanionMock } = vi.hoisted(() => ({
	resolveDeveloperDirMock: vi.fn<() => string>(),
	resolveIdbCompanionMock: vi.fn<() => string>(),
}));

vi.mock('@/backends/ios-simulator/idb-companion-path.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/backends/ios-simulator/idb-companion-path.js')>()),
	resolveIdbCompanion: resolveIdbCompanionMock,
}));

/**
 * The *other* search, stubbed for the same reason: whether this machine has an Xcode is not what
 * this suite is about, and leaving it real would make the environment the companion is handed
 * depend on the machine running the suite.
 */
vi.mock('@/backends/ios-simulator/developer-dir.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/backends/ios-simulator/developer-dir.js')>()),
	resolveDeveloperDir: resolveDeveloperDirMock,
}));

/** What the search settled on, and therefore what the companion must be told to use. */
const DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

/**
 * Two frames of a real `idb_companion --notify stdout` run, newline-terminated as the companion
 * writes them (`tests/fixtures/ios-simulator/README.md`).
 *
 * The captured bytes rather than a hand-written array, so what the stubs print is what the
 * program prints — including the trailing newline the decoder frames on.
 */
const CAPTURE = readFileSync(
	new URL(
		'../../../fixtures/ios-simulator/idb-notify.idbcompanion1.5.2-xcode26.6-ios26.5.txt',
		import.meta.url,
	),
	'utf8',
);
const FRAMES = `${CAPTURE.split('\n').slice(0, 2).join('\n')}\n`;

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'rover-idb-companion-'));
	resolveDeveloperDirMock.mockReturnValue(DEVELOPER_DIR);
	// Replaced rather than read: a machine that exports one of its own would otherwise decide
	// what the case below sees.
	vi.stubEnv('DEVELOPER_DIR', undefined);
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

/** A stub companion: `body` as an `sh` script, executable unless a case says otherwise. */
async function stub(name: string, body: string, mode = 0o755): Promise<string> {
	const path = join(directory, name);
	await writeFile(path, `#!/bin/sh\n${body}`);
	await chmod(path, mode);
	resolveIdbCompanionMock.mockReturnValue(path);
	return path;
}

/** The frames file the stubs print, kept beside them so nothing has to be quoted into a script. */
async function framesFile(): Promise<string> {
	const path = join(directory, 'frames.txt');
	await writeFile(path, FRAMES);
	return path;
}

/** A companion that prints two captured frames and exits. */
async function printsTwoFrames(): Promise<void> {
	await stub('idb_companion', `cat '${await framesFile()}'\n`);
}

/** A companion that complains on stderr and exits non-zero, having printed no frame at all. */
async function exitsImmediately(exitCode = 3): Promise<void> {
	await stub('idb_companion', `echo 'could not connect to CoreSimulator' >&2\nexit ${exitCode}\n`);
}

/**
 * A companion that prints its frames and then stays open, which is what one really does.
 *
 * It blocks on a read that never completes rather than waiting out a duration — `tail -f` on a
 * file nothing writes to — so the case that kills it is asserting a kill and not a race with a
 * timer.
 */
async function staysOpen(): Promise<void> {
	await stub('idb_companion', `cat '${await framesFile()}'\nexec tail -f /dev/null\n`);
}

/** Everything a run said, and the way to wait for it having said it. */
interface Transcript {
	readonly stdout: Buffer[];
	readonly stderr: string[];
	readonly ends: string[];
	/** Reached by the first stdout chunk, and by an end that arrives before one. */
	readonly output: Promise<void>;
	/** Reached by `onEnd`. */
	readonly ended: Promise<void>;
}

function record(): { handlers: IdbCompanionStreamHandlers; transcript: Transcript } {
	const stdout: Buffer[] = [];
	const stderr: string[] = [];
	const ends: string[] = [];
	const output = createGate();
	const ended = createGate();

	return {
		handlers: {
			onStdout(chunk) {
				stdout.push(chunk);
				output.reach();
			},
			onStderr(chunk) {
				stderr.push(chunk);
			},
			onEnd(reason) {
				ends.push(reason);
				output.reach();
				ended.reach();
			},
		},
		transcript: { stdout, stderr, ends, output: output.reached, ended: ended.reached },
	};
}

/** Every byte of stdout, in order. */
const bytesOf = (transcript: Transcript): Buffer => Buffer.concat(transcript.stdout);

/** Whatever is still running when a case ends, stopped so no child outlives the suite. */
const running: IdbCompanionStream[] = [];

function start(handlers: IdbCompanionStreamHandlers): IdbCompanionStream {
	const stream = streamIdbCompanion(['--notify', 'stdout'], handlers);
	running.push(stream);
	return stream;
}

afterEach(async () => {
	await Promise.all(running.splice(0).map((stream) => stream.stop()));
});

describe('what the caller is handed', () => {
	it('hands every byte the companion printed to onStdout, undecoded', async () => {
		await printsTwoFrames();
		const { handlers, transcript } = record();

		start(handlers);
		await transcript.ended;

		expect(bytesOf(transcript).toString('utf8')).toBe(FRAMES);
	});

	/**
	 * The join this runner exists to make: the bytes it hands over are the bytes the decoder
	 * frames, so two frames printed are two full target sets and not one truncated one.
	 */
	it('hands over bytes a frame decoder reads as the two full sets that were printed', async () => {
		await printsTwoFrames();
		const { handlers, transcript } = record();

		start(handlers);
		await transcript.ended;

		const frames = new IdbNotifyFrameDecoder().push(bytesOf(transcript));
		expect(frames).toHaveLength(2);
		expect(frames[0]).toHaveLength(11);
		expect(frames[1]).toHaveLength(11);
	});

	it('hands stderr over as decoded text', async () => {
		await exitsImmediately();
		const { handlers, transcript } = record();

		start(handlers);
		await transcript.ended;

		expect(transcript.stderr.join('')).toContain('could not connect to CoreSimulator');
	});

	/** The argv is the caller's — this module owns the process and decides nothing about the mode. */
	it('runs the argv it was given and nothing of its own', async () => {
		await stub('idb_companion', 'echo "$@"\n');
		const { handlers, transcript } = record();

		start(handlers);
		await transcript.ended;

		expect(bytesOf(transcript).toString('utf8').trim()).toBe('--notify stdout');
	});

	/**
	 * `stdin: 'ignore'`: nothing here has anything to say to a companion, and inheriting it would
	 * let one consume the daemon's own input. A stub that reads stdin therefore reads end-of-file
	 * at once rather than blocking on a terminal.
	 */
	it('gives the companion no stdin to consume', async () => {
		await stub('idb_companion', 'cat\necho "eof"\n');
		const { handlers, transcript } = record();

		start(handlers);
		await transcript.ended;

		expect(bytesOf(transcript).toString('utf8')).toBe('eof\n');
	});

	/**
	 * #171's rule across two programs, and it is measured rather than reasoned: a companion whose
	 * `xcode-select` selection is CommandLineTools exits 0 having printed no frame at all, while
	 * `simctl` runs perfectly through this backend's own search — see the function this asserts.
	 */
	it('tells the companion which Xcode this backend runs simctl out of', async () => {
		await stub('idb_companion', 'echo "$DEVELOPER_DIR"\n');
		const { handlers, transcript } = record();

		start(handlers);
		await transcript.ended;

		expect(bytesOf(transcript).toString('utf8').trim()).toBe(DEVELOPER_DIR);
	});

	/**
	 * And no Xcode at all leaves the variable alone rather than inventing one: the companion's own
	 * complaint about it is more accurate than anything this backend would substitute.
	 */
	it('leaves the variable unset when there is no Xcode to name', async () => {
		resolveDeveloperDirMock.mockImplementation(() => {
			throw new Error('no developer directory on this host');
		});
		await stub(
			'idb_companion',
			'if [ -n "$DEVELOPER_DIR" ]; then echo "[$DEVELOPER_DIR]"; else echo "[unset]"; fi\n',
		);
		const { handlers, transcript } = record();

		start(handlers);
		await transcript.ended;

		expect(bytesOf(transcript).toString('utf8').trim()).toBe('[unset]');
	});
});

describe('how a run ends', () => {
	it('reports the exit code, once, naming the program and its argv', async () => {
		await exitsImmediately(3);
		const { handlers, transcript } = record();

		start(handlers);
		await transcript.ended;
		await drainEventLoop();

		expect(transcript.ends).toEqual(['idb_companion --notify stdout ended with exit 3']);
	});

	/**
	 * **Exit 0 is an end like any other**: a companion that printed its frames and stopped has
	 * taken the host's view with it whatever it exited with, so there is no "clean end" to report
	 * differently — the caller's answer is one interruption and a restart either way.
	 */
	it('reports an exit 0 as an end like any other', async () => {
		await printsTwoFrames();
		const { handlers, transcript } = record();

		start(handlers);
		await transcript.ended;

		expect(transcript.ends).toEqual(['idb_companion --notify stdout ended with exit 0']);
	});

	/**
	 * The end reason carries **neither stream**, which is `./simctl.test.ts`' runner's rule: the
	 * caller has been handed every byte of both already, and a runner that quoted them back would
	 * be deciding for the caller which half of a failure matters.
	 */
	it('keeps the streams out of the end reason', async () => {
		await exitsImmediately();
		const { handlers, transcript } = record();

		start(handlers);
		await transcript.ended;

		expect(transcript.ends[0]).not.toContain('could not connect');
	});

	/**
	 * The file the search accepted has lost its execute bit since — which is the SDK moving out
	 * from under a running daemon, and it arrives as an `error` event rather than as an exit.
	 * Still one `onEnd`, because a caller that had to handle "never started" separately from
	 * "ended" would have two paths for one outcome.
	 */
	it('reports a companion that could not be run at all as an end', async () => {
		await stub('idb_companion', 'exit 0\n', 0o644);
		const { handlers, transcript } = record();

		start(handlers);
		await transcript.ended;

		expect(transcript.ends).toHaveLength(1);
		expect(transcript.ends[0]).toContain('idb_companion --notify stdout failed to run');
	});

	/**
	 * The resolution's failure comes out of the **call**, not through `onEnd` — the contract that
	 * lets `watchDevices` tell "there is no companion on this host" apart from "the stream ended"
	 * and name the program to an operator. It can be synchronous because the search is `stat` and
	 * `access` and no process.
	 */
	it('lets a failed resolution out synchronously rather than reporting it as an end', () => {
		resolveIdbCompanionMock.mockImplementation(() => {
			throw new IdbCompanionNotFoundError([]);
		});
		const { handlers, transcript } = record();

		expect(() => streamIdbCompanion(['--notify', 'stdout'], handlers)).toThrow(
			IdbCompanionNotFoundError,
		);
		expect(transcript.ends).toEqual([]);
	});
});

describe('stop', () => {
	it('kills a companion that would otherwise stay open, and calls no handler', async () => {
		await staysOpen();
		const { handlers, transcript } = record();

		const stream = start(handlers);
		await transcript.output;
		await stream.stop();
		await drainEventLoop();

		expect(transcript.ends).toEqual([]);
		expect(bytesOf(transcript).toString('utf8')).toBe(FRAMES);
	});

	/** Stopped before anything was printed: no frame, no end, nothing at all. */
	it('leaves nothing behind when it stops a companion before its first frame', async () => {
		await staysOpen();
		const { handlers, transcript } = record();

		await start(handlers).stop();
		await drainEventLoop();

		expect(transcript.stdout).toEqual([]);
		expect(transcript.ends).toEqual([]);
	});

	it('treats a second stop as a no-op rather than an error', async () => {
		await staysOpen();
		const { handlers, transcript } = record();

		const stream = start(handlers);
		await transcript.output;

		await expect(stream.stop()).resolves.toBeUndefined();
		await expect(stream.stop()).resolves.toBeUndefined();
	});

	/** A run that already ended has no process to kill, so `stop()` resolves rather than waiting. */
	it('resolves at once for a companion that has already ended', async () => {
		await printsTwoFrames();
		const { handlers, transcript } = record();

		const stream = start(handlers);
		await transcript.ended;

		await expect(stream.stop()).resolves.toBeUndefined();
	});
});
