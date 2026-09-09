/**
 * `rover delete-test` against a real daemon on a real socket (D43, #272).
 *
 * `delete-project.test.ts`'s shape and its reasons: the daemon suite's real-socket exception
 * (ai/TESTING.md), `ROVER_SOCKET_PATH` pointing the CLI at the temp socket rather than a
 * `--socket` flag nobody needs, and every root inside one `mkdtemp` rather than `~/.rover` —
 * which for a command whose job is **deletion** is not a convention to bend.
 *
 * What is asserted is the CLI's own three jobs and nothing the host already owns: the sentence per
 * outcome, the exit code per outcome, the `--json` document, and the usage errors a command line
 * can make.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDeleteArchivedTest } from '@/cli/commands/delete-test.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import { readKeptTests, writeKeptTests } from '@/daemon/kept-tests.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

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
		retention: temp.retention,
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

beforeEach(async () => {
	temp = await createTempSocket();
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	vi.stubEnv('ROVER_KEPT_TESTS_PATH', temp.keptTestsPath);
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

async function fileARun(project: string, testName: string, bytes: number): Promise<void> {
	const path = join(
		temp.artifactsRoot,
		project,
		testName,
		'20260901T101010Z-issue-1-abcd1234',
		'serial-1',
	);
	await mkdir(path, { recursive: true });
	await writeFile(join(path, '001_screenshot.png'), 'x'.repeat(bytes));
}

describe('rover delete-test', () => {
	it('deletes a test, says what went, and exits 0', async () => {
		await fileARun('checkout-web', 'home-screen', 1024);
		await fileARun('checkout-web', 'login-flow', 512);
		await writeKeptTests(temp.keptTestsPath, [
			{
				project: 'checkout-web',
				testName: 'home-screen',
				keptBy: 'bob',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
		]);

		await expect(
			run(['delete-test', 'checkout-web', 'home-screen', '--actor', 'alice']),
		).resolves.toBe(EXIT_OK);

		const said = logged.join('\n');
		expect(said).toContain("deleted 'checkout-web/home-screen'");
		expect(said).toContain('1024 bytes freed');
		// The one thing about this command somebody could be surprised by, said out loud.
		expect(said).toContain('1 kept test removed');
		await expect(
			stat(join(temp.artifactsRoot, 'checkout-web', 'home-screen')),
		).rejects.toMatchObject({ code: 'ENOENT' });
		// And the sibling test is untouched, which is the whole point of the finer address.
		await expect(
			stat(join(temp.artifactsRoot, 'checkout-web', 'login-flow')),
		).resolves.toBeDefined();
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([]);
	});

	it('prints no path on this host, because none is answered', async () => {
		await fileARun('checkout-web', 'home-screen', 512);

		await expect(
			run(['delete-test', 'checkout-web', 'home-screen', '--actor', 'alice']),
		).resolves.toBe(EXIT_OK);

		// The host answers components and counts; where its archive lives is not the client's to
		// know (D19), and there is no field it could arrive in.
		expect(logged.join('\n')).not.toContain(temp.dir);
	});

	it('exits 1 for a test this host has nothing for', async () => {
		await expect(
			run(['delete-test', 'never-filed', 'never-run', '--actor', 'alice']),
		).resolves.toBe(EXIT_FAILED);

		// Deliberately not a success that removed nothing — the four answers are four next moves.
		expect(errored.join('\n')).toContain('has nothing for');
	});

	it('exits 1 on a partial delete and says what is still there', async () => {
		await fileARun('checkout-web', 'home-screen', 512);
		// A store that will not parse is never overwritten, so one half refuses to go.
		await writeFile(temp.keptTestsPath, '{ not json', 'utf8');

		await expect(
			run(['delete-test', 'checkout-web', 'home-screen', '--actor', 'alice']),
		).resolves.toBe(EXIT_FAILED);

		expect(errored.join('\n')).toContain('only partly deleted');
		expect(errored.join('\n')).toContain('NOT removed');
	});

	it('prints the host’s answer verbatim with --json', async () => {
		await fileARun('checkout-web', 'home-screen', 256);

		await expect(
			run(['delete-test', 'checkout-web', 'home-screen', '--actor', 'alice', '--json']),
		).resolves.toBe(EXIT_OK);

		// `printJson` adds the one `host` key beside the host's own answer, which is every
		// command's document shape.
		expect(JSON.parse(logged.join('\n'))).toEqual({
			host: 'local',
			outcome: 'deleted',
			archive: 'removed',
			keptTests: 'absent',
			freedBytes: 256,
			keptTestsRemoved: 0,
		});
	});

	it('prints its own usage for --help, and asks no host', async () => {
		expect(await run(['delete-test', '--help'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('Usage: rover delete-test');
		// The surprising thing is in the usage text rather than in a prompt.
		expect(logged.join('\n')).toContain('rover keep');
	});

	it('is listed in the top-level command list', async () => {
		expect(await run(['--help'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('delete-test <project> <test-name>');
	});
});

describe('the sentence each outcome gets', () => {
	/*
	 * The renderer directly for the outcome this suite cannot stage over a socket without a
	 * device: a live lease needs a backend and an acquire, and what is being asserted is the
	 * client's own wording — that each of the four answers reads as a different next move, which
	 * is the whole reason the host answers four.
	 */
	it('names the next move for a lease that is live', () => {
		const said = renderDeleteArchivedTest('local', 'checkout-web', 'home-screen', {
			outcome: 'refused',
			reason: 'lease-live',
		});

		expect(said).toContain('a lease filing into it is live');
		expect(said).toContain('nothing was touched');
		expect(said).toContain('force-release');
	});

	it('escapes both components the way every other echoed value is escaped', () => {
		const said = renderDeleteArchivedTest('local', 'checkout\nweb', 'home\nscreen', {
			outcome: 'not-found',
		});

		// A name a host answered still goes through `escapeControlCharacters`, as `rover keep`'s
		// table does: a newline in an echoed value could otherwise forge a line of output.
		expect(said).not.toContain('checkout\nweb');
		expect(said).not.toContain('home\nscreen');
	});
});

describe('the usage errors a command line can make', () => {
	it('exits 2 without --actor, which is never derived', async () => {
		await fileARun('checkout-web', 'home-screen', 512);

		await expect(run(['delete-test', 'checkout-web', 'home-screen'])).resolves.toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--actor');
		// And nothing was deleted on the way to that refusal.
		await expect(
			stat(join(temp.artifactsRoot, 'checkout-web', 'home-screen')),
		).resolves.toBeDefined();
	});

	it('exits 2 with only one of the two components named', async () => {
		await expect(run(['delete-test', 'checkout-web', '--actor', 'alice'])).resolves.toBe(
			EXIT_USAGE,
		);

		expect(errored.join('\n')).toContain('<project> <test-name>');
	});

	it('exits 2 on an attribution string past what the host accepts', async () => {
		await fileARun('checkout-web', 'home-screen', 512);

		await expect(
			run(['delete-test', 'checkout-web', 'home-screen', '--actor', 'a'.repeat(1000)]),
		).resolves.toBe(EXIT_USAGE);

		await expect(
			stat(join(temp.artifactsRoot, 'checkout-web', 'home-screen')),
		).resolves.toBeDefined();
	});
});
