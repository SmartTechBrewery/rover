import {
	sizeFieldReading,
	useArchiveSize,
	useGroupedArchiveSize,
} from '@panel/archive/archive-size.js';
import type { GroupRemoval } from '@panel/archive/delete-archived-group.js';
import type { TestRemoval } from '@panel/archive/delete-archived-test.js';
import {
	ConfirmDestructiveDialog,
	type DialogField,
} from '@panel/components/confirm-destructive-dialog.js';

/**
 * The asking, before one archived test and every run under it go (`docs/DESIGN.md` §9, D43, #276).
 *
 * **§7's frame, and it is the same component rather than the same description of one**
 * (`confirm-destructive-dialog.tsx`): `Cancel` filled and prominent with the destructive control
 * recessive, a `secondary-container` header rather than red, `TriangleAlert` and `Gavel`, `Escape`,
 * focus on `Cancel`, no focus trap and a backdrop that is not a control. #272 warned against
 * ending up with two confirmation dialogs, so this file holds no frame at all — what is here is
 * the five rows, the one read behind them and the words.
 *
 * **What goes, in numbers** — §10's departure from §7, and for its reason: force-releasing ends a
 * lease and needs the operator to recognise a run, while a delete removes data that cannot be got
 * back, so the facts that decide it are *how many runs* and *how much disk*. Both are figures
 * rather than warning adjectives.
 *
 * | the field | what it says |
 * | --- | --- |
 * | `PROJECT` | the archive's first component, monospace and verbatim |
 * | `TEST` | its second — the test directory's own name |
 * | `RUNS` | `42 runs`, `1 run`, `none`, or *the host cannot say* |
 * | `ON DISK` | `4.0 MB`, `at least 4.0 MB`, *nothing is filed here*, or *the host cannot say* |
 * | `KEPT` | `yes`, `no`, or *the host cannot say* |
 *
 * **One read, made when the question opens and not before** (§10's rule, §9's *one request on
 * navigation*). This component is mounted only while the dialog is up, so a screen full of rows
 * asks the host nothing extra until somebody presses a control. The other two figures are the
 * screen's own — the run count off a listing the tree needed anyway, the `Keep` mark off the set
 * the ticks are drawn from — and arrive as {@link TestRemoval}.
 *
 * **A second `measure_archive` for a scope the screen may already have measured is accepted**,
 * exactly as `DeleteProjectDialog` accepts one: the hook's cache is per instance and this dialog is
 * transient, and the alternative is threading the badge's measurement down two cards to save one
 * request that is only made when somebody is about to delete something.
 *
 * **The four `measure_archive` readings must not render alike** (D6) — `sizeFieldReading` is that
 * mapping, shared with the Projects screen's confirmation rather than written here a second time.
 */
export function RemoveTestDialog({
	removal,
	removing,
	unanswered,
	onCancel,
	onConfirm,
}: {
	/** The test, and what the screen already knows about it — {@link TestRemoval}. */
	readonly removal: TestRemoval;
	/** A confirmed delete is in flight: the control is disabled and says so (§5, no spinner). */
	readonly removing: boolean;
	/** The last ask reached nothing, so nothing was deleted and this dialog stays open. */
	readonly unanswered: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	/*
	 * **The scope measured is the scope the delete will take** — `<project>/<test_name>`, the same
	 * two components that go on the wire, so neither side re-derives the other's address. In the
	 * groups view this is the *archive's* address rather than the URL's: a group id names no
	 * directory, so there is nothing there to measure (`archiveAddressOf`, and the screen has
	 * already dropped it).
	 */
	const size = useArchiveSize([removal.project, removal.testName]);

	const fields: readonly DialogField[] = [
		{ label: 'PROJECT', value: removal.project, wide: true },
		{ label: 'TEST', value: removal.testName, wide: true },
		{ label: 'RUNS', value: runsReading(removal.runs) },
		{ label: 'ON DISK', value: sizeFieldReading(size) },
		{ label: 'KEPT', value: keptReading(removal.kept) },
	];

	return (
		<ConfirmDestructiveDialog
			confirmLabel="Remove test"
			fields={fields}
			onCancel={onCancel}
			onConfirm={onConfirm}
			pending={removing}
			pendingLabel="Removing…"
			title="Confirm test deletion"
			unanswered={
				unanswered
					? 'Nothing came back from the host, so nothing was deleted and this test is still filed. Ask again — and if the host stays unreachable the panel says so in place of this page.'
					: undefined
			}
			warning={
				/*
				 * **Unsoftened, and the clause a run's card adds is the whole of what the two cards say
				 * differently** (D43). A reader who pressed this on `Run Details` is looking at one
				 * run; the flag is per test and so is the delete, so *the run you are looking at is one
				 * of them* is said in as many words rather than left to be worked out from the fields.
				 */
				<>
					This removes every run of this test and everything filed under them,{' '}
					<strong className="text-on-surface">permanently</strong>. There is no undo. A test marked{' '}
					<span className="font-code-md">Keep</span> goes with it.
					{removal.card === 'run' ? ' The run you are looking at is one of them.' : ''}
				</>
			}
		/>
	);
}

/**
 * How many runs are filed under this test, and **`null` never reads as `0`**.
 *
 * *The host cannot say* and *none* are two different facts about what this delete would take —
 * `childCount: null` is a directory the host could not read into, and the groups view has no
 * listing of the test at all above a run — while `none` is a true claim about an empty test
 * directory (D6). A count is what makes the sentence beside these fields about something, so it is
 * said rather than left out where it is `0`, exactly as the Projects dialog says `none` for a
 * project whose tests are all unkept.
 *
 * The singular is not cosmetic (`file-size.ts`'s own reason): a test with one run is ordinary, and
 * `1 runs` is the kind of thing that makes a reader wonder what else the dialog is guessing at.
 */
function runsReading(runs: number | null): string {
	if (runs === null) {
		return 'the host cannot say';
	}
	if (runs === 0) {
		return 'none';
	}
	return runs === 1 ? '1 run' : `${runs} runs`;
}

/**
 * Whether the operator has this test marked `Keep`, in the three readings there are.
 *
 * **`no` is not the answer for a set the panel could not read** (`pinned-tests.ts`): the kept set
 * is the host's, and while it is out or unreadable a *no* here would be a claim about the
 * operator's own decision that nothing has established — the same reason no tick is drawn then.
 *
 * It is stated even when it is `no`, because the sentence beside these fields says a marked test
 * goes anyway (D35 as amended): a reader has to be able to see that the clause is not about them.
 */
function keptReading(kept: boolean | null): string {
	if (kept === null) {
		return 'the host cannot say';
	}
	return kept ? 'yes' : 'no';
}

/**
 * The asking, before the runs one group holds go (`docs/DESIGN.md` §9, D43, R51 phase 3, #277).
 *
 * **The same frame, the same five-row `<dl>` idiom and the same rules as {@link RemoveTestDialog}**
 * — `confirm-destructive-dialog.tsx` is the component, so `Cancel` filled and prominent with the
 * destructive control recessive, `Escape`, focus on `Cancel`, no focus trap and a backdrop that is
 * not a control are all §7's and are not relitigated here. What is here is the four rows, the one
 * read behind them, and the sentence.
 *
 * | the field | what it says |
 * | --- | --- |
 * | `PROJECT` | the archive's first component, monospace and verbatim |
 * | `GROUP` | the group id a lease named — a caller's own string, shown verbatim |
 * | `RUNS` | `7 runs`, `1 run`, or the same prefixed `at least `, off the grouping answer the screen already holds |
 * | `ON DISK` | `4.0 MB`, `at least 4.0 MB`, *nothing is filed here*, or *the host cannot say* |
 *
 * **There is no `KEPT` row, and its absence is the point.** There is no group-level `Keep` flag and
 * none is invented (D33, D43): the flag is per test, and this delete does not take a test unless it
 * empties it. A row here would either invent a state the host does not hold or answer about tests
 * this delete may well leave standing — so the sentence below carries what a marked test's operator
 * needs to know instead.
 *
 * **`RUNS` is never *the host cannot say***, which is the one place this differs from the test
 * dialog's own field. The control exists only where the grouping answer lists the group's runs — the
 * rule its tick already keeps — so the figure is always the count the same answer the `ON DISK`
 * badge measures is built from (`routes/archive.tsx`, `levelRemoval`). **It can still be a lower
 * bound**, and then it says so: a truncated grouping answer dropped runs this delete's own
 * per-project walk will reach and take, so *at least* is the only honest reading of the sum
 * ({@link runsFieldReading}, `GroupRemoval.runsTruncated`, #284 review). Three readings, then, and
 * never a fourth.
 *
 * **The one read is `measure_archive_groups` and not `measure_archive`**, because a group is not a
 * directory: the archive has no `<group_id>/` level (R41), so its size is a walk over the runs that
 * named it. `useGroupedArchiveSize` is the hook the size badge at this depth already uses, and its
 * four readings are kept apart by the same `sizeFieldReading` (D6). It is made when the question
 * opens and not before, §10's rule, and a second measurement of a scope the badge may already have
 * measured is accepted for {@link RemoveTestDialog}'s recorded reason.
 */
export function RemoveGroupDialog({
	removal,
	removing,
	unanswered,
	onCancel,
	onConfirm,
}: {
	/** The group, and what the screen already knows about it — {@link GroupRemoval}. */
	readonly removal: GroupRemoval;
	/** A confirmed delete is in flight: the control is disabled and says so (§5, no spinner). */
	readonly removing: boolean;
	/** The last ask reached nothing, so nothing was deleted and this dialog stays open. */
	readonly unanswered: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	/*
	 * **The scope measured is the scope the delete will take** — the `(project, groupId)` pair that
	 * goes on the wire, so neither side re-derives the other's idea of what a group is.
	 */
	const size = useGroupedArchiveSize({
		scope: 'group',
		project: removal.project,
		groupId: removal.groupId,
	});

	const fields: readonly DialogField[] = [
		{ label: 'PROJECT', value: removal.project, wide: true },
		{ label: 'GROUP', value: removal.groupId, wide: true },
		{ label: 'RUNS', value: runsFieldReading(removal) },
		{ label: 'ON DISK', value: sizeFieldReading(size) },
	];

	return (
		<ConfirmDestructiveDialog
			confirmLabel="Remove group"
			fields={fields}
			onCancel={onCancel}
			onConfirm={onConfirm}
			pending={removing}
			pendingLabel="Removing…"
			title="Confirm group deletion"
			unanswered={
				unanswered
					? 'Nothing came back from the host, so nothing was deleted and this group’s runs are still filed. Ask again — and if the host stays unreachable the panel says so in place of this page.'
					: undefined
			}
			warning={
				/*
				 * **D43's surgical reading, said in full to the person about to press it** — and it
				 * must not be softened into the test card's wording. Three clauses that are not on
				 * that dialog at all: only the runs *of this group* go, runs of the same tests that
				 * are not in it **stay**, and a test with nothing left afterwards goes with them,
				 * `Keep` and all. The second is the one a reader would otherwise get wrong, because
				 * a test name is not unique to one group (D22); the third is why there is no `KEPT`
				 * row above.
				 */
				<>
					This removes the runs filed under this group and everything in them,{' '}
					<strong className="text-on-surface">permanently</strong>. Runs of the same tests that are
					not in this group stay. There is no undo. A test that has nothing left afterwards goes
					with them, <span className="font-code-md">Keep</span> and all.
				</>
			}
		/>
	);
}

/**
 * The `RUNS` field of a group's confirmation, in all three readings of one grouping answer.
 *
 * | the answer | the value |
 * | --- | --- |
 * | complete | `7 runs`, or `1 run` |
 * | truncated | `at least 7 runs`, or `at least 1 run` |
 *
 * **A truncated answer never renders a plain figure**, `sizeFieldReading`'s own rule one row up and
 * in its own words (D6, `archive-size.ts`): the grouping walk drops runs at either of its bounds
 * while this delete's walk is scoped to one project, so the sum is a floor on what will go rather
 * than a count of it. The two fields the operator confirms on therefore read alike — *at least 7
 * runs* beside *at least 8.1 MB* — instead of one hedging while the other states.
 *
 * **A prefix and nothing else**, exactly as `sizeFieldReading` does it: the plural still follows the
 * number, because *at least 1 runs* would trade one wrong reading for a worse-written one and *at
 * least* is already the whole of the claim being made.
 */
function runsFieldReading(removal: GroupRemoval): string {
	const counted = removal.runs === 1 ? '1 run' : `${removal.runs} runs`;
	return `${removal.runsTruncated ? 'at least ' : ''}${counted}`;
}
