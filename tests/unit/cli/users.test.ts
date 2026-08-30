/**
 * `rover users` end to end, against a real store in a temp directory.
 *
 * The acceptance criterion this suite exists for is a negative one — **the command never goes
 * over the network and never talks to the daemon** (D25) — so it is asserted the way
 * `tests/unit/cli/args.test.ts` asserts its own: `ROVER_SOCKET_PATH` points at a temp path
 * nobody serves, and `afterEach` fails if anything turned up there. A command that reached
 * `connectToHost()` would have autostarted a real daemon on it.
 *
 * The other criterion is that a token is printed **exactly once**, so every assertion about
 * one counts occurrences across the whole run's stdout *and* stderr rather than looking at a
 * single line.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import { USERS_PATH_ENV_VAR } from '@/daemon/user-store.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	stopDaemonAt,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

let temp: TempSocket;
let usersPath: string;
let logged: string[];
let errored: string[];

/** Every line the run produced, on either stream — where a leaked token would turn up. */
function everything(): string {
	return [...logged, ...errored].join('\n');
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** The one JSON document a `--json` invocation is allowed to write on stdout. */
function soleDocument(): Record<string, unknown> {
	expect(logged).toHaveLength(1);
	return JSON.parse(logged[0] ?? '') as Record<string, unknown>;
}

/** `users add <identifier>`, returning the token it printed on its own line. */
async function addAndCaptureToken(identifier: string): Promise<string> {
	expect(await run(['users', 'add', identifier])).toBe(EXIT_OK);
	const token = logged[1] ?? '';
	expect(token).not.toBe('');
	logged = [];
	errored = [];
	return token;
}

beforeEach(async () => {
	temp = await createTempSocket();
	usersPath = join(temp.dir, 'users.json');
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	vi.stubEnv(USERS_PATH_ENV_VAR, usersPath);
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

describe('rover users add', () => {
	it('prints the token exactly once and stores only its hash', async () => {
		expect(await run(['users', 'add', 'alice'])).toBe(EXIT_OK);

		const token = logged[1] ?? '';
		expect(token).not.toBe('');
		expect(occurrences(everything(), token)).toBe(1);
		expect(await readFile(usersPath, 'utf8')).not.toContain(token);
	});

	it('names the user it created and says the token will not be shown again', async () => {
		expect(await run(['users', 'add', 'alice', '--name', 'Alice Example'])).toBe(EXIT_OK);

		expect(logged[0]).toContain("Created user 'alice'");
		expect(logged[2]).toContain('not shown again');
	});

	it('writes one document with the token under --json, and no hash', async () => {
		expect(await run(['users', 'add', 'alice', '--json'])).toBe(EXIT_OK);

		const document = soleDocument();
		expect(document).toMatchObject({ identifier: 'alice', displayName: 'alice' });
		expect(document.token).toEqual(expect.any(String));
		expect(document).not.toHaveProperty('tokenHash');
	});

	it('refuses a duplicate identifier, naming it, and keeps the one record', async () => {
		await addAndCaptureToken('alice');

		expect(await run(['users', 'add', 'alice'])).toBe(EXIT_FAILED);

		expect(errored.join('\n')).toContain("A user 'alice' already exists");
		expect(logged).toEqual([]);
		expect(await run(['users', 'list', '--json'])).toBe(EXIT_OK);
		expect(soleDocument()).toMatchObject({ users: [{ identifier: 'alice' }] });
	});
});

describe('rover users list', () => {
	it('says so plainly when the host has no users', async () => {
		expect(await run(['users', 'list'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('No users');
	});

	it('shows identifier, name and creation date, and never a token or a hash', async () => {
		const token = await addAndCaptureToken('alice');
		const stored = JSON.parse(await readFile(usersPath, 'utf8')) as {
			users: { tokenHash: string }[];
		};

		expect(await run(['users', 'list'])).toBe(EXIT_OK);

		const printed = everything();
		expect(printed).toContain('IDENTIFIER');
		expect(printed).toContain('alice');
		expect(printed).not.toContain(token);
		expect(printed).not.toContain(stored.users[0]?.tokenHash);
	});

	it('carries no tokenHash key on any user under --json', async () => {
		await addAndCaptureToken('alice');
		await addAndCaptureToken('bob');

		expect(await run(['users', 'list', '--json'])).toBe(EXIT_OK);

		const document = soleDocument() as { users: Record<string, unknown>[] };
		expect(document.users).toHaveLength(2);
		for (const user of document.users) {
			expect(Object.keys(user).sort()).toEqual(['createdAt', 'displayName', 'identifier']);
		}
	});
});

describe('rover users rotate', () => {
	it('prints a new token once and never reprints the old one', async () => {
		const first = await addAndCaptureToken('alice');

		expect(await run(['users', 'rotate', 'alice'])).toBe(EXIT_OK);

		const printed = everything();
		const second = logged[1] ?? '';
		expect(second).not.toBe(first);
		expect(occurrences(printed, second)).toBe(1);
		expect(printed).not.toContain(first);
	});

	it('exits 1 naming an identifier the store does not hold', async () => {
		expect(await run(['users', 'rotate', 'nobody'])).toBe(EXIT_FAILED);

		expect(errored.join('\n')).toContain("No user 'nobody'");
	});
});

describe('rover users revoke', () => {
	it('removes the user, after which the listing is empty again', async () => {
		await addAndCaptureToken('alice');

		expect(await run(['users', 'revoke', 'alice'])).toBe(EXIT_OK);
		expect(logged.join('\n')).toContain("Revoked 'alice'");

		logged = [];
		expect(await run(['users', 'list'])).toBe(EXIT_OK);
		expect(logged.join('\n')).toContain('No users');
	});

	it('exits 1 for a user that is not there', async () => {
		expect(await run(['users', 'revoke', 'nobody'])).toBe(EXIT_FAILED);
	});

	it('writes one document under --json', async () => {
		await addAndCaptureToken('alice');

		expect(await run(['users', 'revoke', 'alice', '--json'])).toBe(EXIT_OK);

		expect(soleDocument()).toEqual({ identifier: 'alice', revoked: true });
	});
});

describe('rover users, asked wrong', () => {
	it.each([
		[['users'], 'no subcommand at all'],
		[['users', 'bogus'], 'an unknown subcommand'],
		[['users', 'add'], 'add with no identifier'],
		[['users', 'add', 'alice', 'bob'], 'add with an extra positional'],
		[['users', 'add', '-alice'], 'an identifier that could be read as a flag'],
		[['users', 'add', 'alice', '--name', ''], '--name with nothing after it'],
		[['users', 'list', 'extra'], 'list with a positional'],
		[['users', 'list', '--name', 'Alice'], '--name on a subcommand that has no name'],
		[['users', 'revoke'], 'revoke with no identifier'],
		[['users', 'rotate'], 'rotate with no identifier'],
	])('exits 2 with the users usage on stderr for %j — %s', async (argv) => {
		expect(await run(argv)).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('Usage:\n  rover users add');
		expect(logged).toEqual([]);
	});

	it('prints its own usage on stdout for --help', async () => {
		expect(await run(['users', '--help'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('rover users —');
		expect(errored).toEqual([]);
	});
});

describe('rover users never asks a host', () => {
	// The acceptance criterion, executable: there is no network arm to reach, so --host is an
	// unknown flag rather than one that is accepted and ignored — even with a remote host fully
	// configured in the environment.
	it.each([
		['users', 'list', '--host', 'remote'],
		['users', 'list', '--host', 'local'],
		['users', 'add', 'alice', '--host', 'remote'],
	])('rejects %j as a usage error with a remote host configured', async (...argv) => {
		vi.stubEnv('ROVER_HOST_ADDRESS', '10.0.0.4');
		vi.stubEnv('ROVER_HOST_PORT', '4711');
		vi.stubEnv('ROVER_HOST_TOKEN', 'a'.repeat(40));

		expect(await run(argv)).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--host');
	});

	it('works with no daemon running at all', async () => {
		// Nothing is listening on the stubbed socket, and `afterEach` asserts nothing turned up.
		expect(await run(['users', 'add', 'alice'])).toBe(EXIT_OK);
		logged = [];
		expect(await run(['users', 'list'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('alice');
	});
});
