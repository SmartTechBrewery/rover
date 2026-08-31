import { CheckingSession, SignInScreen } from '@panel/screens/sign-in.js';
import { SessionProvider, useSession } from '@panel/session/session-provider.js';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routes/route-tree.js';

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}

export function App() {
	return (
		<SessionProvider>
			<Panel />
		</SessionProvider>
	);
}

/**
 * The router exists only inside a live session, and **the sign-in screen is not a route.**
 *
 * That is what makes "the token never reaches a URL" structural rather than careful: there is no
 * `/sign-in` address for a credential to be attached to, no redirect target to record on the way
 * in, and no route a signed-out browser can reach by typing at it. It also means no screen inside
 * the router has to defend against having no identity — by the time one renders, there is one.
 */
function Panel() {
	const { state, signIn } = useSession();

	if (state.status === 'signed-in') {
		return <RouterProvider router={router} />;
	}
	// The boot probe is the one state with no form: whether a form is needed is what it is deciding.
	if (state.status === 'checking' && state.of === 'boot') {
		return <CheckingSession />;
	}
	return <SignInScreen onSubmit={signIn} state={state} />;
}
