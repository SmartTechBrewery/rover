import type { ArchiveLevel } from '@panel/archive/archive-levels.js';
import type { ArchiveEntry } from '@panel/archive/archive-listing.js';
import type { DeleteArchivedTestAnswer, TestRemoval } from '@panel/archive/delete-archived-test.js';
import { UNKNOWN } from '@panel/archive/file-size.js';
import { orderedEntries } from '@panel/archive/level-order.js';
import type { PinState } from '@panel/archive/pinned-tests.js';
import { decomposeRunName } from '@panel/archive/run-identity.js';
import { ArchiveCheckbox } from './archive-checkbox.js';
import {
	CardHeading,
	ContentsCard,
	Field,
	NothingFiledHere,
	NotReadableInCard,
	ReadingLevel,
} from './contents-card.js';
import { RemoveControl } from './remove-control.js';

/**
 * What is in the selected level — the root, a project, or a test name (`docs/DESIGN.md` §9).
 *
 * **One component with different rows**, not three screens. What the depth decides is which columns
 * a row carries and nothing else; no name is ever parsed to work out what a level *is* (D22), which
 * is why a legacy `unlabeled/` directory lists here as an ordinary test name with no special
 * treatment at all.
 *
 * | depth | the level | a row is | it carries |
 * | --- | --- | --- | --- |
 * | 0 | the root | a project | its name |
 * | 1 | a project | a test name | its name, and `RUNS` from `childCount` |
 * | 2 | a test name | a run | its name, and `OWNER` / `GRANTED` from the decomposition |
 *
 * **A row is read, not followed** (#161). The approved markup's `cursor-default` was right after
 * all: it was deviated from while the tree stopped at a run, because rows that did nothing would
 * have left the larger half of a file explorer inert — and the tree reaches every address now
 * (#159), so *the tree is the only way to move* is the arrangement rather than the objection to it.
 * The rows carry exactly the fields they carried as links, with **no link affordance and no hover
 * treatment that promises one**, and this card holds no clickable element at all while it is showing
 * a level. §9 records the reversal in place.
 *
 * **A file or a `kind: 'other'` entry at these depths is listed by name**, with no size and no
 * count. The archive is not supposed to have one here, and dropping it would make a short listing
 * look exactly like a complete one — which is the whole reason the host reports `other` at all.
 */
export function LevelContents({
	path,
	level,
	depth = path.length,
	pin,
	pinScope,
	removal,
	onRemoveSettled,
}: {
	readonly path: readonly string[];
	readonly level: ArchiveLevel;
	/**
	 * Which of the three level shapes to draw, and the order to draw it in — **the archive's own
	 * depth, which is not always how deep the address is** (#181).
	 *
	 * In the `All` view they are the same number and this defaults to it. In the groups view the
	 * address carries a group id the archive has no directory for, so a group's test names sit one
	 * component deeper in the URL than the project's test names they are the same *kind* of level
	 * as. Passing the archive depth is what makes this the same three shapes rather than a fourth
	 * one — `archiveAddressOf` is the one place that knows the difference, and `routes/archive.tsx`
	 * is the one caller that asks it.
	 */
	readonly depth?: number;
	/**
	 * The `Keep` checkbox for this level, bound to the test it is about — **given only at a test
	 * name**, and `undefined` at every other depth (`archive-checkbox.tsx`). It is `undefined` for
	 * one further reason since #237: the kept set is the host's, and until it has answered there is
	 * no tick to draw at any depth (`pinned-tests.ts`).
	 *
	 * A prop rather than a depth branch here, because the depth in this component decides *which
	 * columns a row carries and nothing else*, and the screen already owns the depth arithmetic
	 * (`depthsOf`). So this component draws the control when it is handed one and never works out
	 * whether it should exist.
	 */
	readonly pin?: PinState;
	/**
	 * What {@link pin} stands over, forwarded to the control and read nowhere here — a **group's**
	 * card in the groups view ticks every test in that group, a test name's ticks one test, and the
	 * sentence the control shows has to be about the right one (`archive-checkbox.tsx`).
	 */
	readonly pinScope?: 'test' | 'group';
	/**
	 * The `Remove` control for this level, bound to the test it would delete — **given only at a
	 * test name**, and `undefined` at every other depth this card draws (`remove-control.tsx`,
	 * D43).
	 *
	 * A prop for {@link pin}'s reason and the same rule: the depth in this component decides which
	 * columns a row carries and nothing else, and `routes/archive.tsx` already owns the depth
	 * arithmetic (`levelRemoval`). So this card draws the control when it is handed one and never
	 * works out whether it should exist.
	 *
	 * **A group's card carries none in this phase**, which is a phase boundary rather than a gap: a
	 * group is several tests, and one call per test is not what one press should become
	 * (`docs/DESIGN.md` §9, R51 phase 3).
	 */
	readonly removal?: TestRemoval;
	/** What a settled delete is reported to — the screen, never this card (`routes/archive.tsx`). */
	readonly onRemoveSettled?: (answer: DeleteArchivedTestAnswer, removal: TestRemoval) => void;
}) {
	return (
		<ContentsCard
			header={
				/* The name at one end of the strip and the controls at the other, which is the only
				   thing that puts them in a row rather than a stack. `min-w-0` lets a 40-character
				   name wrap instead of pushing them out of the card — each control is a word and a
				   glyph, so the pair is one line and the row can centre on it.

				   **The pair is wrapped in one `shrink-0` box** so it moves together and the heading
				   keeps its wrap: two children of the outer row would each negotiate their own width
				   against the name, and the tick would be the one that lost it. `Keep` first and
				   `Remove` outermost — the safe control is the one under the pointer on the way to
				   the other, and the destructive one is at the end of the strip (§5). */
				<div className="flex items-center justify-between gap-4">
					<div className="min-w-0">
						<CardHeading>{path.at(-1) ?? 'Archive'}</CardHeading>
					</div>
					<div className="flex shrink-0 items-center gap-3">
						{pin === undefined ? null : <ArchiveCheckbox pin={pin} scope={pinScope} />}
						{removal === undefined || onRemoveSettled === undefined ? null : (
							<RemoveControl onSettled={onRemoveSettled} removal={removal} />
						)}
					</div>
				</div>
			}
		>
			<Body depth={depth} level={level} />
		</ContentsCard>
	);
}

function Body({ depth, level }: { readonly depth: number; readonly level: ArchiveLevel }) {
	if (level.status === 'loading') {
		return (
			<div className="px-6 py-5">
				<ReadingLevel />
			</div>
		);
	}
	if (level.status === 'unreadable') {
		return <NotReadableInCard />;
	}
	if (level.status === 'empty') {
		return (
			<div className="px-6 py-5">
				<NothingFiledHere />
			</div>
		);
	}
	return (
		<ul>
			{orderedEntries(level.entries, depth).map((entry) => (
				<li key={entry.name}>
					<Row depth={depth} entry={entry} />
				</li>
			))}
		</ul>
	);
}

/**
 * One entry, read-only. The depth decides the row's shape and its fields, and nothing else about it.
 *
 * The two shapes are the approved ones: a test name puts its `RUNS` figure in a right-hand column
 * (`b91c300d…`), and a run stacks `OWNER` and `GRANTED` under its name, which is 40 characters and
 * needs the width (`8dcd4330…`).
 *
 * **The classes are the same ones minus the two that promised an action** — no `transition-colors`
 * and no `hover:bg-surface-container-highest` — and there is no `cursor-*` in their place: a `<div>`
 * already has the approved markup's `cursor-default`.
 */
function Row({ entry, depth }: { readonly entry: ArchiveEntry; readonly depth: number }) {
	const name = (
		<span className="break-words font-code-md font-bold text-code-md text-on-surface">
			{entry.name}
		</span>
	);
	const row = 'border-outline-variant border-b px-6 py-5';

	if (depth === 1 && entry.kind === 'directory') {
		return (
			<div className={`${row} flex flex-col justify-between gap-4 sm:flex-row sm:items-center`}>
				<span className="min-w-0 flex-1">{name}</span>
				{/*
				 * The one number the tree deliberately does not show. **`null` is `unknown`, never
				 * `0`** — a `0` would say *no runs* about a directory the host could not read into,
				 * which is the distinction `childCount: null` exists to carry.
				 */}
				<span className="flex w-24 flex-col items-end">
					<span className="mb-1 font-label-caps text-[10px] text-outline uppercase">RUNS</span>
					<span className="font-code-md text-[15px] text-on-surface">
						{entry.childCount === null ? UNKNOWN : String(entry.childCount)}
					</span>
				</span>
			</div>
		);
	}

	if (depth === 2 && entry.kind === 'directory') {
		// A name that does not decompose says `unknown` twice rather than guessing at an owner or a
		// time. The name itself is shown in full either way.
		const run = decomposeRunName(entry.name);
		return (
			<div className={`${row} flex flex-col gap-2`}>
				{name}
				<div className="mt-1 flex flex-wrap items-start gap-8">
					<Field label="OWNER">{run.owner ?? UNKNOWN}</Field>
					<Field label="GRANTED">{run.grantedAt ?? UNKNOWN}</Field>
				</div>
			</div>
		);
	}

	/*
	 * A project, and every entry that is not a directory at any of these depths. The archive is not
	 * supposed to have a file or a socket here; naming it with no size and no count is what stops a
	 * short listing looking like a complete one, and the tree beside this card is what reaches it.
	 */
	return <div className={`${row} flex flex-col gap-2`}>{name}</div>;
}
