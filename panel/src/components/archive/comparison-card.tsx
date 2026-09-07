import { keyOf } from '@panel/archive/archive-path.js';
import { useArchivedArtifact } from '@panel/archive/artifact.js';
import { UNKNOWN } from '@panel/archive/file-size.js';
import type { ComparisonPane, LabelComparison } from '@panel/archive/label-comparison.js';
import { decomposeRunName } from '@panel/archive/run-identity.js';
import { ArtifactBodyView, OpenInANewWindow } from './artifact-body-view.js';
import { CardHeading, ContentsCard, Field } from './contents-card.js';

/**
 * **One label, one row of panes, one pane per artifact filed under it** — the groups view's card
 * beside the tree while a *labelled* artifact is open (#199, `docs/DESIGN.md` §9).
 *
 * This is the thing the grouping exists for. A lease names a group and files an artifact under a
 * label, and the same label on an artifact of two runs is the caller saying *these two are the same
 * thing at two moments* (#150, R41). Until now the reader compared a before and an after by clicking
 * one, remembering it, and clicking the other; the panes stand them side by side instead, and
 * `label-comparison.ts` decides which artifacts they are and in what order.
 *
 * **Oldest on the left, newest on the right**, so a before/after reads as a before/after. That is a
 * deliberate local departure from *runs are listed most recent first, in the tree and in the
 * contents card alike*, and it is the one exception on this screen: the tree and every level listing
 * are unchanged, and both directions are decided by `level-order.ts` (`oldestFirst`) so no pane
 * holds a second opinion about it. §9 records the exception and its reason in place.
 *
 * **Two is the common case and nothing caps N.** A group may hold seven runs (R41), so the row takes
 * however many panes the answer gives it: each pane grows into an equal share and stops shrinking at
 * {@link PANE_MIN}, and past that the **row** scrolls inside the card rather than widening it. The
 * card's own `min-w-0 overflow-hidden` (`ContentsCard`) is the other half of that, and it is what
 * keeps the page body from ever scrolling horizontally — the row beside the tree is two fractions
 * that shrink into the gutter (#172), and a card widened by its contents pushes it past the window.
 *
 * **`Compare — Visual Diff (V2)` (`897632dcadce44de9bdee74a94da14f5`) is a layout reference only**,
 * and it is the one remaining uncorrected screen in the project (§11) — the operator decided not to
 * run a correction round for this work, so the layout comes from it and everything else from §9 and
 * the corrected Archive screens. What is taken: a horizontal split of panes, each pane headed by the
 * artifact's own name in a chip, run identity stated above the artifacts. What is **not**, and none
 * of it is reproduced anywhere below: its `SUCCESS` chip, its `PASS` log line, `COMPLETE`, green
 * ticks and red crosses, the words *Visual Regression*, `RUN A (BASELINE)` / `RUN B (CURRENT)`, the
 * `HASH` and `BRANCH` rows, `SWAP`, `RESYNC SCROLL`, its second navigation bar and global
 * `FORCE_RELEASE`, its mid-sidebar `Profile`, its per-arm orange/green pane borders (a red/green
 * pairing by another name), its simulated phone status bar and its `object-cover` crop.
 *
 * **No diff, no score, no verdict, no highlight of what changed.** The comparison is visual and
 * human-judged (`docs/DESIGN_INITIAL_PROMPT.md` §4): Rover puts the artifacts next to each other and
 * the person decides, because judging is the agent's job (`ai/RULES.md` §1). Nothing here reads as an
 * outcome, **neither arm is authoritative** — Rover has no baseline, so there is no `BASELINE` and
 * no `CURRENT` — and **no fact Rover does not have** is drawn: no commit hash and no git branch,
 * because what the archive knows is the project, the test name, the run's own directory name, the
 * device serial and the run's two files.
 *
 * **No second navigation and nothing that becomes an explorer.** No zoom, pan, rotate, filmstrip or
 * next/previous arrows, and no picker: **the tree is how another artifact is chosen** (#160). The
 * address is unchanged too, so a reload and a shared link land on this same card.
 *
 * **No sync scroll, and no control for one** — decided explicitly rather than by default. The
 * reference screen carries a `RESYNC SCROLL` button; an artifact contained at `70vh` has nothing to
 * scroll, and a control that does nothing is worse than none (§3). A text pane scrolls inside its
 * own body, independently, exactly as the single preview's does.
 */

/**
 * How narrow a pane may get before the row scrolls instead — **settled in a browser rather than
 * derived**, the way #172 settled the row's own fractions. Written out because Tailwind reads these
 * class names out of the source text.
 *
 * It is a floor on the **pane** and never on the card, which is what keeps #172's rule intact: the
 * split of the row beside the tree stays a fraction, and content wider than the card is absorbed by
 * this card's own scroll rather than by the page's.
 *
 * **The number is what makes two panes fit at the narrowest window the row is horizontal at.** At
 * 1280 the card is 554px, of which 550px is inside its border and 518px inside the row's `p-4` — so
 * two panes and one `--gutter` have to come to that, and 260px did not: it overflowed by 22px and
 * scrolled the common case. Measured in headless Chrome on the built card at 900px tall, with a
 * 1080x2400 portrait screenshot in every pane:
 *
 * | window | tree / card | 2 panes | 3, 7 and 9 panes |
 * | --- | --- | --- | --- |
 * | 1280 | 369.56 / 554.44 | 249.22px each, no scroll | 240px each, the row scrolls |
 * | 1440 | 433.58 / 650.42 | 297.20px each, no scroll | 240px each, the row scrolls |
 * | 1728 | 503.97 / 756.03 | 350.02px each, no scroll | 240px each, the row scrolls |
 *
 * **And the page never scrolls horizontally at any of them**, with two panes or with nine, which is
 * the property this floor exists for. The screenshot came out 415px tall in a 240px pane and 569px
 * in a 350px one — so inside a pane it is `max-w-full` that bounds it and `max-h-[70vh]` only takes
 * over once a pane is wide, which is the same 569px #140 measured for the single preview.
 */
const PANE_MIN = 'min-w-[240px]';

export function ComparisonCard({ comparison }: { readonly comparison: LabelComparison }) {
	return (
		<ContentsCard
			header={
				/*
				 * **The label is what names the card**, and it is the label *as the archive filed it* —
				 * never the caller's own string, which `pathSegment` truncated and rewrote irreversibly
				 * (`archive-listing.ts`, and the rule §9 already states for `OWNER`). The caption above
				 * it is the `Field` label's own treatment, so the strip says *what the name is* without
				 * inventing one. No count, no chip, no glyph and no control in it.
				 */
				<div className="flex flex-col gap-1">
					<span className="font-label-caps text-[10px] text-outline uppercase">LABEL</span>
					<CardHeading>{comparison.label}</CardHeading>
				</div>
			}
		>
			<div className="flex gap-(--gutter) overflow-x-auto p-4">
				{comparison.panes.map((pane) => (
					/*
					 * Keyed on the artifact's own address, so a pane whose address changes is a new
					 * component and the object URL it held is revoked by the unmount rather than reused.
					 */
					<Pane key={keyOf(pane.path)} pane={pane} />
				))}
			</div>
		</ContentsCard>
	);
}

/**
 * One pane — **which run it is, which file it is, and the file's own body.**
 *
 * **Each pane owns its own read.** `useArchivedArtifact` is one address per hook instance and hooks
 * cannot be called in a variable-length loop, so a component per pane is how N of them are legal —
 * and it carries the object-URL lifecycle over verbatim rather than re-deriving it: the `asked` ref
 * against React 19's double effect, the `live`/`shown` checks before a URL is created, and the
 * revoke keyed on the URL itself. **The cost is stated rather than worked around** (§9): an
 * authenticated byte route cannot be an `<img src>`, so the whole artifact is buffered in the tab,
 * and N panes is N buffered artifacts.
 *
 * **Which run it is, in the vocabulary the screen already has.** The run directory's own name in
 * full, then its identity decomposed at the first and the last hyphen (`run-identity.ts` — never
 * `split('-')`, because `pr-127-review` is one owner), and the test name off the run's own address.
 * `OWNER` is the directory's own text and is **never** presented as the caller's string (D20, D22);
 * `GRANTED` is reformatted textually and is what lets a reader check *oldest on the left* for
 * themselves. A name that does not decompose reads `unknown` in both fields with the name still in
 * full. Nothing is invented — no duration, no trigger, no author, no hash and no branch.
 *
 * `TEST NAME` and never a bare `TEST`: that is the field's real name (D22) and it does not mean a
 * test, while `TEST` alone reads as a category (`docs/DESIGN.md` §2). It is also the thing two arms
 * of one investigation differ by, which is why it is on the pane at all.
 *
 * The three fields are stacked in one column rather than in `RunPanel`'s three-across grid, because
 * a pane at {@link PANE_MIN} has no room for a grid.
 */
function Pane({ pane }: { readonly pane: ComparisonPane }) {
	const artifact = useArchivedArtifact(pane.path);
	const runName = pane.run.at(-2) ?? '';
	const identity = decomposeRunName(runName);
	const name = pane.path.at(-1) ?? '';

	return (
		<article
			className={`flex ${PANE_MIN} basis-0 grow flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface`}
		>
			<div className="border-outline-variant border-b-2 bg-surface-container-high px-3 py-2">
				<h3 className="mb-3 break-words font-code-md font-bold text-code-md text-on-surface">
					{runName}
				</h3>
				<div className="flex flex-col gap-3">
					<Field label="TEST NAME">{pane.run.at(1) ?? UNKNOWN}</Field>
					<Field label="OWNER">{identity.owner ?? UNKNOWN}</Field>
					<Field label="GRANTED">{identity.grantedAt ?? UNKNOWN}</Field>
				</div>
				<div className="mt-3 flex items-start justify-between gap-2">
					{/*
					 * The artifact's own file name, in the reference screen's chip treatment — the one
					 * piece of that screen's pane head worth keeping, because the pane is *this file of
					 * this run* and the card's own heading is the label rather than the file.
					 */}
					<span className="break-words border border-outline-variant bg-surface-container-high px-2 py-1 font-code-md text-code-md text-on-surface-variant">
						{name}
					</span>
					{/*
					 * The **existing** control, unchanged and still recessive: absent for `opaque`, no
					 * `download` attribute, a view rather than a transfer (§10). It is kept here because
					 * selecting a labelled artifact in this view no longer draws the single preview, and a
					 * full-size look is the one thing §11 says the preview genuinely needs.
					 */}
					{artifact.status === 'read' ? <OpenInANewWindow body={artifact.body} /> : null}
				</div>
			</div>
			{/*
			 * Whatever the host's own content type says this file is — so a labelled recording and a
			 * labelled `read_logs` compare the way a screenshot does, and `opaque` still creates no
			 * object URL and still says so in one sentence (`artifact-body-view.tsx`).
			 */}
			<ArtifactBodyView artifact={artifact} name={name} />
		</article>
	);
}
