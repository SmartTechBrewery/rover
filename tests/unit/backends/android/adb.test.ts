import type { ExecFileException } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
	ADB_BINARY_MAX_BUFFER_BYTES,
	ADB_MAX_BUFFER_BYTES,
	ADB_STREAM_STDERR_TAIL_CHARS,
	AdbCommandError,
	DEFAULT_ADB_TIMEOUT_MS,
	describeBytes,
	runAdb,
	runAdbBinaryOnDevice,
	runAdbOnDevice,
	shellArg,
	shellText,
	streamAdb,
} from '@/backends/android/adb.js';
import { parseDeviceSerial } from '@/core/ids.js';

/**
 * The runner's own suite: argv, the options that reach the process, and what a failure
 * carries. Nothing here proves anything about a device — that is `tests/device/`'s job,
 * and the reason the two exist separately (ai/TESTING.md).
 *
 * The mock is declared through `vi.hoisted` so it can carry `execFile`'s real callback
 * signature: an untyped `vi.fn()` infers a zero-argument call and `mock.calls[0][2]`
 * then fails to typecheck (ai/TESTING.md).
 */
type ExecFileCallback = (
	error: ExecFileException | null,
	stdout: string | Buffer,
	stderr: string | Buffer,
) => void;
type ExecFileCall = [
	file: string,
	args: readonly string[],
	options: { timeout?: number; maxBuffer?: number; encoding?: string },
	callback: ExecFileCallback,
];

const { execFileMock, spawnMock } = vi.hoisted(() => ({
	execFileMock: vi.fn<(...call: ExecFileCall) => void>(),
	// `spawn` is a named import of the module under test, so the factory has to answer it
	// even for the suites that never touch it — an ESM named import that resolves to
	// nothing fails the whole file, not the one call.
	spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock }));

const SERIAL = parseDeviceSerial('device-under-test');

function answers(stdout: string, stderr = ''): void {
	execFileMock.mockImplementation((_file, _args, _options, callback) => {
		callback(null, stdout, stderr);
	});
}

/** The binary counterpart: what `encoding: 'buffer'` hands the callback. */
function answersBytes(stdout: Buffer, stderr = ''): void {
	execFileMock.mockImplementation((_file, _args, _options, callback) => {
		callback(null, stdout, Buffer.from(stderr, 'utf8'));
	});
}

function fails(error: Partial<ExecFileException>, stdout = '', stderr = ''): void {
	execFileMock.mockImplementation((_file, _args, _options, callback) => {
		callback(Object.assign(new Error('adb failed'), error) as ExecFileException, stdout, stderr);
	});
}

/** The rejection, as the type it is — `rejects.toThrow` alone proves none of the fields. */
async function failureOf(run: Promise<unknown>): Promise<AdbCommandError> {
	const error = await run.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(AdbCommandError);
	return error as AdbCommandError;
}

describe('runAdb', () => {
	it('runs adb with the arguments it was given and hands back both streams', async () => {
		answers('List of devices attached\n', '* daemon started successfully\n');

		expect(await runAdb(['devices', '-l'])).toEqual({
			stdout: 'List of devices attached\n',
			stderr: '* daemon started successfully\n',
		});
		expect(execFileMock.mock.calls[0][0]).toBe('adb');
		expect(execFileMock.mock.calls[0][1]).toEqual(['devices', '-l']);
	});

	it('gives every invocation a timeout and room for the largest answer', async () => {
		answers('');
		await runAdb(['devices']);

		expect(execFileMock.mock.calls[0][2]).toMatchObject({
			timeout: DEFAULT_ADB_TIMEOUT_MS,
			maxBuffer: ADB_MAX_BUFFER_BYTES,
			encoding: 'utf8',
		});
	});

	it('lets a caller widen the timeout for one call', async () => {
		answers('');
		await runAdb(['install', 'app.apk'], { timeoutMs: 90_000 });

		expect(execFileMock.mock.calls[0][2].timeout).toBe(90_000);
	});

	it('throws with the exit code, the argv and both streams on a non-zero exit', async () => {
		fails({ code: 1 }, 'partial output\n', 'error: no devices/emulators found\n');

		const error = await failureOf(runAdb(['shell', 'wm', 'size']));

		expect(error.exitCode).toBe(1);
		expect(error.timedOut).toBe(false);
		expect(error.argv).toEqual(['shell', 'wm', 'size']);
		expect(error.stdout).toBe('partial output\n');
		expect(error.stderr).toBe('error: no devices/emulators found\n');
		expect(error.message).toContain('adb shell wm size exited 1');
		expect(error.message).toContain('error: no devices/emulators found');
		expect(error.message).toContain('partial output');
	});

	it('names the budget it exceeded when a call times out', async () => {
		fails({ killed: true, signal: 'SIGTERM' });

		const error = await failureOf(runAdb(['shell', 'getprop'], { timeoutMs: 250 }));

		expect(error.timedOut).toBe(true);
		expect(error.exitCode).toBeNull();
		expect(error.message).toContain('timed out after 250ms');
	});

	// `killed` is set for an overflowing maxBuffer too, and reporting that as a timeout
	// would send the next reader looking for a slow device instead of a large answer.
	it('does not report an overflowing output buffer as a timeout', async () => {
		fails({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });

		const error = await failureOf(runAdb(['shell', 'getprop']));

		expect(error.timedOut).toBe(false);
		expect(error.message).not.toContain('timed out');
	});

	it('quotes the underlying failure when the process never ran at all', async () => {
		fails({ code: 'ENOENT', message: 'spawn adb ENOENT' });

		const error = await failureOf(runAdb(['devices']));

		expect(error.exitCode).toBeNull();
		expect(error.message).toContain('spawn adb ENOENT');
	});

	it('says so plainly when a failing command printed nothing', async () => {
		fails({ code: 1 });

		expect((await failureOf(runAdb(['devices']))).message).toContain('stderr: (empty)');
	});
});

/**
 * D19 at the one boundary a transfer crosses: the message of an `AdbCommandError` becomes
 * the text of an `internal_error` response (`src/ipc/server.ts`), read on the agent's
 * machine, where a `/var/folders/…` path this host has already deleted names nothing.
 */
describe('redactArgv', () => {
	const STAGED = '/var/folders/mq/rover-probe-q24AlC/payload';

	it('masks the host path in the argv it quotes', async () => {
		fails({ code: 1 });

		const error = await failureOf(
			runAdb(['push', STAGED, '/data/rover-x.bin'], { redactArgv: [STAGED] }),
		);

		expect(error.message).toContain('adb push <the file you sent> /data/rover-x.bin exited 1');
		expect(error.message).not.toContain(STAGED);
	});

	/**
	 * The half a first pass at this missed: adb writes the path it was handed into its own
	 * output, so masking the argv alone leaves the same string one line further down.
	 * Both wordings are quoted from adb 37.0.0 against an API 37 emulator (PROJECT.md §6).
	 */
	it('masks it again wherever adb echoed it back into its own streams', async () => {
		fails(
			{ code: 1 },
			`${STAGED}: 1 file pushed, 0 skipped.\n`,
			`adb: error: failed to copy '${STAGED}' to '/data/rover-x.bin': ` +
				"remote couldn't create file: Permission denied\n",
		);

		const error = await failureOf(
			runAdb(['push', STAGED, '/data/rover-x.bin'], { redactArgv: [STAGED] }),
		);

		expect(error.message).not.toContain(STAGED);
		expect(error.message).not.toContain('/var/folders');
		// Masked, not elided: the sentence adb wrote still reads, and the device's own half
		// of it — which is the only part the caller can act on — is untouched.
		expect(error.message).toContain(
			"adb: error: failed to copy '<the file you sent>' to '/data/rover-x.bin'",
		);
		expect(error.message).toContain("remote couldn't create file: Permission denied");
		expect(error.message).toContain('<the file you sent>: 1 file pushed, 0 skipped.');
	});

	/** The other transfer's wording, which embeds the path without quoting it. */
	it('masks it in an install failure adb worded without quotes', async () => {
		fails(
			{ code: 1 },
			'Performing Streamed Install\n',
			`adb: failed to install ${STAGED}: Failure [INSTALL_PARSE_FAILED_NOT_APK]\n`,
		);

		const error = await failureOf(runAdb(['install', '-r', STAGED], { redactArgv: [STAGED] }));

		expect(error.message).not.toContain(STAGED);
		expect(error.message).toContain(
			'adb: failed to install <the file you sent>: Failure [INSTALL_PARSE_FAILED_NOT_APK]',
		);
	});

	/**
	 * The message is masked; the error is not. Whoever is reading this on the host — a log,
	 * a debugger — loses nothing, because none of these fields crosses the boundary.
	 */
	it('keeps the real argv and both real streams on the error itself', async () => {
		fails({ code: 1 }, `${STAGED}: pushed\n`, `failed to copy '${STAGED}'\n`);

		const error = await failureOf(
			runAdb(['push', STAGED, '/data/rover-x.bin'], { redactArgv: [STAGED] }),
		);

		expect(error.argv).toEqual(['push', STAGED, '/data/rover-x.bin']);
		expect(error.stdout).toBe(`${STAGED}: pushed\n`);
		expect(error.stderr).toBe(`failed to copy '${STAGED}'\n`);
	});

	/**
	 * The argv rule stays whole-entry, and this is why: an argv entry either *is* the path
	 * this host made up or it is the caller's own value, and a device path that merely
	 * shares a prefix with the staged one is the caller's — the one thing in the message it
	 * can act on.
	 */
	it('masks whole argv entries, not entries that merely share a prefix', async () => {
		fails({ code: 1 });

		const error = await failureOf(
			runAdb(['push', '/tmp/rover-abc', '/tmp/rover-abc-elsewhere'], {
				redactArgv: ['/tmp/rover-abc'],
			}),
		);

		expect(error.message).toContain('adb push <the file you sent> /tmp/rover-abc-elsewhere');
	});

	it('quotes the streams unchanged when there is nothing to redact', async () => {
		fails({ code: 1 }, 'out\n', 'err\n');

		const error = await failureOf(runAdb(['devices']));

		expect(error.message).toContain('stdout: out');
		expect(error.message).toContain('stderr: err');
	});
});

describe('runAdbOnDevice', () => {
	// The pin is the point of the function: an unpinned command landing on another
	// agent's device is the worst failure mode this tool has (PROJECT.md §2).
	it('puts -s <serial> ahead of the arguments it was given', async () => {
		answers('Physical size: 1080x2400\n');

		await runAdbOnDevice(SERIAL, ['shell', 'wm', 'size']);

		expect(execFileMock.mock.calls[0][1]).toEqual([
			'-s',
			'device-under-test',
			'shell',
			'wm',
			'size',
		]);
	});

	it('carries the serial into the error of a failed run', async () => {
		fails({ code: 1 }, '', "device 'device-under-test' not found\n");

		const error = await failureOf(runAdbOnDevice(SERIAL, ['shell', 'getprop']));

		expect(error.argv).toEqual(['-s', 'device-under-test', 'shell', 'getprop']);
		expect(error.message).toContain("device 'device-under-test' not found");
	});
});

/**
 * The capture path. It is a second function rather than an option on the runners above
 * for one reason, and it is the reason every assertion here is about: bytes that get
 * decoded as UTF-8 are gone, and the damage looks like a broken device rather than a
 * broken read.
 */
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('runAdbBinaryOnDevice', () => {
	it('hands back the bytes exactly as the process wrote them', async () => {
		// Every byte a UTF-8 decode would replace or a pty would translate, in ten bytes.
		const capture = Buffer.concat([PNG_HEAD, Buffer.from([0xff, 0xfe])]);
		answersBytes(capture);

		const result = await runAdbBinaryOnDevice(SERIAL, ['exec-out', 'screencap', '-p']);

		expect(Buffer.isBuffer(result.stdout)).toBe(true);
		expect(result.stdout.equals(capture)).toBe(true);
	});

	// The two options that make this path different from the text one, and the two whose
	// absence is silent: a decoded capture is unrecoverable, and an overflow kills the child.
	it('asks the process for bytes, with room for a whole frame', async () => {
		answersBytes(PNG_HEAD);

		await runAdbBinaryOnDevice(SERIAL, ['exec-out', 'screencap', '-p']);

		expect(execFileMock.mock.calls[0][2]).toMatchObject({
			encoding: 'buffer',
			maxBuffer: ADB_BINARY_MAX_BUFFER_BYTES,
			timeout: DEFAULT_ADB_TIMEOUT_MS,
		});
		expect(ADB_BINARY_MAX_BUFFER_BYTES).toBeGreaterThan(ADB_MAX_BUFFER_BYTES);
	});

	it('pins the capture to one device, ahead of the arguments it was given', async () => {
		answersBytes(PNG_HEAD);

		await runAdbBinaryOnDevice(SERIAL, ['exec-out', 'screencap', '-p']);

		expect(execFileMock.mock.calls[0][1]).toEqual([
			'-s',
			'device-under-test',
			'exec-out',
			'screencap',
			'-p',
		]);
	});

	// stderr is adb's own half of the conversation and is text on every call, whatever the
	// device sent back on the other stream.
	it('decodes stderr while leaving stdout alone', async () => {
		answersBytes(PNG_HEAD, '* daemon started successfully\n');

		const result = await runAdbBinaryOnDevice(SERIAL, ['exec-out', 'screencap', '-p']);

		expect(result.stderr).toBe('* daemon started successfully\n');
	});

	it('lets a caller widen the timeout for one capture', async () => {
		answersBytes(PNG_HEAD);

		await runAdbBinaryOnDevice(SERIAL, ['exec-out', 'screencap', '-p'], { timeoutMs: 30_000 });

		expect(execFileMock.mock.calls[0][2].timeout).toBe(30_000);
	});

	// A failure carries a *description* of stdout: there is no text to quote, and pasting a
	// megabyte of PNG into an error message corrupts the terminal that reads it.
	it('describes the bytes rather than quoting them when the run fails', async () => {
		execFileMock.mockImplementation((_file, _args, _options, callback) => {
			callback(
				Object.assign(new Error('adb failed'), { code: 1 }) as ExecFileException,
				PNG_HEAD,
				Buffer.from('error: closed\n'),
			);
		});

		const error = await failureOf(runAdbBinaryOnDevice(SERIAL, ['exec-out', 'screencap', '-p']));

		expect(error.exitCode).toBe(1);
		expect(error.message).toContain('8 bytes, starting 89 50 4e 47');
		expect(error.message).toContain('error: closed');
	});
});

describe('describeBytes', () => {
	it('names the length and the leading bytes that identify a stream', () => {
		expect(describeBytes(Buffer.concat([PNG_HEAD, Buffer.alloc(1_000)]))).toBe(
			'(1008 bytes, starting 89 50 4e 47 0d 0a 1a 0a)',
		);
	});

	it('reads no more than the first eight bytes', () => {
		expect(describeBytes(Buffer.from([0x01, 0x02]))).toBe('(2 bytes, starting 01 02)');
	});

	// A capture that never arrived is its own diagnosis, and `0 bytes, starting ` is not it.
	it('says so plainly when nothing came back at all', () => {
		expect(describeBytes(Buffer.alloc(0))).toBe('(empty)');
	});
});

/**
 * A stand-in for the child process: real streams, so the encoding and the chunking are the
 * ones Node would produce, and an emitter for the lifecycle events the runner listens to.
 */
class FakeChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly kill = vi.fn((): boolean => {
		// A killed child still goes through `close` — the runner must not resolve `stop()`
		// on the kill call itself.
		queueMicrotask(() => this.emit('close', null, 'SIGTERM'));
		return true;
	});
}

function spawns(): FakeChild {
	const child = new FakeChild();
	spawnMock.mockReturnValue(child);
	return child;
}

/** Lets every pending stream event land before the assertions read what arrived. */
async function settled(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe('streamAdb', () => {
	it('spawns adb with the arguments it was given, and never inherits stdin', () => {
		spawns();

		streamAdb(['track-devices', '-l'], { onStdout: vi.fn(), onEnd: vi.fn() });

		expect(spawnMock.mock.calls[0]?.[0]).toBe('adb');
		expect(spawnMock.mock.calls[0]?.[1]).toEqual(['track-devices', '-l']);
		expect(spawnMock.mock.calls[0]?.[2]).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
	});

	// Bytes, in order, undecoded: the framing counts bytes and a chunk boundary can fall
	// inside a character.
	it('hands stdout back as the chunks it arrived in', async () => {
		const child = spawns();
		const onStdout = vi.fn();
		streamAdb(['track-devices'], { onStdout, onEnd: vi.fn() });

		child.stdout.write(Buffer.from('0074emu'));
		child.stdout.write(Buffer.from('lator-5554'));
		await settled();

		expect(onStdout.mock.calls.map(([chunk]) => (chunk as Buffer).toString())).toEqual([
			'0074emu',
			'lator-5554',
		]);
		expect(Buffer.isBuffer(onStdout.mock.calls[0]?.[0])).toBe(true);
	});

	/**
	 * Exit 0 is an end like any other: on adb 37.0.1 a tracker whose server is killed exits
	 * 0 with an empty stderr (PROJECT.md §6). Reporting that as anything but an end is how
	 * a host goes blind and believes it is watching.
	 */
	it('reports a clean exit as an end, naming the command and the code', async () => {
		const child = spawns();
		const onEnd = vi.fn();
		streamAdb(['track-devices', '-l'], { onStdout: vi.fn(), onEnd });

		child.emit('close', 0, null);
		await settled();

		expect(onEnd).toHaveBeenCalledTimes(1);
		expect(onEnd.mock.calls[0]?.[0]).toContain('adb track-devices -l');
		expect(onEnd.mock.calls[0]?.[0]).toContain('ended with exit 0');
	});

	it('names the signal when the run was killed rather than exited', async () => {
		const child = spawns();
		const onEnd = vi.fn();
		streamAdb(['track-devices'], { onStdout: vi.fn(), onEnd });

		child.emit('close', null, 'SIGKILL');
		await settled();

		expect(onEnd.mock.calls[0]?.[0]).toContain('was killed by SIGKILL');
	});

	// adb absent from PATH never reaches `close` with a code — its own message is the only
	// thing that says what happened.
	it('reports a run that never started, with the reason node gave', async () => {
		const child = spawns();
		const onEnd = vi.fn();
		streamAdb(['track-devices'], { onStdout: vi.fn(), onEnd });

		child.emit('error', new Error('spawn adb ENOENT'));
		await settled();

		expect(onEnd).toHaveBeenCalledTimes(1);
		expect(onEnd.mock.calls[0]?.[0]).toContain('failed to run: spawn adb ENOENT');
	});

	it('ends exactly once when the run both errors and closes', async () => {
		const child = spawns();
		const onEnd = vi.fn();
		streamAdb(['track-devices'], { onStdout: vi.fn(), onEnd });

		child.emit('error', new Error('spawn adb ENOENT'));
		child.emit('close', null, null);
		await settled();

		expect(onEnd).toHaveBeenCalledTimes(1);
	});

	// The banner arrives on the tracker's stderr on the **success** path (PROJECT.md §6),
	// so stderr is context for the end reason and never a failure on its own.
	it('carries the stderr tail in the end reason', async () => {
		const child = spawns();
		const onEnd = vi.fn();
		streamAdb(['track-devices'], { onStdout: vi.fn(), onEnd });

		child.stderr.write('* daemon not running; starting now at tcp:5037\n');
		await settled();
		child.emit('close', 0, null);
		await settled();

		expect(onEnd.mock.calls[0]?.[0]).toContain('* daemon not running');
	});

	// It runs for as long as the host does, so what it keeps has to be bounded.
	it('keeps only the tail of a long-running stderr, and keeps the last of it', async () => {
		const child = spawns();
		const onEnd = vi.fn();
		streamAdb(['track-devices'], { onStdout: vi.fn(), onEnd });

		child.stderr.write('x'.repeat(ADB_STREAM_STDERR_TAIL_CHARS * 2));
		child.stderr.write('the last thing adb said');
		await settled();
		child.emit('close', 0, null);
		await settled();

		const reason = onEnd.mock.calls[0]?.[0] as string;
		expect(reason).toContain('the last thing adb said');
		expect(reason.length).toBeLessThan(ADB_STREAM_STDERR_TAIL_CHARS * 2);
	});

	it('says so plainly when the run ended having printed nothing', async () => {
		const child = spawns();
		const onEnd = vi.fn();
		streamAdb(['track-devices'], { onStdout: vi.fn(), onEnd });

		child.emit('close', 0, null);
		await settled();

		expect(onEnd.mock.calls[0]?.[0]).toContain('stderr: (empty)');
	});

	it('kills the child on stop, and resolves once it is gone', async () => {
		const child = spawns();
		const stream = streamAdb(['track-devices'], { onStdout: vi.fn(), onEnd: vi.fn() });

		await stream.stop();

		expect(child.kill).toHaveBeenCalledTimes(1);
	});

	// The contract's promise: no handler call after `stop()`. A caller that restarted on an
	// end reason it asked for would otherwise be handed one it can no longer act on.
	it('calls no handler after stop', async () => {
		const child = spawns();
		const onStdout = vi.fn();
		const onEnd = vi.fn();
		const stream = streamAdb(['track-devices'], { onStdout, onEnd });

		await stream.stop();
		child.stdout.write(Buffer.from('0000'));
		child.emit('close', 0, null);
		await settled();

		expect(onStdout).not.toHaveBeenCalled();
		expect(onEnd).not.toHaveBeenCalled();
	});

	it('is a no-op when stopped twice, or after the run already ended', async () => {
		const child = spawns();
		const stream = streamAdb(['track-devices'], { onStdout: vi.fn(), onEnd: vi.fn() });

		child.emit('close', 0, null);
		await settled();
		await stream.stop();
		await stream.stop();

		expect(child.kill).not.toHaveBeenCalled();
	});
});

/**
 * The two quoters, asserted together because the only thing worth getting wrong about
 * either is which one a call site should have used.
 *
 * Both produce a string the **device's** `sh` reads, so what is pinned is the exact
 * characters — not a round trip through a host shell, which is a different shell with
 * different rules. What the device does with these forms was measured on API 37 with adb
 * 37.0.0 and is recorded in PROJECT.md §6.
 */
describe('shellArg and shellText', () => {
	it('both wrap an ordinary value in single quotes', () => {
		expect(shellArg('com.android.settings')).toBe("'com.android.settings'");
		expect(shellText('hello world')).toBe("'hello world'");
	});

	/**
	 * The whole reason there are two. `shellArg` guards values whose shape was already
	 * checked, so an apostrophe there is a bug in that check and is refused; `shellText`
	 * carries screen content, where `don't` is ordinary and refusing it would be refusing
	 * the caller's data.
	 */
	it('differ on an apostrophe: one refuses it, the other splices it', () => {
		expect(() => shellArg("don't")).toThrow(/single quote/);
		expect(shellText("don't")).toBe("'don'\\''t'");
	});

	/**
	 * The splice is `'` → close the quote, hand the shell a backslashed quote, reopen.
	 * `input text 'don'\''t'` typed `don't` on the device; nothing else works, because a
	 * single-quoted string in `sh` has no escapes inside it at all.
	 */
	it('splices every apostrophe, not only the first', () => {
		expect(shellText("'a'b'")).toBe("''\\''a'\\''b'\\'''");
	});

	/**
	 * The injection this exists to prevent: `am force-stop 'com.rover.nope;echo INJECTED'`
	 * printed `INJECTED` on the device before `shellArg` landed (PROJECT.md §6). Text is the
	 * more exposed of the two — it is arbitrary by definition — so the metacharacters are
	 * asserted to come out inert rather than escaped away. All of them arrived verbatim in a
	 * field on API 37.
	 */
	it('makes shell metacharacters inert rather than removing them', () => {
		const text = 'a&b|c;d $e `f` "g" (h) *?[i]';

		expect(shellText(text)).toBe(`'${text}'`);
	});

	// Empty is a legal argument on both sides: `input text ''` exits 0 and types nothing.
	it('quotes an empty string as an empty word rather than nothing', () => {
		expect(shellText('')).toBe("''");
		expect(shellArg('')).toBe("''");
	});

	/**
	 * A newline is quoted rather than refused. `typeText` never sends one — `./input.js`
	 * rejects it, because `input text` drops it in silence — but that is a decision about
	 * what the *device command* accepts, and this function's job is only to keep the value
	 * one word. A quoter that also policed content would put the same rule in two places.
	 */
	it('keeps a newline inside the quoted word', () => {
		expect(shellText('a\nb')).toBe("'a\nb'");
	});
});
