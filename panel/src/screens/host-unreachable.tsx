import { Wordmark } from '@panel/components/wordmark.js';
import { RefreshCw, WifiOff } from 'lucide-react';

/**
 * The panel cannot reach the daemon at all (`docs/DESIGN.md` §7).
 *
 * **A state of the whole page, not a dialog over the application**, and the rule generalises: a
 * state that leaves the navigation nothing to reach is the whole page; a state where the rest of
 * the panel still works keeps the shell. There is no inventory, no archive and no lease to show
 * here, so a card floating over a dimmed sidebar would be furniture behind a message with every nav
 * item leading nowhere. The sidebar, the navigation and the breadcrumb are **gone, not dimmed** —
 * which `app.tsx` achieves by rendering this in place of the router, the same way the sign-in
 * screen is rendered in place of it.
 *
 * Structurally it follows `SignInPage`: wordmark, one centred block, vertical padding, and
 * scrollable at short viewport heights rather than flex-centred and clipped from the top.
 *
 * **This is the one place in the panel that uses the `error` tokens.** §5 leaves red unused so it
 * stays meaningful, and §7 calls a stale view "an uncertainty, not a fault" — a host that cannot be
 * reached at all is the fault the reserve was kept for. It stays on the border, the mark and the
 * headline; the design's glow shadow and radial-dot background are dropped, both being colour
 * literals as well as ornament.
 *
 * Three things the design's markup does that are deliberately not reproduced: a fixed full-viewport
 * scanline layer (§5), the `shadow-[0_0_40px_rgba(…)]` glow, and the dotted background.
 */
export function HostUnreachable({ onRetry }: { readonly onRetry: () => void }) {
	return (
		<div className="flex min-h-screen flex-col items-center overflow-y-auto bg-surface px-(--margin-mobile) py-(--margin-desktop) text-on-surface">
			<main className="my-auto w-full max-w-2xl">
				<div className="flex flex-col items-center rounded-lg border-2 border-error bg-surface-container-low p-12 text-center">
					<div className="w-full border-outline-variant border-b-2 pb-6">
						<Wordmark />
					</div>

					<WifiOff aria-hidden="true" className="mt-10 text-error" size={48} strokeWidth={2} />

					{/*
					 * Exactly `HOST UNREACHABLE`, and no second clause. A refused connection, a
					 * timeout, a powered-off machine and a daemon that is not running are
					 * indistinguishable from here, so the headline must not claim to know which —
					 * and there is **no error code**, because an earlier revision printed one this
					 * product does not produce and somebody would have searched for it.
					 */}
					<h1 className="mt-8 font-display-lg text-display-lg text-error">HOST UNREACHABLE</h1>

					<p className="mt-6 max-w-lg font-body-lg text-body-lg text-on-surface-variant">
						Nothing answered on the machine this panel is served from. Check that the Rover daemon
						is running there.
					</p>

					{/*
					 * Retrying a read is harmless and it is the one useful thing to do from here. It
					 * is not a spinner while it runs — §5 has no exception for progress — and it does
					 * not need one: the poll is still asking on its own interval behind this page.
					 */}
					<button
						className="mt-10 flex items-center gap-3 rounded-sm border-2 border-outline-variant bg-surface-variant px-8 py-4 font-label-caps text-label-caps text-on-surface uppercase transition-colors hover:border-secondary-fixed-dim hover:text-secondary-fixed-dim"
						onClick={onRetry}
						type="button"
					>
						<RefreshCw aria-hidden="true" size={18} strokeWidth={2} />
						Retry connection
					</button>
				</div>
			</main>
		</div>
	);
}
