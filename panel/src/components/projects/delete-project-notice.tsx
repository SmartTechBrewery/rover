import { formatBytes } from '@panel/archive/file-size.js';
import type { DeleteProjectAnswer } from '@panel/projects/delete-project.js';

/**
 * A settled delete and the project it was about, held together because the line needs both: the
 * answer says what went, and the identifier says which registration — which the list no longer
 * carries by the time anybody reads it.
 */
export interface SettledDeleteProject {
	/**
	 * The request that reached nothing never gets here — it settled nothing, and is not one of the
	 * outcomes (§7's fourth case). It stays in the dialog, which stays open.
	 */
	readonly answer: Extract<
		DeleteProjectAnswer,
		{ outcome: 'deleted' | 'partial' | 'not-registered' | 'refused' }
	>;
	readonly project: string;
}

/**
 * What a delete settled, said above the list.
 *
 * **Four answers that must not collapse into one** (D42, `docs/DESIGN.md` §10). A project that
 * went, a project there was no registration for, a delete that could not take all of it, and a
 * project with a live lease on it are four different pieces of news and four different next moves
 * — and the last two are the reason this is a region rather than the list simply changing.
 *
 * **Above the list rather than on a card, for all four.** Three of them have to be: the card is
 * gone from the next `list_projects` for two of them, and the third's card is still there saying
 * nothing about a delete that did not happen. The fourth is here for consistency of place — one
 * region, one wording per outcome — which is `force-release-notice.tsx`'s own arrangement and §7's
 * rule.
 *
 * **It stays until dismissed**, rather than until the next thing replaces it: this is the only
 * place the panel explains why a confirmed action changed nothing, and a line something else clears
 * is a line the operator may never have read. The screen does not poll, so nothing would clear it
 * anyway — which makes the dismiss control the whole of how it goes.
 *
 * Ordinary text, no colour of alarm and no icon of alarm — the panel did what was asked, or says
 * what there was to do instead (§5).
 *
 * The region is rendered in both states, empty when there is nothing to say, so it exists *before*
 * its text does — a live region created together with its content is announced unreliably, which
 * `Profile`'s sign-out line settled already.
 */
export function DeleteProjectNotice({
	settled,
	onDismiss,
}: {
	readonly settled: SettledDeleteProject | undefined;
	readonly onDismiss: () => void;
}) {
	return (
		<div aria-live="polite">
			{settled === undefined ? null : (
				<section className="mt-8 flex items-start justify-between gap-4 border-2 border-outline-variant bg-surface-container-low p-4">
					<p className="max-w-3xl font-body-md text-body-md text-on-surface">
						{said(settled.answer, settled.project)}
					</p>
					{/*
					 * Recessive, like every other control in this panel, and labelled by what it does to
					 * this line rather than by what it does to a project.
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
 * already keeps between its two empty states and between the card's two arms.
 *
 * **A `deleted` line says what it came to rather than that it succeeded**: the bytes the archive
 * gave back and, when there were any, how many kept exemptions went with them (D35's amendment —
 * the count exists precisely so nobody is surprised by it). A delete of a registration whose
 * archive held nothing therefore reads as one, because `0 B` freed is the truth about it.
 *
 * **`not-registered` is not a delete of zero bytes** and must never read as one: the host reached
 * no hook file, no archive subtree and no kept entry, so the news is that there was nothing of this
 * project on the host — including that the list a reader was looking at was already out of date.
 *
 * **`partial` names the halves that would not go**, because *look at this host's log* is the next
 * move and *which half* is what makes it actionable. It deliberately reports no less than a
 * `deleted` does: the fields say what did go, so this is the fuller sentence rather than the
 * thinner one.
 *
 * **And a `partial` where no half went is said as one, in words of its own.** The host's `partial`
 * arm has **no floor on how many halves went** (`src/daemon/delete-project.ts`: the outcome is
 * `partial` the moment any one of the three is `failed`), so all three failing is an ordinary
 * answer — a read-only `~/.rover`, or three roots owned by another user — and it is a delete that
 * removed nothing. *The rest went, with 0 B back* would then be a removal claimed where the host's
 * own audit line says `NOT removed` three times, which is the one thing this screen must never do
 * (D42). So the removal clause and the bytes are said only when some half is `removed`, and the
 * all-failed state is a fifth wording rather than the `partial` wording with an empty referent.
 *
 * **`refused` is a live lease, and the next move is obvious and the operator's**: wait for it, or
 * force-release it first on the Devices screen. Nothing at all was touched, which the sentence says
 * so that *refused* is not read as *partly done*.
 */
function said(answer: SettledDeleteProject['answer'], project: string): string {
	if (answer.outcome === 'not-registered') {
		return `There was no registration for ${project} on this host, and nothing filed under it either — so nothing was deleted. The list above was out of date, and has been read again.`;
	}
	if (answer.outcome === 'refused') {
		return `A lease on ${project} is live, so nothing was touched — the host still owes that lease its teardown, and the archive is what it is writing into right now. Wait for it to end, or force-release the device holding it first.`;
	}
	/*
	 * **`formatBytes` rather than a second formatter**, imported for `size-sentence.ts`'s recorded
	 * reason: the decimal separator is a dot on every machine because the figure is a fact about
	 * the host's disk, and one function already obeys that. `0 B` is the value this line has to be
	 * honest about — a project with nothing filed under it freed nothing, and saying so is what
	 * keeps the sentence a report rather than a congratulation.
	 */
	const freed = `${formatBytes(answer.freedBytes)} back`;
	const kept =
		answer.keptTestsRemoved === 0
			? ''
			: ` ${answer.keptTestsRemoved === 1 ? 'One test marked Keep went' : `${answer.keptTestsRemoved} tests marked Keep went`} with it.`;
	if (answer.outcome === 'deleted') {
		return `${project} is gone: the registration and everything the archive held for it, with ${freed}.${kept}`;
	}
	/*
	 * No half `removed` means nothing went, so there is no *rest* to have gone and no figure to
	 * state — `0 B` is what `freedBytes` carries there, and printing it beside *the rest went* would
	 * read as a removal that came to nothing rather than as no removal at all. An `absent` half is
	 * not a removal either: there was nothing of it to take.
	 */
	if (!someHalfWent(answer)) {
		return `Nothing of ${project} could be removed: ${halvesThatStayed(answer)}. This host's log says what stopped it.`;
	}
	return `Some of ${project} could not be removed: ${halvesThatStayed(answer)}. The rest went, with ${freed}.${kept} This host's log says what stopped it.`;
}

/**
 * Whether any half of this delete actually went, which is what the removal clause is a claim about.
 *
 * `removed` and nothing else: `absent` is *there was nothing here*, so counting it would put *the
 * rest went* on a delete that took nothing — the same flattening `not-registered` is a separate arm
 * to avoid.
 */
function someHalfWent(answer: Extract<DeleteProjectAnswer, { outcome: 'partial' }>): boolean {
	return (
		answer.registration === 'removed' ||
		answer.archive === 'removed' ||
		answer.keptTests === 'removed'
	);
}

/**
 * Which halves the host would not take, named so the sentence is actionable.
 *
 * The three are named in the order the host removes them (`src/daemon/delete-project.ts`), which is
 * also the order that matters: a registration that went means the host runs strictly less already,
 * whatever happened to the rest.
 */
function halvesThatStayed(
	answer: Extract<DeleteProjectAnswer, { outcome: 'deleted' | 'partial' }>,
): string {
	const stayed = [
		answer.registration === 'failed' ? 'its registration is still there' : null,
		answer.archive === 'failed' ? 'part of its archive is still there' : null,
		answer.keptTests === 'failed' ? 'its Keep flags are still set' : null,
	].filter((half): half is string => half !== null);
	return stayed.join(', ');
}
