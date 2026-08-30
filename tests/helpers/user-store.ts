/**
 * A real `users.json` for the suites that drive the network listener.
 *
 * Deliberately not folded into `tls-fixtures.ts`, whose subject is certificates and raw wire
 * clients: this is the *other* half of what the gate needs, and the two are used
 * independently — `tests/unit/daemon/user-store.test.ts` wants a store and no TLS at all.
 *
 * The store is built by calling the shipping `addUser`, so the token a test presents is a
 * token the shipping code minted and hashed, rather than a fixture constant that happens to
 * match a fixture hash. It lives inside a caller-supplied `mkdtemp` directory — never
 * `~/.rover/users.json`, which belongs to whoever is running the tests — and needs no cleanup
 * entry point of its own, because `removeTempSocket` already removes that directory.
 */

import { join } from 'node:path';
import { addUser } from '@/daemon/user-store.js';

export interface TestUserStore {
	/** The store's path, for a listener config and for further `addUser`/`revokeUser` calls. */
	readonly path: string;
	readonly identifier: string;
	/** The raw token `addUser` printed once — the only place it exists. */
	readonly token: string;
}

/** A store at `<dir>/users.json` holding one user, with that user's issued token. */
export async function createTestUserStore(
	dir: string,
	identifier = 'alice',
): Promise<TestUserStore> {
	const path = join(dir, 'users.json');
	const issued = await addUser(path, { identifier });
	return { path, identifier, token: issued.token };
}
