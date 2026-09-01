import { type ArchiveLevels, levelAt } from '@panel/archive/archive-levels.js';
import { keyOf, splatFromComponents } from '@panel/archive/archive-path.js';
import { orderedEntries } from '@panel/archive/level-order.js';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';

/**
 * The archive as a directory tree — `docs/DESIGN.md` §9's left column.
 *
 * **Expansion is derived from the selection, never stored.** A node is expanded exactly when it is
 * a prefix of the selected path, and the selected node is expanded too; nothing else is. Everything
 * the issue asks of this tree falls out of that one rule:
 *
 * - *lazily, one `readdir` at a time* — the levels drawn are the prefixes of the selection, which
 *   is precisely what `useArchiveLevels` was given, so a walk of the archive is unrepresentable
 *   rather than merely avoided;
 * - *a reload lands where you were and a link is shareable* — the whole of this tree's state is the
 *   URL, so it cannot disagree with the address bar;
 * - a sibling off the selected path draws no children, because nothing has been read for it.
 *
 * The accepted cost, recorded in §9: a folder cannot be peeked at without selecting it. That is
 * ordinary file-explorer behaviour and it removes a whole class of *the tree and the URL disagree*
 * bugs. A separate collapse control is a later change if anybody wants one.
 *
 * **What may never appear on a row**, all of it from the issue's binding rules:
 *
 * - **no count.** `childCount` is on the wire and is deliberately not drawn here; the header badge
 *   carries the one number for whatever is selected, so the tree stays a tree.
 * - **no status icon of any kind** — no tick, no cross, no dot, no play glyph, no colour that means
 *   an outcome. Rover has no verdicts to report (`docs/DESIGN.md` §2), and green ticks beside runs
 *   in the tree are exactly what the earlier design got wrong.
 * - **a folder on every row, a triangle only on an expandable one.** A run is a leaf: its `<serial>`
 *   is a fact about the run rather than a level (`onlyChild`), so there is nothing under it to open.
 * - **`break-words`, never `break-all`.** The latter splits `issue-112` across two lines.
 *
 * Every row is a `<Link>` and there is no nested interactive element: the triangle is `aria-hidden`
 * decoration saying *this opens*, not a second control.
 */

/** A run is a leaf — depth 0 is a project, 1 a test name, 2 a run. */
const DEEPEST_EXPANDABLE_DEPTH = 1;

export function DirectoryTree({
	selected,
	levels,
}: {
	readonly selected: readonly string[];
	readonly levels: ArchiveLevels;
}) {
	return (
		<aside className="flex w-full shrink-0 flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface-container lg:w-[320px]">
			<div className="border-outline-variant border-b-2 bg-surface-container-high px-4 py-3">
				<h2 className="font-label-caps text-label-caps text-on-surface uppercase tracking-widest">
					DIRECTORY
				</h2>
			</div>
			<div className="flex-1 overflow-y-auto p-4 font-code-md text-code-md">
				<Branch levels={levels} path={[]} selected={selected} />
			</div>
		</aside>
	);
}

/**
 * One level's rows, and the children of whichever of them is on the selected path.
 *
 * **Only a directory becomes a row.** The tree is the navigable structure; the complete listing —
 * including a file or a `kind: 'other'` entry the archive is not supposed to have at this level —
 * is the contents card's job, and it does say so rather than dropping it.
 *
 * **The order comes from `orderedEntries`, which is the contents card's too**: the two panes list
 * the same run directories side by side, so *most recent first* is decided once for both rather
 * than remembered separately by each.
 */
function Branch({
	path,
	selected,
	levels,
}: {
	readonly path: readonly string[];
	readonly selected: readonly string[];
	readonly levels: ArchiveLevels;
}) {
	const level = levelAt(levels, path);
	// The row's own level: 0 is a project, 1 a test name, 2 a run.
	const depth = path.length;

	if (level.status === 'loading') {
		return <Quiet>Reading this level.</Quiet>;
	}
	/*
	 * An empty or unreadable level draws **nothing** under its node — no `0`, no placeholder row,
	 * no icon. A directory that does not exist is not listed, and one the host cannot see into is
	 * said where there is room to say it: the contents card, whose whole area is the message.
	 */
	if (level.status !== 'listed') {
		return null;
	}

	return (
		<ul className="space-y-1">
			{orderedEntries(level.entries, depth)
				.filter((entry) => entry.kind === 'directory')
				.map((entry) => {
					const childPath = [...path, entry.name];
					const expanded = keyOf(selected.slice(0, childPath.length)) === keyOf(childPath);
					return (
						<li className="min-w-0" key={entry.name}>
							<Row
								depth={depth}
								expanded={expanded}
								name={entry.name}
								path={childPath}
								selected={keyOf(childPath) === keyOf(selected)}
							/>
							{expanded && depth <= DEEPEST_EXPANDABLE_DEPTH ? (
								<div className="mt-1 ml-2.5 space-y-1 border-outline-variant border-l-2 py-1 pl-5">
									<Branch levels={levels} path={childPath} selected={selected} />
								</div>
							) : null}
						</li>
					);
				})}
		</ul>
	);
}

const ROW_BASE = 'flex items-start gap-2 rounded-sm border-2 px-3 py-1.5';
const ROW_SELECTED = 'bg-tertiary-container text-on-tertiary-container border-tertiary';
// Bordered transparent rather than unbordered, so selecting a row does not shift it by 2px — the
// sidebar's own trick.
const ROW_UNSELECTED =
	'text-on-surface border-transparent hover:bg-surface-container-highest transition-colors';

function Row({
	path,
	name,
	depth,
	expanded,
	selected,
}: {
	readonly path: readonly string[];
	readonly name: string;
	readonly depth: number;
	readonly expanded: boolean;
	readonly selected: boolean;
}) {
	const Triangle = expanded ? ChevronDown : ChevronRight;
	const FolderIcon = expanded ? FolderOpen : Folder;
	return (
		<Link
			aria-current={selected ? 'page' : undefined}
			className={`${ROW_BASE} ${selected ? ROW_SELECTED : ROW_UNSELECTED}`}
			params={{ _splat: splatFromComponents(path) }}
			to="/archive/$"
		>
			{depth <= DEEPEST_EXPANDABLE_DEPTH ? (
				<Triangle aria-hidden="true" className="mt-0.5 shrink-0" size={14} strokeWidth={2} />
			) : null}
			<FolderIcon aria-hidden="true" className="mt-0.5 shrink-0" size={16} strokeWidth={2} />
			{/* Verbatim, and wrapping at its own separators — `break-words`, never `break-all`. */}
			<span className="min-w-0 break-words">{name}</span>
		</Link>
	);
}

/** One line, no spinner — §5 has no exception for progress, and `devices.tsx` set the precedent. */
function Quiet({ children }: { readonly children: string }) {
	return (
		<p aria-live="polite" className="px-3 py-1.5 text-on-surface-variant">
			{children}
		</p>
	);
}
