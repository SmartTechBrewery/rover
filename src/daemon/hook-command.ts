/**
 * Running one declared hook command on the host (D13, `./project-hooks.ts`).
 *
 * **It lives here rather than in the verb layer, for `./frames.ts`'s reason.** `src/ipc/
 * verb-methods.ts` imports the verb schemas, so a `node:child_process` import anywhere under
 * `src/verbs/` would be a spawn in every client's module graph — the shape D19 rules out and
 * `tests/unit/daemon/remote-never-spawns.test.ts` gates. It is also why this is its own module
 * rather than part of `./restore.ts`: that one is imported by `./lease-handlers.ts`, and
 * `./project-hooks.ts` has to stay free of a spawn so anything may read a hook file.
 *
 * **A hook is foreign code the host runs with the daemon's own privileges**, so every part of
 * this is a bound rather than a courtesy: `shell: false` so nothing is word-split or
 * glob-expanded, an explicit timeout so a helper service that never exits cannot wedge the
 * restoration queued behind it, and a **tail** of the output rather than all of it, because a
 * hook is not a place to buffer a megabyte. Success is silent — a quiet teardown is the normal
 * one — and a failure is a named error carrying the exit code and that tail.
 */

import { spawn } from 'node:child_process';
import type { DeviceSerial } from '../core/ids.js';
import type { HookCommand } from './project-hooks.js';

/**
 * How long one hook command may run before it is killed and the failure says so.
 *
 * It is deliberately **below** `TEARDOWN_TIMEOUT_MS` (`./restore.ts`), and
 * `tests/unit/daemon/hook-command.test.ts` asserts that relationship rather than leaving it to
 * drift, the way `MAX_RECORDING_MS` is asserted against `MAX_ARTIFACT_BYTES`. The restorer's
 * bound is a bound on its *wait*: it cannot cancel a hook. So unless the child is killed first,
 * what the restorer advertises is a bound on how long it waits and on nothing else, and the
 * program keeps running against a device already handed to somebody else.
 */
export const HOOK_COMMAND_TIMEOUT_MS = 8_000;

/**
 * How much of a hook's output travels in a failure — the tail rather than the head, for the
 * reason `./frames.ts` keeps a tail: what it said last is what explains how it ended.
 */
export const HOOK_OUTPUT_TAIL_CHARS = 4096;

/** The name of the environment variable telling a hook which device its lease held. */
export const HOOK_SERIAL_ENV_VAR = 'ROVER_DEVICE_SERIAL';

/** The name of the environment variable telling a hook which project it is running for. */
export const HOOK_PROJECT_ENV_VAR = 'ROVER_PROJECT';

/**
 * A hook ran and did not succeed — a non-zero exit, a signal, or a program that never started
 * at all. Named rather than a bare `Error` so the restorer's warning can say which project's
 * hook it was and what the program itself reported.
 */
export class HookCommandFailedError extends Error {
	readonly project: string;
	readonly command: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	/** The last {@link HOOK_OUTPUT_TAIL_CHARS} characters the program wrote to stderr. */
	readonly stderr: string;

	constructor(options: {
		project: string;
		command: string;
		exitCode: number | null;
		signal: NodeJS.Signals | null;
		stderr: string;
		outcome: string;
	}) {
		super(
			`The '${options.project}' hook command '${options.command}' ${options.outcome}` +
				(options.stderr === '' ? '' : `: ${options.stderr}`),
		);
		this.name = 'HookCommandFailedError';
		this.project = options.project;
		this.command = options.command;
		this.exitCode = options.exitCode;
		this.signal = options.signal;
		this.stderr = options.stderr;
	}
}

/** What a hook is told about the lease that is ending, beyond what its own file declares. */
export interface HookCommandContext {
	readonly project: string;
	readonly serial: DeviceSerial;
	/**
	 * Defaults to {@link HOOK_COMMAND_TIMEOUT_MS}. A test seam in the spirit of
	 * `DeviceRestorerOptions.teardownTimeoutMs`, not a configuration surface — a real
	 * eight-second bound and a unit test cannot both be in the same run.
	 */
	readonly timeoutMs?: number;
}

/**
 * Run one hook command to completion. Resolves on exit 0 and says nothing.
 *
 * The child's environment is the daemon's own, then the hook's declared `env` over it, then the
 * two values a hook cannot know for itself: {@link HOOK_PROJECT_ENV_VAR} and
 * {@link HOOK_SERIAL_ENV_VAR}. The serial is there from the first phase of this row deliberately
 * — a teardown that cannot name the device it is undoing is the wrong shape to hand the phases
 * that follow.
 *
 * @throws HookCommandFailedError on a non-zero exit, a signal (the timeout's kill included), or
 *   a program that could not be started.
 */
export async function runHookCommand(
	hook: HookCommand,
	context: HookCommandContext,
): Promise<void> {
	const timeoutMs = context.timeoutMs ?? HOOK_COMMAND_TIMEOUT_MS;

	return new Promise<void>((resolve, reject) => {
		const child = spawn(hook.command, hook.args, {
			// Never a shell: what the file declares is a program and its arguments, and a shell
			// here would turn a stray metacharacter in any of them into a second command.
			shell: false,
			...(hook.cwd === undefined ? {} : { cwd: hook.cwd }),
			env: {
				...process.env,
				...hook.env,
				[HOOK_PROJECT_ENV_VAR]: context.project,
				[HOOK_SERIAL_ENV_VAR]: context.serial,
			},
			// stdin closed: a hook is not interactive, and one that reads from it would otherwise
			// wait for input nobody is going to send until its timeout fired.
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: timeoutMs,
			// The timeout must actually end the process, including one that ignores a polite ask.
			killSignal: 'SIGKILL',
		});

		let stderrTail = '';
		/** Set by whichever of the two endings arrives first; suppresses the other. */
		let settled = false;

		const fail = (
			exitCode: number | null,
			signal: NodeJS.Signals | null,
			outcome: string,
		): void => {
			if (settled) return;
			settled = true;
			reject(
				new HookCommandFailedError({
					project: context.project,
					command: hook.command,
					exitCode,
					signal,
					stderr: stderrTail,
					outcome,
				}),
			);
		};

		// Decoded by the streams themselves, so a chunk boundary inside a multi-byte character
		// cannot become a replacement character in the message a human reads.
		child.stdout.setEncoding('utf8');
		// Read and dropped. The pipe exists so a chatty hook cannot block on a full one; what it
		// wrote is the operator's own log to keep, not the daemon's to relay.
		child.stdout.on('data', () => {});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderrTail = `${stderrTail}${chunk}`.slice(-HOOK_OUTPUT_TAIL_CHARS);
		});

		child.on('error', (error: Error) => {
			// Nothing ran at all — the program absent from `PATH`, or a `cwd` that is not there.
			// The common one, and the one whose remedy is on the host rather than in the lease.
			fail(null, null, `could not be started — ${error.message}`);
		});
		child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			if (code === 0) {
				settled = true;
				resolve();
				return;
			}
			fail(code, signal, endOfRun(code, signal, timeoutMs));
		});
	});
}

/** How a run that did not succeed ended, in words a human reads before the stderr tail. */
function endOfRun(code: number | null, signal: NodeJS.Signals | null, timeoutMs: number): string {
	if (code !== null) return `exited ${code}`;
	if (signal !== null) {
		return `was killed by ${signal} — its ${timeoutMs}ms budget is the likely reason`;
	}
	return 'ended without an exit code';
}
