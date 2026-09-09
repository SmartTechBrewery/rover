import {
	type DeleteArchivedTestAnswer,
	deleteArchivedTest,
	type TestRemoval,
} from '@panel/archive/delete-archived-test.js';
import { BADGE_SHAPE, BADGE_TYPE } from '@panel/components/archive/header-badge.js';
import { RemoveTestDialog } from '@panel/components/archive/remove-dialog.js';
import { useSession } from '@panel/session/session-provider.js';
import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * `Remove` — the Archive screen's second operator control, beside the `Keep` tick on the two cards
 * whose tick is about a test (`docs/DESIGN.md` §9, D43, R51, #276).
 *
 * **The treatment is §10's badge and not a new one.** `BADGE_SHAPE` and `BADGE_TYPE` come out of
 * `header-badge.tsx` — the Archive header's own pill — so the radius, the border width, the
 * padding, the face and the 12px step are **shared rather than copied**, and this control cannot
 * drift from the one on a Projects card by a border width. The colour is deliberately not in either
 * constant: with `border-outline-variant` and `border-error` in one class list, which wins is the
 * order of two utilities in the emitted stylesheet rather than anything this component says.
 *
 * **The accent is `error`, on the glyph and the words, and never a fill.** §5's *destructive
 * actions are recessive* is what that shape is for, and it matters more here than on a Projects
 * card: the loudest thing in this strip is the test's own name, and a solid red pill in a card
 * header beside a checkbox would be the full-width orange button §5 records as the mistake. The
 * frame stays `outline-variant` until the pointer is on it. `Trash2` at 14px and `aria-hidden`,
 * because the words are already there.
 *
 * **Its accessible name carries the test** — `Remove test statistics-deliveries`, via `aria-label`,
 * because the visible word is the same on every card and on both of the two cards that draw it.
 *
 * **It asks first, and the asking is `ForceReleaseControl`'s and `DeleteProjectControl`'s
 * arrangement** (§7): one confirmation over the working panel, mounted on `document.body`, with the
 * safe exit as the prominent control. Nothing is asked of the host until the operator has been
 * asked, and the dialog is the extracted frame rather than a second one (#272's warning).
 *
 * **This control does not own the reporting, and on this screen that is load-bearing.** A settled
 * delete may take the very address the reader is looking at — a test's card *is* that test, and a
 * run's card is inside it — so a settled outcome goes up to the screen through
 * {@link RemoveControl.onSettled}, which is where the navigation, the re-read and the line above
 * the content area live (`routes/archive.tsx`, `remove-notice.tsx`). The one answer that stays here
 * is the request that reached nothing: nothing was deleted, so the dialog stays open with the
 * control usable again and nothing is said about the tree.
 */
export function RemoveControl({
	removal,
	onSettled,
}: {
	/** The test this control is about, and the facts the confirmation states — {@link TestRemoval}. */
	readonly removal: TestRemoval;
	/**
	 * The host answered, one way or the other. Never called for a request that reached nothing —
	 * that one has not settled anything, and the panel may not report a deletion it did not get.
	 */
	readonly onSettled: (answer: DeleteArchivedTestAnswer, removal: TestRemoval) => void;
}) {
	const { state, call } = useSession();
	const [asking, setAsking] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [unanswered, setUnanswered] = useState(false);
	const controlRef = useRef<HTMLButtonElement>(null);

	// The router only exists inside a live session (`app.tsx`), so this narrows a type rather than
	// describing a state anybody can reach — and it is the identity the call is attributed with.
	if (state.status !== 'signed-in') {
		return null;
	}
	const actor = state.identity.identifier;

	const open = (): void => {
		setUnanswered(false);
		setAsking(true);
	};

	/*
	 * Cancelling returns focus to the control it came from — the dialog moved focus in, so
	 * something has to move it back, and the element it belongs on is this one.
	 *
	 * A *settled* outcome deliberately does not: three of the four move the selection onto the
	 * parent address, so this control is about to be unmounted by the very answer it just received.
	 * The outcome is announced above the content area instead, which is the thing that still exists
	 * to be read.
	 */
	const cancel = (): void => {
		setAsking(false);
		controlRef.current?.focus();
	};

	const confirm = (): void => {
		setRemoving(true);
		setUnanswered(false);
		void (async () => {
			const answer = await deleteArchivedTest(call, {
				project: removal.project,
				testName: removal.testName,
				actor,
			});
			if (answer.outcome === 'unanswered') {
				// Nothing was deleted, so nothing closes and nothing is claimed. The control comes
				// back so the same ask can be made again.
				setRemoving(false);
				setUnanswered(true);
				return;
			}
			if (answer.outcome === 'access-ended') {
				// `Session.call` has already fired the bounce and the router is coming down. Saying
				// anything here would make the panel's last word the wrong one.
				return;
			}
			setRemoving(false);
			setAsking(false);
			onSettled(answer, removal);
		})();
	};

	return (
		<>
			<button
				// `aria-label` overrides the visible word rather than adding to it, which is what a
				// control whose words are the same on every card needs: `Remove test login-flow`, not
				// `Remove` on whichever card happens to be open.
				aria-label={`Remove test ${removal.testName}`}
				className={`${BADGE_SHAPE} ${BADGE_TYPE} flex shrink-0 items-center gap-2 border-outline-variant bg-surface-container text-error transition-colors hover:border-error`}
				onClick={open}
				ref={controlRef}
				type="button"
			>
				<Trash2 aria-hidden="true" size={14} strokeWidth={2} />
				Remove
			</button>
			{/*
			 * **Mounted on `document.body`, not here** — `force-release-control.tsx`'s recorded
			 * reason, and it applies to a control in a card header as much as to one on a card in a
			 * grid. A dialog rendered inline inherits every treatment an ancestor carries, and this
			 * one's ancestors include a card with `overflow-hidden` on its own `<section>`
			 * (`contents-card.tsx`) — which is exactly what the `Keep` popover relies on and what a
			 * modal must not be inside.
			 *
			 * The portal is here rather than inside `RemoveTestDialog` because it is a fact about
			 * where this control mounts it, not about what the dialog is: the dialog stays an
			 * ordinary component that renders where it is put.
			 */}
			{asking
				? createPortal(
						<RemoveTestDialog
							onCancel={cancel}
							onConfirm={confirm}
							removal={removal}
							removing={removing}
							unanswered={unanswered}
						/>,
						document.body,
					)
				: null}
		</>
	);
}
