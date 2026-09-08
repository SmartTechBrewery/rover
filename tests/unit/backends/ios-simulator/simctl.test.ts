import type { ExecFileException } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_SIMCTL_TIMEOUT_MS,
	describeBytes,
	QUOTED_STREAM_MAX_CHARS,
	quoteStream,
	READ_LOGS_SIMCTL_MAX_BUFFER_BYTES,
	readProcessTable,
	runSimctl,
	runSimctlOnDevice,
	SIMCTL_MAX_BUFFER_BYTES,
	SimctlCommandError,
	streamSimctlOnDevice,
} from '@/backends/ios-simulator/simctl.js';
import { parseDeviceSerial } from '@/core/ids.js';

/**
 * The runner's own suite: argv, the options that reach the process, and what a failure carries.
 * Nothing here proves anything about a simulator — that is `tests/device/`'s job, and the reason
 * the two exist separately (ai/TESTING.md).
 *
 * The mock is declared through `vi.hoisted` so it can carry `execFile`'s real callback
 * signature: an untyped `vi.fn()` infers a zero-argument call and `mock.calls[0][2]` then fails
 * to typecheck (ai/TESTING.md).
 *
 * **Which `simctl` gets run is stubbed out here on purpose**, exactly as
 * `../android/adb.test.ts` stubs its own resolution. Finding it is `developer-dir.test.ts`'s
 * subject and it needs a real filesystem to be about anything; what this suite is about is what
 * happens once one has been found. Leaving it real would make the whole file depend on whether
 * the machine running it has Xcode — the property the backend was written to stop depending on —
 * so as it stands the suite passes on a Mac that has never had Xcode, and on Linux.
 */
type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;
type ExecFileCall = [
	file: string,
	args: readonly string[],
	options: { timeout?: number; maxBuffer?: number; encoding?: string },
	callback: ExecFileCallback,
];

const { execFileMock, resolveDeveloperDirMock, spawnMock } = vi.hoisted(() => ({
	execFileMock: vi.fn<(...call: ExecFileCall) => void>(),
	resolveDeveloperDirMock: vi.fn<() => string>(),
	// `spawn` is a named import of the module under test, so the factory has to answer it even
	// for the suites that never touch it — an ESM named import that resolves to nothing fails
	// the whole file rather than the one call.
	spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock }));
vi.mock('@/backends/ios-simulator/developer-dir.js', () => ({
	resolveDeveloperDir: resolveDeveloperDirMock,
	SIMCTL_RELATIVE_PATH: 'usr/bin/simctl',
}));

/** What the search settled on, and the file inside it that must be the one executed. */
const DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
const RESOLVED_SIMCTL = `${DEVELOPER_DIR}/usr/bin/simctl`;

beforeEach(() => {
	resolveDeveloperDirMock.mockReturnValue(DEVELOPER_DIR);
});

/** A booted simulator's udid, in the shape the enumeration reports one. */
const SERIAL = parseDeviceSerial('997FA43E-FF9F-4109-BEF0-53D3F46653E7');

function answers(stdout: string, stderr = ''): void {
	execFileMock.mockImplementation((_file, _args, _options, callback) => {
		callback(null, stdout, stderr);
	});
}

function fails(error: Partial<ExecFileException>, stdout = '', stderr = ''): void {
	execFileMock.mockImplementation((_file, _args, _options, callback) => {
		callback(Object.assign(new Error('simctl failed'), error) as ExecFileException, stdout, stderr);
	});
}

/** The rejection, as the type it is — `rejects.toThrow` alone proves none of the fields. */
async function failureOf(run: Promise<unknown>): Promise<SimctlCommandError> {
	const error = await run.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(SimctlCommandError);
	return error as SimctlCommandError;
}

describe('runSimctl', () => {
	/**
	 * The decision the module exists to hold: the verified file, run directly. Never `xcrun`,
	 * which would search again and can disagree, and never a bare name, which would resolve
	 * against the `PATH` of whoever started the daemon.
	 */
	it('runs the simctl inside the developer directory the search verified', async () => {
		answers('{"devices":{}}\n');

		expect(await runSimctl(['list', '-j', 'devices', 'runtimes'])).toEqual({
			stdout: '{"devices":{}}\n',
			stderr: '',
		});
		expect(execFileMock.mock.calls[0][0]).toBe(RESOLVED_SIMCTL);
		expect(execFileMock.mock.calls[0][0]).not.toContain('xcrun');
		expect(execFileMock.mock.calls[0][1]).toEqual(['list', '-j', 'devices', 'runtimes']);
	});

	it('gives every invocation a timeout and room for the largest answer', async () => {
		answers('');
		await runSimctl(['list', '-j', 'devices']);

		expect(execFileMock.mock.calls[0][2]).toMatchObject({
			timeout: DEFAULT_SIMCTL_TIMEOUT_MS,
			maxBuffer: SIMCTL_MAX_BUFFER_BYTES,
			encoding: 'utf8',
		});
	});

	it('lets a caller widen the timeout for one call without touching the buffer', async () => {
		answers('');
		await runSimctl(['install', 'booted', 'App.app'], { timeoutMs: 90_000 });

		expect(execFileMock.mock.calls[0][2].timeout).toBe(90_000);
		expect(execFileMock.mock.calls[0][2].maxBuffer).toBe(SIMCTL_MAX_BUFFER_BYTES);
	});

	/**
	 * The other half of that: the log read's answer is a payload rather than a listing, and a
	 * minute of it measured past the default buffer on an idle simulator. Widening it must not
	 * quietly buy a longer budget along with the room.
	 */
	it('lets a caller widen the buffer for one call without touching the timeout', async () => {
		answers('');
		await runSimctl(['spawn', 'booted', 'log', 'show'], {
			maxBufferBytes: READ_LOGS_SIMCTL_MAX_BUFFER_BYTES,
		});

		expect(execFileMock.mock.calls[0][2].maxBuffer).toBe(READ_LOGS_SIMCTL_MAX_BUFFER_BYTES);
		expect(execFileMock.mock.calls[0][2].timeout).toBe(DEFAULT_SIMCTL_TIMEOUT_MS);
	});

	/**
	 * The three failures measured on macOS 26.6.2 / Xcode 26.4.1, 2026-09-08, each asserted in
	 * the shape it actually came back in. Together they are the evidence *against* mapping the
	 * exit code to anything: 148, 1 and 3 for three commands.
	 */
	it('carries the exit code, the argv and both streams of an invalid device', async () => {
		fails({ code: 148 }, '', 'Invalid device: 00000000-0000-0000-0000-000000000000\n');

		const error = await failureOf(
			runSimctl(['launch', '00000000-0000-0000-0000-000000000000', 'com.example.nope']),
		);

		expect(error.exitCode).toBe(148);
		expect(error.timedOut).toBe(false);
		expect(error.argv).toEqual([
			'launch',
			'00000000-0000-0000-0000-000000000000',
			'com.example.nope',
		]);
		expect(error.stderr).toBe('Invalid device: 00000000-0000-0000-0000-000000000000\n');
		expect(error.message).toContain(
			'simctl launch 00000000-0000-0000-0000-000000000000 com.example.nope exited 148',
		);
		expect(error.message).toContain('Invalid device: 00000000-0000-0000-0000-000000000000');
		expect(error.message).toContain('stdout: (empty)');
	});

	/**
	 * The row that makes carrying *both* streams necessary rather than tidy: an unrecognised
	 * subcommand puts one line on stderr and its whole usage text on **stdout**.
	 */
	it('keeps the stdout half of a failure that wrote its useful output there', async () => {
		fails(
			{ code: 1 },
			'usage: simctl [--set <path>] [--profiles <path>] <subcommand> ...\n',
			'Unrecognized subcommand: nonsense\n',
		);

		const error = await failureOf(runSimctl(['nonsense']));

		expect(error.exitCode).toBe(1);
		expect(error.stdout).toBe(
			'usage: simctl [--set <path>] [--profiles <path>] <subcommand> ...\n',
		);
		expect(error.message).toContain('stdout: usage: simctl');
		expect(error.message).toContain('stderr: Unrecognized subcommand: nonsense');
	});

	it('carries a multi-line failure whose exit code is a third number again', async () => {
		fails(
			{ code: 3 },
			'',
			'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):\n' +
				'Simulator device failed to terminate com.rover.nope.\n' +
				'found nothing to terminate\n',
		);

		const error = await failureOf(runSimctl(['terminate', 'booted', 'com.rover.nope']));

		expect(error.exitCode).toBe(3);
		expect(error.message).toContain('found nothing to terminate');
	});

	/**
	 * The redaction, on the failure it was written for: `simctl install` echoes the path it was
	 * given straight back out — `lstat of <path> failed: No such file or directory`, measured on
	 * Xcode 26.4.1 — so masking the argv alone would leave the same string in the message two
	 * lines further down. That is the hole a first pass at this left open on the Android side.
	 */
	it('masks a host path out of the message, in the argv and in the streams alike', async () => {
		const staged = '/var/folders/qx/T/rover-transfer-a1b2/payload';
		fails(
			{ code: 2 },
			'',
			'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2):\n' +
				`\tlstat of ${staged} failed: No such file or directory\n`,
		);

		const error = await failureOf(runSimctl(['install', SERIAL, staged], { redactArgv: [staged] }));

		expect(error.message).not.toContain(staged);
		expect(error.message).toContain(`simctl install ${SERIAL} <the file you sent> exited 2`);
		expect(error.message).toContain('lstat of <the file you sent> failed');
	});

	/**
	 * The error object keeps the real values, and the boundary is the message: this host's own
	 * log is exactly where the staged path is worth having (D19).
	 */
	it('keeps the unmasked argv and streams on the error itself', async () => {
		const staged = '/var/folders/qx/T/rover-transfer-a1b2/payload';
		fails({ code: 2 }, '', `lstat of ${staged} failed\n`);

		const error = await failureOf(runSimctl(['install', staged], { redactArgv: [staged] }));

		expect(error.argv).toEqual(['install', staged]);
		expect(error.stderr).toContain(staged);
	});

	/**
	 * The argv is matched as **whole entries** so the mask cannot swallow a device path that
	 * merely starts with the staged one — the asymmetry with the stream rule, and the reason it
	 * is one.
	 */
	it('does not mask an argv entry that only shares a prefix with the redacted path', async () => {
		fails({ code: 2 }, '', '');

		const error = await failureOf(
			runSimctl(['install', '/tmp/rover/payload-2'], { redactArgv: ['/tmp/rover/payload'] }),
		);

		expect(error.message).toContain('/tmp/rover/payload-2');
	});

	it('leaves the message alone when nothing was named for redaction', async () => {
		const path = '/tmp/rover/payload';
		fails({ code: 2 }, '', `lstat of ${path} failed\n`);

		const error = await failureOf(runSimctl(['install', path]));

		expect(error.message).toContain(`simctl install ${path} exited 2`);
		expect(error.message).toContain(`lstat of ${path} failed`);
	});

	it('names the budget it exceeded when a call times out', async () => {
		fails({ killed: true, signal: 'SIGTERM' });

		const error = await failureOf(runSimctl(['list', '-j', 'devices'], { timeoutMs: 250 }));

		expect(error.timedOut).toBe(true);
		expect(error.exitCode).toBeNull();
		expect(error.signal).toBe('SIGTERM');
		expect(error.message).toContain('timed out after 250ms');
	});

	// `killed` is set for an overflowing maxBuffer too, and reporting that as a timeout would
	// send the next reader looking for a slow simulator instead of a large answer.
	it('does not report an overflowing output buffer as a timeout', async () => {
		fails({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });

		const error = await failureOf(runSimctl(['list', '-j', 'devices']));

		expect(error.timedOut).toBe(false);
		expect(error.message).not.toContain('timed out');
	});

	/**
	 * The overflow as a field, because it is the one failure here a caller can act on rather than
	 * only report: `./backend.ts`'s log read widens its window until the cap binds and keeps the
	 * narrower answer when a wider one outgrows the buffer. Matching Node's wording out of the
	 * message would tie that decision to a string, and the message is also what gets masked.
	 */
	it('says an overflowing output buffer was one, as a field and in the message', async () => {
		fails({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'a partial answer\n');

		const error = await failureOf(runSimctl(['spawn', SERIAL, 'log', 'show']));

		expect(error.overflowedBuffer).toBe(true);
		expect(error.message).toContain('said more than its buffer holds');
		// The branch it has to sit ahead of: Node's own message reads `stdout maxBuffer length
		// exceeded`, and quoting it through `failed to run` would name the one thing that did not
		// happen.
		expect(error.message).not.toContain('failed to run');
	});

	it('leaves the flag off every other failure', async () => {
		fails({ code: 2 });

		expect((await failureOf(runSimctl(['install', '/tmp/nope.app']))).overflowedBuffer).toBe(false);
	});

	it('quotes the underlying failure when the process never ran at all', async () => {
		fails({ code: 'ENOENT', message: 'spawn ENOENT' });

		const error = await failureOf(runSimctl(['list']));

		expect(error.exitCode).toBeNull();
		expect(error.message).toContain('spawn ENOENT');
	});

	/**
	 * No `simctl` under any developer directory this host looks in. The search's own failure is
	 * what the caller gets, unwrapped: it names every place that was tried and the variable that
	 * overrides them, which is the whole difference from an opaque "utility not found" once per
	 * method.
	 */
	it('refuses without running anything when the search found no simctl at all', async () => {
		answers('');
		resolveDeveloperDirMock.mockImplementation(() => {
			throw new Error("'simctl' was not found under any of the developer directories");
		});

		await expect(runSimctl(['list'])).rejects.toThrow(
			"'simctl' was not found under any of the developer directories",
		);
		expect(execFileMock).not.toHaveBeenCalled();
	});

	/** Nothing is memoised, which is `developer-dir.ts`'s own documented stance. */
	it('resolves the developer directory again on every call', async () => {
		answers('');

		await runSimctl(['list']);
		await runSimctl(['list']);

		expect(resolveDeveloperDirMock).toHaveBeenCalledTimes(2);
	});
});

describe('runSimctlOnDevice', () => {
	// The pin is the point of the function: a command landing on another agent's device is the
	// worst failure mode this tool has (PROJECT.md §2), and it looks like success from both sides.
	it('puts the udid immediately after the subcommand and before the rest', async () => {
		answers('');

		await runSimctlOnDevice(SERIAL, 'install', ['/tmp/Rover.app']);

		expect(execFileMock.mock.calls[0][1]).toEqual([
			'install',
			'997FA43E-FF9F-4109-BEF0-53D3F46653E7',
			'/tmp/Rover.app',
		]);
	});

	it('runs a subcommand that takes no further arguments', async () => {
		answers('');

		await runSimctlOnDevice(SERIAL, 'shutdown');

		expect(execFileMock.mock.calls[0][1]).toEqual([
			'shutdown',
			'997FA43E-FF9F-4109-BEF0-53D3F46653E7',
		]);
	});

	it('carries the udid into the error of a failed run', async () => {
		fails({ code: 3 }, '', 'found nothing to terminate\n');

		const error = await failureOf(runSimctlOnDevice(SERIAL, 'terminate', ['com.rover.nope']));

		expect(error.argv).toEqual([
			'terminate',
			'997FA43E-FF9F-4109-BEF0-53D3F46653E7',
			'com.rover.nope',
		]);
		expect(error.message).toContain('simctl terminate 997FA43E-FF9F-4109-BEF0-53D3F46653E7');
	});

	/**
	 * The one value that silently turns a pinned call into an unpinned one: `simctl` accepts the
	 * literal `booted` and, when several are, "will choose one of them" (its own usage text).
	 *
	 * **Every casing of it, because the tool's own match ignores case** — measured on Xcode
	 * 26.4.1, where `terminate BOOTED …` resolved the booted device just as `booted` did while
	 * the near-miss `bootedx` answered `Invalid device: bootedx` (`docs/IOS.md` §2). A
	 * case-sensitive guard would refuse the one spelling nobody types and pass the two a caller
	 * plausibly would.
	 */
	it.each([
		'booted',
		'BOOTED',
		'Booted',
		'bOoTeD',
	])('refuses the booted selector spelled %s and says why, without running anything', async (selector) => {
		answers('');

		await expect(
			runSimctlOnDevice(parseDeviceSerial(selector), 'terminate', ['com.rover.nope']),
		).rejects.toThrow(/simctl choosing one of the booted ones/);
		expect(execFileMock).not.toHaveBeenCalled();
	});

	/**
	 * The refusal names what was passed rather than the constant, so the four spellings above are
	 * distinguishable in a log — which is the whole value of a tripwire that fires.
	 */
	it('names the offending value in the refusal rather than the canonical spelling', async () => {
		answers('');

		await expect(
			runSimctlOnDevice(parseDeviceSerial('BOOTED'), 'terminate', ['com.rover.nope']),
		).rejects.toThrow("against 'BOOTED'");
	});

	it('passes a widened timeout through to the process', async () => {
		answers('');

		await runSimctlOnDevice(SERIAL, 'install', ['/tmp/Rover.app'], { timeoutMs: 300_000 });

		expect(execFileMock.mock.calls[0][2].timeout).toBe(300_000);
	});
});

describe('describeBytes', () => {
	/** The eight bytes a capture off this platform starts with (`parsers/png.ts`). */
	const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	it('names the length and the leading bytes that identify a payload', () => {
		expect(describeBytes(Uint8Array.from([...PNG_HEAD, ...new Uint8Array(1_000)]))).toBe(
			'(1008 bytes, starting 89 50 4e 47 0d 0a 1a 0a)',
		);
	});

	it('reads no more than the first eight bytes', () => {
		expect(describeBytes(Uint8Array.from([0x01, 0x02]))).toBe('(2 bytes, starting 01 02)');
	});

	// A capture that never arrived is its own diagnosis, and `0 bytes, starting ` is not it.
	it('says so plainly when nothing came back at all', () => {
		expect(describeBytes(new Uint8Array())).toBe('(empty)');
	});
});

describe('quoteStream', () => {
	it('says so plainly when a stream carried nothing', () => {
		expect(quoteStream('')).toBe('(empty)');
		expect(quoteStream('\n\n')).toBe('(empty)');
	});

	it('trims the trailing newline every one of these carries', () => {
		expect(quoteStream('Invalid device: 0000\n')).toBe('Invalid device: 0000');
	});

	// The substring rule, which is what reaches a path the tool embedded in a sentence of its
	// own. Safe because the only values ever passed are paths this host invented moments before.
	it('masks a redacted path wherever the tool embedded it', () => {
		const staged = '/var/folders/qx/T/rover-transfer-a1b2/payload';

		expect(quoteStream(`lstat of ${staged} failed\n`, [staged])).toBe(
			'lstat of <the file you sent> failed',
		);
	});

	it('leaves an empty redaction entry alone rather than masking every gap', () => {
		expect(quoteStream('Invalid device: 0000\n', [''])).toBe('Invalid device: 0000');
	});

	// A successful `simctl io` writes an informational note here, so an inner newline is
	// ordinary content and is left alone.
	it('keeps the shape of a multi-line stream', () => {
		expect(quoteStream('Detected file type from extension: PNG\nNote: No display\n')).toBe(
			'Detected file type from extension: PNG\nNote: No display',
		);
	});

	/**
	 * The bound, and why it exists: a log read that overflows its 64 MB buffer hands the runner
	 * back everything it had buffered, and quoting that whole put tens of megabytes into an
	 * `Error.message` that then travels to another machine (D19) — measured at 67,108,185
	 * characters, enough on its own to take a test worker down serialising it.
	 */
	it('bounds a stream that is a payload rather than a complaint, and says what it dropped', () => {
		const line = `${'x'.repeat(99)}\n`;
		const lines = line.repeat(200);
		const kept = Math.floor(QUOTED_STREAM_MAX_CHARS / line.length) * line.length;

		const quoted = quoteStream(lines);

		expect(quoted.length).toBeLessThan(QUOTED_STREAM_MAX_CHARS + 100);
		expect(quoted).toContain(`(${lines.length - kept} more characters, dropped)`);
	});

	/**
	 * Cut back to the last line break rather than at the character. A host path is masked by a
	 * substring rule, which no partial copy of one would match, so a line the bound fell inside
	 * is dropped whole rather than quoted half — and a stream with no line break inside the bound
	 * is quoted as its size alone for the same reason.
	 */
	it('quotes whole lines only, so the bound cannot cut a redacted path in half', () => {
		const staged = '/var/folders/qx/T/rover-transfer-a1b2/payload';
		// The filler ends one line short of the bound, so the bound falls *inside* the path on the
		// next line: a plain slice would quote `/var/folders/qx/T/rover-transfe` unmasked.
		const stream = `${'x'.repeat(QUOTED_STREAM_MAX_CHARS - 41)}\nlstat of ${staged} failed\n`;

		expect(stream.slice(0, QUOTED_STREAM_MAX_CHARS)).toContain('/var/folders');
		expect(quoteStream(stream, [staged])).not.toContain('/var/folders');
		expect(quoteStream('y'.repeat(QUOTED_STREAM_MAX_CHARS * 2))).toBe(
			`(${QUOTED_STREAM_MAX_CHARS * 2} characters, not quoted)`,
		);
	});

	it('leaves a stream that fits the bound exactly as it was', () => {
		const stream = 'z'.repeat(QUOTED_STREAM_MAX_CHARS);

		expect(quoteStream(stream)).toBe(stream);
	});
});

/**
 * The long-lived spawn's stand-in. `unref` is answered on the child and on both pipes because
 * `release()` calls all three, and a `PassThrough` has no `unref` of its own — the same gap the
 * runner's own `unreference` exists for, since Node types a child's pipe as a `Readable` while
 * handing back a `Socket`.
 */
class FakeRecorder extends EventEmitter {
	readonly stdout = Object.assign(new PassThrough(), { unref: vi.fn() });
	readonly stderr = Object.assign(new PassThrough(), { unref: vi.fn() });
	readonly pid = 4242;
	readonly kill = vi.fn((): boolean => true);
	readonly unref = vi.fn();
}

function spawns(): FakeRecorder {
	const child = new FakeRecorder();
	spawnMock.mockReturnValue(child);
	return child;
}

/** Lets every pending stream event land before the assertions read what arrived. */
async function settled(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

const noHandlers = () => ({ onEnd: vi.fn(), onStderr: vi.fn(), onStdout: vi.fn() });

describe('streamSimctlOnDevice', () => {
	/**
	 * The same file the query runner runs, and the same pin: an unpinned recorder would record
	 * whichever device `simctl` felt like and hand the bytes over as this one's.
	 */
	it('spawns the verified simctl with the udid after the subcommand, and never inherits stdin', () => {
		spawns();

		streamSimctlOnDevice(SERIAL, 'io', ['recordVideo', '/tmp/out.mov'], noHandlers());

		expect(spawnMock.mock.calls[0]?.[0]).toBe(RESOLVED_SIMCTL);
		expect(spawnMock.mock.calls[0]?.[1]).toEqual([
			'io',
			String(SERIAL),
			'recordVideo',
			'/tmp/out.mov',
		]);
		expect(spawnMock.mock.calls[0]?.[2]).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
	});

	// The tripwire `runSimctlOnDevice` carries, on the runner where it matters most: a recording
	// is the one long-lived call here, and the one whose wrong device is least visible.
	it('refuses the booted selector in any casing before anything is spawned', () => {
		spawns();

		expect(() =>
			streamSimctlOnDevice(parseDeviceSerial('BOOTED'), 'io', ['recordVideo'], noHandlers()),
		).toThrow(/not a device/);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	// Answered synchronously, because the resolution behind it is: the pid is what the process
	// table is later matched against, and it is available the moment this returns.
	it('answers the pid without waiting for anything', () => {
		spawns();

		expect(streamSimctlOnDevice(SERIAL, 'io', ['recordVideo'], noHandlers()).pid).toBe(4242);
	});

	/**
	 * Decoded text rather than bytes, unlike the Android stream: nothing this runner streams is
	 * binary — the recording goes to a file — so a chunk boundary inside a multi-byte character
	 * must not become a replacement character in the marker a wait is looking for.
	 */
	it('hands both streams back as decoded text, in order', async () => {
		const child = spawns();
		const handlers = noHandlers();
		streamSimctlOnDevice(SERIAL, 'io', ['recordVideo'], handlers);

		child.stderr.write('Note: No display specified.\n');
		child.stderr.write('Recording started\n');
		child.stdout.write('Recording completed. Writing to disk.\n');
		await settled();

		expect(handlers.onStderr.mock.calls.map(([chunk]) => chunk)).toEqual([
			'Note: No display specified.\n',
			'Recording started\n',
		]);
		expect(handlers.onStdout.mock.calls).toEqual([['Recording completed. Writing to disk.\n']]);
	});

	/**
	 * Exit 0 is an end like any other here, and that is not a formality: a recording asked to stop
	 * exits 0, and so does one given a device with no screen to record, which produced nothing.
	 */
	it('reports a clean exit as an end, naming the command and the code', async () => {
		const child = spawns();
		const handlers = noHandlers();
		streamSimctlOnDevice(SERIAL, 'io', ['recordVideo'], handlers);

		child.emit('close', 0, null);
		await settled();

		expect(handlers.onEnd).toHaveBeenCalledTimes(1);
		expect(handlers.onEnd.mock.calls[0]?.[0]).toContain(`simctl io ${String(SERIAL)} recordVideo`);
		expect(handlers.onEnd.mock.calls[0]?.[0]).toContain('ended with exit 0');
	});

	it('names the signal when the run was killed rather than exited', async () => {
		const child = spawns();
		const handlers = noHandlers();
		streamSimctlOnDevice(SERIAL, 'io', ['recordVideo'], handlers);

		child.emit('close', null, 'SIGINT');
		await settled();

		expect(handlers.onEnd.mock.calls[0]?.[0]).toContain('was killed by SIGINT');
	});

	// Nothing ran at all: the file the search verified has moved since.
	it('reports a run that never started, with the reason node gave', async () => {
		const child = spawns();
		const handlers = noHandlers();
		streamSimctlOnDevice(SERIAL, 'io', ['recordVideo'], handlers);

		child.emit('error', new Error('spawn ENOENT'));
		await settled();

		expect(handlers.onEnd).toHaveBeenCalledTimes(1);
		expect(handlers.onEnd.mock.calls[0]?.[0]).toContain('failed to run: spawn ENOENT');
	});

	// One end, however many ways it arrives — a caller resolves its own promise from this.
	it('reports the end exactly once even when both events fire', async () => {
		const child = spawns();
		const handlers = noHandlers();
		streamSimctlOnDevice(SERIAL, 'io', ['recordVideo'], handlers);

		child.emit('error', new Error('spawn ENOENT'));
		child.emit('close', null, 'SIGKILL');
		await settled();

		expect(handlers.onEnd).toHaveBeenCalledTimes(1);
	});

	it('calls no handler with output that arrives after the end', async () => {
		const child = spawns();
		const handlers = noHandlers();
		streamSimctlOnDevice(SERIAL, 'io', ['recordVideo'], handlers);

		child.emit('close', 0, null);
		child.stdout.write('Wrote video to: /tmp/out.mov\n');
		await settled();

		expect(handlers.onStdout).not.toHaveBeenCalled();
	});

	/**
	 * The signal is the caller's to choose and `SIGINT` is the only one this repository sends
	 * (`../../../../src/backends/ios-simulator/simctl.ts` carries what a `SIGKILL` costs), but
	 * what this pins is that it reaches the process at all.
	 */
	it('sends the signal it was given to the run', () => {
		const child = spawns();
		const stream = streamSimctlOnDevice(SERIAL, 'io', ['recordVideo'], noHandlers());

		stream.signal('SIGINT');

		expect(child.kill).toHaveBeenCalledWith('SIGINT');
	});

	/**
	 * A signal after the end is a no-op, which is what makes it safe to arm a deadline timer and
	 * never clear it, and safe for a `finally` to signal again on every path.
	 */
	it('does not signal a run that has already ended', async () => {
		const child = spawns();
		const stream = streamSimctlOnDevice(SERIAL, 'io', ['recordVideo'], noHandlers());

		child.emit('close', 0, null);
		await settled();
		stream.signal('SIGINT');

		expect(child.kill).not.toHaveBeenCalled();
	});

	/**
	 * `release()` unreferences and never destroys — destroying the read end would give the
	 * recorder `EPIPE` on the two lines it writes as it finalises the file, so the tidier-looking
	 * version of this risks the recording.
	 */
	it('unreferences the run and both pipes without destroying either', () => {
		const child = spawns();
		const stream = streamSimctlOnDevice(SERIAL, 'io', ['recordVideo'], noHandlers());

		stream.release();

		expect(child.unref).toHaveBeenCalledTimes(1);
		expect(child.stdout.unref).toHaveBeenCalledTimes(1);
		expect(child.stderr.unref).toHaveBeenCalledTimes(1);
		expect(child.stdout.destroyed).toBe(false);
		expect(child.stderr.destroyed).toBe(false);
	});

	// A released run is still a run: the two lines it writes as it finalises still arrive, which
	// is the whole difference between unreferencing a pipe and closing it.
	it('keeps delivering output after the run has been released', async () => {
		const child = spawns();
		const handlers = noHandlers();
		const stream = streamSimctlOnDevice(SERIAL, 'io', ['recordVideo'], handlers);

		stream.release();
		child.stdout.write('Wrote video to: /tmp/out.mov\n');
		await settled();

		expect(handlers.onStdout).toHaveBeenCalledWith('Wrote video to: /tmp/out.mov\n');
	});
});

describe('readProcessTable', () => {
	/**
	 * By absolute path and with `-A`, because both are load-bearing: this is the one place a
	 * `PATH` a caller controls would decide *which* program answers a question this host then
	 * acts on with a signal, and a recorder an earlier daemon started is exactly the one the
	 * lease-end teardown has to find.
	 */
	it('asks ps for every process, by absolute path, with no header row', async () => {
		answers('4242 /usr/bin/simctl io x recordVideo\n');

		expect(await readProcessTable()).toBe('4242 /usr/bin/simctl io x recordVideo\n');
		expect(execFileMock.mock.calls[0][0]).toBe('/bin/ps');
		expect(execFileMock.mock.calls[0][1]).toEqual(['-A', '-o', 'pid=,command=']);
	});

	it('bounds the read, tighter than a call against a simulator', async () => {
		answers('');
		await readProcessTable();

		expect(execFileMock.mock.calls[0][2].timeout).toBeLessThan(DEFAULT_SIMCTL_TIMEOUT_MS);
		expect(execFileMock.mock.calls[0][2]).toMatchObject({
			encoding: 'utf8',
			maxBuffer: SIMCTL_MAX_BUFFER_BYTES,
		});
	});

	/**
	 * The distinction this function exists to keep: an unknown answer is not "no". An empty table
	 * reads as *this device is not recording*, which is the answer that starts a second recorder
	 * and stops the teardown collecting anything — so a `ps` that would not run says so.
	 */
	it('fails rather than answering an empty table when ps will not run', async () => {
		fails({ code: 'ENOENT' }, '', 'no such file');

		await expect(readProcessTable()).rejects.toThrow(/not "no"/);
		await expect(readProcessTable()).rejects.toThrow(/no such file/);
	});
});
