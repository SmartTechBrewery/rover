import { type ArchiveSize, useArchiveSize } from '@panel/archive/archive-size.js';
import { formatBytes } from '@panel/archive/file-size.js';
import { type KeptTestCount, useKeptTestCount } from '@panel/projects/kept-test-count.js';
import { Gavel, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

/**
 * The asking, in the shape `docs/DESIGN.md` §7 settled for the panel's first destructive action
 * and §10 records for this one.
 *
 * **A modal over the working panel, which keeps the shell** (§7): the rest of the panel still
 * works, so this is not a page and does not rebuild the navigation. Everything §7 recorded so it
 * would not be "fixed" back holds here unchanged, and is asserted in this file's own suite:
 *
 * - **`Cancel` is the filled, prominent control and `Delete project` is the recessive one.** The
 *   safe exit is the easier target. Promoting the destructive action to primary is the specific
 *   mistake that arrangement exists to prevent.
 * - **The header is `secondary-container`, not red.** Analog Horizon defines that colour for
 *   critical alerts and physical power metaphors, which is the weight this needs; leaving red
 *   unused keeps it meaningful if something ever genuinely needs it (§5). The card's own control
 *   carries the `error` accent (§10) and this dialog carries none — the accent belongs to the
 *   affordance in a list of registrations, not to the surface asking about one of them.
 * - **It says in plain words what confirming does**, and that is not softened: the registration
 *   and everything the archive holds for this project go permanently, there is no undo, and a test
 *   marked `Keep` goes with them.
 *
 * **The one deliberate departure from §7's dialog: this one carries numbers about what goes.**
 * Force-releasing ends a lease, and what an operator needs to recognise is the *run* — a device, a
 * holder, a test name. A delete removes data that cannot be got back, so the fact that decides it
 * is **how much**, and the honest way to say that is a figure rather than a warning adjective. Both
 * figures come from reads the panel already has: `measure_archive` over this project's own archive
 * address, which is on `PANEL_METHODS` for the Archive screen's size badge (R49, #259), and
 * `list_kept_tests`, which is on it for the `Keep` flag (D33, #234). **No host read was added for
 * this dialog.**
 *
 * **The reads are here rather than in the control**, because this component is mounted only while
 * the question is open: a Projects screen listing fourteen registrations asks the host nothing
 * extra until somebody presses one of the controls, which is what keeps §10's *one request on
 * navigation* true of the screen.
 *
 * **The three `measure_archive` answers are kept apart and never render alike** (D6): a size,
 * *nothing is filed here* and *the host cannot say* are three different facts, and a `truncated`
 * answer reads as *at least* because its `bytes` is a lower bound (`archive-listing.ts`). The kept
 * count is the same discipline in the other direction — **`0` draws the row rather than hiding
 * it**, because *none of this project's tests are kept* is precisely the fact that stops the
 * sentence below being alarming, and a count the host could not give must not read as `0`.
 */
export function DeleteProjectDialog({
	project,
	deleting,
	unanswered,
	onCancel,
	onConfirm,
}: {
	/** The identifier the host answered `list_projects` with — the whole of what is asked about. */
	readonly project: string;
	/** A confirmed delete is in flight: the control is disabled and says so (§5, no spinner). */
	readonly deleting: boolean;
	/** The last ask reached nothing, so nothing was deleted and this dialog stays open. */
	readonly unanswered: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	/*
	 * **The registration's identifier *is* the archive address's first component** for a registered
	 * project — the hook file's own name, the string a lease carries as its `project` and the
	 * component the archive filed that project's subtree under are one string (D42). So the scope
	 * measured here is the scope the delete will take, and neither side re-derives the other's
	 * name.
	 */
	const size = useArchiveSize([project]);
	const kept = useKeptTestCount(project);
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
				aria-labelledby="delete-project-title"
				aria-modal="true"
				className="flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface"
				role="dialog"
			>
				<header className="flex items-center justify-between gap-3 border-outline-variant border-b-2 bg-secondary-container/20 p-4">
					<span className="flex items-center gap-3 text-secondary-container">
						<TriangleAlert aria-hidden="true" size={20} strokeWidth={2} />
						<h2 className="font-headline-sm text-headline-sm uppercase" id="delete-project-title">
							Confirm project deletion
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
					 * **What goes, in numbers.** The card's own anatomy (§6, §10): a caps label over
					 * its value, the identifier in the monospace face and verbatim, and the two
					 * figures beside it so the sentence below has something to be about.
					 */}
					<dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-sm border-2 border-outline-variant bg-surface-container-low p-4">
						<Field className="col-span-2" label="Project" value={project} />
						<Field label="In the archive" value={archiveReading(size)} />
						<Field label="Kept tests" value={keptReading(kept)} />
					</dl>

					<div className="flex items-start gap-4 border-secondary-container border-l-4 bg-secondary-container/10 p-4">
						<Gavel
							aria-hidden="true"
							className="mt-0.5 shrink-0 text-secondary-container"
							size={20}
							strokeWidth={2}
						/>
						<p className="font-body-md text-body-md text-on-surface-variant">
							This removes the registration and everything the archive holds for this project,{' '}
							<strong className="text-on-surface">permanently</strong>. There is no undo. A test
							marked <span className="font-code-md">Keep</span> goes with it.
						</p>
					</div>

					{/*
					 * The request that reached nothing — not an outcome, and the one answer that leaves
					 * this dialog open with the control usable again (§7's fourth case). The panel
					 * never reports a deletion it did not get, so this says what did not happen and
					 * carries no colour of alarm: nothing is wrong with the project, which is exactly
					 * still registered.
					 */}
					<p aria-live="polite" className="font-body-md text-body-md text-on-surface">
						{unanswered
							? 'Nothing came back from the host, so nothing was deleted and this project is still registered. Ask again — and if the host stays unreachable the panel says so in place of this page.'
							: ''}
					</p>
				</div>

				<footer className="flex items-center justify-end gap-4 border-outline-variant border-t-2 bg-surface-container-low p-4">
					{/*
					 * Recessive, and disabled with a changed label while the ask is out — `Profile`'s
					 * sign-out treatment, which is §5's pending state and never a spinner.
					 */}
					<button
						className={
							deleting
								? 'cursor-not-allowed rounded-sm border-2 border-outline-variant px-6 py-3 font-label-caps text-label-caps text-on-surface-variant uppercase'
								: 'rounded-sm border-2 border-outline px-6 py-3 font-label-caps text-label-caps text-on-surface uppercase transition-colors hover:border-secondary-fixed-dim hover:text-secondary-fixed-dim'
						}
						disabled={deleting}
						onClick={onConfirm}
						type="button"
					>
						{deleting ? 'Deleting…' : 'Delete project'}
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
 * What the archive holds for this project, in the four readings `measure_archive` can produce.
 *
 * | the answer | the value |
 * | --- | --- |
 * | `measured`, complete | `7.7 MB` |
 * | `measured`, truncated | `at least 7.7 MB` |
 * | `absent` | *nothing is filed here* |
 * | `unmeasurable` | *the host cannot say* |
 * | `loading` | *measuring…* |
 *
 * **`absent` is not `0 B`** and neither of them is *the host cannot say* (D6): a project with no
 * archive subtree, an empty one and a host that could not walk it are three different facts about
 * what this delete would take, and the middle one is the only one `0 B` is true of.
 *
 * **A truncated answer never renders a plain figure** — `truncated` means at least one directory
 * that exists was not fully examined, so `bytes` is a lower bound and *at least* is the only
 * honest way to say it. `size-sentence.ts` keeps the same rule for the Archive screen's badge; the
 * words differ because this is a labelled field rather than a sentence naming its own scope.
 */
function archiveReading(size: ArchiveSize): string {
	if (size.status === 'loading') {
		return 'measuring…';
	}
	if (size.status === 'absent') {
		return 'nothing is filed here';
	}
	if (size.status === 'unmeasurable') {
		return 'the host cannot say';
	}
	return `${size.truncated ? 'at least ' : ''}${formatBytes(size.bytes)}`;
}

/**
 * How many of this project's tests are kept, and **`0` draws the row**.
 *
 * *None of its tests are kept* is the fact that stops the sentence beside this field being
 * alarming, so it is said rather than left out — the one place this dialog departs from the
 * absent-rather-than-`0` rule the badges follow, and deliberately: a badge describes a set that is
 * there, and this field answers a question the reader is about to act on.
 *
 * The singular is not cosmetic (`file-size.ts`'s own reason): one kept test is the common case,
 * and `1 tests` is the kind of thing that makes a reader wonder what else the dialog is guessing.
 */
function keptReading(kept: KeptTestCount): string {
	if (kept.status === 'loading') {
		return 'reading…';
	}
	if (kept.status === 'unknown') {
		return 'the host cannot say';
	}
	if (kept.count === 0) {
		return 'none';
	}
	return kept.count === 1 ? '1 test' : `${kept.count} tests`;
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
