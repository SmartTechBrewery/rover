/**
 * Dispatch and flag parsing, with no host anywhere in it.
 *
 * Every case here has to be decided **before** a connection is attempted — that is half of
 * what is being asserted. So the socket path is stubbed at a temp directory nobody serves,
 * and `afterEach` fails if anything turned up on it: a command that reached
 * `connectToHost()` would autostart a real daemon, and a test that quietly tolerated one
 * would also tolerate `--host somewhere-else` spawning a local daemon before rejecting the
 * name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST, resolveHost } from '@/cli/_shared/host.js';
import { EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	stopDaemonAt,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

let temp: TempSocket;
let logged: string[];
let errored: string[];

beforeEach(async () => {
	temp = await createTempSocket();
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	logged = [];
	errored = [];
	vi.spyOn(console, 'log').mockImplementation((line: string) => logged.push(line));
	vi.spyOn(console, 'warn').mockImplementation((line: string) => errored.push(line));
	vi.spyOn(console, 'error').mockImplementation((line: string) => errored.push(line));
});

afterEach(async () => {
	vi.restoreAllMocks();
	const stray = await connectWithoutStarting(temp.socketPath);
	if (stray) {
		await stray.close();
		await stopDaemonAt(temp.socketPath);
	}
	await removeTempSocket(temp);
	expect(stray).toBeNull();
});

describe('rover, before it talks to anything', () => {
	it('prints usage on stdout and exits 0 for --help', async () => {
		expect(await run(['--help'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('Usage: rover <command> [options]');
		expect(errored).toEqual([]);
	});

	it('prints usage on stdout and exits 0 for no command at all', async () => {
		expect(await run([])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('Commands:');
	});

	it('exits 2 with usage on stderr for an unknown command', async () => {
		expect(await run(['tap'])).toBe(EXIT_USAGE);

		// Both on stderr: stdout stays empty so a caller reading it never sees usage text
		// where a result belongs.
		expect(errored.join('\n')).toContain("Unknown command 'tap'");
		expect(errored.join('\n')).toContain('Usage: rover <command> [options]');
		expect(logged).toEqual([]);
	});

	it("exits 2 for a command's unknown flag", async () => {
		expect(await run(['list', '--evrything'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--evrything');
	});

	it('exits 2 for an argument a command does not take', async () => {
		expect(await run(['status', 'local'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('expected no arguments');
	});

	it('names R22 and exits 2 for a host that is not the local one', async () => {
		expect(await run(['list', '--host', 'somewhere-else'])).toBe(EXIT_USAGE);

		const said = errored.join('\n');
		expect(said).toContain("Unknown host 'somewhere-else'");
		// The failure has to say what *would* make another host reachable, or the flag reads
		// as broken rather than as not built yet.
		expect(said).toContain('R22');
		// The rejecting command's own usage, not the dispatcher's: the shape the caller got
		// wrong is what they need back.
		expect(said).toContain('Usage: rover list');
	});

	it('treats --host local and no flag as the same host', () => {
		// Asserted on the seam rather than through a command, because the alternative is a
		// command that connects — and 'local' resolving is exactly the case that would then
		// autostart a daemon in a suite that has no business starting one.
		expect(resolveHost('local')).toBe(LOCAL_HOST);
		expect(resolveHost(undefined)).toBe(LOCAL_HOST);
	});

	it("prints a command's own usage for `<command> --help`", async () => {
		expect(await run(['list', '--help'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('Usage: rover list');
	});
});

describe('rover acquire, on its required attribution', () => {
	it('exits 2 without --owner rather than deriving one', async () => {
		expect(await run(['acquire', 'serial-1', '--project', 'rover'])).toBe(EXIT_USAGE);

		// The message has to say the value is the caller's to supply (D16, D20). A CLI that
		// filled it in from the environment would be the failure those decisions prevent.
		expect(errored.join('\n')).toContain('--owner is required');
	});

	it('exits 2 without --project', async () => {
		expect(await run(['acquire', 'serial-1', '--owner', 'issue-112'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--project is required');
	});

	it('exits 2 without a serial', async () => {
		expect(await run(['acquire', '--owner', 'issue-112', '--project', 'rover'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('expected <serial>');
	});

	it('exits 2 for an --owner given as an empty string', async () => {
		expect(await run(['acquire', 'serial-1', '--owner', '', '--project', 'rover'])).toBe(
			EXIT_USAGE,
		);

		expect(errored.join('\n')).toContain('--owner is required');
	});
});

describe('rover release, on its one argument', () => {
	it('exits 2 without a lease id', async () => {
		expect(await run(['release'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('expected <lease-id>');
	});

	it('takes no --owner: the lease id is the credential', async () => {
		expect(await run(['release', 'lease-1', '--owner', 'issue-112'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--owner');
	});
});
