import type { ArchiveEntry } from '@panel/archive/archive-listing.js';
import {
	keyOf,
	MAX_ARCHIVE_SEARCH_TEXT_LENGTH,
	splatFromComponents,
} from '@panel/archive/archive-path.js';
import type { ArchiveSearch, ArchiveSearchState } from '@panel/archive/archive-search.js';
import type { OpenBranches } from '@panel/archive/open-branches.js';
import { type HitNode, hitTree } from '@panel/archive/search-tree.js';
import type { TreeRoute, TreeSource } from '@panel/archive/tree-source.js';
import { LabelBadge } from '@panel/components/archive/label-badge.js';
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
import { type MouseEvent, type ReactNode, type RefObject, useRef } from 'react';

/**
 * The archive as a directory tree — `docs/DESIGN.md` §9's left column.
 *
 * **One tree, and both views draw it** (#181). The rows come from a {@link TreeSource} rather than
 * from `ArchiveLevels`: a source answers *the rows at this node*, *the level a row opens* and *the
 * route a row's address is on*, and nothing else about a tree is a view's to choose. So the `All`
 * view's levels and the groups view's arrangement are two answers to one question, and every rule
 * below — the row anatomy, what a row may never carry, what expands, how clicking an open row closes
 * it — is shared and unconditional. A second tree implementation for the second view is the failure
 * mode this shape exists to prevent.
 *
 * **The card carries no width of its own** (#172). It was `lg:w-[320px] shrink-0` — the row's one
 * sized child — and the row now writes both fractions of the split itself (`routes/archive.tsx`,
 * `Columns`). This file describes the card, never how much of the row it is given.
 *
 * **Expansion is an open set, over the selection's own ancestors as a floor** (#198, reversing
 * #175's derived-expansion rule in place — `docs/DESIGN.md` §9, rewritten with it). It was derived
 * *entirely* from the selection: a node was expanded exactly when it was a prefix of the selected
 * path, and the selected node too. One selection is one path, so only one branch could be open at
 * a time and opening a second top-level row closed the first — the rule's exact consequence rather
 * than a defect in it, and it made a reader crossing between two projects rebuild the tree they had
 * a moment ago. So a node is drawn expanded when it is **in the open set** *or* it is a **strict**
 * ancestor of the selection (`open-branches.ts`, {@link OpenBranches}), and what the reversal did
 * **not** surrender is the guarantee the old rule was protecting:
 *
 * - **the selection is always drawn.** Its ancestors are expanded whatever the set holds, so a
 *   closed ancestor with the card beside the tree still drawing the file underneath it is
 *   unreachable rather than merely avoided — which is what #160 put the tree there for;
 * - *lazily, one `readdir` at a time* — the levels read are the levels **drawn**, walked from the
 *   root through expanded rows only (`tree-source.ts`, `drawnLevels`). The set grows only by a
 *   click, so the number of levels read is bounded by the reader's gestures and never by what is in
 *   the archive; a pre-walk is still unrepresentable;
 * - *a reload lands where you were and a link is shareable* — **where you are is still the address
 *   alone.** The open set is component state and deliberately not in the URL, the exception the
 *   tree card's search text already is (#146): a shared link lands on the address without somebody
 *   else's browsing, and it is seeded from that address's own prefixes, so what it draws is the tree
 *   the derived rule drew;
 * - a sibling nobody opened draws no children, because nothing has been read for it.
 *
 * **And clicking an open row still closes it** (#175's gesture, unchanged, at every depth). Every
 * row links to its **own** address now — the `to` that went one level up is gone — and the click
 * toggles that row's branch. Landing *on* the row is what makes the closing half work: it stops
 * being a strict ancestor of the selection, so the floor stops holding it open and the set's answer
 * is what the tree draws. **A row that opens nothing gains nothing**: no triangle, no
 * `aria-expanded`, and a click on it is the navigation it always was.
 *
 * The stated cost stays stated: **closing an ancestor of the selection moves the selection up to
 * that node**, so the card beside the tree becomes that node's card. What it no longer costs is
 * every *other* open branch, and closing a project no longer lands on the archive root.
 *
 * The accepted cost that stands, recorded in §9: a folder cannot be peeked at without selecting it,
 * because the row is one target and selecting is what it does.
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
 *   its `<serial>` directory, which is still **not a level of this tree** (`tree-source.ts`)
 *   and still in every address below the run — so a run whose parent named no single child has no
 *   triangle, because there is no level to open and drawing one over nothing is the same class of
 *   claim as an invented `0`.
 * - **`break-words`, never `break-all`.** The latter splits `issue-112` across two lines.
 * - **One thing was added, and it is a name rather than a measure** (#182): the label badge, on an
 *   artifact the **groups** view has a filed label for and on no other row anywhere. A badge number
 *   is defined only inside a group, so the source is what answers it and the `All` view's rows have
 *   none by construction; an artifact with no label has none either, so an archive that never used
 *   labels draws the tree it drew before. It is not a verdict, nothing is ranked by it, and the
 *   number — never the colour alone — is what carries it (`label-badge.tsx`). It is also **not the
 *   file's own ordinal**, which is why it is a `#`-prefixed pill rather than a bare digit beside a
 *   name that already starts with one (#206).
 *
 * Every row is a `<Link>` and there is no nested interactive element: the triangle is `aria-hidden`
 * decoration saying *this opens*, not a second control. **Collapsing stays the row's** (#175, and
 * #198 kept it there): the row already goes somewhere, and hanging the second half of one gesture on
 * a `<button>` inside the link would split it across two targets and make a row two things. What the
 * row does say out loud is `aria-expanded`, on every row there is a level under and on no other, and
 * it reports the **drawn** state — the triangle draws openness and cannot say it.
 *
 * **And the card searches the whole archive** (#146, R38, `docs/DESIGN.md` §9). The field between
 * the header strip and the tree is the design's own (screen `8dcd4330…`), and while there is text in
 * it the body draws the host's matches instead of the URL's levels. **It is the `All` view's and is
 * absent from the groups view** (#181): `search_archive` answers addresses of the archive, which
 * are addresses the groups view does not own, so a hit found there would have nowhere in this
 * arrangement to land. The field is drawn only where the search it performs is about the tree
 * beside it —
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
	source,
	branches,
	search,
}: {
	readonly selected: readonly string[];
	/** Where the rows come from, and the one thing the two views differ in (#181). */
	readonly source: TreeSource;
	/**
	 * Which branches are open and what a click on a row does to them (#198) — held **above this
	 * card** for the reason the search is, and with the same consequence: it outlives an address
	 * changing under it, so opening a node never closes another.
	 *
	 * It is not a view's choice. Both views draw one tree, so both are handed one of these
	 * (`routes/archive.tsx`) and the searched tree below is the only thing here that has none.
	 */
	readonly branches: OpenBranches;
	/**
	 * The search, held **above this card** (`routes/archive.tsx`, which gives the reason) — the
	 * state outlives an address changing under it, and the field is absent wherever this card is
	 * without anything having to say so twice, because it is part of the card. It stays above now
	 * that #160 left one arrangement and this component no longer remounts under one.
	 *
	 * **Absent in the groups view** (#181), which is what `undefined` draws: no field, and the body
	 * is the tree unconditionally.
	 */
	readonly search?: ArchiveSearch;
}) {
	return (
		<aside className="flex w-full flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface-container">
			<div className="border-outline-variant border-b-2 bg-surface-container-high px-4 py-3">
				<h2 className="font-label-caps text-label-caps text-on-surface uppercase tracking-widest">
					DIRECTORY
				</h2>
			</div>
			{search === undefined ? null : <SearchField search={search} />}
			<div className="flex-1 overflow-y-auto p-4 font-code-md text-code-md">
				{search !== undefined && search.state.status !== 'idle' ? (
					<Searched route={source.route} selected={selected} state={search.state} />
				) : (
					<>
						{source.truncated ? <Truncated /> : null}
						<Branch branches={branches} node={[]} selected={selected} source={source} />
					</>
				)}
			</div>
		</aside>
	);
}

/**
 * The design's own field, drawn only where the search it performs is about the tree beside it —
 * which is the `All` view (#181, and the module header's reason).
 *
 * Its own component since the groups view draws none, so *no field* is one absent element rather
 * than a condition threaded through the markup of one.
 */
function SearchField({ search }: { readonly search: ArchiveSearch }) {
	// Where {@link Clear} puts the caret back, for the reason given there.
	const field = useRef<HTMLInputElement>(null);

	return (
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
	);
}

/**
 * The rows below this line came out of an answer that was cut short (#181).
 *
 * The groups view is one bounded walk of the whole archive, and `truncated` means exactly *at least
 * one directory that exists was not fully examined* — so a group, a run or an artifact may be
 * missing. Said **above** the rows and not below them, exactly as the searched tree says it: a
 * partial arrangement must not read like a complete one for as long as it takes to scroll to the
 * end of it.
 */
function Truncated() {
	return (
		<p className="mb-3 px-3 text-on-surface-variant">
			More is filed here than the host could examine. A group or a run may be missing.
		</p>
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
	route,
}: {
	readonly state: Exclude<ArchiveSearchState, { status: 'idle' }>;
	readonly selected: readonly string[];
	readonly route: TreeRoute;
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
			<Hits nodes={hitTree(state.matches)} route={route} selected={selected} />
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
 * **So a hit row never collapses, and it still says it is open** (#175, and #198 left this tree
 * alone). Every row here goes to its own address — which every row of the browsing tree does now
 * too — and it carries no toggle: a hit *is* an address the host answered with rather than a level
 * of anything, so there is nothing under it to open and nothing to close onto. `aria-expanded` is
 * still true of it and is still drawn, for the same reason the triangle is.
 */
function Hits({
	nodes,
	selected,
	route,
}: {
	readonly nodes: readonly HitNode[];
	readonly selected: readonly string[];
	readonly route: TreeRoute;
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
							route={route}
							selected={keyOf(node.path) === keyOf(selected)}
							to={node.path}
						/>
						{opens ? (
							<div className="mt-1 ml-2.5 space-y-1 border-outline-variant border-l-2 py-1 pl-5">
								<Hits nodes={node.children} route={route} selected={selected} />
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
 * One node's rows, and the children of whichever of them are open.
 *
 * **Everything about what a row is comes off the source** (#181) — which entries become rows, the
 * order they are drawn in, and the level each one opens. What is here is what is true of the tree
 * in both views: what expands, a click toggling it, and a level with nothing in it drawing nothing
 * under its node.
 *
 * **A level with nothing in it draws nothing under its node — except the run's own** (#161). Every
 * other level's card is that level's listing and says *empty* or *unreadable* itself; the run's card
 * lists nothing, so the pair is said here, in one quiet line and never as a row. Which node that is
 * is the source's to say, because the group id puts it one level deeper in the groups view.
 */
function Branch({
	node,
	selected,
	source,
	branches,
}: {
	/** This level's node, in the tree's own address space — never a host path. */
	readonly node: readonly string[];
	readonly selected: readonly string[];
	readonly source: TreeSource;
	readonly branches: OpenBranches;
}) {
	const level = source.rowsAt(node);

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
		if (source.isRunContents(node)) {
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
			{level.rows.map((row) => {
				/*
				 * Open is *has a level under it* and *the open set says so* — over the floor that keeps
				 * every ancestor of the selection expanded (`open-branches.ts`), so nothing is ever
				 * drawn open over a level that does not exist and the selection is never hidden under a
				 * shut one. `null` is the third answer and it is not *shut*: a row that opens nothing
				 * has no state to be in, carries no triangle and claims none to assistive technology.
				 */
				const expanded = row.opens === null ? null : branches.isOpen(row.address);
				return (
					<li className="min-w-0" key={row.name}>
						<Row
							/*
							 * **A badge exactly where the source answered a label, and nowhere else** (#182).
							 * The number is the group's and the label is the archive's, and both come off the
							 * row rather than out of anything this component knows — so the `All` view's tree,
							 * whose rows carry no label at any depth, renders exactly what it renders today.
							 */
							badge={
								row.label === undefined ? undefined : (
									<LabelBadge label={row.label.label} number={row.label.number} />
								)
							}
							expanded={expanded}
							kind={row.kind}
							name={row.name}
							route={source.route}
							/*
							 * The serial is not a level, so `/…/<run>` and `/…/<run>/<serial>` are the
							 * same place in this tree and the run's row is what marks it. Without the
							 * second clause a selected `<serial>` address — typed, or followed from a
							 * search hit — would mark no row at all. Everywhere else the level a row
							 * opens *is* its address, so the clause is the first one again and no
							 * depth has to be named to know which case this is.
							 */
							selected={
								keyOf(row.address) === keyOf(selected) ||
								(row.opens !== null && keyOf(row.opens) === keyOf(selected))
							}
							// **One address per row, and it is the row's own** (#198). Shut, the click
							// selects it and opens it; open, it selects it and closes it — landing on the
							// row is what takes it out from under the floor that was holding it open.
							to={row.address}
							toggle={row.opens === null ? undefined : () => branches.toggle(row.address)}
						/>
						{row.opens !== null && expanded ? (
							<div className="mt-1 ml-2.5 space-y-1 border-outline-variant border-l-2 py-1 pl-5">
								<Branch branches={branches} node={row.opens} selected={selected} source={source} />
							</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * Whether this click is the one that opens or closes a branch — **the same click the navigation acts
 * on, and no other** (#198).
 *
 * A row's `onClick` runs *before* the router's own (`composeHandlers`, in
 * `@tanstack/react-router`'s `link.tsx`), and the router deliberately declines a modifier-click or a
 * secondary button so the browser can take the address to a new tab or a new window. The two halves
 * of one gesture have to agree about that: without this, cmd-clicking a row to read a second file
 * beside the one already open would collapse that branch in the tab being left behind. So the
 * condition is the router's own, narrowed to what a row can see.
 */
function opensOn(event: MouseEvent<HTMLAnchorElement>): boolean {
	return !(event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) && event.button === 0;
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
 * **What a row *is*, whether it is open, where it goes and which route that address is on are the
 * inputs; nothing else is** (#146, amended in place by #175, #181 and #198). Every tree that draws
 * one takes what a row is from the host's own `kind` and never from a name (D22), and takes openness
 * from its own idea of it — the open set in a browsing tree, an answer with something under it in a
 * searched one. **Where a row goes is its own address in both**, which is what #198 gave back: the
 * one-level-up destination that used to be the whole of collapsing is gone, and what closes a
 * browsing row is the {@link toggle} its click carries. Everything that makes a row a row is here
 * and unconditional — the `<Link>`, the classes, and every extra it refuses to carry — so a hit, or
 * a row of the groups view, cannot acquire a count, a status glyph or an outcome colour by being
 * drawn from a different source.
 *
 * `expanded` is `null` on a row nothing opens, which is not the same as shut: it draws no triangle,
 * claims no state and carries no toggle. Where there is one, the triangle stays `aria-hidden`
 * decoration meaning *this opens* — never a second control inside the link — and `aria-expanded` is
 * what says the same thing to a reader who cannot see it.
 *
 * **The row is one target and stays one** (#175). A click is one navigation and, on a browsing row,
 * one toggle of that row's branch: the handler is on the `<Link>` itself, never on a `<button>`
 * nested in it, so there is nothing here a reader can hit that is not the row. The two halves ride
 * on the same click and on no other — see {@link opensOn}.
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
	route,
	badge,
	toggle,
}: {
	/** Where clicking goes, and it is always this row's own address (#198). */
	readonly to: readonly string[];
	readonly name: string;
	/** What this row **is**, in the host's own words: a directory, a file, or *unclassified*. */
	readonly kind: ArchiveEntry['kind'];
	/** Open, shut, or `null` on a row that opens nothing at all. */
	readonly expanded: boolean | null;
	readonly selected: boolean;
	/**
	 * Which route family {@link to} is a splat on — **the one thing in this component a view gets to
	 * decide** (#181). It came from the source rather than being hardcoded here the moment a second
	 * arrangement had addresses of its own; everything else about a row is still unconditional.
	 */
	readonly route: TreeRoute;
	/**
	 * The label badge, on an artifact the groups view has a label for and `undefined` on every other
	 * row (#182) — the second thing a view gets to decide, and the whole of the row's change.
	 *
	 * It is not one of the extras this row refuses. A count is a measure of the row and a status
	 * glyph is a verdict about it; this is a **name the archive filed with the artifact**, drawn
	 * short because a group is where the same label on two runs is the point. Nothing about it is an
	 * outcome, nothing is ranked by it, and the colour is a second channel for the number rather than
	 * a meaning of its own (`label-badge.tsx`).
	 */
	readonly badge?: ReactNode;
	/**
	 * What this row's click does to its branch — open it if it is drawn shut, close it if it is drawn
	 * open (#198, `open-branches.ts`).
	 *
	 * `undefined` on a row that opens nothing, and on **every** row of the searched tree: a hit is an
	 * address the host answered with rather than a level of anything, so there is nothing there to
	 * open or to close (§9).
	 */
	readonly toggle?: () => void;
}) {
	const Icon = glyphFor(kind, expanded === true);
	const Triangle = expanded === null ? null : expanded ? ChevronDown : ChevronRight;
	return (
		<Link
			aria-current={selected ? 'page' : undefined}
			aria-expanded={expanded ?? undefined}
			className={`${ROW_BASE} ${selected ? ROW_SELECTED : ROW_UNSELECTED}`}
			onClick={
				toggle === undefined
					? undefined
					: (event) => {
							if (opensOn(event)) {
								toggle();
							}
						}
			}
			params={{ _splat: splatFromComponents(to) }}
			to={route}
		>
			{Triangle === null ? null : (
				<Triangle aria-hidden="true" className="mt-0.5 shrink-0" size={14} strokeWidth={2} />
			)}
			<Icon aria-hidden="true" className="mt-0.5 shrink-0" size={16} strokeWidth={2} />
			{/* Between the glyph and the name: what this entry is, then which label it was filed
			    under, then what it is called. A row without one is this row with nothing in it. */}
			{badge}
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
