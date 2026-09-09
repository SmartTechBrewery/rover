import type { DeleteArchivedGroupAnswer } from '@panel/archive/delete-archived-group.js';
import type { DeleteArchivedTestAnswer } from '@panel/archive/delete-archived-test.js';
import { formatBytes } from '@panel/archive/file-size.js';

/**
 * A settled delete and the test it was about, held together because the line needs both: the
 * answer says what went, and the name says which test — which the screen no longer has an address
 * for by the time anybody reads it.
 */
export interface SettledRemoveTest {
	/**
	 * Which scope settled — added when a **group's** became the second one (#277).
	 *
	 * The two share no phrase (see {@link said}), so the line has to know which it is saying; and it
	 * cannot be read off the answer, the group's arms being the test's arms plus one field. So the
	 * screen labels what it received, exactly as it labels what it built (`Removal`).
	 */
	readonly scope: 'test';
	/**
	 * The request that reached nothing never gets here — it settled nothing, and is not one of the
	 * outcomes (§7's fourth case). It stays in the dialog, which stays open.
	 */
	readonly answer: Extract<
		DeleteArchivedTestAnswer,
		{ outcome: 'deleted' | 'partial' | 'not-found' | 'refused' }
	>;
	/**
	 * The test's own name — what a reader recognises, and what the sentence is about.
	 *
	 * **The name and not the pair**, which is the one place this differs from
	 * `delete-project-notice.tsx`: a settled delete leaves the reader *on the project*, so which
	 * project it was is the breadcrumb above this line rather than something the line has to repeat.
	 * The identity is still the pair (D22) — that is what went on the wire — and this is the half of
	 * it the screen no longer draws anywhere.
	 */
	readonly testName: string;
}

/**
 * A settled delete and the group it was about — {@link SettledRemoveTest}'s shape one scope over.
 *
 * **The group id and not the pair**, for that interface's own reason: a settled group delete leaves
 * the reader *on the project*, so which project it was is the breadcrumb above this line rather
 * than something the line has to repeat.
 */
export interface SettledRemoveGroup {
	readonly scope: 'group';
	/** The request that reached nothing never gets here — it settled nothing (§7's fourth case). */
	readonly answer: Extract<
		DeleteArchivedGroupAnswer,
		{ outcome: 'deleted' | 'partial' | 'not-found' | 'refused' }
	>;
	/** The group's own id — what a reader recognises, and what the sentence is about. */
	readonly groupId: string;
}

/** Whichever of the two scopes settled, as the region takes it. */
export type SettledRemove = SettledRemoveTest | SettledRemoveGroup;

/**
 * What a delete settled, said above the content area.
 *
 * **Four answers that must not collapse into one** (D43, `docs/DESIGN.md` §9). A test that went, an
 * address there was nothing at, a delete that could not take all of it, and a test a live lease is
 * filing into are four different pieces of news and four different next moves — and the last two
 * are the reason this is a region rather than the tree simply changing.
 *
 * **Above the content area rather than on a card, and here that means above the tree as well as
 * above the card.** This is the one thing that differs from `delete-project-notice.tsx`'s
 * arrangement, and it differs because of what a settled delete does to this screen: three of the
 * four outcomes move the selection onto the parent address, so the card the reader pressed the
 * control on is gone and the tree beside it has been re-read. A line inside either column would go
 * with the thing it was about.
 *
 * **It stays until dismissed**, rather than until the next thing replaces it: this is the only
 * place the panel explains why a confirmed action changed nothing, and a line something else clears
 * is a line the operator may never have read. The Archive screen does not poll (§9), so nothing
 * would clear it anyway — which makes the dismiss control the whole of how it goes.
 *
 * Ordinary text, no colour of alarm and no icon of alarm — the panel did what was asked, or says
 * what there was to do instead (§5).
 *
 * The region is rendered in both states, empty when there is nothing to say, so it exists *before*
 * its text does — a live region created together with its content is announced unreliably, which
 * `Profile`'s sign-out line settled already.
 */
export function RemoveNotice({
	settled,
	onDismiss,
}: {
	readonly settled: SettledRemove | undefined;
	readonly onDismiss: () => void;
}) {
	return (
		<div aria-live="polite">
			{settled === undefined ? null : (
				<section className="mt-8 flex items-start justify-between gap-4 border-2 border-outline-variant bg-surface-container-low p-4">
					<p className="max-w-3xl font-body-md text-body-md text-on-surface">
						{settled.scope === 'test'
							? said(settled.answer, settled.testName)
							: saidOfGroup(settled.answer, settled.groupId)}
					</p>
					{/*
					 * Recessive, like every other control in this panel, and labelled by what it does to
					 * this line rather than by what it does to a test.
					 */}
					<button
						className="shrink-0 rounded-sm border-2 border-outline px-4 py-2 font-label-caps text-label-caps text-on-surface uppercase transition-colors hover:border-secondary-fixed-dim hover:text-secondary-fixed-dim"
						onClick={onDismiss}
						type="button"
					>
						Dismiss
					</button>
				</section>
			)}
		</div>
	);
}

/**
 * One sentence per outcome, and **no two share a phrase** (D6) — the pairing rule this screen
 * already keeps between *nothing filed here* and *not readable*, and between the two views' empty
 * states.
 *
 * **A `deleted` line says what it came to rather than that it succeeded**: the bytes the archive
 * gave back and, when there was one, that the `Keep` mark went with it (D35's amendment — the count
 * exists precisely so nobody is surprised by it). A test whose runs weighed nothing therefore reads
 * as one, because `0 B` freed is the truth about it.
 *
 * **`not-found` is not a delete of zero bytes** and must never read as one: the host reached no
 * directory and no kept entry, so the news is that there was nothing of this test on the host —
 * including that what the reader was looking at had already gone out of date.
 *
 * **`partial` names the half that would not go**, because *look at this host's log* is the next
 * move and *which half* is what makes it actionable. It deliberately reports no less than a
 * `deleted` does: the fields say what did go, so this is the fuller sentence rather than the
 * thinner one.
 *
 * **And a `partial` where neither half went is said as one, in words of its own.** The host's
 * `partial` arm has **no floor on how many halves went** (`src/daemon/delete-archived-test.ts`: the
 * outcome is `partial` the moment either is `failed`), so both failing is an ordinary answer — an
 * archive root the daemon's user may not write, a kept-tests store that will not parse — and it is
 * a delete that removed nothing. *The rest went, with 0 B back* would then be a removal claimed
 * where the host's own audit line says `NOT removed` twice, which is the one thing this screen must
 * never do (D42's rule one level down). So the removal clause and the bytes are said only when a
 * half is `removed`, and the neither-went state is a fifth wording rather than the `partial`
 * wording with an empty referent.
 *
 * **`refused` is a live lease, and the next move is obvious and the operator's**: wait for it, or
 * force-release the device holding it on the Devices screen. Nothing at all was touched, which the
 * sentence says so that *refused* is not read as *partly done* — the directory is what that lease
 * is writing into right now (D35).
 */
function said(answer: SettledRemoveTest['answer'], testName: string): string {
	if (answer.outcome === 'not-found') {
		return `There was nothing at that address for ${testName}, and no Keep mark named it either — so nothing was deleted. What the screen was showing had gone out of date, and it has been read again.`;
	}
	if (answer.outcome === 'refused') {
		return `A lease is filing into ${testName} right now, so nothing at all was touched — that directory is what it is writing into. Wait for the lease to end, or force-release the device holding it first.`;
	}
	/*
	 * **`formatBytes` rather than a second formatter**, imported for `size-sentence.ts`'s recorded
	 * reason: the decimal separator is a dot on every machine because the figure is a fact about the
	 * host's disk, and one function already obeys that. `0 B` is the value this line has to be
	 * honest about — a test whose runs held nothing freed nothing, and saying so is what keeps the
	 * sentence a report rather than a congratulation.
	 */
	const freed = `${formatBytes(answer.freedBytes)} came back`;
	const kept = keptClause(answer.keptTestsRemoved);
	if (answer.outcome === 'deleted') {
		return `${testName} is gone: every run filed under it went, and ${freed}.${kept}`;
	}
	/*
	 * Neither half `removed` means nothing went, so there is no *rest* to have gone and no figure to
	 * state — `0` is what `freedBytes` carries there, and printing it beside *the rest went* would
	 * read as a removal that came to nothing rather than as no removal at all. An `absent` half is
	 * not a removal either: there was nothing of it to take.
	 */
	if (!someHalfWent(answer)) {
		return `None of ${testName} could be removed: ${halvesThatStayed(answer)}. This host's log says what stopped it.`;
	}
	return `Some of ${testName} could not be removed: ${halvesThatStayed(answer)}. The rest went, and ${freed}.${kept} This host's log says what stopped it.`;
}

/**
 * That the exemption went with the test, said only when one did — D35's amendment is a *number* on
 * the wire precisely so nobody is surprised by it.
 *
 * The pair is keyed on `<project>/<test_name>`, so one test has at most one entry and the plural
 * branch is the honest reading of a count rather than a case anybody expects: a host that answered
 * two would be saying something this line has no business rounding to one.
 */
function keptClause(removed: number): string {
	if (removed === 0) {
		return '';
	}
	return removed === 1 ? ' Its Keep mark went too.' : ` ${removed} Keep marks went with it.`;
}

/**
 * Whether either half of this delete actually went, which is what the removal clause is a claim
 * about.
 *
 * `removed` and nothing else: `absent` is *there was nothing here*, so counting it would put *the
 * rest went* on a delete that took nothing — the same flattening `not-found` is a separate arm to
 * avoid.
 */
function someHalfWent(
	answer: Extract<SettledRemoveTest['answer'], { outcome: 'partial' }>,
): boolean {
	return answer.archive === 'removed' || answer.keptTests === 'removed';
}

/**
 * One sentence per outcome for a **group**, and **no two lines across the two scopes are the same
 * sentence, each naming its own scope in its leading clause** (D6) — the pairing rule this screen
 * keeps everywhere, and the reason these are sentences of their own rather than the ones above with
 * a noun swapped.
 *
 * **That claim is deliberately weaker than the within-scope one, and it is the true one** (#284
 * review). Two of these do share a closing clause with the test's — *What the screen was showing had
 * gone out of date, and it has been read again.* on `not-found`, and *Wait for the lease to end, or
 * force-release the device holding it first.* on `refused` — because after either answer the next
 * move genuinely is identical, and inventing a second wording for one identical instruction would
 * make the two scopes differ where they do not. What has to differ is what a reader tells the two
 * apart by, and that is the half that leads: *login-flow* against *one of app-bar-top-space's runs*.
 * The guard in `remove-notice.test.tsx` enforces exactly that pair of properties rather than
 * asserting the stronger one this comment used to claim.
 *
 * Each says the thing only this scope can say, which is what makes the four different next moves:
 *
 * - **`deleted` leads with the run count**, because a group has no directory whose size stands for
 *   it — *how many runs went* is the figure nobody can recover afterwards. And it says that runs of
 *   the same tests outside the group stayed, which is D43's surgical reading confirmed after the
 *   fact rather than only promised before it.
 * - **`not-found` is not a delete of zero runs**: no run filed under the project named that group,
 *   so what the reader was looking at had gone out of date.
 * - **`partial` says *ask again***, and that is the sharpest difference from the test's line. This
 *   delete is a bounded walk, so a `partial` may mean *a run would not go* **or** *the walk did not
 *   reach everything* — and in both readings the operator's next move is to run it again once the
 *   host's log says what stopped it. A `partial` that removed nothing is said as one, for the test
 *   line's reason: the host puts no floor on how much went.
 * - **`refused` is a live lease on one of its runs**, with nothing at all touched — said so that
 *   *refused* is not read as *partly done*.
 */
function saidOfGroup(answer: SettledRemoveGroup['answer'], groupId: string): string {
	if (answer.outcome === 'not-found') {
		return `No run filed under this project names ${groupId}, so nothing was deleted. What the screen was showing had gone out of date, and it has been read again.`;
	}
	if (answer.outcome === 'refused') {
		return `A lease is filing into one of ${groupId}'s runs right now, so nothing at all was touched — that run directory is what it is writing into. Wait for the lease to end, or force-release the device holding it first.`;
	}
	const went = `${runsClause(answer.runsRemoved)}, freeing ${formatBytes(answer.freedBytes)}`;
	const emptied = emptiedClause(answer.keptTestsRemoved);
	if (answer.outcome === 'deleted') {
		return `${groupId} holds nothing any more: ${went}. Runs of the same tests that were not in it are still filed.${emptied}`;
	}
	if (answer.runsRemoved === 0) {
		return `Not one run of ${groupId} could be taken. This host's log says what stopped it — put that right and ask again.`;
	}
	return `Only part of ${groupId} could be taken: ${went}. The rest may still be filed.${emptied} This host's log says what stopped it — put that right and ask again.`;
}

/** How many runs went, with the singular said properly: a group of one run is ordinary. */
function runsClause(runsRemoved: number): string {
	return `${runsRemoved} ${runsRemoved === 1 ? 'run went' : 'runs went'}`;
}

/**
 * That a test the delete emptied went with its `Keep` mark, said only when one did.
 *
 * **This is where the group's line carries what its dialog has no `KEPT` row for.** There is no
 * group-level flag (D33), and whether a test is emptied is not knowable until the runs have gone —
 * so the count is news after the fact rather than a field before it, which is exactly what D35's
 * amendment made the number for.
 */
function emptiedClause(removed: number): string {
	if (removed === 0) {
		return '';
	}
	return removed === 1
		? ' One test it emptied was marked Keep, and that mark went with it.'
		: ` ${removed} tests it emptied were marked Keep, and those marks went with them.`;
}

/**
 * Which half the host would not take, named so the sentence is actionable.
 *
 * The two are named in the order the host removes them (`src/daemon/delete-archived-test.ts`),
 * which is also the order that matters: the directory goes first, so a tick that outlived it is the
 * recoverable half and a directory that stayed is the one an operator has to go and look at.
 */
function halvesThatStayed(
	answer: Extract<SettledRemoveTest['answer'], { outcome: 'deleted' | 'partial' }>,
): string {
	const stayed = [
		answer.archive === 'failed' ? 'some of its runs are still filed' : null,
		answer.keptTests === 'failed' ? 'its Keep mark is still set' : null,
	].filter((half): half is string => half !== null);
	return stayed.join(', ');
}
