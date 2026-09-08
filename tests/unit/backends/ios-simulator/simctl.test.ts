import type { ExecFileException } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_SIMCTL_TIMEOUT_MS,
	quoteStream,
	runSimctl,
	runSimctlOnDevice,
	SIMCTL_MAX_BUFFER_BYTES,
	SimctlCommandError,
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

const { execFileMock, resolveDeveloperDirMock } = vi.hoisted(() => ({
	execFileMock: vi.fn<(...call: ExecFileCall) => void>(),
	resolveDeveloperDirMock: vi.fn<() => string>(),
}));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
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
	 */
	it('refuses the literal booted selector and says why, without running anything', async () => {
		answers('');

		await expect(
			runSimctlOnDevice(parseDeviceSerial('booted'), 'terminate', ['com.rover.nope']),
		).rejects.toThrow(/simctl choosing one of the booted ones/);
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it('passes a widened timeout through to the process', async () => {
		answers('');

		await runSimctlOnDevice(SERIAL, 'install', ['/tmp/Rover.app'], { timeoutMs: 300_000 });

		expect(execFileMock.mock.calls[0][2].timeout).toBe(300_000);
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

	// A successful `simctl io` writes an informational note here, so an inner newline is
	// ordinary content and is left alone.
	it('keeps the shape of a multi-line stream', () => {
		expect(quoteStream('Detected file type from extension: PNG\nNote: No display\n')).toBe(
			'Detected file type from extension: PNG\nNote: No display',
		);
	});
});
