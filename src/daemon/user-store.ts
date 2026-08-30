/**
 * `~/.rover/users.json` — the host's own list of who may use it (D25).
 *
 * One record per user: an identifier, a display name, the **hash** of that user's token, and
 * when it was created. Never a token: `add` and `rotate` return the raw value to their caller
 * exactly once, and nothing here writes, logs or interpolates one.
 *
 * Two properties are what this module is for, and both are easy to lose by writing the
 * obvious thing:
 *
 * - **It is a local file, not a service.** Every function takes the resolved path and touches
 *   the filesystem directly. `rover users` is an operator tool for the machine holding the
 *   instance, so it works whether or not a daemon is running and never goes over the network
 *   (D25). Nothing here imports a client, a socket or an IPC method. That stays true now the
 *   daemon's network gate is a second reader ({@link findUserByToken}): it is on the same
 *   machine and opens the same file, rather than asking anything for it.
 * - **A malformed store is never silently reset.** A read that cannot be parsed throws, naming
 *   the path; rewriting it as an empty list would delete every credential on the host to make
 *   one command succeed.
 *
 * The path lives beside `~/.rover/rover.sock` and is resolved the way `socket-path.ts`
 * resolves that one, down to treating an exported-but-empty variable as unset. It is
 * deliberately **not** derived from the socket path: an operator who moves a socket has not
 * asked to move their credential file, and the socket's 103-byte address cap has nothing to
 * do with a JSON file.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { describeIssues } from '../ipc/protocol.js';
import {
	generateUserToken,
	hashUserToken,
	TOKEN_HASH_PATTERN,
	verifyUserToken,
} from './user-token.js';

/** Environment variable naming the store, for tests and for a non-default install. */
export const USERS_PATH_ENV_VAR = 'ROVER_USERS_PATH';

/** A display name is shown in a table, not parsed. Long enough for a human name, bounded. */
export const MAX_DISPLAY_NAME_LENGTH = 120;

/**
 * The shape of an identifier, following the reasoning `APP_ID` (src/core/ids.ts) is written
 * with: a shape says what is allowed, a blocklist says what someone thought of.
 *
 * Wide enough for the two things operators actually type — a username and an email address —
 * and narrow in two deliberate ways: no leading `-`, so an identifier can never be read as a
 * flag by a command it is passed to, and no whitespace or control character, so a record can
 * never forge a row in `rover users list`.
 */
const USER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;

/** C0 and DEL — the characters that would let a display name forge a line of output. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const UserIdentifierSchema = z
	.string()
	.regex(
		USER_IDENTIFIER,
		'an identifier is 1–64 characters of letters, digits, dot, underscore, @, + or -, ' +
			'starting with a letter or a digit (e.g. alice, alice@example.com, ci-runner.1)',
	);

export const UserRecordSchema = z
	.object({
		identifier: UserIdentifierSchema,
		displayName: z
			.string()
			.min(1, 'a display name must not be empty')
			.max(MAX_DISPLAY_NAME_LENGTH)
			.refine(
				(value) => !CONTROL_CHARACTERS.test(value),
				'a display name must not contain control characters',
			),
		tokenHash: z.string().regex(TOKEN_HASH_PATTERN, 'a token hash is <saltHex>:<keyHex>'),
		createdAt: z.string().datetime(),
	})
	.strict();
export type UserRecord = z.infer<typeof UserRecordSchema>;

/**
 * A top-level object rather than a bare array, which is what leaves room for a `version` key
 * later without a migration. Adding one before anything needs it would be speculative.
 */
export const UserStoreFileSchema = z.object({ users: z.array(UserRecordSchema) }).strict();

/** `~/.rover/users.json` — the zero-config path, beside the socket. */
export function defaultUsersPath(): string {
	return join(homedir(), '.rover', 'users.json');
}

/** Resolve the store's path. An empty value counts as unset, as it does for the socket. */
export function resolveUsersPath(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[USERS_PATH_ENV_VAR];
	return configured === undefined || configured === '' ? defaultUsersPath() : configured;
}

/** `add` found the identifier already taken. Never an overwrite — that would revoke silently. */
export class DuplicateUserError extends Error {
	readonly identifier: string;

	constructor(identifier: string, path: string) {
		super(`A user '${identifier}' already exists in ${path}`);
		this.name = 'DuplicateUserError';
		this.identifier = identifier;
	}
}

/** `rotate` or `revoke` named someone the store does not hold. */
export class UnknownUserError extends Error {
	readonly identifier: string;

	constructor(identifier: string, path: string) {
		super(`No user '${identifier}' in ${path}`);
		this.name = 'UnknownUserError';
		this.identifier = identifier;
	}
}

/** The result of minting a credential: the record to store, and the token to show once. */
export interface IssuedUser {
	readonly user: UserRecord;
	/** The raw token. Printed once by the caller and never persisted, logged or recoverable. */
	readonly token: string;
}

/**
 * Every user this host knows, or `[]` when the store does not exist yet — a host with no
 * users is the ordinary starting state, not a failure. Every other read failure throws.
 */
export async function readUsers(path: string): Promise<UserRecord[]> {
	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	} catch (error) {
		if (isNotFound(error)) {
			return [];
		}
		throw new Error(`Could not read the user store at ${path}: ${describeError(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`The user store at ${path} is not valid JSON: ${describeError(error)}. It has been ` +
				`left untouched — fix or move it rather than letting a command overwrite it.`,
		);
	}

	const result = UserStoreFileSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(
			`The user store at ${path} is not a valid store: ${describeIssues(result.error)}. ` +
				`It has been left untouched — fix or move it rather than letting a command ` +
				`overwrite it.`,
		);
	}
	return result.data.users;
}

/**
 * The user whose token is `token`, or `undefined` when no stored record matches it.
 *
 * **The store is read on every call, deliberately** — no cache, no memo, no watcher. This is
 * what the daemon's network gate authenticates against (D6: the daemon is a cache, and holds
 * nothing it cannot re-derive), so a `rover users revoke` on this machine bites on the very
 * next connection attempt with the daemon still running.
 *
 * One `scrypt` per record, by construction: the per-record salt this store's hashes carry
 * makes a lookup *by* hash impossible, for the reason `user-token.ts` sets out, and a linear
 * scan is the price of a credential that survives the file leaking. Returning early on a match
 * costs a valid token nothing it did not already know — an invalid one always pays for every
 * record — and only a caller already holding a token can observe its record's position.
 *
 * A store that cannot be read or parsed **throws**, carrying `readUsers`' own diagnosis. What
 * a caller on a socket is told about that is the caller's policy to decide, not this module's.
 */
export async function findUserByToken(
	path: string,
	token: string,
): Promise<UserRecord | undefined> {
	for (const user of await readUsers(path)) {
		if (await verifyUserToken(token, user.tokenHash)) {
			return user;
		}
	}
	return undefined;
}

/** Create a user and mint its first token. Throws {@link DuplicateUserError} on a repeat. */
export async function addUser(
	path: string,
	input: { identifier: string; displayName?: string },
): Promise<IssuedUser> {
	const identifier = parseIdentifier(input.identifier);
	const users = await readUsers(path);
	if (users.some((user) => user.identifier === identifier)) {
		throw new DuplicateUserError(identifier, path);
	}

	const token = generateUserToken();
	const user = parseRecord({
		identifier,
		displayName: input.displayName ?? identifier,
		tokenHash: await hashUserToken(token),
		createdAt: new Date().toISOString(),
	});

	await writeUsers(path, [...users, user]);
	return { user, token };
}

/**
 * Replace a user's token with a fresh one, invalidating the old one.
 *
 * `tokenHash` is the only field that moves: `createdAt` records when the *record* was created,
 * not when its current secret was, and rewriting it would erase the one date `list` shows.
 */
export async function rotateUserToken(path: string, identifier: string): Promise<IssuedUser> {
	const users = await readUsers(path);
	const existing = users.find((user) => user.identifier === identifier);
	if (!existing) {
		throw new UnknownUserError(identifier, path);
	}

	const token = generateUserToken();
	const user: UserRecord = { ...existing, tokenHash: await hashUserToken(token) };

	await writeUsers(
		path,
		users.map((candidate) => (candidate.identifier === identifier ? user : candidate)),
	);
	return { user, token };
}

/** Remove a user outright. Throws {@link UnknownUserError} when there is nothing to remove. */
export async function revokeUser(path: string, identifier: string): Promise<UserRecord> {
	const users = await readUsers(path);
	const existing = users.find((user) => user.identifier === identifier);
	if (!existing) {
		throw new UnknownUserError(identifier, path);
	}

	await writeUsers(
		path,
		users.filter((candidate) => candidate.identifier !== identifier),
	);
	return existing;
}

/** The one place an identifier from outside is checked, so no caller can skip the shape. */
export function parseIdentifier(raw: string): string {
	const result = UserIdentifierSchema.safeParse(raw);
	if (!result.success) {
		throw new Error(`Invalid user identifier '${raw}': ${describeIssues(result.error)}`);
	}
	return result.data;
}

function parseRecord(candidate: unknown): UserRecord {
	const result = UserRecordSchema.safeParse(candidate);
	if (!result.success) {
		// Nothing rejected is interpolated: one of the fields validated here is a token's hash.
		throw new Error(`Invalid user record: ${describeIssues(result.error)}`);
	}
	return result.data;
}

/**
 * Write the whole store, atomically and readably.
 *
 * Two details, each buying something concrete: `0o600` because this file is what stands
 * between a stranger with a shell account and every credential on the host, and
 * write-then-`rename` because a process killed mid-write would otherwise truncate the file
 * holding every user. `rename` within one directory is atomic, so a reader sees the old file
 * or the new one and never half of either.
 */
async function writeUsers(path: string, users: readonly UserRecord[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ users }, null, 2)}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	});
	await rename(temporary, path);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code: unknown }).code === 'ENOENT'
	);
}
