/**
 * The one thing the browser keeps between reloads: the session id.
 *
 * **Never the token.** The token is what `rover users add` printed once — it is also the
 * operator's CLI credential, it never expires on its own, and only `rover users revoke`/`rotate`
 * ends it, everywhere at once (`PROJECT.md` D30). It reaches the host in one request body and is
 * dropped; what is written here is the session id minted in exchange, which expires on its own and
 * which `DELETE /session` ends and nothing else.
 *
 * **`localStorage` rather than `sessionStorage`, and the cost is stated rather than hidden.**
 * `sessionStorage` is per-tab and does not survive the tab being closed, so a second tab would ask
 * for the token again and a restart of the browser always would — which is the whole thing the
 * session exists to avoid. What `localStorage` costs is that an XSS in the panel reads the id; D30
 * accepts that deliberately, because what it reads is a credential that expires, that a sign-out
 * ends, and that is not the token `rover users` issued. A cookie would swap that for a credential
 * the browser attaches to cross-site requests on its own, which is the worse trade and is why the
 * host sets none.
 *
 * **Every path is tolerant of there being no storage at all.** In a browser with storage disabled,
 * reading `window.localStorage` throws before any method is called, so the property access itself
 * is inside the guard and not only the call. A panel that cannot persist the id still signs in and
 * still works for the life of the page; what is lost is staying signed in across a reload, which is
 * a far smaller failure than refusing to sign in.
 */

/**
 * One key, namespaced by product and surface. Nothing else in the panel writes to storage, so this
 * is the whole of what the panel leaves behind on a machine.
 */
const STORAGE_KEY = 'rover.panel.session';

/** `localStorage`, or `undefined` where a browser will not give one out. */
function storage(): Storage | undefined {
	try {
		return window.localStorage;
	} catch {
		// Storage disabled by policy or by a private-browsing mode. There is no session to hold
		// between reloads here, and that is the whole consequence.
		return undefined;
	}
}

/** The session id this browser was holding, or `undefined` for a cold arrival. */
export function readStoredSession(): string | undefined {
	try {
		const stored = storage()?.getItem(STORAGE_KEY);
		return stored === null || stored === undefined || stored.length === 0 ? undefined : stored;
	} catch {
		// A quota or security error reading one key. Treated as a cold arrival.
		return undefined;
	}
}

export function storeSession(session: string): void {
	try {
		storage()?.setItem(STORAGE_KEY, session);
	} catch {
		// Full, or refused. The session is live either way — it just will not outlive this page.
	}
}

export function clearStoredSession(): void {
	try {
		storage()?.removeItem(STORAGE_KEY);
	} catch {
		// Nothing left to do: the id is already unusable by the time anything clears it.
	}
}
