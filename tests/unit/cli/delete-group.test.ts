/**
 * `rover delete-group` against a real daemon on a real socket (D43, #277).
 *
 * `delete-test.test.ts`'s shape and its reasons: the daemon suite's real-socket exception
 * (ai/TESTING.md), `ROVER_SOCKET_PATH` pointing the CLI at the temp socket rather than a `--socket`
 * flag nobody needs, and every root inside one `mkdtemp` rather than `~/.rover` — which for a
 * command whose job is **deletion** is not a convention to bend.
 *
 * What is asserted is the CLI's own three jobs and nothing the host already owns: the sentence per
 * outcome, the exit code per outcome, the `--json` document, and the usage errors a command line can
 * make. The one thing this command's usage text has to carry that no other does is the pair a reader
 * could get wrong — *only the runs of this group go*, and *a test emptied by it is removed, kept
 * flag and all* — so that pair is asserted rather than assumed.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDeleteArchivedGroup } from '@/cli/commands/delete-group.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import { readKeptTests, writeKeptTests } from '@/daemon/kept-tests.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

const GROUP = 'app-bar-top-space';
const OTHER_GROUP = 'basket-total';

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

/** One run of one group, filed under `<project>/<test_name>/<run>/<serial>` as the archive does. */
async function fileAGroupedRun(
	project: string,
	testName: string,
	run: string,
	groupId: string | null,
	bytes: number,
): Promise<void> {
	const path = join(temp.artifactsRoot, project, testName, run, 'serial-1');
	await mkdir(path, { recursive: true });
	await writeFile(join(path, '001_screenshot.png'), 'x'.repeat(bytes));
	if (groupId !== null) {
		await writeFile(join(path, 'group_id.json'), JSON.stringify({ groupId }));
	}
}

describe('rover delete-group', () => {
	it('deletes the group’s runs, says what went, and exits 0', async () => {
		// One group across two tests, plus a run of another group under one of them.
		await fileAGroupedRun('checkout-web', 'home-screen', '20260901T101010Z-i-aaaaaaaa', GROUP, 512);
		await fileAGroupedRun('checkout-web', 'login-flow', '20260902T101010Z-i-bbbbbbbb', GROUP, 256);
		await fileAGroupedRun(
			'checkout-web',
			'login-flow',
			'20260903T101010Z-i-cccccccc',
			OTHER_GROUP,
			128,
		);
		await writeKeptTests(temp.keptTestsPath, [
			{
				project: 'checkout-web',
				testName: 'home-screen',
				keptBy: 'bob',
				keptAt: '2026-09-01T00:00:00.000Z',
			},
		]);

		await expect(run(['delete-group', 'checkout-web', GROUP, '--actor', 'alice'])).resolves.toBe(
			EXIT_OK,
		);

		const said = logged.join('\n');
		expect(said).toContain(`deleted the runs of 'checkout-web/${GROUP}'`);
		expect(said).toContain('2 runs removed');
		// The one thing about this command somebody could be surprised by, said out loud.
		expect(said).toContain('1 kept test removed');
		expect(said).toContain('are untouched');
		// The test its last run emptied is gone with its kept entry.
		await expect(
			stat(join(temp.artifactsRoot, 'checkout-web', 'home-screen')),
		).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([]);
		// And the test still holding another group's run is exactly where it was.
		await expect(
			stat(join(temp.artifactsRoot, 'checkout-web', 'login-flow', '20260903T101010Z-i-cccccccc')),
		).resolves.toBeDefined();
	});

	/*
	 * **A test left standing keeps its `Keep`** — the half of D43's surgical reading a reader of
	 * this command would otherwise have to trust, and the one the usage text promises.
	 */
	it('leaves a test that still holds runs kept, and says no emptied test was kept', async () => {
		await fileAGroupedRun('checkout-web', 'login-flow', '20260901T101010Z-i-aaaaaaaa', GROUP, 512);
		await fileAGroupedRun('checkout-web', 'login-flow', '20260902T101010Z-i-bbbbbbbb', null, 256);
		const kept = {
			project: 'checkout-web',
			testName: 'login-flow',
			keptBy: 'bob',
			keptAt: '2026-09-01T00:00:00.000Z',
		};
		await writeKeptTests(temp.keptTestsPath, [kept]);

		await expect(run(['delete-group', 'checkout-web', GROUP, '--actor', 'alice'])).resolves.toBe(
			EXIT_OK,
		);

		expect(logged.join('\n')).toContain('no emptied test was kept');
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([kept]);
	});

	it('prints no path on this host, because none is answered', async () => {
		await fileAGroupedRun('checkout-web', 'home-screen', '20260901T101010Z-i-aaaaaaaa', GROUP, 512);

		await expect(run(['delete-group', 'checkout-web', GROUP, '--actor', 'alice'])).resolves.toBe(
			EXIT_OK,
		);

		// The host answers components and counts; where its archive lives is not the client's to
		// know (D19), and there is no field it could arrive in.
		expect(logged.join('\n')).not.toContain(temp.dir);
	});

	it('exits 1 for a group no run of this project named', async () => {
		await expect(run(['delete-group', 'never-filed', GROUP, '--actor', 'alice'])).resolves.toBe(
			EXIT_FAILED,
		);

		// Deliberately not a success that removed nothing — the four answers are four next moves.
		expect(errored.join('\n')).toContain('has no run of');
	});

	it('prints the host’s answer verbatim with --json', async () => {
		await fileAGroupedRun('checkout-web', 'home-screen', '20260901T101010Z-i-aaaaaaaa', GROUP, 256);

		await expect(
			run(['delete-group', 'checkout-web', GROUP, '--actor', 'alice', '--json']),
		).resolves.toBe(EXIT_OK);

		// `printJson` adds the one `host` key beside the host's own answer, which is every
		// command's document shape — and `runsRemoved` is the field only this row has.
		expect(JSON.parse(logged.join('\n'))).toEqual({
			host: 'local',
			outcome: 'deleted',
			archive: 'removed',
			keptTests: 'absent',
			freedBytes: 256 + JSON.stringify({ groupId: GROUP }).length,
			keptTestsRemoved: 0,
			runsRemoved: 1,
		});
	});

	it('prints its own usage for --help, and asks no host', async () => {
		expect(await run(['delete-group', '--help'])).toBe(EXIT_OK);

		const usage = logged.join('\n');
		expect(usage).toContain('Usage: rover delete-group');
		// The two things a reader could get wrong, in the usage text rather than in a prompt.
		expect(usage).toContain('Only the runs of this group go');
		expect(usage).toContain('kept flag and all');
	});

	it('is listed in the top-level command list', async () => {
		expect(await run(['--help'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('delete-group <project> <group-id>');
	});
});

describe('the sentence each outcome gets', () => {
	/*
	 * The renderer directly for the two outcomes this suite cannot stage over a socket: a live lease
	 * needs a backend and an acquire, and a `partial` needs a run the daemon's user may not remove.
	 * What is being asserted is the client's own wording — that each of the four answers reads as a
	 * different next move, which is the whole reason the host answers four.
	 */
	it('names the next move for a lease that is live', () => {
		const said = renderDeleteArchivedGroup('local', 'checkout-web', GROUP, {
			outcome: 'refused',
			reason: 'lease-live',
		});

		expect(said).toContain('a lease filing into one of its runs is live');
		expect(said).toContain('nothing at all was touched');
		expect(said).toContain('force-release');
	});

	/*
	 * **A `partial` says *ask again***, which is this command's own next move and not `delete-test`'s:
	 * a group's delete is a bounded walk, so part of the group may never have been reached.
	 */
	it('says a partial delete may have left runs behind, and to ask again', () => {
		const said = renderDeleteArchivedGroup('local', 'checkout-web', GROUP, {
			outcome: 'partial',
			archive: 'failed',
			keptTests: 'absent',
			freedBytes: 512,
			keptTestsRemoved: 0,
			runsRemoved: 1,
		});

		expect(said).toContain('only partly deleted');
		expect(said).toContain('1 run removed');
		expect(said).toContain('run this again');
	});

	it('escapes both components the way every other echoed value is escaped', () => {
		const said = renderDeleteArchivedGroup('local', 'checkout\nweb', 'group\nid', {
			outcome: 'not-found',
		});

		// A name a host answered still goes through `escapeControlCharacters`, as `rover keep`'s
		// table does: a newline in an echoed value could otherwise forge a line of output.
		expect(said).not.toContain('checkout\nweb');
		expect(said).not.toContain('group\nid');
	});
});

describe('the usage errors a command line can make', () => {
	it('exits 2 without --actor, which is never derived', async () => {
		await fileAGroupedRun('checkout-web', 'home-screen', '20260901T101010Z-i-aaaaaaaa', GROUP, 512);

		await expect(run(['delete-group', 'checkout-web', GROUP])).resolves.toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--actor');
		// And nothing was deleted on the way to that refusal.
		await expect(
			stat(join(temp.artifactsRoot, 'checkout-web', 'home-screen')),
		).resolves.toBeDefined();
	});

	it('exits 2 with only one of the two arguments named', async () => {
		await expect(run(['delete-group', 'checkout-web', '--actor', 'alice'])).resolves.toBe(
			EXIT_USAGE,
		);

		expect(errored.join('\n')).toContain('<project> <group-id>');
	});

	/*
	 * **A group id with a separator in it is a usage error only if the *host* refuses it, and it
	 * does not** (R41): the id names no directory, so it is matched as content. What is refused here
	 * is the `project`, which is a path component.
	 */
	it('takes a group id carrying a separator and refuses one in the project', async () => {
		await fileAGroupedRun(
			'checkout-web',
			'home-screen',
			'20260901T101010Z-i-aaaaaaaa',
			'../etc/passwd',
			64,
		);

		await expect(
			run(['delete-group', 'checkout-web', '../etc/passwd', '--actor', 'alice']),
		).resolves.toBe(EXIT_OK);
		await expect(run(['delete-group', '../checkout-web', GROUP, '--actor', 'alice'])).resolves.toBe(
			EXIT_FAILED,
		);

		expect(logged.join('\n')).toContain('1 run removed');
	});
});
