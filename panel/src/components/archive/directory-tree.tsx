import { type ArchiveLevels, levelAt, runContentsLevel } from '@panel/archive/archive-levels.js';
import type { ArchiveEntry } from '@panel/archive/archive-listing.js';
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
	X,
} from 'lucide-react';
import { type RefObject, useRef } from 'react';

/**
 * The archive as a directory tree — `docs/DESIGN.md` §9's left column.
 *
 * **The card carries no width of its own** (#172). It was `lg:w-[320px] shrink-0` — the row's one
 * sized child — and the row now writes both fractions of the split itself (`routes/archive.tsx`,
 * `Columns`). This file describes the card, never how much of the row it is given.
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
 * **And clicking an open row closes it, because an open row goes up** (#175). A row's address is
 * its own while it is shut and the address of the node it is drawn under while it is open, so a
 * second click on a node lands one level above it and the rule above then draws it closed. Nothing
 * is stored to make that happen at any depth: the tree is still a pure function of the URL, so a
 * reload and a shared link still land where the reader is and the tree still cannot disagree with
 * the address bar.
 *
 * The cost is that **collapsing a node moves the selection to its parent**, so the card beside the
 * tree becomes that parent's card. The alternative — a set of deliberately-closed nodes laid over
 * the rule above — buys collapsing without moving the selection and pays for it by making *the
 * selection is drawn nowhere in the tree* reachable while the card still draws that file, which is
 * the one thing the tree is on screen to prevent (#160).
 *
 * The accepted cost that stands, recorded in §9: a folder cannot be peeked at without selecting it,
 * and now it cannot be closed without leaving it either. Both are ordinary file-explorer behaviour
 * and they remove a whole class of *the tree and the URL disagree* bugs.
 *
 * **What may never appear on a row**, all of it from the issue's binding rules:
 *
 * - **no count.** `childCount` is on the wire and is deliberately not drawn here; the header badge
 *   carries the one number for whatever is selected, so the tree stays a tree.
 * - **no status icon of any kind** — no tick, no cross, no dot, no play glyph, no colour that means
 *   an outcome. Rover has no verdicts to report (`docs/DESIGN.md` §2), and green ticks beside runs
 *   in the tree are exactly what the earlier design got wrong.
 * - **a glyph on every row saying what the entry is, and a triangle only where there is a level
 *   under it.** **A run is no longer a leaf** (#159, reversed in place in `docs/DESIGN.md` §9): it
 *   was one because the card beside this tree was a second explorer that named what the run wrote,
 *   and with that card going the tree has to reach the file itself. Its children are the entries of
 *   its `<serial>` directory, which is still **not a level of this tree** ({@link runContentsLevel})
 *   and still in every address below the run — so a run whose parent named no single child has no
 *   triangle, because there is no level to open and drawing one over nothing is the same class of
 *   claim as an invented `0`.
 * - **`break-words`, never `break-all`.** The latter splits `issue-112` across two lines.
 *
 * Every row is a `<Link>` and there is no nested interactive element: the triangle is `aria-hidden`
 * decoration saying *this opens*, not a second control. **Collapsing stays the row's** (#175): the
 * row already goes somewhere, and hanging the second half of one gesture on a `<button>` inside the
 * link would split it across two targets and make a row two things. What the row does say out loud
 * is `aria-expanded`, on every row there is a level under and on no other — the triangle draws
 * openness and cannot say it, and this is the change that would have noticed.
 *
 * **And the card searches the whole archive** (#146, R38, `docs/DESIGN.md` §9). The field between
 * the header strip and the tree is the design's own (screen `8dcd4330…`), and while there is text in
 * it the body draws the host's matches instead of the URL's levels:
 *
 * - **every hit is visible and its ancestors are expanded, and a branch holding no match is not
 *   drawn** — all three fall out of `search-tree.ts` building the tree from the matches themselves;
 * - **there is no depth bound in either tree now** (#159, amended in place). This one drew exactly
 *   the paths the host answered, which was how a name below a run became reachable at all while the
 *   browsing tree stopped at one; the browsing tree reaches it too now, and this one still draws
 *   exactly the addresses the host answered and nothing else;
 * - **a hit row gains nothing a browsing row is forbidden.** It is the same {@link Row}: the same
 *   `<Link>`, the same classes, no count, no status glyph, no colour that means an outcome.
 * - **a truncated answer says so**, above the hits and not below them, so a partial list cannot
 *   read like a complete one for as long as it takes to scroll to the end of it — and it says so
 *   whether or not anything matched, because an empty hit list is still a hit list ({@link Searched}).
 *
 * **And while there is text in it, that field's leading glyph is a clear action** (#154) — a
 * *further* **deliberate deviation from the approved markup**, recorded in `docs/DESIGN.md` §9
 * beside the placeholder's. The approved screens draw the magnifying glass and nothing else, and no
 * acceptance criterion asks for a way to empty the field — but they only ever draw the field
 * *empty*, so what that position does with a query in it was never designed. Empty, it is the
 * approved glyph, unchanged; with text in it, it is the {@link Clear} button.
 */

/** The level whose rows are runs — 0 is a project, 1 a test name, 2 a run. */
const RUN_ROW_DEPTH = 2;

/**
 * The first level whose listing is a run's **own** — `[…run, <serial>]`, reached by hopping the
 * serial at {@link RUN_ROW_DEPTH} rather than by descending into it.
 *
 * At and below it every entry is a row, whatever its `kind`: a file is what a reader selects in
 * order to preview it. Above it only a directory is a row, because a stray file at a project or a
 * test-name level is not something this tree can take you into.
 */
const SERIAL_DEPTH = 4;

/**
 * The placeholder, and it is a **deliberate deviation from the approved markup** recorded in
 * `docs/DESIGN.md` §9.
 *
 * The design says *Filter this tree...*, which describes a client-side filter over rows already
 * drawn. This is not that: typing asks the host to search the whole archive, including levels this
 * tree has never read, so the field says what it does.
 */
const PLACEHOLDER = 'Search the whole archive...';

/** The leading glyph's corner, shared so the two things that sit in it cannot drift apart. */
const GLYPH = 'absolute top-2.5 left-2.5';

export function DirectoryTree({
	selected,
	levels,
	search,
}: {
	readonly selected: readonly string[];
	readonly levels: ArchiveLevels;
	/**
	 * The search, held **above this card** (`routes/archive.tsx`, which gives the reason) — the
	 * state outlives an address changing under it, and the field is absent wherever this card is
	 * without anything having to say so twice, because it is part of the card. It stays above now
	 * that #160 left one arrangement and this component no longer remounts under one.
	 */
	readonly search: ArchiveSearch;
}) {
	// Where {@link Clear} puts the caret back, for the reason given there.
	const field = useRef<HTMLInputElement>(null);

	return (
		<aside className="flex w-full flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface-container">
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
						ref={field}
						spellCheck={false}
						type="text"
						value={search.text}
					/>
					{search.text === '' ? (
						/* `lucide-react`'s own glyph, not the design's Material Symbols one (§9). */
						<Search
							aria-hidden="true"
							className={`${GLYPH} text-outline`}
							size={18}
							strokeWidth={2}
						/>
					) : (
						<Clear field={field} setText={search.setText} />
					)}
				</div>
			</div>
			<div className="flex-1 overflow-y-auto p-4 font-code-md text-code-md">
				{search.state.status === 'idle' ? (
					<Branch levels={levels} path={[]} selected={selected} under={[]} />
				) : (
					<Searched selected={selected} state={search.state} />
				)}
			</div>
		</aside>
	);
}

/**
 * The clear action that stands where the `Search` glyph stands while the field holds a query (#154,
 * `docs/DESIGN.md` §9) — the same corner, the same size, so nothing in the approved markup moves.
 *
 * **It empties the field through the field's own setter**, so clearing is not a second path: an
 * empty text is `idle` in `archive-search.ts` whether it arrived by a keystroke or by this, the
 * tree goes straight back to the levels the URL describes, and no request is spent saying so.
 *
 * **The caret goes back to the field**, because this control stops existing the instant the text is
 * empty — leaving focus on it would drop a keyboard reader onto the document body mid-search. And
 * `aria-label` rather than a title or a bare glyph, the way the field itself carries one: the `X`
 * draws the action and cannot say it.
 */
function Clear({
	field,
	setText,
}: {
	readonly field: RefObject<HTMLInputElement | null>;
	readonly setText: (text: string) => void;
}) {
	return (
		<button
			aria-label="Clear the search text"
			className={`${GLYPH} flex text-outline transition-colors hover:text-tertiary`}
			onClick={() => {
				setText('');
				field.current?.focus();
			}}
			type="button"
		>
			<X aria-hidden="true" size={18} strokeWidth={2} />
		</button>
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
 *
 * **So a hit row never collapses, and it still says it is open** (#175). Every row here goes to its
 * own address, because that address is the whole of what a hit is; there is no *node it is drawn
 * under* to close onto, since a search answer is not a level of anything. `aria-expanded` is still
 * true of it and is still drawn, for the same reason the triangle is.
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
							expanded={opens ? true : null}
							kind={node.kind}
							name={node.name}
							selected={keyOf(node.path) === keyOf(selected)}
							to={node.path}
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

/**
 * A folder open or shut, a file, or something the host could not classify. No status glyph.
 *
 * **One helper for both trees**, and it takes the host's own `kind` in both: a name never decides
 * what an entry is (D22), and the two trees drawing a `.png` differently would be exactly that
 * inference sneaking in on one side of the card.
 */
function glyphFor(kind: ArchiveEntry['kind'], expanded: boolean): LucideIcon {
	if (kind === 'directory') {
		return expanded ? FolderOpen : Folder;
	}
	return kind === 'file' ? FileText : FileQuestionMark;
}

/**
 * One level's rows, and the children of whichever of them is on the selected path.
 *
 * **Above a run only a directory becomes a row; at and below the `<serial>` every entry is one**
 * ({@link SERIAL_DEPTH}). A stray file at a project or a test-name level is still the contents
 * card's to name — this tree cannot take you into it — but inside a run a file is precisely what a
 * reader selects, so refusing it a row would leave the tree unable to reach most of the archive.
 *
 * **And a run's children are not its own level.** They are the entries of its `<serial>` directory
 * ({@link runContentsLevel}), so the recursion hops that one address at {@link RUN_ROW_DEPTH} and
 * descends ordinarily either side of it.
 *
 * **A level with nothing in it draws nothing under its node — except the run's own** (#161). Every
 * other level's card is that level's listing and says *empty* or *unreadable* itself; the run's card
 * lists nothing, so the pair is said here, in one quiet line and never as a row.
 *
 * **The order comes from `orderedEntries`, which is the contents card's too**: the two panes list
 * the same run directories side by side, so *most recent first* is decided once for both rather
 * than remembered separately by each.
 */
function Branch({
	path,
	under,
	selected,
	levels,
}: {
	readonly path: readonly string[];
	/**
	 * The address of the node this level is drawn under, and so where an **open** row in it goes —
	 * which is the whole of collapsing (#175). It is `[]` at the root, and it is the **run's** own
	 * address for the run's contents: the `<serial>` is not a level of this tree, so the hop
	 * {@link levelUnder} makes on the way down is made back here rather than closing a row onto an
	 * address no row of this tree stands for. Passed down rather than derived from {@link path}, so
	 * no depth is special-cased in either direction.
	 */
	readonly under: readonly string[];
	readonly selected: readonly string[];
	readonly levels: ArchiveLevels;
}) {
	const level = levelAt(levels, path);
	// The rows' own level: 0 is a project, 1 a test name, 2 a run, and 4 and below are inside one.
	const depth = path.length;

	if (level.status === 'loading') {
		return <Quiet>Reading this level.</Quiet>;
	}
	/*
	 * An empty or unreadable level draws **nothing** under its node — no `0`, no placeholder row,
	 * no icon. A directory that does not exist is not listed, and one the host cannot see into is
	 * said where there is room to say it: the contents card, whose whole area is the message.
	 *
	 * **The run's own `<serial>` level is the exception, and it is the only one** (#161). The card
	 * beside every other node *is* that level's listing, so the card is where its two empty-handed
	 * answers are already said; a run's card is the run's identity and its device and lists nothing
	 * at all since `CONTENTS` went, which leaves nowhere else to draw *empty* and *unreadable*
	 * apart — and they may never render alike (D6, `docs/DESIGN.md` §9). So this one level says
	 * which it is, in the line the tree already uses for a level in flight and in nothing that is a
	 * row.
	 */
	if (level.status !== 'listed') {
		if (depth === SERIAL_DEPTH) {
			return (
				<Quiet>
					{level.status === 'empty'
						? 'This run wrote nothing.'
						: "This run's contents are not readable."}
				</Quiet>
			);
		}
		return null;
	}

	return (
		<ul className="space-y-1">
			{orderedEntries(level.entries, depth)
				.filter((entry) => depth >= SERIAL_DEPTH || entry.kind === 'directory')
				.map((entry) => {
					const childPath = [...path, entry.name];
					const below = levelUnder(levels, path, entry);
					/*
					 * Open is *has a level under it* and *is on the selected path* — so nothing is ever
					 * drawn open over a level that does not exist. `null` is the third answer and it is
					 * not *shut*: a row that opens nothing has no state to be in, carries no triangle and
					 * claims none to assistive technology.
					 */
					const onPath = keyOf(selected.slice(0, childPath.length)) === keyOf(childPath);
					const expanded = below === null ? null : onPath;
					return (
						<li className="min-w-0" key={entry.name}>
							<Row
								expanded={expanded}
								kind={entry.kind}
								name={entry.name}
								/*
								 * The serial is not a level, so `/…/<run>` and `/…/<run>/<serial>` are the
								 * same place in this tree and the run's row is what marks it. Without the
								 * second clause a depth-4 address — typed, or followed from a search hit —
								 * would mark no row at all.
								 */
								selected={
									keyOf(childPath) === keyOf(selected) ||
									(depth === RUN_ROW_DEPTH && below !== null && keyOf(below) === keyOf(selected))
								}
								// Shut, it goes to itself and opens; open, it goes to the node above it and
								// closes (#175). One address per row either way, and nothing stored.
								to={expanded === true ? under : childPath}
							/>
							{below !== null && expanded ? (
								<div className="mt-1 ml-2.5 space-y-1 border-outline-variant border-l-2 py-1 pl-5">
									<Branch levels={levels} path={below} selected={selected} under={childPath} />
								</div>
							) : null}
						</li>
					);
				})}
		</ul>
	);
}

/**
 * The level a row opens, or `null` when it opens nothing — a file, and **a run whose parent named
 * no single child**.
 *
 * A run's is the entries of its `<serial>` directory, which is not a level of this tree
 * ({@link runContentsLevel}); everywhere else a directory's is its own. This is the whole of the
 * hop, and it is what makes the recursion below a run ordinary rather than special-cased at every
 * depth under it.
 */
function levelUnder(
	levels: ArchiveLevels,
	path: readonly string[],
	entry: ArchiveEntry,
): readonly string[] | null {
	if (entry.kind !== 'directory') {
		return null;
	}
	const childPath = [...path, entry.name];
	return path.length === RUN_ROW_DEPTH ? runContentsLevel(levels, childPath) : childPath;
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
 * **What a row *is*, whether it is open, and where it goes are the inputs; nothing else is** (#146,
 * amended in place by #175). Both trees take what a row is from the host's own `kind` and never
 * from a name (D22), and both take openness from their own idea of it — a level drawn under it
 * here, an answer with something under it there. They differ in one more thing since #175, and it
 * is the whole of collapsing: a browsing row that is open goes to the node above it, while a hit
 * goes to its own address whatever it is drawing under itself. Everything that makes a row a row is
 * here and unconditional — the `<Link>`, the classes, and every extra it refuses to carry — so a
 * hit cannot acquire a count, a status glyph or an outcome colour by being drawn from a different
 * tree.
 *
 * `expanded` is `null` on a row nothing opens, which is not the same as shut: it draws no triangle
 * and claims no state. Where there is one, the triangle stays `aria-hidden` decoration meaning
 * *this opens* — never a second control inside the link — and `aria-expanded` is what says the same
 * thing to a reader who cannot see it.
 *
 * **`aria-current` marks the selection, and since #175 it is not the link's destination.** An open
 * row is the selection or an ancestor of it and goes *up*; saying *you are here* about the row and
 * *this closes it* about the click is the toggle a file explorer's row already is.
 *
 * What this component passes is not all that reaches the DOM, and **that predates #175 and is
 * unchanged by it**: `Link` stamps `aria-current="page"` on every row whose address is a prefix of
 * the current one, which the ancestors of a selection always were and still are. Checked in Chrome
 * against a running host. The **colour** is this component's own and marks exactly one row; the
 * attribute is over-applied there, and narrowing it is a change of its own rather than this one's.
 */
function Row({
	to,
	name,
	kind,
	expanded,
	selected,
}: {
	/** Where clicking goes — this row's own address, or the node above it when it is open (#175). */
	readonly to: readonly string[];
	readonly name: string;
	/** What this row **is**, in the host's own words: a directory, a file, or *unclassified*. */
	readonly kind: ArchiveEntry['kind'];
	/** Open, shut, or `null` on a row that opens nothing at all. */
	readonly expanded: boolean | null;
	readonly selected: boolean;
}) {
	const Icon = glyphFor(kind, expanded === true);
	const Triangle = expanded === null ? null : expanded ? ChevronDown : ChevronRight;
	return (
		<Link
			aria-current={selected ? 'page' : undefined}
			aria-expanded={expanded ?? undefined}
			className={`${ROW_BASE} ${selected ? ROW_SELECTED : ROW_UNSELECTED}`}
			params={{ _splat: splatFromComponents(to) }}
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
