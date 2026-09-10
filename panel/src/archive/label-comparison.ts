import type { ArchiveGroup } from './archive-listing.js';
import { keyOf } from './archive-path.js';
import { labelledArtifactsOf } from './group-labels.js';
import { oldestFirst } from './level-order.js';
import { variantOf } from './variant-name.js';

/**
 * **Which artifacts of a group are the same thing at two moments** — as a pure function over the
 * same `list_archive_groups` answer the arrangement and the badges already come out of (#199, R41,
 * `docs/DESIGN.md` §9).
 *
 * A lease names a group and files an artifact under a label; the same label on an artifact of two
 * runs is the caller saying *these two are the same thing at two moments* (#150). `group-tree.ts`
 * turns that answer into levels and `group-labels.ts` into badges; this module turns it into the
 * one thing the grouping exists for — the set of artifacts a selected artifact is comparable with.
 * No React, no host, unit-tested on its own, and **one walk of an answer already in memory**: no
 * second request, no second cache and no hook.
 *
 * **The label is the archive's, never the caller's own string** (`archive-listing.ts`). It went
 * through `pathSegment` on the way into the artifact's file name, which truncates and rewrites
 * irreversibly, so what comes back is what was *filed*. Nothing here trims it, lower-cases it or
 * normalises it (D22): two labels are the same label exactly when the host answered the same
 * string for both, so two labels differing only in case are two labels.
 *
 * **Nothing about a score or a verdict is computed here or anywhere else, and the diff is not this
 * module's** (amended in place 2026-09-10, per `ai/RULES.md` §1 — this said *nothing about a diff, a
 * score or a verdict is computed here or anywhere else*). The reversal is the card's and is argued
 * out there (`comparison-card.tsx`): a reader may now ask for boxes over the second of two panes,
 * computed by `image-diff.ts` from the bytes the panes already hold. **What is untouched is this
 * module's own job** — it answers *which artifacts* and *in what order*, over one host answer, and
 * that is still the whole of it. It reads no bytes, caps no arity, and knows nothing about pixels.
 * Judging what a difference means is still the person's (`docs/DESIGN_INITIAL_PROMPT.md` §4).
 */

/** One pane of the card: the artifact, and the run that filed it. */
export interface ComparisonPane {
	/** The run's four-component archive address, `[project, testName, run, serial]`, verbatim. */
	readonly run: readonly string[];
	/** The artifact's own archive address, verbatim from the answer — no group id in it. */
	readonly path: readonly string[];
	/**
	 * **Which arm of the investigation this pane is** — the part of the run's test name that is not
	 * the group's, which is the one thing two panes of one comparison actually differ by, **as the
	 * caller wrote it**. `variant-name.ts` is how little is read out of the name to get it, and
	 * `variantPhrase` there is what the pane head says out loud over it.
	 */
	readonly variant: string;
}

export interface LabelComparison {
	/** The label **as the archive filed it**. */
	readonly label: string;
	/**
	 * The badge number this label takes **in this group** — `group-labels.ts`'s own assignment and
	 * not a second opinion about it, so the badge heading the card is the badge on the tree row that
	 * opened it (#182, numbered by #206, `label-badge.tsx`). A number is a code local to one group;
	 * {@link label} is the meaning.
	 */
	readonly number: number;
	/** Oldest run first, and always two or more — one pane is not a comparison. */
	readonly panes: readonly ComparisonPane[];
}

/** How deep a run's own address is in the archive: `[project, test_name, run, serial]` (#129). */
const RUN_ADDRESS_DEPTH = 4;

/**
 * Every artifact of one `(project, groupId)` filed under **the label the selected artifact carries**
 * — or `null` when there is no comparison to draw.
 *
 * `address` is the archive's own path for the selection (`archiveAddressOf` has already dropped the
 * group id), and it is matched by `keyOf` against the answer's own `path` — the same key
 * `labelledArtifactsOf` matches a tree row by, so a row and an answer artifact are the same file
 * exactly when the strings are equal.
 *
 * The four `null`s are each *there is nothing to compare*, and the card falls back to the single
 * preview for all of them:
 *
 * - the answer holds no such `(project, groupId)` — including while the grouping walk is still out;
 * - the selected address is not one of that group's labelled artifacts, so it carries no label —
 *   which is every row of the `All` view by construction, and every unlabelled artifact anywhere;
 * - fewer than two artifacts carry the label. **One pane is not a comparison**, so a label only one
 *   run filed draws the preview it draws today and an archive that never used labels sees no change.
 *
 * **One pane per labelled artifact, not per run**, which in the common case — one artifact per label
 * per run — is the same thing. Nothing enforces arity (R41), so an arm may file the same label three
 * times; all three are panes, in the answer's own order and adjacent, because showing the first of
 * them would drop evidence and invent a selection the archive never made (D22). Each pane says which
 * run it is, so two panes naming one run read as two artifacts of one run.
 */
export function comparisonAt(
	groups: readonly ArchiveGroup[],
	project: string,
	groupId: string,
	address: readonly string[],
): LabelComparison | null {
	const group = groups.find(
		(candidate) => candidate.project === project && candidate.groupId === groupId,
	);
	if (group === undefined) {
		return null;
	}
	// **The label and its badge number come out of one lookup**, which is `group-labels.ts`'s own
	// walk of this same answer rather than a second reading of it (#206). Asking for the number
	// separately would have meant a lookup that can come back empty and a fallback standing in for
	// a case that cannot happen — the label was read *from* this group, so this group numbered it.
	const selected = labelledArtifactsOf(groups, project, groupId).get(keyOf(address));
	if (selected === undefined) {
		return null;
	}
	const panes: ComparisonPane[] = [];
	for (const run of group.runs) {
		// A run whose address is not the archive's four levels is skipped, exactly as
		// `group-tree.ts`'s `placedRunsOf` skips it and for its reason: placing it would mean
		// guessing which of its components was the run — and which of them was the test name the
		// pane's head is about.
		if (run.path.length !== RUN_ADDRESS_DEPTH) {
			continue;
		}
		const variant = variantOf(run.path.at(1) ?? '', groupId);
		for (const artifact of run.artifacts) {
			if (artifact.label === selected.label) {
				panes.push({ run: run.path, path: artifact.path, variant });
			}
		}
	}
	if (panes.length < 2) {
		return null;
	}
	// The run directory's own name — index 2 of a four-component run address, and the component
	// that leads with the host's UTC timestamp. `oldestFirst` is why this reads left to right.
	return {
		label: selected.label,
		number: selected.number,
		panes: oldestFirst(panes, (pane) => pane.run.at(-2) ?? ''),
	};
}
