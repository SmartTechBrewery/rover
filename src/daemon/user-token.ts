/**
 * The credential half of the host's user store (D25): how a user's token is minted, hashed
 * and checked.
 *
 * It sits beside `host-token.ts` and keeps that module's discipline — nothing it returns can
 * be turned back into a token — but it solves a different problem, which is why it is a
 * second module rather than a second function there. `host-token.ts` gates **one** secret
 * held in memory for the lifetime of a process, so a bare digest is enough. A user's token
 * is written to a file that outlives the process and is read back cold, so it is hashed the
 * way a stored credential has to be: `scrypt` with a fresh per-record salt, the shape
 * `../swarm/src/identity/auth.ts` uses, minus the password/session split a bearer token does
 * not need. The token *is* the credential here; there is no separate login step.
 *
 * `node:crypto` only — no new dependency, for the reason ai/RULES.md gives about Swarm's own
 * dependency-free identity code.
 *
 * Two consequences worth stating rather than rediscovering:
 *
 * - **A per-record salt means a token cannot be looked up by its hash.** Whoever authenticates
 *   a caller against this store has to run {@link verifyUserToken} once per record. That is
 *   fine at operator scale, and it is the price of a stored credential that survives the file
 *   leaking; weakening the hash to make a lookup possible would be the wrong trade.
 * - **{@link verifyUserToken} has no caller in `src/` yet** — the daemon starts reading this
 *   store in a later change. It ships now because without it there is no way to assert that
 *   the token `rover users add` printed is the token the stored hash actually matches, and a
 *   write-only hash is an untestable credential store.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/**
 * 32 random bytes — 256 bits, so guessing is hopeless whatever the hash costs. Base64url
 * encoded, that is 43 characters, comfortably over the 32-character floor a host token has
 * to clear, and it carries no character a shell, a URL or a header would have to escape.
 */
export const USER_TOKEN_BYTES = 32;

/** The Node docs' worked example, and Swarm's: 16-byte salt, 64-byte derived key. */
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** `<saltHex>:<keyHex>` — what a record's `tokenHash` is, and the only form ever stored. */
export const TOKEN_HASH_PATTERN = /^[0-9a-f]+:[0-9a-f]+$/;

/** A fresh opaque token. The only place in Rover a user's raw credential comes into being. */
export function generateUserToken(): string {
	return randomBytes(USER_TOKEN_BYTES).toString('base64url');
}

/** `scrypt(token, salt)` with a fresh random salt, encoded `<saltHex>:<keyHex>`. */
export async function hashUserToken(token: string): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const derived = (await scryptAsync(token, salt, KEY_BYTES)) as Buffer;
	return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Whether `token` is the token `stored` was derived from.
 *
 * Returns `false` rather than throwing on a malformed stored value, so a caller can treat it
 * as a plain predicate: a record somebody hand-edited into nonsense must not authenticate
 * anyone, and must not take the daemon down either.
 *
 * `timingSafeEqual` throws on unequal lengths — the same trap `host-token.ts` documents — so
 * the derived key is computed at the stored key's own length, which makes the two buffers
 * equal-sized by construction.
 */
export async function verifyUserToken(token: string, stored: string): Promise<boolean> {
	const [saltHex, keyHex] = stored.split(':');
	if (!saltHex || !keyHex || !TOKEN_HASH_PATTERN.test(stored)) {
		return false;
	}

	const salt = Buffer.from(saltHex, 'hex');
	const expected = Buffer.from(keyHex, 'hex');
	if (salt.length === 0 || expected.length === 0) {
		return false;
	}

	const derived = (await scryptAsync(token, salt, expected.length)) as Buffer;
	return timingSafeEqual(derived, expected);
}
