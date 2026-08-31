import { DeviceListProvider, useDeviceList } from '@panel/devices/device-list-provider.js';
import { HostUnreachable } from '@panel/screens/host-unreachable.js';
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
		return (
			<DeviceListProvider>
				<Reachable />
			</DeviceListProvider>
		);
	}
	// The boot probe is the one state with no form: whether a form is needed is what it is deciding.
	if (state.status === 'checking' && state.of === 'boot') {
		return <CheckingSession />;
	}
	return <SignInScreen onSubmit={signIn} state={state} />;
}

/**
 * The other thing that renders in place of the router, and for the same kind of reason.
 *
 * A host the panel cannot reach leaves the navigation nothing to reach — no inventory, no archive,
 * no lease — so it is a state of the **whole page** rather than a card over a dimmed shell
 * (`docs/DESIGN.md` §7). A route component cannot remove the shell its parent route renders, and a
 * cover inside `<main>` would leave every nav link in the DOM and in the tab order behind an opaque
 * layer; mounting the poll above `RouterProvider` and swapping the two is what makes "gone, not
 * dimmed" literally true.
 *
 * **Only the reachability failure does this.** A poll that has not answered yet leaves the router
 * where it is and the Devices screen says it is reading — a page that blinked out on every slow
 * first request would be worse than the state it was reporting.
 *
 * The accepted cost, recorded in §7: the device poll runs while `Profile` is open, and an
 * unreachable host takes `Profile` down with everything else. The panel has exactly one live data
 * source and this is it.
 */
function Reachable() {
	const { state, refresh } = useDeviceList();

	if (state.status === 'unreachable') {
		return <HostUnreachable onRetry={refresh} />;
	}
	return <RouterProvider router={router} />;
}
