/**
 * Running one declared hook command (D13, R17) — against real, short-lived child processes.
 *
 * Real processes rather than a mocked `spawn`, because every property this module exists for
 * is a property of the process: that an argument is one argument and not a second command,
 * that a program which never exits is killed rather than waited on, that the two things a hook
 * cannot know for itself reach its environment, and that a failure comes back named rather than
 * as an unhandled rejection. A mock would assert the options object and none of that.
 *
 * Every child here is `process.execPath -e …`, which exists wherever this suite runs, and every
 * one of them exits in milliseconds. Nothing waits out a real bound: the timeout case passes a
 * few milliseconds through the runner's own seam.
 */

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDeviceSerial } from '@/core/ids.js';
import {
	HOOK_COMMAND_TIMEOUT_MS,
	HOOK_OUTPUT_TAIL_CHARS,
	HookCommandFailedError,
	runHookCommand,
} from '@/daemon/hook-command.js';
import type { HookCommand } from '@/daemon/project-hooks.js';
import { TEARDOWN_TIMEOUT_MS } from '@/daemon/restore.js';

const SERIAL = parseDeviceSerial('attached-1');
const PROJECT = 'checkout-web';
const CONTEXT = { project: PROJECT, serial: SERIAL };

/** Everything the child can see about how it was started, written where the test can read it. */
const REPORT_SOURCE =
	"require('node:fs').writeFileSync(process.argv[1], JSON.stringify({" +
	'project: process.env.ROVER_PROJECT,' +
	'serial: process.env.ROVER_DEVICE_SERIAL,' +
	'stage: process.env.STAGE,' +
	'onPath: process.env.PATH !== undefined,' +
	'cwd: process.cwd(),' +
	'argv: process.argv.slice(2),' +
	'}))';

interface Report {
	readonly project: string;
	readonly serial: string;
	readonly stage: string;
	readonly onPath: boolean;
	readonly cwd: string;
	readonly argv: string[];
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'rover-hook-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A hook running `node -e <source>`, with everything after it handed to the child. */
function nodeHook(source: string, args: string[] = []): HookCommand {
	return { command: process.execPath, args: ['-e', source, ...args], env: {} };
}

async function failureOf(hook: HookCommand, timeoutMs?: number): Promise<HookCommandFailedError> {
	const error = await runHookCommand(hook, {
		...CONTEXT,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(HookCommandFailedError);
	return error as HookCommandFailedError;
}

describe('a hook that succeeds', () => {
	it('resolves, and says nothing at all', async () => {
		await expect(runHookCommand(nodeHook(''), CONTEXT)).resolves.toBeUndefined();
	});

	it('tells the child which project and which device, and honours its own env and cwd', async () => {
		const marker = join(dir, 'report.json');
		const hook: HookCommand = {
			...nodeHook(REPORT_SOURCE, [marker]),
			env: { STAGE: 'local' },
			cwd: dir,
		};

		await runHookCommand(hook, CONTEXT);

		const report = JSON.parse(await readFile(marker, 'utf8')) as Report;
		// The serial from the first phase deliberately: a teardown that cannot name the device
		// it is undoing is the wrong shape to hand the phases after this one.
		expect(report.serial).toBe(SERIAL);
		expect(report.project).toBe(PROJECT);
		// The hook's own declared environment, over the daemon's — which is still there.
		expect(report.stage).toBe('local');
		expect(report.onPath).toBe(true);
		expect(report.cwd).toBe(await realpath(dir));
	});

	it('passes an argument as one argument, whatever is in it', async () => {
		const marker = join(dir, 'report.json');
		const hostile = '$(touch pwned) && rm -rf * ; echo *';
		const hook: HookCommand = {
			...nodeHook(REPORT_SOURCE, [marker, hostile]),
			cwd: dir,
		};

		await runHookCommand(hook, CONTEXT);

		// `shell: false`: nothing a hook file declares is word-split, glob-expanded or read as a
		// second command. An operator who wants a shell makes the shell the program.
		const report = JSON.parse(await readFile(marker, 'utf8')) as Report;
		expect(report.argv).toEqual([hostile]);
	});
});

describe('a hook that fails', () => {
	it('names the project, the exit code and what the program said last', async () => {
		const failure = await failureOf(
			nodeHook("process.stderr.write('the helper service was already gone'); process.exit(3)"),
		);

		expect(failure.exitCode).toBe(3);
		expect(failure.signal).toBeNull();
		expect(failure.project).toBe(PROJECT);
		expect(failure.message).toContain(PROJECT);
		expect(failure.message).toContain('exited 3');
		expect(failure.stderr).toBe('the helper service was already gone');
	});

	it('carries the tail of a chatty program rather than all of it', async () => {
		const failure = await failureOf(
			nodeHook(
				`process.stderr.write('x'.repeat(${HOOK_OUTPUT_TAIL_CHARS * 3}) + 'THE-LAST-WORD');` +
					'process.exit(1)',
			),
		);

		// The tail rather than the head: what it said last is what explains how it ended, and a
		// failure is not a place to put a megabyte somebody has to render.
		expect(failure.stderr.length).toBeLessThanOrEqual(HOOK_OUTPUT_TAIL_CHARS);
		expect(failure.stderr.endsWith('THE-LAST-WORD')).toBe(true);
	});

	it('kills a program that never exits, and says the budget is why', async () => {
		// A helper service that does not stop when it is asked. The bound is passed through the
		// runner's own seam, so nothing here waits out the real one.
		const failure = await failureOf(nodeHook('setInterval(() => {}, 1000)'), 25);

		expect(failure.exitCode).toBeNull();
		expect(failure.signal).toBe('SIGKILL');
		expect(failure.message).toContain('25ms budget');
	});

	it('reports a program that is not there as a named failure, not a rejection nobody caught', async () => {
		const failure = await failureOf({
			command: join(dir, 'no-such-program'),
			args: [],
			env: {},
		});

		expect(failure.exitCode).toBeNull();
		expect(failure.message).toContain('could not be started');
	});
});

describe('the two bounds around one teardown', () => {
	it('kills the child before the restorer stops waiting for it', async () => {
		// Asserted rather than left to drift, the way `MAX_RECORDING_MS` is asserted against
		// `MAX_ARTIFACT_BYTES`. The restorer cannot cancel a hook — it only stops waiting — so
		// unless the child is killed first, its advertised bound is a bound on the wait and on
		// nothing else, and the program runs on against a device already handed to somebody else.
		expect(HOOK_COMMAND_TIMEOUT_MS).toBeLessThan(TEARDOWN_TIMEOUT_MS);
	});
});
