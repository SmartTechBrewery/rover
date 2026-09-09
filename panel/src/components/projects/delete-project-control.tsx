import { BADGE_SHAPE, BADGE_TYPE } from '@panel/components/archive/header-badge.js';
import { DeleteProjectDialog } from '@panel/components/projects/delete-project-dialog.js';
import { type DeleteProjectAnswer, deleteProject } from '@panel/projects/delete-project.js';
import { useSession } from '@panel/session/session-provider.js';
import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * `Delete project` — the Projects card's one control, and **the action behind the affordance §10
 * settled ahead of it** (D42, R50, #273).
 *
 * **The shape is unchanged from the affordance it replaces**, which is what that phase was for:
 * the badge treatment out of `header-badge.tsx` rather than a new one, the `error` accent on the
 * glyph and the words and never a fill, the frame neutral until the pointer is on it, `Trash2` at
 * 14px and `aria-hidden`, and the identifier in the accessible name because the visible words are
 * the same on every card. §10 carries the reasoning for every one of those and it is not
 * relitigated here — what is new is the `onClick`.
 *
 * **It asks first, and the asking is `ForceReleaseControl`'s arrangement** (§7): a confirmation
 * over the working panel, mounted on `document.body`, with the safe exit as the prominent control.
 * Nothing is asked of the host until the operator has been asked.
 *
 * What this control does *not* own is the reporting. The card is about to disappear underneath the
 * answer — a deleted registration is not in the next `list_projects` — so a settled outcome goes up
 * to the screen through {@link DeleteProjectControl.onSettled} and is said above the list, where it
 * survives the card it was about (§7). The one answer that stays here is the request that reached
 * nothing: nothing was deleted, so the dialog stays open with the control usable again.
 */
export function DeleteProjectControl({
	project,
	className,
	onSettled,
}: {
	/**
	 * The identifier this control is about — the host's own, used verbatim as the accessible name
	 * and as what goes on the wire (D22).
	 */
	readonly project: string;
	/** The strip's own arrangement (`ml-auto`), passed in because the strip owns it, not this. */
	readonly className: string;
	/**
	 * The host answered, one way or the other. Never called for a request that reached nothing —
	 * that one has not settled anything, and the panel may not report a deletion it did not get.
	 */
	readonly onSettled: (answer: DeleteProjectAnswer, project: string) => void;
}) {
	const { state, call } = useSession();
	const [asking, setAsking] = useState(false);
	const [deleting, setDeleting] = useState(false);
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
	 * A *settled* outcome deliberately does not: the screen re-reads on one, so this control is
	 * about to be unmounted by the very answer it just received. The outcome is announced above the
	 * list in a polite live region instead, which is the thing that still exists to be read.
	 */
	const cancel = (): void => {
		setAsking(false);
		controlRef.current?.focus();
	};

	const confirm = (): void => {
		setDeleting(true);
		setUnanswered(false);
		void (async () => {
			const answer = await deleteProject(call, { project, actor });
			if (answer.outcome === 'unanswered') {
				// Nothing was deleted, so nothing closes and nothing is claimed. The control comes
				// back so the same ask can be made again.
				setDeleting(false);
				setUnanswered(true);
				return;
			}
			if (answer.outcome === 'access-ended') {
				// `Session.call` has already fired the bounce and the router is coming down. Saying
				// anything here would make the panel's last word the wrong one.
				return;
			}
			setDeleting(false);
			setAsking(false);
			onSettled(answer, project);
		})();
	};

	return (
		<>
			<button
				// `aria-label` overrides the visible words rather than adding to them, which is what a
				// list of same-labelled controls needs: `Delete project checkout-web`, not `Delete
				// project` eight times.
				aria-label={`Delete project ${project}`}
				className={`${BADGE_SHAPE} ${BADGE_TYPE} ${className} flex shrink-0 items-center gap-2 border-outline-variant bg-surface-container text-error transition-colors hover:border-error`}
				onClick={open}
				ref={controlRef}
				type="button"
			>
				<Trash2 aria-hidden="true" size={14} strokeWidth={2} />
				Delete project
			</button>
			{/*
			 * **Mounted on `document.body`, not here** — `force-release-control.tsx`'s recorded
			 * reason, and it applies to a card in a list as much as to one in a grid. A dialog
			 * rendered inline inherits every treatment an ancestor carries, including a CSS
			 * `opacity` that applies to `fixed` descendants; a modal asking about one destructive
			 * action is never part of a treatment of the list behind it, which is the same reason
			 * the outcome line lives outside that list.
			 *
			 * The portal is here rather than inside `DeleteProjectDialog` because it is a fact about
			 * where this control mounts it, not about what the dialog is: the dialog stays an
			 * ordinary component that renders where it is put.
			 */}
			{asking
				? createPortal(
						<DeleteProjectDialog
							deleting={deleting}
							onCancel={cancel}
							onConfirm={confirm}
							project={project}
							unanswered={unanswered}
						/>,
						document.body,
					)
				: null}
		</>
	);
}
