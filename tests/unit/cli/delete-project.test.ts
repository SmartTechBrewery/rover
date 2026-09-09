/**
 * `rover delete-project` against a real daemon on a real socket (D42, #271).
 *
 * `keep.test.ts`'s shape and its reasons: the daemon suite's real-socket exception
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
import { renderDeleteProject } from '@/cli/commands/delete-project.js';
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

async function register(project: string): Promise<void> {
	await mkdir(temp.projectsRoot, { recursive: true });
	await writeFile(join(temp.projectsRoot, `${project}.json`), JSON.stringify({ project }), 'utf8');
}

async function fileARun(project: string, bytes: number): Promise<void> {
	const path = join(
		temp.artifactsRoot,
		project,
		'home-screen',
		'20260901T101010Z-issue-1-abcd1234',
		'serial-1',
	);
	await mkdir(path, { recursive: true });
	await writeFile(join(path, '001_screenshot.png'), 'x'.repeat(bytes));
}

describe('rover delete-project', () => {
	it('deletes a project, says what went, and exits 0', async () => {
		await register('checkout-web');
		await fileARun('checkout-web', 1024);
		await writeKeptTests(temp.keptTestsPath, [
			{
				project: 'checkout-web',
				testName: 'home-screen',
				keptBy: 'bob',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
		]);

		await expect(run(['delete-project', 'checkout-web', '--actor', 'alice'])).resolves.toBe(
			EXIT_OK,
		);

		const said = logged.join('\n');
		expect(said).toContain("deleted 'checkout-web'");
		expect(said).toContain('1024 bytes freed');
		// The one thing about this command somebody could be surprised by, said out loud.
		expect(said).toContain('1 kept test removed');
		await expect(stat(join(temp.projectsRoot, 'checkout-web.json'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([]);
	});

	it('prints no path on this host, because none is answered', async () => {
		await register('checkout-web');
		await fileARun('checkout-web', 512);

		await expect(run(['delete-project', 'checkout-web', '--actor', 'alice'])).resolves.toBe(
			EXIT_OK,
		);

		// The host answers identifiers and counts; where its archive lives is not the client's to
		// know (D19), and there is no field it could arrive in.
		expect(logged.join('\n')).not.toContain(temp.dir);
	});

	it('exits 1 for a project this host has nothing for', async () => {
		await expect(run(['delete-project', 'never-registered', '--actor', 'alice'])).resolves.toBe(
			EXIT_FAILED,
		);

		// Deliberately not a success that removed nothing — the four answers are four next moves.
		expect(errored.join('\n')).toContain('has nothing for');
	});

	it('exits 1 on a partial delete and says what is still there', async () => {
		await register('checkout-web');
		// A store that will not parse is never overwritten, so one half refuses to go.
		await writeFile(temp.keptTestsPath, '{ not json', 'utf8');

		await expect(run(['delete-project', 'checkout-web', '--actor', 'alice'])).resolves.toBe(
			EXIT_FAILED,
		);

		expect(errored.join('\n')).toContain('only partly deleted');
		expect(errored.join('\n')).toContain('NOT removed');
	});

	it('prints the host’s answer verbatim with --json', async () => {
		await register('checkout-web');

		await expect(
			run(['delete-project', 'checkout-web', '--actor', 'alice', '--json']),
		).resolves.toBe(EXIT_OK);

		// `printJson` adds the one `host` key beside the host's own answer, which is every
		// command's document shape.
		expect(JSON.parse(logged.join('\n'))).toEqual({
			host: 'local',
			outcome: 'deleted',
			registration: 'removed',
			archive: 'absent',
			keptTests: 'absent',
			freedBytes: 0,
			keptTestsRemoved: 0,
		});
	});
});

describe('the sentence each outcome gets', () => {
	/*
	 * The renderer directly for the two answers this suite cannot stage over a socket without a
	 * device: a live lease needs a backend and an acquire, and what is being asserted is the
	 * client's own wording — that each of the four answers reads as a different next move, which
	 * is the whole reason the host answers four.
	 */
	it('names the next move for a lease that is live', () => {
		const said = renderDeleteProject('local', 'checkout-web', {
			outcome: 'refused',
			reason: 'lease-live',
		});

		expect(said).toContain('a lease on it is live');
		expect(said).toContain('nothing was touched');
		expect(said).toContain('force-release');
	});

	it('escapes an identifier the way every other echoed value is escaped', () => {
		const said = renderDeleteProject('local', 'checkout\nweb', { outcome: 'not-registered' });

		// A name a host answered still goes through `escapeControlCharacters`, as `rover keep`'s
		// table does: a newline in an echoed value could otherwise forge a line of output.
		expect(said).not.toContain('checkout\nweb');
	});
});

describe('the usage errors a command line can make', () => {
	it('exits 2 without --actor, which is never derived', async () => {
		await register('checkout-web');

		await expect(run(['delete-project', 'checkout-web'])).resolves.toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--actor');
		// And nothing was deleted on the way to that refusal.
		await expect(stat(join(temp.projectsRoot, 'checkout-web.json'))).resolves.toBeDefined();
	});

	it('exits 2 with no project named', async () => {
		await expect(run(['delete-project', '--actor', 'alice'])).resolves.toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('<project>');
	});

	it('exits 2 on an attribution string past what the host accepts', async () => {
		await register('checkout-web');

		await expect(
			run(['delete-project', 'checkout-web', '--actor', 'a'.repeat(1000)]),
		).resolves.toBe(EXIT_USAGE);

		await expect(stat(join(temp.projectsRoot, 'checkout-web.json'))).resolves.toBeDefined();
	});
});
