/**
 * The host user store and the hashing under it, against a real file.
 *
 * Real files rather than a mocked `fs`, for the reason the daemon suite's exception gives
 * (ai/TESTING.md): what is asserted here is the file's *mode*, the atomic replace, and that
 * the raw token is nowhere in the bytes — none of which a mock can be wrong about. Every one
 * lives inside a per-test `mkdtemp`, never `~/.rover/users.json`, which belongs to whoever is
 * running the tests.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_HOST_TOKEN_LENGTH } from '@/daemon/network-config.js';
import {
	addUser,
	DuplicateUserError,
	defaultUsersPath,
	readUsers,
	resolveUsersPath,
	revokeUser,
	rotateUserToken,
	UnknownUserError,
	USERS_PATH_ENV_VAR,
} from '@/daemon/user-store.js';
import { generateUserToken, hashUserToken, verifyUserToken } from '@/daemon/user-token.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

let temp: TempSocket;
let path: string;

beforeEach(async () => {
	temp = await createTempSocket();
	path = join(temp.dir, 'users.json');
});

afterEach(async () => {
	await removeTempSocket(temp);
});

describe('resolveUsersPath', () => {
	it('falls back to ~/.rover/users.json, beside the socket', () => {
		expect(resolveUsersPath({})).toBe(join(homedir(), '.rover', 'users.json'));
		expect(defaultUsersPath()).toBe(join(homedir(), '.rover', 'users.json'));
	});

	it('prefers the configured path and reads process.env when passed nothing', () => {
		expect(resolveUsersPath({ [USERS_PATH_ENV_VAR]: '/tmp/rover-users.json' })).toBe(
			'/tmp/rover-users.json',
		);

		vi.stubEnv(USERS_PATH_ENV_VAR, '/tmp/rover-from-process-env.json');
		expect(resolveUsersPath()).toBe('/tmp/rover-from-process-env.json');
	});

	it('treats an exported-but-empty value as unset', () => {
		expect(resolveUsersPath({ [USERS_PATH_ENV_VAR]: '' })).toBe(defaultUsersPath());
	});
});

describe('user tokens', () => {
	it('mints a token that already clears the floor a host token has to clear', () => {
		expect(generateUserToken().length).toBeGreaterThanOrEqual(MIN_HOST_TOKEN_LENGTH);
	});

	it('verifies the token it hashed and nothing else', async () => {
		const token = generateUserToken();
		const hash = await hashUserToken(token);

		expect(await verifyUserToken(token, hash)).toBe(true);
		expect(await verifyUserToken(generateUserToken(), hash)).toBe(false);
	});

	it('salts every hash, so the same token twice is two different stored values', async () => {
		const token = generateUserToken();

		expect(await hashUserToken(token)).not.toBe(await hashUserToken(token));
	});

	// A record somebody hand-edited into nonsense must authenticate nobody, and must not take
	// the process down either — `timingSafeEqual` throws on unequal lengths.
	it.each([
		'',
		'not-a-hash',
		':',
		'abc:',
		':abc',
		'zz:zz',
	])('returns false rather than throwing for the malformed stored value %j', async (stored) => {
		await expect(verifyUserToken('anything', stored)).resolves.toBe(false);
	});
});

describe('addUser', () => {
	it('stores a record whose hash matches the token it returned', async () => {
		const { user, token } = await addUser(path, { identifier: 'alice' });

		expect(user.identifier).toBe('alice');
		expect(await verifyUserToken(token, user.tokenHash)).toBe(true);
		expect(await readUsers(path)).toEqual([user]);
	});

	it('leaves the raw token nowhere on disk', async () => {
		const { token } = await addUser(path, { identifier: 'alice' });

		const bytes = await readFile(path, 'utf8');
		expect(bytes).not.toContain(token);
		expect(bytes).not.toContain(token.slice(0, 16));
	});

	it('defaults the display name to the identifier', async () => {
		const { user } = await addUser(path, { identifier: 'alice' });

		expect(user.displayName).toBe('alice');
	});

	it('keeps a display name it was given', async () => {
		const { user } = await addUser(path, { identifier: 'alice', displayName: 'Alice Example' });

		expect(user.displayName).toBe('Alice Example');
	});

	it('refuses a duplicate identifier rather than overwriting the record', async () => {
		const first = await addUser(path, { identifier: 'alice' });

		await expect(addUser(path, { identifier: 'alice' })).rejects.toThrow(DuplicateUserError);
		// The overwrite this prevents would silently revoke a credential somebody is holding.
		expect(await readUsers(path)).toEqual([first.user]);
	});

	it.each([
		'alice',
		'alice@example.com',
		'ci-runner.1',
		'a',
		'A+b_c',
	])('accepts the identifier %j', async (identifier) => {
		await expect(addUser(path, { identifier })).resolves.toBeTruthy();
	});

	it.each([
		['an empty one', ''],
		['a leading dash, which a command could read as a flag', '-alice'],
		['an embedded newline, which would forge a row in the listing', 'alice\nbob'],
		['a space', 'alice bob'],
		['a slash', '../etc/passwd'],
		['65 characters', 'a'.repeat(65)],
	])('rejects an identifier that is %s', async (_why, identifier) => {
		await expect(addUser(path, { identifier })).rejects.toThrow('Invalid user identifier');
	});

	it('rejects a display name with a control character in it', async () => {
		await expect(addUser(path, { identifier: 'alice', displayName: 'Alice\nBob' })).rejects.toThrow(
			'control characters',
		);
	});

	it('writes a file only its owner can read, and leaves no temporary behind', async () => {
		await addUser(path, { identifier: 'alice' });

		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await readdir(temp.dir)).not.toContain('users.json.tmp');
	});

	it('creates the directory the store lives in', async () => {
		const nested = join(temp.dir, 'nested', 'deeper', 'users.json');

		await addUser(nested, { identifier: 'alice' });

		expect(await readUsers(nested)).toHaveLength(1);
	});
});

describe('readUsers', () => {
	it('answers [] for a store that does not exist yet', async () => {
		expect(await readUsers(path)).toEqual([]);
	});

	it('throws naming the path when the file is not JSON, and leaves it untouched', async () => {
		await writeFile(path, 'not json at all', 'utf8');

		await expect(readUsers(path)).rejects.toThrow(path);
		expect(await readFile(path, 'utf8')).toBe('not json at all');
	});

	it('throws rather than resetting a store whose shape is wrong', async () => {
		// Resetting would delete every credential on the host to make one command succeed.
		const malformed = JSON.stringify({ users: [{ identifier: 'alice' }] });
		await writeFile(path, malformed, 'utf8');

		await expect(readUsers(path)).rejects.toThrow(path);
		expect(await readFile(path, 'utf8')).toBe(malformed);
	});
});

describe('rotateUserToken', () => {
	it('mints a token that works and invalidates the one before it', async () => {
		const first = await addUser(path, { identifier: 'alice', displayName: 'Alice Example' });

		const second = await rotateUserToken(path, 'alice');

		expect(second.token).not.toBe(first.token);
		expect(await verifyUserToken(second.token, second.user.tokenHash)).toBe(true);
		expect(await verifyUserToken(first.token, second.user.tokenHash)).toBe(false);
	});

	it('moves only the hash — the record still records when it was created', async () => {
		const first = await addUser(path, { identifier: 'alice', displayName: 'Alice Example' });

		const second = await rotateUserToken(path, 'alice');

		expect(second.user.createdAt).toBe(first.user.createdAt);
		expect(second.user.displayName).toBe('Alice Example');
		expect(second.user.tokenHash).not.toBe(first.user.tokenHash);
		expect(await readUsers(path)).toEqual([second.user]);
	});

	it('leaves every other user alone', async () => {
		const bob = await addUser(path, { identifier: 'bob' });
		await addUser(path, { identifier: 'alice' });

		await rotateUserToken(path, 'alice');

		expect(await readUsers(path)).toContainEqual(bob.user);
	});

	it('throws UnknownUserError naming an identifier the store does not hold', async () => {
		await expect(rotateUserToken(path, 'nobody')).rejects.toThrow(UnknownUserError);
		await expect(rotateUserToken(path, 'nobody')).rejects.toThrow('nobody');
	});
});

describe('revokeUser', () => {
	it('removes exactly the record it names', async () => {
		const alice = await addUser(path, { identifier: 'alice' });
		const bob = await addUser(path, { identifier: 'bob' });

		const removed = await revokeUser(path, 'alice');

		expect(removed).toEqual(alice.user);
		expect(await readUsers(path)).toEqual([bob.user]);
	});

	it('throws UnknownUserError naming an identifier the store does not hold', async () => {
		await addUser(path, { identifier: 'alice' });

		await expect(revokeUser(path, 'nobody')).rejects.toThrow(UnknownUserError);
		expect(await readUsers(path)).toHaveLength(1);
	});
});
