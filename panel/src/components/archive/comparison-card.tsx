import { keyOf } from '@panel/archive/archive-path.js';
import { type ArchivedArtifactState, useArchivedArtifact } from '@panel/archive/artifact.js';
import type { ComparisonPane, LabelComparison } from '@panel/archive/label-comparison.js';
import {
	type ImageMarks,
	type MarkedDifferences,
	useMarkedDifferences,
} from '@panel/archive/marked-differences.js';
import { variantPhrase } from '@panel/archive/variant-name.js';
import { useState } from 'react';
import { ArtifactBodyView, OpenInANewWindow } from './artifact-body-view.js';
import { CardHeading, ContentsCard } from './contents-card.js';
import { DifferenceToggle } from './difference-toggle.js';
import { LabelBadge } from './label-badge.js';

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
 * the corrected Archive screens. What is taken: a horizontal split of panes, each pane headed by a
 * strip naming the arm it is. **Its per-pane run identity was taken and has since been given back**
 * — the head carried the run name and three decomposed fields until the row was seen at
 * {@link PANE_MIN}, where four stacked fields stood taller than the screenshot they headed; `Pane`
 * records what replaced them and why. What is **not** taken, and none of it is reproduced anywhere
 * below: its `SUCCESS` chip, its `PASS` log line, `COMPLETE`, green
 * ticks and red crosses, the words *Visual Regression*, `RUN A (BASELINE)` / `RUN B (CURRENT)`, the
 * `HASH` and `BRANCH` rows, `SWAP`, `RESYNC SCROLL`, its second navigation bar and global
 * `FORCE_RELEASE`, its mid-sidebar `Profile`, its per-arm orange/green pane borders (a red/green
 * pairing by another name), its simulated phone status bar and its `object-cover` crop.
 *
 * **No score, no verdict, and no arm that is the right one — but a diff the reader can ask for**
 * (2026-09-10, edited in place with its reasoning rewritten rather than deleted, per
 * `ai/RULES.md` §1). This paragraph read *no diff, no score, no verdict, no highlight of what
 * changed*, on the reasoning that the comparison is visual and human-judged
 * (`docs/DESIGN_INITIAL_PROMPT.md` §4) and that judging is the agent's job (`ai/RULES.md` §1). **The
 * second half of that stands and is untouched**; the first half was doing more work than its own
 * argument supported, and the operator reversed it. *Where two artifacts differ* is not a judgement
 * — it is arithmetic over two files, the same class of fact as `411 KB on disk`. What would have
 * been a verdict is everything the reversal does **not** buy: there is still no score, no
 * percentage, no threshold anybody passes or fails, no arm that is the baseline and no arm that is
 * the current one, nothing coloured red or green, and no region ranked above another. The marks say
 * *here*, in one colour, and the person still decides what that means.
 *
 * **They are off until asked for, on exactly two panes, and never on the first of them.** The
 * control is a lamp in the header strip (`difference-toggle.tsx`), the boxes are chrome over the
 * artifact rather than pixels composited into it (`difference-marks.tsx`), and what is compared is
 * decided by `image-diff.ts` — where the alignment, and the measurement that forced it, are argued
 * out.
 *
 * **And still no fact Rover does not have**: no commit hash and no git branch, because what the
 * archive knows is the project, the test name, the run's own directory name, the device serial and
 * the run's two files.
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
	const pair = pairOf(comparison);
	const [asked, setAsked] = useState(false);
	/*
	 * **The pair's two reads live here rather than in its panes**, and that is the whole structural
	 * cost of the marks: comparing two artifacts needs both of them in one place, and a hook cannot
	 * be called in a loop. `useArchivedArtifact` takes `null` for *there is no artifact open* and
	 * fetches nothing for it, so the two calls are unconditional and a card of three or nine panes
	 * makes no request from here — its panes still each own their own read, unchanged.
	 *
	 * The object-URL lifecycle survives the move: the hook revokes on the URL itself rather than on
	 * unmount (`artifact.ts`), so an address that changes under a pane frees the handle it held
	 * whether or not the component holding it was keyed.
	 */
	const reference = useArchivedArtifact(pair === null ? null : pair[0].path);
	const compared = useArchivedArtifact(pair === null ? null : pair[1].path);
	const differences = useMarkedDifferences(asked && pair !== null, reference, compared);

	return (
		<ContentsCard
			header={
				/*
				 * **The label names the card and the control sits opposite it** — the arrangement `Keep`
				 * and `Remove` already have on this screen (§10): the name on the left, the one thing a
				 * reader can press at the right end of the strip.
				 */
				<div className="flex items-center justify-between gap-3">
					{/*
					 * **The label is the label *as the archive filed it*** — never the caller's own string,
					 * which `pathSegment` truncated and rewrote irreversibly (`archive-listing.ts`, and the
					 * rule §9 already states for `OWNER`). The caption above it is the `Field` label's own
					 * treatment, so the strip says *what the name is* without inventing one. No count and
					 * no glyph in it.
					 */}
					<div className="flex min-w-0 flex-col gap-1">
						<span className="font-label-caps text-[10px] text-outline uppercase">LABEL</span>
						<div className="flex items-center gap-2">
							{/*
							 * **The tree's own badge, in front of the name it belongs to.** One label heads
							 * the whole card, so the badge belongs in the one strip that spans every pane
							 * rather than repeated down the row — and here it does the job it exists for,
							 * tying the card to the row a reader clicked in the tree. The number is a code
							 * local to this group; the name beside it is the thing that means something,
							 * which is why the badge is in front of it and not instead of it.
							 */}
							<LabelBadge label={comparison.label} number={comparison.number} />
							<CardHeading>{comparison.label}</CardHeading>
						</div>
					</div>
					{/*
					 * **The control is drawn for two panes and for nothing else.** A difference is
					 * pairwise, and with three panes there is no pair to take without naming one of them
					 * the one the others are measured against — which is the `BASELINE` this card refuses
					 * to have (§9). So a group of seven arms gets the card it already had, and the absence
					 * is the honest answer rather than a control that would have to invent a reference.
					 */}
					{pair === null ? null : (
						<div className="flex shrink-0 items-center gap-3">
							<DifferenceSentence differences={differences} />
							<DifferenceToggle on={asked} onPress={() => setAsked(!asked)} />
						</div>
					)}
				</div>
			}
		>
			<div className="flex gap-(--gutter) overflow-x-auto p-4">
				{pair === null ? (
					comparison.panes.map((pane) => (
						/*
						 * Keyed on the artifact's own address, so a pane whose address changes is a new
						 * component and the object URL it held is revoked by the unmount rather than reused.
						 */
						<Pane key={keyOf(pane.path)} pane={pane} />
					))
				) : (
					<>
						{/*
						 * **The marks go on the second pane and never on the first.** The first is what the
						 * second is being read against, so boxing it would be marking a file against
						 * itself — and *oldest on the left* is what makes the second the later one rather
						 * than the chosen one.
						 */}
						<PaneFrame artifact={reference} pane={pair[0]} />
						<PaneFrame
							artifact={compared}
							marks={differences.status === 'marked' ? differences.marks : null}
							pane={pair[1]}
						/>
					</>
				)}
			</div>
		</ContentsCard>
	);
}

/**
 * The two panes to compare, or `null` for a card that is not a pair.
 *
 * **Two is what a difference is defined over**, and nothing about the rest of the card narrows to
 * it: N panes is still N panes, `label-comparison.ts` still caps nothing, and a group of seven arms
 * still draws seven of them (R41).
 */
function pairOf(comparison: LabelComparison): readonly [ComparisonPane, ComparisonPane] | null {
	const [first, second] = comparison.panes;
	return comparison.panes.length === 2 && first !== undefined && second !== undefined
		? [first, second]
		: null;
}

/**
 * What the card says about the comparison, in the strip beside the control.
 *
 * **Every answer is a sentence and none of them is an alarm** — `NothingFiledHere`'s language and
 * weight (§9), no colour, no icon, no error code, no retry. Four of the six are *there is nothing
 * to compare*, and they are four different sentences because they are four different facts: two
 * screens of different sizes, a labelled recording, a file the host would not serve, and two files
 * that are simply the same.
 *
 * **`aria-live` because this text is the answer**, and for a reader who cannot see the boxes it is
 * the *whole* answer — which is why it is `sr-only` below `sm` and never `hidden`. The strip has no
 * room for a sentence beside the label and the control at a narrow window, but `hidden` would take
 * the one channel that carries the answer out of the accessibility tree along with the pixels. The count is the one number the marks produce and it is stated plainly rather
 * than as a score: `4 regions differ` and never `96% identical`, which is the sentence a threshold
 * would be hiding in.
 */
function DifferenceSentence({ differences }: { readonly differences: MarkedDifferences }) {
	const said = sentenceFor(differences);
	if (said === null) {
		return null;
	}
	return (
		<span
			aria-live="polite"
			className="sr-only font-code-md text-[12px] text-on-surface-variant sm:not-sr-only sm:inline"
		>
			{said}
		</span>
	);
}

function sentenceFor(differences: MarkedDifferences): string | null {
	if (differences.status === 'idle') {
		return null;
	}
	if (differences.status === 'reading') {
		return 'Reading both files.';
	}
	if (differences.status === 'measuring') {
		return 'Comparing.';
	}
	if (differences.status === 'different-dimensions') {
		return 'These two ran on different screens, so there is nothing to compare.';
	}
	if (differences.status === 'unavailable') {
		return 'These two have no pixels to compare.';
	}
	const marked = differences.marks.regions.length;
	if (marked === 0) {
		return 'These two do not differ.';
	}
	return marked === 1 ? '1 region differs.' : `${marked} regions differ.`;
}

/**
 * One pane — **which arm of the investigation it is, and the file's own body.**
 *
 * **Each pane owns its own read.** `useArchivedArtifact` is one address per hook instance and hooks
 * cannot be called in a variable-length loop, so a component per pane is how N of them are legal —
 * and it carries the object-URL lifecycle over verbatim rather than re-deriving it: the `asked` ref
 * against React 19's double effect, the `live`/`shown` checks before a URL is created, and the
 * revoke keyed on the URL itself. **The cost is stated rather than worked around** (§9): an
 * authenticated byte route cannot be an `<img src>`, so the whole artifact is buffered in the tab,
 * and N panes is N buffered artifacts.
 *
 * **The head is the variant and the control, and that is the whole of it** — a correction to #199
 * made in place. It carried the run directory's own name in full and `TEST NAME`, `OWNER` and
 * `GRANTED` decomposed out of it, on the reasoning that a pane has to say which run it is. Standing
 * four stacked text fields over every artifact is what that cost: at {@link PANE_MIN} the head was
 * taller than the screenshot under it in the narrow case, the thing the card exists for was pushed
 * below the fold, and the fields repeated down the row the parts a reader was not comparing. **The
 * evidence is what the card is for, so the head gets out of its way**, and none of what was removed
 * is lost from the screen: the tree beside it stands on the artifact, and the run, its owner and its
 * grant time are what `LevelContents` and `RunPanel` say at the depths that are about a run.
 *
 * **What the head kept is the one thing the panes differ by**, which is what a reader needs to know
 * *which arm is which* and is the reason `TEST NAME` was on the pane at all. The whole test name is
 * the group's name and the arm's run together, and the group's half is already the address the
 * reader is standing on, so the pane says the arm's half alone — `Variant A` rather than
 * `statistics-deliveries_variantA`, four times across a row 240px wide.
 *
 * **And it says it as a phrase rather than as an identifier.** `variantPhrase` re-spaces and
 * re-cases the arm's own name and does nothing else (`variant-name.ts`): every word survives, in
 * order, spelled as the caller spelled it apart from its first character. A head is read at a
 * glance and `variantA` beside `variantB` differs by one character in the least-looked-at position
 * on the card, which is the whole reason a phrase is worth the transform. **The caller's own string
 * is on the `title`**, so what was actually filed is a hover away and this is a re-rendering rather
 * than a replacement — the rule D22 asks for when a panel touches a caller's text at all.
 *
 * **Ordering is not the head's job** — *oldest on the left, newest on the right* is the card's own
 * rule, stated in this module's header and decided by `level-order.ts`, rather than something a
 * reader was meant to verify by reading `GRANTED` off each pane in turn.
 *
 * **The label badge is not here.** One label heads the whole card, so the badge is in the card's own
 * strip in front of the name it belongs to; repeating it down the row would draw the same number N
 * times to say the thing every pane already has in common. The artifact's file name is not here
 * either, for the same reason the reference screen's chip is not: within one comparison every pane
 * is the same file of a different run, so it was the same string N times across the row — and the
 * name is still on the tree row, in the body's `alt`, and one click away in the window the control
 * opens.
 */
function Pane({ pane }: { readonly pane: ComparisonPane }) {
	const artifact = useArchivedArtifact(pane.path);
	return <PaneFrame artifact={artifact} pane={pane} />;
}

/**
 * One pane, **handed the artifact rather than reading it** — the same `<article>`, the same head and
 * the same body, for a pane that owns its read and for one of a pair whose reads the card owns.
 *
 * The split exists so that the two arrangements cannot drift: what a reader sees must not depend on
 * whether the card happened to be a pair, and the only thing that differs between them is
 * {@link PaneFrame.marks} — which is `null` for every pane but the second of two, and `null` there
 * too until the reader asks.
 */
function PaneFrame({
	pane,
	artifact,
	marks = null,
}: {
	readonly pane: ComparisonPane;
	readonly artifact: ArchivedArtifactState;
	/** The difference boxes, for the second pane of a pair and nothing else. */
	readonly marks?: ImageMarks | null;
}) {
	const name = pane.path.at(-1) ?? '';

	return (
		<article
			className={`flex ${PANE_MIN} basis-0 grow flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface`}
		>
			{/*
			 * `min-h-12` is the head's height **with** the control in it — 32px of bordered, padded
			 * glyph inside `py-2` — held whether the control is there or not. The control renders only
			 * once the read lands, and a head sized by its text alone would have grown under the reader
			 * mid-read, shifting every artifact in the row down at the same moment.
			 */}
			<div className="flex min-h-12 items-center justify-between gap-2 border-outline-variant border-b-2 bg-surface-container-high px-3 py-2">
				{/*
				 * `break-words` and never a truncation: an arm's name is the one thing this row is here
				 * to tell apart, and an ellipsis on it would hide exactly the character two arms differ
				 * by. A long one takes a second line and the row of panes grows with it.
				 *
				 * The `title` is the arm **as the caller named it**, unphrased — the same channel the
				 * label badge puts the filed label on, and for the same reason.
				 */}
				<h3
					className="min-w-0 break-words font-code-md font-bold text-code-md text-on-surface"
					title={pane.variant}
				>
					{variantPhrase(pane.variant)}
				</h3>
				{/*
				 * The **existing** control, unchanged in everything but its width: absent for `opaque`, no
				 * `download` attribute, a view rather than a transfer (§10). It is kept here because
				 * selecting a labelled artifact in this view no longer draws the single preview, and a
				 * full-size look is the one thing §11 says the preview genuinely needs.
				 */}
				{artifact.status === 'read' ? <OpenInANewWindow body={artifact.body} iconOnly /> : null}
			</div>
			{/*
			 * Whatever the host's own content type says this file is — so a labelled recording and a
			 * labelled `read_logs` compare the way a screenshot does, and `opaque` still creates no
			 * object URL and still says so in one sentence (`artifact-body-view.tsx`).
			 */}
			<ArtifactBodyView artifact={artifact} marks={marks} name={name} />
		</article>
	);
}
