import type { ArchiveLevel } from '@panel/archive/archive-levels.js';
import type { ArchiveEntry } from '@panel/archive/archive-listing.js';
import { splatFromComponents } from '@panel/archive/archive-path.js';
import { UNKNOWN } from '@panel/archive/file-size.js';
import { orderedEntries } from '@panel/archive/level-order.js';
import { decomposeRunName } from '@panel/archive/run-identity.js';
import { Link } from '@tanstack/react-router';
import {
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
 * **A row is a link.** The approved markup has `cursor-default` on these rows, which would leave the
 * tree as the only way to move and make the larger half of a file explorer inert; the deviation is
 * recorded in §9 rather than made silently. Nothing else about a row changes — it gains no control,
 * no count the tree refuses to show, and no status of any kind.
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
		<ContentsCard title={path.at(-1) ?? 'Archive'}>
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
					<Row depth={path.length} entry={entry} path={[...path, entry.name]} />
				</li>
			))}
		</ul>
	);
}

/**
 * One entry, as a link to its own level. The depth decides the row's shape and its fields, and
 * nothing else about it.
 *
 * The two shapes are the approved ones: a test name puts its `RUNS` figure in a right-hand column
 * (`b91c300d…`), and a run stacks `OWNER` and `GRANTED` under its name, which is 40 characters and
 * needs the width (`8dcd4330…`).
 */
function Row({
	path,
	entry,
	depth,
}: {
	readonly path: readonly string[];
	readonly entry: ArchiveEntry;
	readonly depth: number;
}) {
	const name = (
		<span className="break-words font-code-md font-bold text-code-md text-on-surface">
			{entry.name}
		</span>
	);
	const link =
		'border-outline-variant border-b px-6 py-5 transition-colors hover:bg-surface-container-highest';

	if (depth === 1 && entry.kind === 'directory') {
		return (
			<Link
				className={`${link} flex flex-col justify-between gap-4 sm:flex-row sm:items-center`}
				params={{ _splat: splatFromComponents(path) }}
				to="/archive/$"
			>
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
			</Link>
		);
	}

	if (depth === 2 && entry.kind === 'directory') {
		// A name that does not decompose says `unknown` twice rather than guessing at an owner or a
		// time. The name itself is shown in full either way.
		const run = decomposeRunName(entry.name);
		return (
			<Link
				className={`${link} flex flex-col gap-2`}
				params={{ _splat: splatFromComponents(path) }}
				to="/archive/$"
			>
				{name}
				<div className="mt-1 flex flex-wrap items-start gap-8">
					<Field label="OWNER">{run.owner ?? UNKNOWN}</Field>
					<Field label="GRANTED">{run.grantedAt ?? UNKNOWN}</Field>
				</div>
			</Link>
		);
	}

	/*
	 * A project, and every entry that is not a directory at any of these depths. The archive is not
	 * supposed to have a file or a socket here; naming it with no size and no count is what stops a
	 * short listing looking like a complete one, and it is still addressable because the host would
	 * answer for the path.
	 */
	return (
		<Link
			className={`${link} flex flex-col gap-2`}
			params={{ _splat: splatFromComponents(path) }}
			to="/archive/$"
		>
			{name}
		</Link>
	);
}
