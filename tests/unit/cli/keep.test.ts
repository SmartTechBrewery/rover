/**
 * `rover keep` against a real daemon on a real socket (D33, #234).
 *
 * `commands.test.ts`'s shape and its reasons: the daemon suite's real-socket exception
 * (ai/TESTING.md), `ROVER_SOCKET_PATH` pointing the CLI at the temp socket rather than a
 * `--socket` flag nobody needs, and the store in the temp directory rather than
 * `~/.rover/kept-tests.json`, which belongs to whoever is running the tests — and which this
 * command *writes*.
 *
 * What is asserted is the CLI's own three jobs and nothing the host already owns: the exit code
 * for each answer, the `--json` document, and the two usage errors a command line can make.
 */

import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
	// The store the *daemon* uses is passed to `startDaemon`; this points the environment at the
	// same file so nothing in this suite can reach the developer's own.
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

describe('rover keep list', () => {
	it('says a host keeps nothing, and exits 0', async () => {
		await expect(run(['keep', 'list'])).resolves.toBe(EXIT_OK);

		// An empty answer is a host that keeps nothing, which is not a failure.
		expect(logged.join('\n')).toContain('keeps no archived tests');
	});

	it('names each kept test as the pair the archive filed', async () => {
		await writeKeptTests(temp.keptTestsPath, [
			{
				project: 'rover',
				testName: 'home-screen',
				keptBy: 'alice',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
		]);

		await expect(run(['keep', 'list'])).resolves.toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('rover');
		expect(logged.join('\n')).toContain('home-screen');
	});

	it('prints the result document with --json', async () => {
		await expect(run(['keep', 'list', '--json'])).resolves.toBe(EXIT_OK);

		// `printJson` adds the one `host` key beside the host's own answer, which is every
		// command's document shape.
		expect(JSON.parse(logged.join('\n'))).toEqual({
			host: 'local',
			outcome: 'listed',
			tests: [],
		});
	});
});

describe('rover keep add and remove', () => {
	it('keeps a test and then stops keeping it, exiting 0 for each', async () => {
		await expect(run(['keep', 'add', 'rover', 'home-screen', '--actor', 'alice'])).resolves.toBe(
			EXIT_OK,
		);
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toMatchObject([
			{ project: 'rover', testName: 'home-screen', keptBy: 'alice' },
		]);

		await expect(run(['keep', 'remove', 'rover', 'home-screen', '--actor', 'alice'])).resolves.toBe(
			EXIT_OK,
		);
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([]);
	});

	it('prints the whole set back with --json, so no second request is needed', async () => {
		await expect(
			run(['keep', 'add', 'rover', 'home-screen', '--actor', 'alice', '--json']),
		).resolves.toBe(EXIT_OK);

		expect(JSON.parse(logged.join('\n'))).toEqual({
			host: 'local',
			outcome: 'set',
			tests: [{ project: 'rover', testName: 'home-screen' }],
		});
	});

	it('exits 1 when the host will not write its own record', async () => {
		// A store that will not parse is never overwritten, so the write does not happen.
		await writeFile(temp.keptTestsPath, '{ not json', 'utf8');

		await expect(run(['keep', 'add', 'rover', 'home-screen', '--actor', 'alice'])).resolves.toBe(
			EXIT_FAILED,
		);
		expect(errored.join('\n')).toContain('did not write');
	});
});

describe('the usage errors a command line can make', () => {
	it('exits 2 without --actor, which is never derived', async () => {
		await expect(run(['keep', 'add', 'rover', 'home-screen'])).resolves.toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--actor');
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([]);
	});

	it('exits 2 on an unknown subcommand', async () => {
		await expect(run(['keep', 'prune'])).resolves.toBe(EXIT_USAGE);

		// In particular `prune`: nothing prunes the archive, and this command must not read as
		// though something did (`PROJECT.md` §9.4).
		expect(errored.join('\n')).toContain("unknown subcommand 'prune'");
	});

	it('exits 2 on an argument that is a path rather than a component', async () => {
		await expect(run(['keep', 'add', 'rover/home-screen', 'x', '--actor', 'alice'])).resolves.toBe(
			EXIT_USAGE,
		);

		expect(errored.join('\n')).toContain('never a path');
	});

	it('exits 2 when --actor is given to the read, which attributes nothing', async () => {
		await expect(run(['keep', 'list', '--actor', 'alice'])).resolves.toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--actor');
	});
});
