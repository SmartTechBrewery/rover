import {
	deleteArchivedGroup,
	type GroupRemoval,
	type SettledDeleteArchivedGroup,
} from '@panel/archive/delete-archived-group.js';
import {
	deleteArchivedTest,
	type SettledDeleteArchivedTest,
	type TestRemoval,
} from '@panel/archive/delete-archived-test.js';
import { BADGE_SHAPE, BADGE_TYPE } from '@panel/components/archive/header-badge.js';
import { RemoveGroupDialog, RemoveTestDialog } from '@panel/components/archive/remove-dialog.js';
import { type Session, useSession } from '@panel/session/session-provider.js';
import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * What one `Remove` control stands over — a **test** or a **group** (#276, #277).
 *
 * A union rather than two components, because everything about the control itself is the same in
 * both: the treatment, the asking, the pending state, the answer that settles nothing and the
 * handing of a settled outcome up to the screen. What differs is the method, the accessible name,
 * the confirmation's own words and figures, and where the screen lands afterwards — and each of
 * those is one branch keyed on `kind` rather than a second copy of the control.
 *
 * The screen builds it (`routes/archive.tsx`, `levelRemoval`), for the reason it builds a
 * {@link TestRemoval}: a group's card in the groups view and a test name's card in the `All` view
 * sit at the same depth, so nothing below the screen can tell which of the two it is drawing.
 */
export type Removal = TestRemoval | GroupRemoval;

/**
 * What this control hands up when the host has answered — **the scope and its answer together,
 * discriminated**, because the two are only meaningful as a pair.
 *
 * A single object rather than two arguments, and `kind` on it rather than only on the removal
 * inside it: narrowing `settled.removal.kind` would tell TypeScript nothing about `settled.answer`,
 * and the screen's whole job here is to say a group's sentence about a group's answer. So the
 * discriminant is at the top, where narrowing it narrows both halves at once.
 *
 * **The answer is already narrowed to the four that settled something.** The request that reached
 * nothing and the session the host refused never leave this component — neither settled anything —
 * so the screen has no re-check to make and no way to be handed one (§7's fourth case).
 */
export type SettledRemoval =
	| {
			readonly kind: 'test';
			readonly removal: TestRemoval;
			readonly answer: SettledDeleteArchivedTest;
	  }
	| {
			readonly kind: 'group';
			readonly removal: GroupRemoval;
			readonly answer: SettledDeleteArchivedGroup;
	  };

/**
 * `Remove` — the Archive screen's second operator control, beside the `Keep` tick on **every card
 * whose tick it stands beside** (`docs/DESIGN.md` §9, D43, R51, #276, #277).
 *
 * **It is on the group's card too since #277**, which closed the phase boundary #276 recorded: a
 * group's tick writes one array in one request, and a group's `Remove` is the surgical run-by-run
 * walk D43 settled — so the tick and the control are now on the same set of cards, and this
 * component is the one that draws both by taking a {@link Removal} rather than a test.
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
	/** What this control is about, and the facts the confirmation states — {@link Removal}. */
	readonly removal: Removal;
	/**
	 * The host answered, one way or the other. Never called for a request that reached nothing —
	 * that one has not settled anything, and the panel may not report a deletion it did not get.
	 */
	readonly onSettled: (settled: SettledRemoval) => void;
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
			const settled = await ask(call, removal, actor);
			if (settled === 'unanswered') {
				// Nothing was deleted, so nothing closes and nothing is claimed. The control comes
				// back so the same ask can be made again.
				setRemoving(false);
				setUnanswered(true);
				return;
			}
			if (settled === 'access-ended') {
				// `Session.call` has already fired the bounce and the router is coming down. Saying
				// anything here would make the panel's last word the wrong one.
				return;
			}
			setRemoving(false);
			setAsking(false);
			onSettled(settled);
		})();
	};

	return (
		<>
			<button
				// `aria-label` overrides the visible word rather than adding to it, which is what a
				// control whose words are the same on every card needs: `Remove test login-flow` or
				// `Remove group app-bar-top-space`, not `Remove` on whichever card happens to be open.
				// The **noun** is in it as well as the name, because the two scopes are drawn at the
				// same depth in their two views and take different things.
				aria-label={
					removal.kind === 'test'
						? `Remove test ${removal.testName}`
						: `Remove group ${removal.groupId}`
				}
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
						removal.kind === 'test' ? (
							<RemoveTestDialog
								onCancel={cancel}
								onConfirm={confirm}
								removal={removal}
								removing={removing}
								unanswered={unanswered}
							/>
						) : (
							<RemoveGroupDialog
								onCancel={cancel}
								onConfirm={confirm}
								removal={removal}
								removing={removing}
								unanswered={unanswered}
							/>
						),
						document.body,
					)
				: null}
		</>
	);
}

/**
 * Make the one call this control's scope names, and answer either **the settled pair** or which of
 * the two non-outcomes happened.
 *
 * **A function rather than a branch inside `confirm`**, and that is not stylistic: the answer has to
 * be narrowed to the four settled arms *while it is still known which method produced it*, which is
 * exactly what a local variable inside one arm of a `kind` check gives and what a shared variable
 * outside both does not ({@link SettledRemoval}).
 *
 * The params are the scope verbatim — a test's two components, or a project component and the
 * opaque group id a lease named, which is never a path and never a second component (R41).
 */
async function ask(
	call: Session['call'],
	removal: Removal,
	actor: string,
): Promise<SettledRemoval | 'unanswered' | 'access-ended'> {
	if (removal.kind === 'test') {
		const answer = await deleteArchivedTest(call, {
			project: removal.project,
			testName: removal.testName,
			actor,
		});
		return answer.outcome === 'unanswered' || answer.outcome === 'access-ended'
			? answer.outcome
			: { kind: 'test', removal, answer };
	}
	const answer = await deleteArchivedGroup(call, {
		project: removal.project,
		groupId: removal.groupId,
		actor,
	});
	return answer.outcome === 'unanswered' || answer.outcome === 'access-ended'
		? answer.outcome
		: { kind: 'group', removal, answer };
}
