import { sizeFieldReading, useArchiveSize } from '@panel/archive/archive-size.js';
import {
	ConfirmDestructiveDialog,
	type DialogField,
} from '@panel/components/confirm-destructive-dialog.js';
import { type KeptTestCount, useKeptTestCount } from '@panel/projects/kept-test-count.js';

/**
 * The asking, in the shape `docs/DESIGN.md` §7 settled for the panel's first destructive action
 * and §10 records for this one.
 *
 * **The frame is `ConfirmDestructiveDialog`'s and no longer this file's** (#276) — lifted out
 * unchanged when a third destructive action arrived, so that *two destructive actions in one
 * product get one way of asking* is true in code and not only in prose. There is no visual change
 * and this file's own suite did not move a line, which is what makes that extraction checkable
 * rather than asserted. Everything §7 recorded so it would not be "fixed" back now lives with the
 * frame: `Cancel` filled and prominent with `Delete project` recessive, a `secondary-container`
 * header rather than red, `TriangleAlert` and `Gavel`, `Escape`, focus on `Cancel`, no focus trap
 * and a backdrop that is not a control.
 *
 * What is left here is what this dialog *is*: the three rows, the two reads behind them, and the
 * sentence.
 *
 * **It says in plain words what confirming does**, and that is not softened: the registration and
 * everything the archive holds for this project go permanently, there is no undo, and a test
 * marked `Keep` goes with them.
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
 * **The four `measure_archive` answers are kept apart and never render alike** (D6): a size,
 * *nothing is filed here* and *the host cannot say* are three different facts, and a `truncated`
 * answer reads as *at least* because its `bytes` is a lower bound (`archive-listing.ts`). That
 * mapping is `archive-size.ts`'s own (`sizeFieldReading`), shared with the Archive screen's
 * `Remove` confirmation rather than written twice. The kept count is the same discipline in the
 * other direction — **`0` draws the row rather than hiding it**, because *none of this project's
 * tests are kept* is precisely the fact that stops the sentence below being alarming, and a count
 * the host could not give must not read as `0`.
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

	const fields: readonly DialogField[] = [
		{ label: 'Project', value: project, wide: true },
		{ label: 'In the archive', value: sizeFieldReading(size) },
		{ label: 'Kept tests', value: keptReading(kept) },
	];

	return (
		<ConfirmDestructiveDialog
			confirmLabel="Delete project"
			fields={fields}
			onCancel={onCancel}
			onConfirm={onConfirm}
			pending={deleting}
			pendingLabel="Deleting…"
			title="Confirm project deletion"
			unanswered={
				unanswered
					? 'Nothing came back from the host, so nothing was deleted and this project is still registered. Ask again — and if the host stays unreachable the panel says so in place of this page.'
					: undefined
			}
			warning={
				<>
					This removes the registration and everything the archive holds for this project,{' '}
					<strong className="text-on-surface">permanently</strong>. There is no undo. A test marked{' '}
					<span className="font-code-md">Keep</span> goes with it.
				</>
			}
		/>
	);
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
