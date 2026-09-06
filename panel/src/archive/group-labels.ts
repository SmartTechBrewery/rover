import type { ArchiveGroup } from './archive-listing.js';
import { keyOf } from './archive-path.js';

/**
 * The groups view's label badges, as pure functions over **the same** `list_archive_groups` answer
 * the arrangement itself comes out of (#182, R41, `docs/DESIGN.md` §9).
 *
 * A run's artifacts may carry a `label`, and a group is where comparing them is the point: the same
 * label on an artifact of two runs is the caller saying *these two are the same thing at two
 * moments*. What the tree draws for that is a short letter beside the artifact's name, and this
 * module is the whole of deciding which letter — no React, no host, and unit-tested on its own.
 *
 * **A letter is local to one group and means nothing outside it.** The assignment runs over one
 * group's runs, so the same label in a different group may take a different letter and no letter is
 * stable across groups. That is deliberate rather than a shortfall: there are four letters and an
 * archive may hold any number of labels, so a letter that tried to be stable everywhere would run
 * out globally instead of per group and say less in every group for it.
 *
 * **Inside one group it is completely determined**, and that is not the same criterion. The
 * criterion only forbids stability *across* groups; a letter that moved between two loads of the
 * same group would be a bug a reader could see, so the order is the answer's own — runs in the
 * order the host walked them, artifacts in the name order the host read them in — and never the
 * order a pane happens to draw those runs in. The tree and the card beside it reverse at the run
 * level through `level-order.ts`, so an assignment that followed what is drawn would give one group
 * two alphabets.
 *
 * **`@` is a case rather than a corner.** A group holding more distinct labels than there are
 * letters gives every remaining one `@`: the badge stops distinguishing them and says so, and what
 * the row says about the artifact does not change. The palette in
 * `panel/src/components/archive/label-badge.tsx` draws it as the quietest thing on the card, and §9
 * records that a longer alphabet is a commissioned categorical ramp for Analog Horizon
 * (`ai/RULES.md` §8) rather than a fifth hue picked at the keyboard.
 *
 * **The label is the archive's, never the caller's own string** (`archive-listing.ts`). It went
 * through `pathSegment` on the way into the artifact's file name, which truncates and rewrites, so
 * what comes back is what was *filed*. Nothing here parses it, trims it or lower-cases it (D22);
 * two labels are the same label exactly when the host answered the same string for both.
 */

/**
 * The letters a group hands out, in order, and **four is deliberate** (`docs/DESIGN.md` §9).
 *
 * Analog Horizon has three accent families plus `error`, and §5 already spends the tertiary green,
 * the primary-container blue and the secondary-container orange on device states — so what is left
 * that reads as a *category* rather than as an outcome is three `-fixed` steps and one neutral.
 * There is no honest fifth hue, which is why the overflow below is a first-class case.
 */
export const LABEL_LETTERS = ['A', 'B', 'C', 'D'] as const;

/** What every distinct label past the fourth takes. It names nothing, and that is what it says. */
export const OVERFLOW_LETTER = '@';

export type LabelLetter = (typeof LABEL_LETTERS)[number] | typeof OVERFLOW_LETTER;

/** One artifact's badge — the letter it is drawn as, and the label the archive filed it under. */
export interface ArtifactLabel {
	readonly letter: LabelLetter;
	/** Verbatim from the answer. A letter is a code; this is the thing that has a meaning. */
	readonly label: string;
}

/** No artifact here carries a label — the `All` view's answer at every address, and a group's. */
export const NO_LABELS: ReadonlyMap<string, ArtifactLabel> = new Map();

/**
 * The letter each distinct label of **one group** takes, in the order the host answered them.
 *
 * Insertion order is the assignment: the first label the walk met is `A`, and a label already seen
 * keeps the letter it was given, which is the whole of *the same label is the same letter
 * everywhere in this group*.
 */
export function lettersOfGroup(group: ArchiveGroup): ReadonlyMap<string, LabelLetter> {
	const letters = new Map<string, LabelLetter>();
	for (const run of group.runs) {
		for (const artifact of run.artifacts) {
			if (!letters.has(artifact.label)) {
				// `.at` rather than an index, so the fifth label's `undefined` is in the type and the
				// overflow is a branch the compiler knows about rather than one it takes on trust.
				letters.set(artifact.label, LABEL_LETTERS.at(letters.size) ?? OVERFLOW_LETTER);
			}
		}
	}
	return letters;
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
	const letters = lettersOfGroup(group);
	const labelled = new Map<string, ArtifactLabel>();
	for (const run of group.runs) {
		for (const artifact of run.artifacts) {
			labelled.set(keyOf(artifact.path), {
				letter: letters.get(artifact.label) ?? OVERFLOW_LETTER,
				label: artifact.label,
			});
		}
	}
	return labelled;
}
