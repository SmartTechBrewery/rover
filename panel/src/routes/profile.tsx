import { PageHeader } from '@panel/components/layout/page-header.js';
import { useSession } from '@panel/session/session-provider.js';
import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root.js';

/**
 * Who you are signed in as, and the one control that ends it.
 *
 * `DELETE /session` is what a sign-out sends, so the session ends **on the host** rather than only
 * in this browser (`PROJECT.md` D30) — a `localStorage.removeItem` would leave a live credential
 * behind for anything that had already read it.
 *
 * Nothing else goes on this screen. It is not a settings page, there is no role to change and no
 * token to re-issue: users are issued on the host by an operator (`docs/DESIGN.md` §8), and the
 * panel authenticates without ever administering. The sign-out control lives here and **not in the
 * sidebar**, which carries no action at all (§3, §7) — the design's own early revision promoted
 * `Log Out` into the navigation and replaced `Profile` with an avatar, and both were mistakes.
 *
 * Exported for `profile.test.tsx`: a route's component is otherwise reachable only through a router
 * instance, and what is worth asserting here is that the control reaches the host.
 */
export function ProfileScreen() {
	const { state, signOut } = useSession();

	// The router only exists inside a live session (`app.tsx`), so this narrows a type rather than
	// describing a state anybody can reach.
	if (state.status !== 'signed-in') {
		return null;
	}

	return (
		<>
			<PageHeader trail={[{ label: 'Profile' }]} description="Who you are signed in as." />

			<section className="mt-8 rounded-lg border-2 border-outline-variant bg-surface-container-low p-8">
				<dl className="flex flex-col gap-6">
					<Field label="Display name" value={state.identity.displayName} />
					<Field label="Identifier" value={state.identity.identifier} />
				</dl>

				<p className="mt-8 max-w-prose font-body-md text-body-md text-on-surface-variant">
					Signing out ends this session on the host. The token an operator issued you is not
					affected — sign in with it again whenever you need to.
				</p>

				{/*
				 * Recessive rather than filled, for the reason §7 records about the force-release
				 * confirmation: a control that ends something is not the loudest thing on its screen.
				 */}
				<button
					className="mt-4 rounded-sm border-2 border-outline px-6 py-3 font-label-caps text-label-caps text-on-surface uppercase transition-colors hover:border-secondary-fixed-dim hover:text-secondary-fixed-dim"
					onClick={() => {
						void signOut();
					}}
					type="button"
				>
					Sign out
				</button>
			</section>
		</>
	);
}

/** One field of the identity, in §6's anatomy: a caps label over the value in the monospace face. */
function Field({ label, value }: { readonly label: string; readonly value: string }) {
	return (
		<div>
			<dt className="font-label-caps text-label-caps text-on-surface-variant uppercase">{label}</dt>
			<dd className="mt-2 font-code-md text-code-md text-on-surface">{value}</dd>
		</div>
	);
}

export const profileRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/profile',
	component: ProfileScreen,
});
