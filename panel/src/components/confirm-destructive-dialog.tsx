import { Gavel, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';

/**
 * The way this panel asks before it destroys something — **one frame, and every destructive
 * confirmation is its fields and its own words over it** (`docs/DESIGN.md` §7, §9, §10).
 *
 * **Extracted rather than copied, and the extraction is the point** (#276, #272). §7 settled this
 * arrangement for force-releasing a lease; §10 built it again for `Delete project`; §9's `Remove`
 * on an archived test is the third destructive action in the product. *Two destructive actions in
 * one product get one way of asking* was true in prose and about to stop being true in code, so
 * `DeleteProjectDialog`'s frame is lifted here whole and both callers render it. Its own suite is
 * the guard on that: there is no visual change and not one line of
 * `delete-project-dialog.test.tsx` moved.
 *
 * Everything §7 recorded so it would not be "fixed" back lives here now, which is what stops a
 * second dialog re-deriving half of it and getting a piece wrong:
 *
 * - **`Cancel` is the filled, prominent control and the destructive one is recessive.** The safe
 *   exit is the easier target. Promoting the destructive action to primary is the specific mistake
 *   this arrangement exists to prevent, and it is the one a fresh dialog makes.
 * - **The header is `secondary-container`, not red.** Analog Horizon defines red for critical
 *   alerts and physical power metaphors, and leaving it unused keeps it meaningful if something
 *   ever genuinely needs it (§5). The **accent belongs to the affordance** — the control on the
 *   card that opened this, whose accent is `error` — and never to the surface asking about one
 *   thing, so this file writes no colour token of alarm at all.
 * - **`TriangleAlert` in the header and `Gavel` beside the sentence**, `Escape` cancels, focus
 *   lands on `Cancel`, there is **no focus trap**, and the backdrop is **not a control**.
 * - **The words are the caller's and are not softened here.** This frame supplies no adjective of
 *   its own: what confirming does is a fact about one action, so {@link ConfirmDestructiveDialog}
 *   takes the sentence rather than composing one.
 *
 * **What is deliberately *not* here.** No read of the host: each caller's numbers are its own
 * question, asked by the caller while it is mounted (§10's *the reads happen when the dialog
 * opens*), so this frame stays a frame and one dialog's measurement cannot become the other's. No
 * scope, no identifier and no vocabulary of either screen — {@link DialogField} is a label and a
 * value, and which five rows a `<dl>` carries is a table each caller owns.
 *
 * **It is mounted where it is put.** The portal onto `document.body` is the *control's* fact and
 * lives with the control (`delete-project-control.tsx`, `remove-control.tsx`): a dialog rendered
 * inline inherits every treatment an ancestor carries, and which ancestor that is depends on the
 * card, not on the dialog.
 */
export function ConfirmDestructiveDialog({
	title,
	fields,
	warning,
	confirmLabel,
	pendingLabel,
	pending,
	unanswered,
	onCancel,
	onConfirm,
}: {
	/** The header's own words, e.g. `Confirm project deletion`. Also the accessible name. */
	readonly title: string;
	/** What goes, in numbers — the `<dl>`'s rows, in the caller's own order ({@link DialogField}). */
	readonly fields: readonly DialogField[];
	/**
	 * What confirming does, in plain words and unsoftened.
	 *
	 * A `ReactNode` rather than a string because the emphasis is part of the sentence — the one
	 * word a reader must not skim past is `permanently`, and the `Keep` in it is the name of a
	 * control and carries the monospace face.
	 */
	readonly warning: ReactNode;
	/** The recessive control's words, e.g. `Delete project`. */
	readonly confirmLabel: string;
	/** And what it reads while the ask is out — §5's pending state, never a spinner. */
	readonly pendingLabel: string;
	/** A confirmed ask is in flight: the destructive control is disabled and says so. */
	readonly pending: boolean;
	/**
	 * The last ask reached nothing, said in the caller's own words — or `undefined`, which is the
	 * ordinary state and leaves the live region empty.
	 *
	 * The caller's words because *what is still there* is what the sentence has to name, and that
	 * is a registration on one screen and a test on the other. It is **not** a boolean with a
	 * wording here: the one thing this line must do is say truthfully what did not happen.
	 */
	readonly unanswered?: string;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	const titleId = useId();
	const cancelRef = useRef<HTMLButtonElement>(null);

	/*
	 * Focus moves into the dialog on open, and onto `Cancel` rather than onto the destructive
	 * control: the safe exit is the easier target with a keyboard too, not only with a mouse.
	 * Returning it to the control that opened this is the caller's half — it owns that element.
	 */
	useEffect(() => {
		cancelRef.current?.focus();
	}, []);

	/*
	 * Escape cancels, and it is a listener on the document rather than on the dialog so it works
	 * wherever focus has since gone. `keydown` and not `keyup`: a key that opens something on the
	 * way down must not close it on the way up.
	 *
	 * Deliberately **no focus trap**, `force-release-dialog.tsx`'s recorded choice: `aria-modal`
	 * tells assistive technology this is modal, and tabbing past it reaches a panel that genuinely
	 * still works (§7). The backdrop is not a control either — a stray click outside a destructive
	 * confirmation should do nothing at all.
	 */
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				onCancel();
			}
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [onCancel]);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-container-lowest/80 p-4">
			<div
				aria-labelledby={titleId}
				aria-modal="true"
				className="flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface"
				role="dialog"
			>
				<header className="flex items-center justify-between gap-3 border-outline-variant border-b-2 bg-secondary-container/20 p-4">
					<span className="flex items-center gap-3 text-secondary-container">
						<TriangleAlert aria-hidden="true" size={20} strokeWidth={2} />
						<h2 className="font-headline-sm text-headline-sm uppercase" id={titleId}>
							{title}
						</h2>
					</span>
					{/*
					 * The third way out, and it does exactly what `Cancel` does — closing this dialog
					 * is cancelling, since nothing has been asked of the host yet. Labelled `Close`
					 * rather than `Cancel` so the two are not one accessible name on two controls.
					 */}
					<button
						aria-label="Close"
						className="text-on-surface-variant transition-colors hover:text-secondary-container"
						onClick={onCancel}
						type="button"
					>
						<X aria-hidden="true" size={20} strokeWidth={2} />
					</button>
				</header>

				<div className="flex flex-col gap-6 p-6">
					{/*
					 * **What goes, in numbers.** The card's own anatomy (§6, §9, §10): a caps label
					 * over its value, the identifier in the monospace face and verbatim, and the
					 * figures beside it so the sentence below has something to be about.
					 */}
					<dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-sm border-2 border-outline-variant bg-surface-container-low p-4">
						{fields.map((field) => (
							<Field
								className={field.wide === true ? 'col-span-2' : undefined}
								key={field.label}
								label={field.label}
								value={field.value}
							/>
						))}
					</dl>

					<div className="flex items-start gap-4 border-secondary-container border-l-4 bg-secondary-container/10 p-4">
						<Gavel
							aria-hidden="true"
							className="mt-0.5 shrink-0 text-secondary-container"
							size={20}
							strokeWidth={2}
						/>
						<p className="font-body-md text-body-md text-on-surface-variant">{warning}</p>
					</div>

					{/*
					 * The request that reached nothing — not an outcome, and the one answer that leaves
					 * this dialog open with the control usable again (§7's fourth case). The panel
					 * never reports a deletion it did not get, so this says what did not happen and
					 * carries no colour of alarm: nothing is wrong with what was named, which is
					 * exactly still there.
					 *
					 * **Rendered in both states**, empty when there is nothing to say, so the region
					 * exists *before* its text does — a live region created together with its content
					 * is announced unreliably, which `Profile`'s sign-out line settled already.
					 */}
					<p aria-live="polite" className="font-body-md text-body-md text-on-surface">
						{unanswered ?? ''}
					</p>
				</div>

				<footer className="flex items-center justify-end gap-4 border-outline-variant border-t-2 bg-surface-container-low p-4">
					{/*
					 * Recessive, and disabled with a changed label while the ask is out — `Profile`'s
					 * sign-out treatment, which is §5's pending state and never a spinner.
					 */}
					<button
						className={
							pending
								? 'cursor-not-allowed rounded-sm border-2 border-outline-variant px-6 py-3 font-label-caps text-label-caps text-on-surface-variant uppercase'
								: 'rounded-sm border-2 border-outline px-6 py-3 font-label-caps text-label-caps text-on-surface uppercase transition-colors hover:border-secondary-fixed-dim hover:text-secondary-fixed-dim'
						}
						disabled={pending}
						onClick={onConfirm}
						type="button"
					>
						{pending ? pendingLabel : confirmLabel}
					</button>
					<button
						className="rounded-sm bg-primary px-8 py-3 font-label-caps text-label-caps text-on-primary uppercase transition-colors hover:bg-primary-fixed"
						onClick={onCancel}
						ref={cancelRef}
						type="button"
					>
						Cancel
					</button>
				</footer>
			</div>
		</div>
	);
}

/**
 * One row of the `<dl>`: a caps label over its value.
 *
 * **Which rows there are is the caller's**, and so is what each value reads when the host could not
 * answer — three `measure_archive` answers that must not render alike are a fact about that
 * method, not about a dialog (D6). This type carries a label, a value and whether the row takes
 * the whole width, and nothing else.
 */
export interface DialogField {
	readonly label: string;
	readonly value: ReactNode;
	/** The row spans both columns — what a long identifier or a test name needs. */
	readonly wide?: boolean;
}

/** The card's own anatomy, in the dialog: a caps label over its value in the monospace face (§6). */
function Field({
	label,
	value,
	className,
}: {
	readonly label: string;
	readonly value: ReactNode;
	readonly className?: string;
}) {
	return (
		<div className={className}>
			<dt className="font-label-caps text-label-caps text-on-surface-variant uppercase">{label}</dt>
			<dd className="mt-2 break-words font-code-md text-code-md text-on-surface">{value}</dd>
		</div>
	);
}
