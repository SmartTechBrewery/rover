import type { ExecFileException } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
	ADB_MAX_BUFFER_BYTES,
	AdbCommandError,
	DEFAULT_ADB_TIMEOUT_MS,
	runAdb,
	runAdbOnDevice,
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
type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;
type ExecFileCall = [
	file: string,
	args: readonly string[],
	options: { timeout?: number; maxBuffer?: number; encoding?: string },
	callback: ExecFileCallback,
];

const { execFileMock } = vi.hoisted(() => ({
	execFileMock: vi.fn<(...call: ExecFileCall) => void>(),
}));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const SERIAL = parseDeviceSerial('device-under-test');

function answers(stdout: string, stderr = ''): void {
	execFileMock.mockImplementation((_file, _args, _options, callback) => {
		callback(null, stdout, stderr);
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
