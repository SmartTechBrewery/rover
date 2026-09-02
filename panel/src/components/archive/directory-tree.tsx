import { type ArchiveLevels, levelAt } from '@panel/archive/archive-levels.js';
import {
	keyOf,
	MAX_ARCHIVE_SEARCH_TEXT_LENGTH,
	splatFromComponents,
} from '@panel/archive/archive-path.js';
import type { ArchiveSearch, ArchiveSearchState } from '@panel/archive/archive-search.js';
import { orderedEntries } from '@panel/archive/level-order.js';
import { type HitNode, hitTree } from '@panel/archive/search-tree.js';
import { Link } from '@tanstack/react-router';
import {
	ChevronDown,
	ChevronRight,
	FileQuestionMark,
	FileText,
	Folder,
	FolderOpen,
	type LucideIcon,
	Search,
} from 'lucide-react';

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
 *
 * **And the card searches the whole archive** (#146, R38, `docs/DESIGN.md` §9). The field between
 * the header strip and the tree is the design's own (screen `8dcd4330…`), and while there is text in
 * it the body draws the host's matches instead of the URL's levels:
 *
 * - **every hit is visible and its ancestors are expanded, and a branch holding no match is not
 *   drawn** — all three fall out of `search-tree.ts` building the tree from the matches themselves;
 * - **there is no `DEEPEST_EXPANDABLE_DEPTH` in the searched tree.** It draws exactly the paths the
 *   host answered, so a hit under a run is drawn — which is how a name below the tree's own leaf
 *   becomes reachable at all;
 * - **a hit row gains nothing a browsing row is forbidden.** It is the same {@link Row}: the same
 *   `<Link>`, the same classes, no count, no status glyph, no colour that means an outcome.
 * - **a truncated answer says so**, above the hits and not below them, so a partial list cannot
 *   read like a complete one for as long as it takes to scroll to the end of it — and it says so
 *   whether or not anything matched, because an empty hit list is still a hit list ({@link Searched}).
 */

/** A run is a leaf — depth 0 is a project, 1 a test name, 2 a run. */
const DEEPEST_EXPANDABLE_DEPTH = 1;

/**
 * The placeholder, and it is a **deliberate deviation from the approved markup** recorded in
 * `docs/DESIGN.md` §9.
 *
 * The design says *Filter this tree...*, which describes a client-side filter over rows already
 * drawn. This is not that: typing asks the host to search the whole archive, including levels this
 * tree has never read, so the field says what it does.
 */
const PLACEHOLDER = 'Search the whole archive...';

export function DirectoryTree({
	selected,
	levels,
	search,
}: {
	readonly selected: readonly string[];
	readonly levels: ArchiveLevels;
	/**
	 * The search, held **above this card** (`routes/archive.tsx`) — this component remounts when
	 * the screen changes arrangement, and state held here would be lost on the very navigation a
	 * hit performs.
	 */
	readonly search: ArchiveSearch;
}) {
	return (
		<aside className="flex w-full shrink-0 flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface-container lg:w-[320px]">
			<div className="border-outline-variant border-b-2 bg-surface-container-high px-4 py-3">
				<h2 className="font-label-caps text-label-caps text-on-surface uppercase tracking-widest">
					DIRECTORY
				</h2>
			</div>
			<div className="border-outline-variant border-b-2 p-4">
				<div className="relative">
					{/*
					 * `aria-label` rather than a visible label: the design has none, and a placeholder
					 * is not a name. It is the one thing here that is not in the approved markup and it
					 * draws nothing — assistive technology has to be able to say what this field is.
					 *
					 * `maxLength` is the host's own bound, mirrored in `archive-path.ts` beside the path
					 * depth: a paste longer than the host accepts stops at the field rather than being
					 * sent to be refused and reported as a host that could not search.
					 */}
					<input
						aria-label="Search the whole archive"
						autoCapitalize="off"
						autoComplete="off"
						autoCorrect="off"
						className="w-full rounded-sm border-2 border-outline-variant bg-surface px-3 py-2 pl-9 font-code-md text-code-md text-on-surface transition-colors placeholder:text-outline focus:border-tertiary focus:ring-0"
						maxLength={MAX_ARCHIVE_SEARCH_TEXT_LENGTH}
						onChange={(event) => search.setText(event.target.value)}
						placeholder={PLACEHOLDER}
						spellCheck={false}
						type="text"
						value={search.text}
					/>
					{/* `lucide-react`'s own glyph, not the design's Material Symbols one (§9). */}
					<Search
						aria-hidden="true"
						className="absolute top-2.5 left-2.5 text-outline"
						size={18}
						strokeWidth={2}
					/>
				</div>
			</div>
			<div className="flex-1 overflow-y-auto p-4 font-code-md text-code-md">
				{search.state.status === 'idle' ? (
					<Branch levels={levels} path={[]} selected={selected} />
				) : (
					<Searched selected={selected} state={search.state} />
				)}
			</div>
		</aside>
	);
}

/**
 * What the body draws once there is text in the field — **three states that share no sentence**,
 * and none of them borrows one from *Nothing in the archive* or `ARCHIVE NOT READABLE` either.
 *
 * In flight is one quiet line and no spinner (§5), exactly as a level in flight is.
 *
 * **Truncation is reported independently of whether anything matched**, and is not a fourth state.
 * The host's flag means *a directory that exists was not fully examined*, which it can set without
 * recording a single match — an unreadable subtree, or a bound reached before any name matched. So
 * `matches: []` with `truncated: true` is a reachable answer, and it is the one a reader is most
 * likely to act on by giving up: *no name in the archive contains that text* would be a definitive
 * negative about a search that was cut short, so the empty answer says which of the two it is.
 */
function Searched({
	state,
	selected,
}: {
	readonly state: Exclude<ArchiveSearchState, { status: 'idle' }>;
	readonly selected: readonly string[];
}) {
	if (state.status === 'searching') {
		return <Quiet>Searching this host's archive.</Quiet>;
	}
	if (state.status === 'failed') {
		return <Quiet>The host could not search the archive.</Quiet>;
	}
	if (state.matches.length === 0) {
		return (
			<Quiet>
				{state.truncated
					? 'Nothing in the part of the archive that could be examined contains that text.'
					: 'No name in the archive contains that text.'}
			</Quiet>
		);
	}
	return (
		<>
			{state.truncated ? (
				<p className="mb-3 px-3 text-on-surface-variant">
					More names match than are shown. Narrow the text.
				</p>
			) : null}
			<Hits nodes={hitTree(state.matches)} selected={selected} />
		</>
	);
}

/**
 * The matched tree's rows — the same shape `Branch` draws, with two differences that are the whole
 * of the searched tree.
 *
 * **Every node is drawn expanded**, because the tree is exactly the addresses the host answered:
 * there is nothing here that was not asked for, so there is no depth at which to stop. And **what a
 * row is comes from the host's own `kind`**, never from its name (D22) — a folder, a file, or
 * something the host could not classify, which is `run-panel.tsx`'s own idiom for the same fact.
 */
function Hits({
	nodes,
	selected,
}: {
	readonly nodes: readonly HitNode[];
	readonly selected: readonly string[];
}) {
	return (
		<ul className="space-y-1">
			{nodes.map((node) => {
				const opens = node.children.length > 0;
				return (
					<li className="min-w-0" key={keyOf(node.path)}>
						<Row
							Icon={iconFor(node, opens)}
							name={node.name}
							path={node.path}
							selected={keyOf(node.path) === keyOf(selected)}
							Triangle={opens ? ChevronDown : null}
						/>
						{opens ? (
							<div className="mt-1 ml-2.5 space-y-1 border-outline-variant border-l-2 py-1 pl-5">
								<Hits nodes={node.children} selected={selected} />
							</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/** A folder open or shut, a file, or something the host could not classify. No status glyph. */
function iconFor(node: HitNode, opens: boolean): LucideIcon {
	if (node.kind === 'directory') {
		return opens ? FolderOpen : Folder;
	}
	return node.kind === 'file' ? FileText : FileQuestionMark;
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
								Icon={expanded ? FolderOpen : Folder}
								name={entry.name}
								path={childPath}
								selected={keyOf(childPath) === keyOf(selected)}
								Triangle={
									depth <= DEEPEST_EXPANDABLE_DEPTH ? (expanded ? ChevronDown : ChevronRight) : null
								}
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

/**
 * One row, and it is the same row in both trees.
 *
 * **The two glyphs are inputs and nothing else is** (#146): the browsing tree derives them from the
 * depth and the expansion, the searched tree from the host's `kind` and whether the answer put
 * anything under it. Everything that makes a row a row is here and unconditional — the `<Link>`,
 * the classes, and every extra it refuses to carry — so a hit cannot acquire a count, a status
 * glyph or an outcome colour by being drawn from a different tree.
 *
 * `Triangle` is `null` on a row nothing opens. It is `aria-hidden` decoration meaning *this opens*,
 * never a second control inside the link.
 */
function Row({
	path,
	name,
	Icon,
	Triangle,
	selected,
}: {
	readonly path: readonly string[];
	readonly name: string;
	/** What this row **is** — a folder, an open folder, a file, or the host's own *unclassified*. */
	readonly Icon: LucideIcon;
	readonly Triangle: LucideIcon | null;
	readonly selected: boolean;
}) {
	return (
		<Link
			aria-current={selected ? 'page' : undefined}
			className={`${ROW_BASE} ${selected ? ROW_SELECTED : ROW_UNSELECTED}`}
			params={{ _splat: splatFromComponents(path) }}
			to="/archive/$"
		>
			{Triangle === null ? null : (
				<Triangle aria-hidden="true" className="mt-0.5 shrink-0" size={14} strokeWidth={2} />
			)}
			<Icon aria-hidden="true" className="mt-0.5 shrink-0" size={16} strokeWidth={2} />
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
