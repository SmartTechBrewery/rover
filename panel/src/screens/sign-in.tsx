import { Wordmark } from '@panel/components/wordmark.js';
import type { SessionState } from '@panel/session/session-provider.js';
import { Eye, EyeOff } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * The one screen a person sees before they are authenticated, and all four of its other states.
 *
 * **It is not a route, and that is the point** (`app.tsx`): while there is no live session the panel
 * renders this in place of the router, so there is no address a credential could be attached to, no
 * `?next=` to record and nothing to redirect back to. It is also why the states below are states of
 * one screen rather than four destinations.
 *
 * Built from the Stitch screen `Sign In — Rover OS` (`5035330b2c12401080263625ff564369`, project
 * `Rover` `636633385461686529`) under `docs/DESIGN.md` §8, which is binding and settles more than
 * the screen shows: no sidebar, no navigation, no breadcrumb, no profile; **no host or address
 * field** and no hostname line; one input — the access token, in the monospace face, masked with a
 * reveal, sized for a machine string; no account creation and no reset, because users are issued on
 * the host; **one refusal for every reason**; and **no spinner** — the pending state is a disabled
 * control whose label changes, since a spinner is a looping animation and §5 has no exception for
 * progress.
 *
 * Three things the emitted design markup does that are deliberately not reproduced: a fixed
 * full-viewport scanline layer (§5 forbids one — the texture is on the card, which is chrome), a
 * flex-centred container that clips the card from the top at short viewport heights (§8), and a
 * `DEBUG // UI STATES` switcher whose buttons did nothing (§9).
 */

/** What a state says on arrival, above the form. Not every state has something to say. */
interface Notice {
	readonly heading: string;
	readonly detail: string;
}

/**
 * A deliberate sign-out, and a session that stopped being accepted. **The second is
 * `docs/DESIGN.md` §8's deliberate exception to the uniform refusal**: this person authenticated a
 * moment ago, so saying that their access ended costs nothing and tells a stranger nothing. It must
 * not claim *why* — a revoke, a rotate and a daemon restart are indistinguishable from a browser,
 * and §7's "the headline must not claim to know which" applies here too.
 *
 * Neither is written in a colour of alarm. Both are normal, finished states in the language of §7,
 * and one of them is something the person did on purpose.
 */
const SIGNED_OUT: Notice = {
	heading: 'Signed out',
	detail: 'The session ended on the host. Sign in again whenever you need the panel.',
};

const ACCESS_ENDED: Notice = {
	heading: 'Access ended',
	detail:
		'This host stopped accepting the session. Sign in again — and if that does not work, ask whoever runs the host.',
};

/**
 * **One message, for every reason.** A token nobody holds, a revoked user's token, a malformed one
 * and a host that never answered all arrive here, and the wording claims neither the token nor the
 * host as the cause — the host refuses every failed attempt identically on purpose
 * (`docs/DESIGN.md` §8), and a screen that offered "unknown user" and "wrong token" as separate
 * states would undo that.
 */
const REFUSAL =
	'That did not sign you in. Check that the whole token was pasted, and that the host is running.';

const CONTROL_BASE = 'w-full rounded-sm py-4 font-label-caps text-label-caps uppercase';
const CONTROL_READY = `${CONTROL_BASE} control-tactile bg-tertiary text-on-tertiary`;
const CONTROL_PENDING = `${CONTROL_BASE} cursor-not-allowed bg-surface-variant text-on-surface-variant`;

export function SignInScreen({
	state,
	onSubmit,
}: {
	readonly state: SessionState;
	readonly onSubmit: (token: string) => void;
}) {
	const [token, setToken] = useState('');
	const [revealed, setRevealed] = useState(false);
	const field = useRef<HTMLInputElement>(null);

	const pending = state.status === 'checking';
	const refused = state.status === 'refused';
	const notice = noticeFor(state);

	// A refusal keeps the field's content *and* its focus. Disabling the control while a token is
	// in flight is what takes focus away, so it is given back rather than left on the document.
	useEffect(() => {
		if (refused) {
			field.current?.focus();
		}
	}, [refused]);

	const submit = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		if (!pending) {
			onSubmit(token);
		}
	};

	return (
		<SignInPage>
			{notice === undefined ? null : (
				<section className="rounded-sm border-2 border-outline-variant bg-surface-container-high p-4">
					<h2 className="font-label-caps text-label-caps text-on-surface-variant uppercase">
						{notice.heading}
					</h2>
					<p className="mt-2 font-body-md text-body-md text-on-surface">{notice.detail}</p>
				</section>
			)}

			{/*
			 * `method="post"` and no `name` on the field, both for the same reason: a form that fell
			 * back to a native submit must not be able to put the token in a URL. A GET form would
			 * do exactly that, and an unnamed control contributes nothing to a body either.
			 */}
			<form className="flex flex-col gap-6" method="post" onSubmit={submit}>
				<div className="flex flex-col gap-2">
					<label
						className="font-label-caps text-label-caps text-on-surface-variant uppercase"
						htmlFor="access-token"
					>
						Access token
					</label>

					<div className="relative flex items-center">
						<input
							autoCapitalize="off"
							autoComplete="off"
							autoCorrect="off"
							className="w-full rounded-sm border-2 border-outline bg-surface-container-lowest p-3 pr-12 font-code-md text-code-md text-on-surface placeholder-on-surface-variant focus:border-tertiary focus:outline-none"
							id="access-token"
							onChange={(event) => setToken(event.target.value)}
							placeholder="Paste the access token"
							ref={field}
							spellCheck={false}
							type={revealed ? 'text' : 'password'}
							value={token}
						/>
						<button
							aria-label={revealed ? 'Hide the token' : 'Show the token'}
							aria-pressed={revealed}
							className="absolute right-3 text-on-surface-variant transition-colors hover:text-tertiary"
							onClick={() => setRevealed(!revealed)}
							type="button"
						>
							{revealed ? (
								<EyeOff aria-hidden="true" size={20} strokeWidth={2} />
							) : (
								<Eye aria-hidden="true" size={20} strokeWidth={2} />
							)}
						</button>
					</div>

					{/*
					 * `aria-live="polite"` and no `role="alert"`: a refused attempt is not an
					 * emergency, and §8 asks for ordinary text with no colour of alarm. The element
					 * is present in every state, empty or not — a live region has to exist before
					 * the text appears for it to be announced, and the card keeps one shape.
					 */}
					<p aria-live="polite" className="font-body-md text-body-md text-on-surface">
						{refused ? REFUSAL : ''}
					</p>

					<p className="font-code-md text-code-md text-on-surface-variant">
						An operator issues one on the host with <code>rover users add &lt;name&gt;</code>. It is
						the string that printed once.
					</p>
				</div>

				<button
					className={pending ? CONTROL_PENDING : CONTROL_READY}
					disabled={pending}
					type="submit"
				>
					{pending ? 'Checking…' : 'Sign in'}
				</button>
			</form>
		</SignInPage>
	);
}

/**
 * The boot probe, which is the other half of *checking* and looks nothing like the first: there is
 * no form yet, because whether one is needed is exactly what the probe is deciding. One quiet line
 * on the same shell-less page, and no spinner.
 */
export function CheckingSession() {
	return (
		<SignInPage>
			<p aria-live="polite" className="font-code-md text-code-md text-on-surface-variant">
				Checking the session this browser was holding.
			</p>
		</SignInPage>
	);
}

function noticeFor(state: SessionState): Notice | undefined {
	if (state.status === 'access-ended') {
		return ACCESS_ENDED;
	}
	// A cold arrival carries no line at all, which is the only difference between it and a
	// deliberate sign-out (`docs/DESIGN.md` §8).
	if (state.status === 'signed-out' && state.after === 'sign-out') {
		return SIGNED_OUT;
	}
	return undefined;
}

/**
 * The shell-less page every state above shares: the wordmark centred in the card, vertical padding
 * so the card never touches an edge, and `my-auto` inside a scrollable column rather than
 * `justify-center` — a flex-centred container clips the card from the *top* at short viewport
 * heights, and §8 names that.
 *
 * The scanline is on the card, never a fixed full-viewport layer (§5). Nothing on this page renders
 * a screenshot, so there is nothing here for the texture to tint.
 */
function SignInPage({ children }: { readonly children: ReactNode }) {
	return (
		<div className="flex min-h-screen flex-col items-center overflow-y-auto bg-surface px-(--margin-mobile) py-(--margin-desktop) text-on-surface">
			<main className="my-auto w-full max-w-md">
				<div className="relative overflow-hidden rounded-lg border-2 border-outline-variant bg-surface-container">
					<div aria-hidden="true" className="scanline absolute inset-0" />
					<div className="relative flex flex-col gap-6 p-8">
						<div className="border-outline-variant border-b-2 pb-6 text-center">
							<Wordmark />
						</div>
						{children}
					</div>
				</div>
			</main>
		</div>
	);
}
