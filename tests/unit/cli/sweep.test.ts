/**
 * `rover sweep` against a real daemon on a real socket (§9.4, #238).
 *
 * `keep.test.ts`'s shape and its reasons: the daemon suite's real-socket exception
 * (`ai/TESTING.md`), `ROVER_SOCKET_PATH` pointing the CLI at the temp socket, and every root
 * inside one temp directory rather than `~/.rover` — which for the command that *deletes* an
 * archive is the least optional convention in this repository.
 *
 * What is asserted is the CLI's own three jobs and nothing the host already owns: the exit code
 * for each answer, the `--json` document, the two usage errors a command line can make, and the
 * one sentence a dry run must not leave to be inferred.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

let temp: TempSocket;
const running: RunningDaemon[] = [];
let logged: string[];
let errored: string[];

async function start(): Promise<void> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		keptTestsPath: temp.keptTestsPath,
		// A megabyte and a day, so one filed run is past both bounds. The shipped defaults are
		// the right defaults and the wrong fixture.
		retention: { budgetMb: 1, maxAgeDays: 1 },
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

/** One run directory past the age bound, holding one file. Named as the archive would name it. */
async function fileAnOldRun(testName = 'home-screen'): Promise<string> {
	const run = `${new Date(Date.now() - 40 * DAY_MS)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z')}-issue-1-abcd1234`;
	const path = join(temp.artifactsRoot, 'rover', testName, run);
	await mkdir(join(path, 'serial-1'), { recursive: true });
	await writeFile(join(path, 'serial-1', '001_screenshot.png'), 'x'.repeat(2048));
	return run;
}

beforeEach(async () => {
	temp = await createTempSocket();
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	logged = [];
	errored = [];
	vi.spyOn(console, 'log').mockImplementation((line: string) => logged.push(line));
	vi.spyOn(console, 'warn').mockImplementation((line: string) => errored.push(line));
	vi.spyOn(console, 'error').mockImplementation((line: string) => errored.push(line));
	await start();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	await removeTempSocket(temp);
});

describe('rover sweep', () => {
	it('exits 1 for a host with no archive at all', async () => {
		await expect(run(['sweep', '--actor', 'alice'])).resolves.toBe(EXIT_FAILED);

		expect(errored.join('\n')).toContain('no artifact archive');
	});

	it('names each deleted run by the components an archive listing named', async () => {
		const runName = await fileAnOldRun();

		await expect(run(['sweep', '--actor', 'alice'])).resolves.toBe(EXIT_OK);

		const output = logged.join('\n');
		expect(output).toContain('rover');
		expect(output).toContain('home-screen');
		expect(output).toContain(runName);
		expect(output).toContain('age');
	});

	/*
	 * **The dry run says nothing was deleted, in as many words.** Its table looks exactly like a
	 * real sweep's, so leaving that to be inferred from the flag the reader typed is the one
	 * confusion this command must not permit.
	 */
	it('says plainly that a dry run deleted nothing', async () => {
		await fileAnOldRun();

		await expect(run(['sweep', '--dry-run', '--actor', 'alice'])).resolves.toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('nothing was deleted');
		// And the run really is still there: a second question finds it again.
		logged = [];
		await expect(run(['sweep', '--dry-run', '--actor', 'alice'])).resolves.toBe(EXIT_OK);
		expect(logged.join('\n')).toContain('would delete 1 run');
	});

	it('prints one document with --json', async () => {
		await fileAnOldRun();

		await expect(run(['sweep', '--actor', 'alice', '--json'])).resolves.toBe(EXIT_OK);

		const document = JSON.parse(logged.join('\n')) as {
			host: string;
			outcome: string;
			runs: { project: string; bound: string }[];
		};
		expect(document.host).toBe('local');
		expect(document.outcome).toBe('swept');
		expect(document.runs[0]?.bound).toBe('age');
	});

	// `--actor` is never derived: a value this CLI invented would attribute the decision to
	// nobody (D20, D28).
	it('is a usage error with no --actor', async () => {
		await expect(run(['sweep'])).resolves.toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--actor');
	});

	it('is a usage error with a positional argument', async () => {
		await expect(run(['sweep', '--actor', 'alice', 'rover'])).resolves.toBe(EXIT_USAGE);
	});

	it('is a usage error with an unknown flag', async () => {
		await expect(run(['sweep', '--actor', 'alice', '--force'])).resolves.toBe(EXIT_USAGE);
	});

	it('prints its own usage with --help, and exits 0', async () => {
		await expect(run(['sweep', '--help'])).resolves.toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('rover sweep');
		// The dry run leads the text: it is the form to run first.
		expect(logged.join('\n')).toContain('--dry-run');
	});

	/*
	 * **A component's control characters are escaped, as `rover keep`'s table escapes them.** A
	 * name the host answered with may legally carry an ESC, and a rendered table whose columns
	 * are measured must not be broken — or an operator's terminal cleared — by one.
	 */
	it('escapes control characters in a component', async () => {
		await fileAnOldRun(`home${String.fromCharCode(27)}[2Jscreen`);

		await expect(run(['sweep', '--actor', 'alice'])).resolves.toBe(EXIT_OK);

		expect(logged.join('\n')).not.toContain(String.fromCharCode(27));
		expect(logged.join('\n')).toContain('\\x1b');
	});
});
