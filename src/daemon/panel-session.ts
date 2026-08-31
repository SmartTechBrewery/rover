/**
 * The browser's half of a credential: a session minted from an `rover users` token, held in
 * memory, and ended by a sign-out or by a revoke (D30).
 *
 * D29 settled *which* credential the panel presents — an `rover users` one, hashed and looked up
 * in `~/.rover/users.json` on every request — and deliberately left open the layer above it: how
 * a **browser** holds that credential between reloads. This module is that layer. A token is
 * exchanged once, over `POST /session`, for an opaque session id the page presents afterwards in
 * the same `Authorization: Bearer` header a token goes in today.
 *
 * **Why a session id rather than the token itself.** The token is what `rover users add` printed:
 * it is also the operator's CLI credential, it never expires on its own, and the only way to end
 * it is `rover users revoke`/`rotate`, which ends it *everywhere*. A session is minted for one
 * browser, expires on its own, and {@link PanelSessionStore.end} ends it and nothing else — which
 * is what makes "signing out ends the session server-side" true rather than a
 * `localStorage.removeItem`.
 *
 * Two properties are what this module is for, and both are easy to lose by writing the obvious
 * thing:
 *
 * - **Resolving a session re-reads the user store, every time** (D6, D25). An entry binds the
 *   user's `identifier` *and* their `tokenHash`, and both must still be in the store for the
 *   session to resolve — so `rover users revoke alice` kills her session on its very next
 *   request, on a keep-alive connection the browser is already holding, and `rover users rotate
 *   alice` kills it too, which is the only reading consistent with "rotate invalidates the old
 *   token". A memo added here later "for performance" would reintroduce exactly the cache D6
 *   forbids and would silently undo both. It is also *cheaper* than the token path, not more
 *   expensive: an identifier and a hash compared, where a presented token costs one `scrypt` per
 *   stored record.
 * - **The id is hashed, and the raw value exists only in the answer to the sign-in that minted
 *   it.** SHA-256 and deliberately not `scrypt`: `user-token.ts` pays for `scrypt` because a
 *   user's token is at rest in a file that can leak, whereas a session id is 256 bits of CSPRNG
 *   output living only in this process's memory for its lifetime — there is nothing to
 *   brute-force and no file to leak, and a `scrypt` per request would be a cost with no attacker
 *   to spend it on. Hashing at all is what keeps a live credential out of the daemon's own heap.
 *
 * **In memory, per listener, dying with the daemon.** The store is created inside
 * `startHttpListener` and needs no plumbing through `./listen.ts`. A daemon restart signs
 * everyone out; that is honest, needs no file, and cannot go stale against the user store.
 *
 * **Expiry is swept lazily, never on a timer.** A `setInterval` here would hold a handle that has
 * to be `unref`ed and cleared on close for no gain: entries are dropped when they are looked at,
 * on a mint and on a resolve, so a store nobody is using costs nothing and holds nothing.
 *
 * **The rejected alternatives**, recorded because they will be proposed again: persisting
 * sessions to disk (a second credential file to leak and to keep in step with the user store,
 * bought so a daemon restart does not sign anyone out — which is not a cost worth a file); and a
 * `create_panel_session` IPC method instead of a route (it would put a raw credential into an
 * envelope layer that has never carried one, on the unix socket where a browser cannot reach and
 * a session means nothing — see `./http-listen.ts`'s header for why the exchange is this
 * transport's own).
 */

import { createHash, randomBytes } from 'node:crypto';
import { readUsers, type UserRecord } from './user-store.js';

/**
 * How long a session survives without use. Sliding: every resolve pushes it out again, the shape
 * D8 already gives a lease.
 *
 * Eight hours is one working day of use, and a browser left open overnight is signed out by
 * morning. It is a constant rather than an option because there is nothing here for an operator
 * to tune — a shorter window is `DELETE /session`, and a longer one is a decision, not a setting.
 */
export const PANEL_SESSION_IDLE_MS = 8 * 60 * 60 * 1000;

/**
 * 32 random bytes — 256 bits, so guessing is hopeless — base64url encoded, which is 43 characters
 * carrying nothing a URL, a header or a shell would have to escape. `user-token.ts` sizes a
 * user's token the same way and for the same reason.
 */
const SESSION_ID_BYTES = 32;

/**
 * Who a live session belongs to. Returned to the browser that authenticated as them and to
 * nothing else — **no lease field may ever be derived from it** (D20): a lease's `owner` is an
 * explicit, caller-supplied string, and an authenticated identity is not one.
 */
export interface PanelSessionIdentity {
	readonly identifier: string;
	readonly displayName: string;
}

export interface PanelSessionStore {
	/** Mint a session for a user the caller has already authenticated. The raw id, once. */
	open(user: UserRecord): string;
	/**
	 * The identity behind a live session, or `undefined` for one that never existed, has expired,
	 * or whose user has been revoked or rotated since. Re-reads `usersPath`; never caches.
	 */
	resolve(usersPath: string, sessionId: string): Promise<PanelSessionIdentity | undefined>;
	/** End one session. Idempotent, and silent about whether there was one to end. */
	end(sessionId: string): void;
	/** Drop every session — what the listener calls when it closes. */
	clear(): void;
}

export interface PanelSessionStoreOptions {
	/**
	 * Defaults to {@link PANEL_SESSION_IDLE_MS}. A test seam in the spirit of
	 * `HttpListenerOptions.authTimeoutMs`, not a configuration surface.
	 */
	readonly idleMs?: number;
	/** Defaults to `Date.now`. The other half of the same seam: an idle window a test can cross. */
	readonly now?: () => number;
}

/** What is remembered about a session. Never the id, and never the user's token. */
interface PanelSession {
	readonly identifier: string;
	readonly tokenHash: string;
	expiresAt: number;
}

export function createPanelSessionStore(options: PanelSessionStoreOptions = {}): PanelSessionStore {
	const idleMs = options.idleMs ?? PANEL_SESSION_IDLE_MS;
	const now = options.now ?? Date.now;
	const sessions = new Map<string, PanelSession>();

	const sweep = (at: number): void => {
		for (const [key, session] of sessions) {
			if (session.expiresAt <= at) {
				sessions.delete(key);
			}
		}
	};

	return {
		open(user: UserRecord): string {
			const at = now();
			sweep(at);
			const id = randomBytes(SESSION_ID_BYTES).toString('base64url');
			sessions.set(digestOf(id), {
				identifier: user.identifier,
				tokenHash: user.tokenHash,
				expiresAt: at + idleMs,
			});
			return id;
		},

		async resolve(usersPath: string, sessionId: string): Promise<PanelSessionIdentity | undefined> {
			const at = now();
			sweep(at);
			const key = digestOf(sessionId);
			const session = sessions.get(key);
			if (session === undefined) {
				return undefined;
			}

			let users: readonly UserRecord[];
			try {
				users = await readUsers(usersPath);
			} catch {
				// A store this host cannot read authenticates nobody, exactly as the token gate
				// decides. The entry is *kept*: an unreadable file is usually a transient state of
				// the operator's own making, and signing every browser out over it would be a
				// harsher answer than the one this failure deserves. It expires on its own.
				return undefined;
			}

			const user = users.find(
				(candidate) =>
					candidate.identifier === session.identifier && candidate.tokenHash === session.tokenHash,
			);
			if (user === undefined) {
				// Revoked, or rotated. The session is dead for good, so it goes now rather than
				// waiting out an idle window nobody will renew.
				sessions.delete(key);
				return undefined;
			}

			session.expiresAt = at + idleMs;
			// The store's record, not the entry's copy: a display name changed on disk is the one
			// the browser is shown next.
			return { identifier: user.identifier, displayName: user.displayName };
		},

		end(sessionId: string): void {
			sessions.delete(digestOf(sessionId));
		},

		clear(): void {
			sessions.clear();
		},
	};
}

/** The key an entry lives under: the SHA-256 of the id, never the id. */
function digestOf(sessionId: string): string {
	return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}
