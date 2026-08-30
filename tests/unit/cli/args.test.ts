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
import { LOCAL_HOST, REMOTE_HOST, resolveHost } from '@/cli/_shared/host.js';
import { EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import { ATTRIBUTION_MAX_LENGTH, AttributionStringSchema } from '@/ipc/methods.js';
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

	// An object literal inherits these from Object.prototype, so a dispatch table built as one
	// hands every one of them back as a truthy value — past the unknown-command guard and into
	// `handler.run`, where the TypeError surfaces as exit 1: "the operation did not succeed",
	// for a word that was never a command.
	it.each([
		'toString',
		'valueOf',
		'constructor',
		'hasOwnProperty',
		'__proto__',
	])("exits 2 with usage for '%s', an inherited key and not a command", async (inherited) => {
		expect(await run([inherited])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain(`Unknown command '${inherited}'`);
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

	it('names both hosts and exits 2 for one that is neither', async () => {
		expect(await run(['list', '--host', 'somewhere-else'])).toBe(EXIT_USAGE);

		const said = errored.join('\n');
		expect(said).toContain("Unknown host 'somewhere-else'");
		// The failure has to say what the reachable hosts *are*, or the flag reads as broken
		// rather than as mistyped — and for 'remote' that means naming what configures it.
		expect(said).toContain("'local'");
		expect(said).toContain("'remote'");
		expect(said).toContain('ROVER_HOST_ADDRESS');
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

	it('resolves --host remote without connecting to anything', () => {
		// Same reason as above, mirrored: resolving the *name* is a pure decision, and it has
		// to stay one — a `resolveHost` that reached for the environment or a socket would
		// make every flag-parsing test depend on what the developer exported.
		expect(resolveHost('remote')).toBe(REMOTE_HOST);
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

	// The optional attribution string has to fail the same way the required pair does. Left to
	// the host it is a round trip that comes back naming `testName` — a key the caller never
	// typed — at exit 1, the code reserved for a refused acquire or an unreachable host.
	it('exits 2 for a --test-name given with no value, without reaching a host', async () => {
		expect(
			await run([
				'acquire',
				'serial-1',
				'--owner',
				'issue-112',
				'--project',
				'rover',
				'--test-name',
				'',
			]),
		).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--test-name was given with no value');
		expect(errored.join('\n')).toContain('Usage: rover acquire');
	});

	it.each([
		'owner',
		'project',
		'test-name',
	])('exits 2 for a --%s past the length the host accepts, naming the flag as typed', async (flag) => {
		const argv = ['acquire', 'serial-1', '--owner', 'issue-112', '--project', 'rover'];
		const tooLong = 'x'.repeat(ATTRIBUTION_MAX_LENGTH + 1);
		const at = argv.indexOf(`--${flag}`);
		if (at === -1) {
			argv.push(`--${flag}`, tooLong);
		} else {
			argv[at + 1] = tooLong;
		}

		expect(await run(argv)).toBe(EXIT_USAGE);

		// The flag as the caller spelled it, not the request key it maps to.
		expect(errored.join('\n')).toContain(`--${flag} is ${tooLong.length} characters`);
		expect(errored.join('\n')).not.toContain('testName');
	});

	it('takes its ceiling from the host schema rather than restating it', () => {
		// One bound, in one place. A CLI carrying its own copy would start refusing values the
		// host accepts — or waving through ones it does not — the moment the schema moves.
		expect(() => AttributionStringSchema.parse('x'.repeat(ATTRIBUTION_MAX_LENGTH))).not.toThrow();
		expect(() => AttributionStringSchema.parse('x'.repeat(ATTRIBUTION_MAX_LENGTH + 1))).toThrow();
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
