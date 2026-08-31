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
	signOut as endSession,
	type HostIdentity,
	signIn as mintSession,
	whoAmI,
} from './host-client.js';
import { clearStoredSession, readStoredSession, storeSession } from './session-storage.js';

/**
 * Whether there is a session, and the five states that answer for it.
 *
 * The whole of the panel's authentication lives here, so no screen has to know how a session is
 * held and R35's requests inherit {@link Session.onRefusal} instead of re-deriving the bounce.
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

export interface Session {
	readonly state: SessionState;
	/** Present a token. Moves through `checking` to `signed-in`, or to `refused`. */
	readonly signIn: (token: string) => Promise<void>;
	/** End the session on the host, then forget it here. */
	readonly signOut: () => Promise<void>;
	/**
	 * What a later request calls when the host refuses the session it presented — the one path to
	 * *access ended*, so every screen bounces the same way and clears the same storage.
	 */
	readonly onRefusal: () => void;
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
		session.current = answer.value.session;
		storeSession(answer.value.session);
		setState({
			status: 'signed-in',
			identity: { identifier: answer.value.identifier, displayName: answer.value.displayName },
		});
	}, []);

	const signOut = useCallback(async (): Promise<void> => {
		const ending = session.current;
		// Dropped before the request rather than after it, so a second click has nothing left to
		// end and the host is asked exactly once.
		session.current = undefined;
		if (ending !== undefined) {
			await endSession(ending);
		}
		clearStoredSession();
		setState({ status: 'signed-out', after: 'sign-out' });
	}, []);

	const onRefusal = useCallback((): void => {
		if (session.current === undefined) {
			// Nothing was live, so nothing ended: a refusal arriving after a sign-out is the answer
			// to a request that outlived its session, not news for the person reading the screen.
			return;
		}
		forget();
		setState({ status: 'access-ended' });
	}, [forget]);

	const value: Session = { state, signIn, signOut, onRefusal };

	return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
	const session = useContext(SessionContext);
	if (session === undefined) {
		throw new Error('useSession was called outside a SessionProvider');
	}
	return session;
}
