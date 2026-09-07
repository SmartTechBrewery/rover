import type { ArchiveGroup } from './archive-listing.js';
import { keyOf } from './archive-path.js';

/**
 * The groups view's label badges, as pure functions over **the same** `list_archive_groups` answer
 * the arrangement itself comes out of (#182, R41, `docs/DESIGN.md` §9).
 *
 * A run's artifacts may carry a `label`, and a group is where comparing them is the point: the same
 * label on an artifact of two runs is the caller saying *these two are the same thing at two
 * moments*. What the tree draws for that is a short **number** beside the artifact's name, and this
 * module is the whole of deciding which number — no React, no host, and unit-tested on its own.
 *
 * **A number is local to one group and means nothing outside it.** The assignment runs over one
 * group's runs, so the same label in a different group may take a different number and no number is
 * stable across groups. That is deliberate rather than a shortfall, and the reason is no longer the
 * one #182 and #197 gave — an integer does not run out, so *the alphabet ends at `Z`* has stopped
 * being an argument for anything. What is left is the honest reason: a number stable across the
 * whole archive would have to be handed out by a registry over every label anywhere, and the only
 * answer there is is **one bounded walk that says when it was cut short**
 * (`archive-listing.ts`, `truncated`). A global number would therefore change under a reader when
 * the walk stopped a directory earlier, which is worse than a number that never claimed to travel.
 *
 * **Inside one group it is completely determined**, and that is not the same criterion. The
 * criterion only forbids stability *across* groups; a number that moved between two loads of the
 * same group would be a bug a reader could see, so the order is the answer's own — runs in the
 * order the host walked them, artifacts in the name order the host read them in — and never the
 * order a pane happens to draw those runs in. The tree and the card beside it reverse at the run
 * level through `level-order.ts`, so an assignment that followed what is drawn would give one group
 * two numberings.
 *
 * **There is no ceiling and no overflow value** (#206). `@` is gone, and so is the twenty-seventh
 * label it stood for: the numbers run `1`, `2`, `3`, … and an integer has no last value, so nothing
 * a group can file is ever left undistinguished. The record of why `@` existed is kept in
 * `docs/DESIGN.md` §9 rather than as a fallback here for a case that can no longer arise — it was
 * the arity of the *alphabet* twice over, first four letters and then twenty-six, and the alphabet
 * was never what the badge needed. What is unbounded here is the **glyph**; the palette keeps a
 * ceiling of its own and `label-badge.tsx` is where the colour wraps at it.
 *
 * **A number is a code for a label and never a rank.** Nothing here sorts, scores or compares:
 * `1` is *the first label this group's walk met*, and Rover reports no verdicts (`ai/RULES.md` §1).
 *
 * **The label is the archive's, never the caller's own string** (`archive-listing.ts`). It went
 * through `pathSegment` on the way into the artifact's file name, which truncates and rewrites, so
 * what comes back is what was *filed*. Nothing here parses it, trims it or lower-cases it (D22);
 * two labels are the same label exactly when the host answered the same string for both.
 */

/** One artifact's badge — the number it is drawn as, and the label the archive filed it under. */
export interface ArtifactLabel {
	/** The first label this group's walk met is `1`, the next new one `2`, and so on without end. */
	readonly number: number;
	/** Verbatim from the answer. A number is a code; this is the thing that has a meaning. */
	readonly label: string;
}

/** No artifact here carries a label — the `All` view's answer at every address, and a group's. */
export const NO_LABELS: ReadonlyMap<string, ArtifactLabel> = new Map();

/**
 * One group's whole answer to both questions, out of **one** walk: the number each distinct label
 * takes, and every labelled artifact keyed by its archive address.
 *
 * Both come off one traversal on purpose. Two walks would be two statements of *what the host's
 * answer order is*, and the one rule this module has to keep — the same label is the same number
 * everywhere in this group — is exactly the thing that drifts when a rule is written twice. It also
 * leaves no branch for a label the numbering somehow missed: the number is read and written in the
 * same step, so there is no lookup here that can come back empty and no fallback standing in for a
 * case that cannot happen.
 *
 * `numbers.size + 1` is the assignment: the map holds the labels already seen, so the next new one
 * takes the next integer and a label already seen keeps what it was given.
 */
function walkGroup(group: ArchiveGroup): {
	readonly numbers: ReadonlyMap<string, number>;
	readonly labelled: ReadonlyMap<string, ArtifactLabel>;
} {
	const numbers = new Map<string, number>();
	const labelled = new Map<string, ArtifactLabel>();
	for (const run of group.runs) {
		for (const artifact of run.artifacts) {
			const number = numbers.get(artifact.label) ?? numbers.size + 1;
			numbers.set(artifact.label, number);
			labelled.set(keyOf(artifact.path), { number, label: artifact.label });
		}
	}
	return { numbers, labelled };
}

/**
 * The number each distinct label of **one group** takes, in the order the host answered them —
 * `1` for the first label the walk met, and the next integer for every new one after it.
 */
export function numbersOfGroup(group: ArchiveGroup): ReadonlyMap<string, number> {
	return walkGroup(group).numbers;
}

/**
 * Every labelled artifact of one `(project, groupId)`, **keyed by its archive address** — the
 * lookup the tree's rows are matched against.
 *
 * The key is `keyOf` over the answer's own `path`, which is the components a `list_archive` walk
 * would have reached the artifact by, so a row composed from a listing and an artifact answered by
 * the grouping walk are the same string exactly when they are the same file. The groups view's
 * *tree* address carries the group id in front of it; `archiveAddressOf` is what drops it, and
 * `tree-source.ts` has already done so at every depth that reads this.
 *
 * A group nothing answered for gives {@link NO_LABELS}, which is *no badge on any row* — the same
 * thing an unlabelled group gives, because in both cases there is no label to draw.
 */
export function labelledArtifactsOf(
	groups: readonly ArchiveGroup[],
	project: string,
	groupId: string,
): ReadonlyMap<string, ArtifactLabel> {
	const group = groups.find(
		(candidate) => candidate.project === project && candidate.groupId === groupId,
	);
	if (group === undefined) {
		return NO_LABELS;
	}
	return walkGroup(group).labelled;
}
