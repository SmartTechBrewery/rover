import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from 'react';
import {
	type ArchivedFile,
	signOut as endSession,
	type HostAnswer,
	type HostIdentity,
	signIn as mintSession,
	type RpcEnvelope,
	readArtifactText as readArtifact,
	rpc,
	whoAmI,
} from './host-client.js';
import { clearStoredSession, readStoredSession, storeSession } from './session-storage.js';

/**
 * Whether there is a session, and the five states that answer for it.
 *
 * The whole of the panel's authentication lives here, so no screen has to know how a session is
 * held and every screen's requests inherit {@link Session.onRefusal} instead of re-deriving the
 * bounce — that is {@link Session.call}, and it is the only way out of this module for a request
 * carrying the session.
 *
 * **The session id is in a ref, not in state.** Nothing renders it and nothing may: a credential
 * that is state ends up in a dependency array, a devtools panel and eventually a rendered
 * attribute. What state carries is the *identity* the host reported, which is the panel's to show.
 */
export type SessionState =
	/**
	 * A request is deciding this, and `of` says which — because the two look nothing alike
	 * (`docs/DESIGN.md` §8). `boot` is the probe on a stored id, before any form exists. `token` is
	 * a submitted token in flight, where the form must stay mounted so the field keeps its content.
	 */
	| { readonly status: 'checking'; readonly of: 'boot' | 'token' }
	/**
	 * No session. `after` is the only difference between a cold arrival, which says nothing, and a
	 * deliberate sign-out, which says the session ended.
	 */
	| { readonly status: 'signed-out'; readonly after: 'arrival' | 'sign-out' }
	| { readonly status: 'signed-in'; readonly identity: HostIdentity }
	/** A submitted credential was not accepted. One state for every reason (`docs/DESIGN.md` §8). */
	| { readonly status: 'refused' }
	/**
	 * A session that was live stopped being accepted. The deliberate exception to the uniform
	 * refusal: this person authenticated a moment ago, so the panel says so — without claiming
	 * *why*, since a revoke, a rotate and a daemon restart are indistinguishable from a browser.
	 */
	| { readonly status: 'access-ended' };

/**
 * What a sign-out achieved, which is not a detail the control may skip over.
 *
 * - `ended` — the host answered, so the session is finished there. A `401` counts: a host that will
 *   not take the id has already forgotten it.
 * - `unreachable` — nothing answered, so **nothing ended**. The session is still live on the host
 *   and this browser holds the only id that can end it, so it stays signed in and the control says
 *   so. Announcing a sign-out here would be the panel claiming an ending it never got, while
 *   discarding the id would leave a live credential nothing can reach for the rest of its idle
 *   window — the exact failure D30 has the browser hold a session id to avoid.
 */
export type SignOutOutcome = 'ended' | 'unreachable';

export interface Session {
	readonly state: SessionState;
	/** Present a token. Moves through `checking` to `signed-in`, or to `refused`. */
	readonly signIn: (token: string) => Promise<void>;
	/**
	 * End the session on the host, then forget it here — and report which of those happened, because
	 * a host that never answered has ended nothing (see {@link SignOutOutcome}).
	 */
	readonly signOut: () => Promise<SignOutOutcome>;
	/**
	 * What a later request calls when the host refuses the session it presented — the one path to
	 * *access ended*, so every screen bounces the same way and clears the same storage.
	 */
	readonly onRefusal: () => void;
	/**
	 * One call on the host's surface, with the session this browser holds.
	 *
	 * **This exists so the session id does not have to.** The id lives in a ref here and is never
	 * handed out (see {@link SessionState}), so a screen that needs `list_devices` gets a method
	 * rather than a credential — and the bounce to *access ended* on a `refused` happens by
	 * construction, in the one place that knows how to perform it, instead of by every caller
	 * remembering to.
	 *
	 * The result stays `unknown` for the caller to parse against the schema of the method it asked
	 * for, exactly as `rpc` argues: this module knows about credentials and transports and
	 * deliberately not about any method's shape. With no session held it answers `unanswered` —
	 * nothing was asked, so nothing came back.
	 *
	 * `signal` is the caller's own deadline, and optional because only a repeating caller has one
	 * to give (`host-client.ts`, `rpc`). An abandoned request answers `unanswered`, so a caller
	 * that sets a budget needs no third status to read.
	 */
	readonly call: (
		method: string,
		params: unknown,
		signal?: AbortSignal,
	) => Promise<HostAnswer<RpcEnvelope>>;
	/**
	 * One archived file's text, from the components a listing answered — {@link call}'s sibling on
	 * the byte route, and here for exactly {@link call}'s reason.
	 *
	 * The id lives in a ref and is never handed out, so a screen that needs a file's contents gets
	 * a method rather than a credential, and the bounce to *access ended* happens by construction.
	 * With no session held it answers `unanswered`: nothing was asked, so nothing came back.
	 *
	 * No `signal`, because the caller has no deadline to give. The archive is finished data read
	 * once on navigation, not a poll with an interval to spend (`host-client.ts`, `rpc`).
	 */
	readonly readArtifactText: (path: readonly string[]) => Promise<HostAnswer<ArchivedFile>>;
}

const SessionContext = createContext<Session | undefined>(undefined);

export function SessionProvider({ children }: { readonly children: ReactNode }) {
	// The live credential, and the only copy in memory. `useRef` rather than `useState` on purpose
	// — see the note on `SessionState`.
	const session = useRef<string | undefined>(readStoredSession());
	const [state, setState] = useState<SessionState>(
		session.current === undefined
			? { status: 'signed-out', after: 'arrival' }
			: { status: 'checking', of: 'boot' },
	);

	const forget = useCallback((): void => {
		session.current = undefined;
		clearStoredSession();
	}, []);

	// The boot probe. It runs once, only with an id to probe, and it is the reason a reload does
	// not ask for the token again.
	useEffect(() => {
		const stored = session.current;
		if (stored === undefined) {
			return;
		}

		let live = true;
		void (async () => {
			const answer = await whoAmI(stored);
			if (!live) {
				return;
			}
			if (answer.ok) {
				setState({ status: 'signed-in', identity: answer.value });
				return;
			}
			if (answer.refusal === 'refused') {
				// A stored id the host will not take is a session that was live and is not any
				// more, which is exactly *access ended* — the id in storage is the evidence that
				// somebody was signed in with it.
				forget();
				setState({ status: 'access-ended' });
				return;
			}
			// Nothing answered. The id is **kept**: an unreachable host has said nothing about
			// whether the session is good, and throwing it away would sign someone out over a
			// daemon that was restarting.
			setState({ status: 'signed-out', after: 'arrival' });
		})();

		return () => {
			live = false;
		};
	}, [forget]);

	const signIn = useCallback(async (token: string): Promise<void> => {
		setState({ status: 'checking', of: 'token' });
		const answer = await mintSession(token);
		if (!answer.ok) {
			// One state for a refusal and for a host that never answered alike: the screen shows
			// one message for every reason, and this is where that stops being possible to leak.
			setState({ status: 'refused' });
			return;
		}
		// Whatever the boot probe kept when it reached nothing is about to be overwritten, and the
		// host may hold it still — so it is presented to `DELETE /session` on the way out. The
		// answer is deliberately not read: a host that has come back reclaims the orphan, one that
		// is still down changes nothing, and either way this sign-in has already succeeded. Without
		// this the host would keep a second live session for the same person that no browser could
		// reach or end.
		const replaced = session.current;
		session.current = answer.value.session;
		storeSession(answer.value.session);
		if (replaced !== undefined && replaced !== answer.value.session) {
			void endSession(replaced);
		}
		setState({
			status: 'signed-in',
			identity: { identifier: answer.value.identifier, displayName: answer.value.displayName },
		});
	}, []);

	// A sign-out already in flight, so a second click joins it rather than sending a second
	// `DELETE`. This is what dropping the id up front used to buy: it cannot do that any more,
	// because an unanswered sign-out has to leave the id behind to retry with.
	const inFlight = useRef<Promise<SignOutOutcome> | undefined>(undefined);

	const endOnHost = useCallback(async (): Promise<SignOutOutcome> => {
		const ending = session.current;
		if (ending !== undefined) {
			// Asked while the id is still in storage: a sign-out that cleared first would be a
			// `localStorage.removeItem` with a live credential left behind it.
			const answer = await endSession(ending);
			if (!answer.ok && answer.refusal === 'unanswered') {
				// Nothing answered, so nothing ended. The id is kept for the same reason the boot
				// probe keeps it — an unreachable host has said nothing — and here it is also the
				// only thing that can still end the session.
				return 'unreachable';
			}
			// `ok` and `refused` alike are a finished sign-out (see `SignOutOutcome`).
		}
		forget();
		setState({ status: 'signed-out', after: 'sign-out' });
		return 'ended';
	}, [forget]);

	const signOut = useCallback((): Promise<SignOutOutcome> => {
		inFlight.current ??= endOnHost().finally(() => {
			inFlight.current = undefined;
		});
		return inFlight.current;
	}, [endOnHost]);

	const onRefusal = useCallback((): void => {
		if (session.current === undefined) {
			// Nothing was live, so nothing ended: a refusal arriving after a sign-out is the answer
			// to a request that outlived its session, not news for the person reading the screen.
			return;
		}
		forget();
		setState({ status: 'access-ended' });
	}, [forget]);

	const call = useCallback(
		async (
			method: string,
			params: unknown,
			signal?: AbortSignal,
		): Promise<HostAnswer<RpcEnvelope>> => {
			const live = session.current;
			if (live === undefined) {
				return { ok: false, refusal: 'unanswered' };
			}
			const answer = await rpc(live, method, params, signal);
			if (!answer.ok && answer.refusal === 'refused') {
				// Fired here rather than at the call site so a screen cannot forget it: a session the
				// host will not take is *access ended*, and `app.tsx` takes the router down with it.
				onRefusal();
			}
			return answer;
		},
		[onRefusal],
	);

	const readArtifactText = useCallback(
		async (path: readonly string[]): Promise<HostAnswer<ArchivedFile>> => {
			const live = session.current;
			if (live === undefined) {
				return { ok: false, refusal: 'unanswered' };
			}
			const answer = await readArtifact(live, path);
			if (!answer.ok && answer.refusal === 'refused') {
				// The byte route is behind the same per-request gate as every method, so a session
				// the host will not take is *access ended* here too — fired in the one place that
				// knows how, exactly as `call` does.
				onRefusal();
			}
			return answer;
		},
		[onRefusal],
	);

	const value: Session = { state, signIn, signOut, onRefusal, call, readArtifactText };

	return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
	const session = useContext(SessionContext);
	if (session === undefined) {
		throw new Error('useSession was called outside a SessionProvider');
	}
	return session;
}
