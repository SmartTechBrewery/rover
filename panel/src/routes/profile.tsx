import { PageHeader } from '@panel/components/layout/page-header.js';
import { useSession } from '@panel/session/session-provider.js';
import { createRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { rootRoute } from './__root.js';

/**
 * Who you are signed in as, and the one control that ends it.
 *
 * `DELETE /session` is what a sign-out sends, so the session ends **on the host** rather than only
 * in this browser (`PROJECT.md` D30) — a `localStorage.removeItem` would leave a live credential
 * behind for anything that had already read it.
 *
 * Which is why the control reports what it actually achieved. A `DELETE` that reached nothing ended
 * nothing, so this screen stays where it is, still signed in, and says the host could not be
 * reached — the browser keeps the only id that can end that session, and announcing a sign-out
 * would both be false and throw that id away (`docs/DESIGN.md` §8, `SignOutOutcome`).
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
	const [ending, setEnding] = useState(false);
	const [unreachable, setUnreachable] = useState(false);

	const end = (): void => {
		setEnding(true);
		setUnreachable(false);
		void (async () => {
			// `ended` takes the router down with it (`app.tsx`), so only the other outcome has
			// anything left to say on a screen that still exists.
			if ((await signOut()) === 'unreachable') {
				setEnding(false);
				setUnreachable(true);
			}
		})();
	};

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
					Signing out ends this session on the host, and if the host cannot be reached nothing ends
					and you stay signed in. The token an operator issued you is not affected either way — sign
					in with it again whenever you need to.
				</p>

				{/*
				 * Recessive rather than filled, for the reason §7 records about the force-release
				 * confirmation: a control that ends something is not the loudest thing on its screen.
				 * Its pending state is the disabled control with a changed label that §5 asks for, not
				 * a spinner.
				 */}
				<button
					className={
						ending
							? 'mt-4 cursor-not-allowed rounded-sm border-2 border-outline-variant px-6 py-3 font-label-caps text-label-caps text-on-surface-variant uppercase'
							: 'mt-4 rounded-sm border-2 border-outline px-6 py-3 font-label-caps text-label-caps text-on-surface uppercase transition-colors hover:border-secondary-fixed-dim hover:text-secondary-fixed-dim'
					}
					disabled={ending}
					onClick={end}
					type="button"
				>
					{ending ? 'Signing out…' : 'Sign out'}
				</button>

				{/*
				 * `aria-live="polite"` and no colour of alarm, for §7's reason: a host that did not
				 * answer is news, not an emergency, and nothing here has gone wrong with the session.
				 * The element is present in both states so the region exists before the text does.
				 *
				 * **It does not say "try again", and that is deliberate** (#123). The device poll
				 * fails on the very `fetch` that made this sign-out unanswered, so within `POLL_MS`
				 * `app.tsx` replaces the router — this screen and its control included — with the
				 * unreachable page. Instructing an action that is about to have no control left to
				 * perform it is the one thing this line must not do; it says what happened and where
				 * the panel is going instead.
				 */}
				<p
					aria-live="polite"
					className="mt-4 max-w-prose font-body-md text-body-md text-on-surface"
				>
					{unreachable
						? 'Nothing answered on the host, so the session is still open and you are still signed in. If the host stays unreachable the panel says so in place of this page — sign out again once it is back.'
						: ''}
				</p>
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
