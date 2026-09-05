import type { ArchiveLevel } from '@panel/archive/archive-levels.js';
import type { ArchiveEntry } from '@panel/archive/archive-listing.js';
import { UNKNOWN } from '@panel/archive/file-size.js';
import { orderedEntries } from '@panel/archive/level-order.js';
import { decomposeRunName } from '@panel/archive/run-identity.js';
import {
	CardHeading,
	ContentsCard,
	Field,
	NothingFiledHere,
	NotReadableInCard,
	ReadingLevel,
} from './contents-card.js';

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
}: {
	readonly path: readonly string[];
	readonly level: ArchiveLevel;
}) {
	return (
		<ContentsCard header={<CardHeading>{path.at(-1) ?? 'Archive'}</CardHeading>}>
			<Body level={level} path={path} />
		</ContentsCard>
	);
}

function Body({ path, level }: { readonly path: readonly string[]; readonly level: ArchiveLevel }) {
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
			{orderedEntries(level.entries, path.length).map((entry) => (
				<li key={entry.name}>
					<Row depth={path.length} entry={entry} />
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
