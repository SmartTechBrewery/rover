import { type ArchiveGroups, useArchiveGroups } from '@panel/archive/archive-groups.js';
import {
	type ArchiveLevel,
	type ArchiveLevels,
	levelAt,
	runContentsLevel,
	useArchiveLevels,
} from '@panel/archive/archive-levels.js';
import {
	archiveAddressOf,
	componentsFromSplat,
	levelsOf,
	MAX_ARCHIVE_PATH_DEPTH,
	splatFromComponents,
} from '@panel/archive/archive-path.js';
import { type ArchiveSearch, useArchiveSearch } from '@panel/archive/archive-search.js';
import { useArchivedArtifact } from '@panel/archive/artifact.js';
import { type ArchivedDeviceInfo, useArchivedDeviceInfo } from '@panel/archive/device-info.js';
import { groupedSearch } from '@panel/archive/group-search.js';
import { groupRowsAt, groupRunSerial, testNamesOfGroup } from '@panel/archive/group-tree.js';
import { comparisonAt, type LabelComparison } from '@panel/archive/label-comparison.js';
import { type OpenBranches, useOpenBranches } from '@panel/archive/open-branches.js';
import {
	type PinnedTests,
	type PinState,
	TEST_NAME_DEPTH,
	type TestPath,
	usePinnedTests,
} from '@panel/archive/pinned-tests.js';
import {
	type ArchivedTestDescription,
	useArchivedTestDescription,
} from '@panel/archive/test-description.js';
import {
	allRowSource,
	drawnLevels,
	groupRowSource,
	type TreeSource,
} from '@panel/archive/tree-source.js';
import { ArtifactPreview } from '@panel/components/archive/artifact-preview.js';
import { ComparisonCard } from '@panel/components/archive/comparison-card.js';
import {
	ArchiveNotReadable,
	CardHeading,
	ContentsCard,
} from '@panel/components/archive/contents-card.js';
import { DirectoryTree } from '@panel/components/archive/directory-tree.js';
import { LevelContents } from '@panel/components/archive/level-contents.js';
import { RunPanel, type RunSerial } from '@panel/components/archive/run-panel.js';
import { type ArchiveView, ArchiveViewToggle } from '@panel/components/archive/view-toggle.js';
import type { BreadcrumbSegment } from '@panel/components/layout/breadcrumb.js';
import { PageHeader } from '@panel/components/layout/page-header.js';
import { QuietPanel } from '@panel/components/quiet-panel.js';
import { createRoute, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { rootRoute } from './__root.js';

/**
 * The archive, as a file explorer over what past leases wrote — **in either of its two
 * arrangements** (`docs/DESIGN.md` §9, #165, #181).
 *
 * **The path is in the URL, and two pieces of state on this screen are deliberately not** (#146,
 * #198). A reload lands where you were and a link is shareable, because *where you are* is the
 * address and nothing else carries it. The two exceptions are the tree card's search text
 * (`archive-search.ts`) and **which branches of the tree are open** (`open-branches.ts`), and they
 * are exceptions on the same terms: a shared link lands on the address without somebody else's
 * search and without somebody else's browsing, and each is seeded from that address — the search
 * empty, the open set with the selection's own prefixes, which is the tree the derived-expansion
 * rule used to draw. A hit and a row are navigations to one of these paths like any other, and the
 * open set **absorbs the selection's ancestors at every one of them** (`open-branches.ts`,
 * `absorbing`, and §9): the floor holding a branch open is evaluated against wherever the selection
 * is now, so a branch reached without clicking a row has to be taken into the set before the
 * selection leaves it — otherwise the next click elsewhere rebuilds the tree the reader was reading.
 *
 * **And since #181 the *view* is in the URL too, which is the question #165 deliberately left
 * open.** It could not be answered then, because the groups arrangement had no addresses of its own
 * and a link to a placeholder is a link to nothing. It has them now: `/archive` and `/archive/$`
 * are the file explorer, `/groups` and `/groups/$` the group-first arrangement, and this one
 * component serves all four with `view` as a prop. What that buys is exactly what §9 asks of the
 * `All` view's selection — a reload and a shared link land on it — and what it costs is the reset
 * machinery that stood in for it: `viewChosenAt`, `setView`, and the rule that any navigation ended
 * the second view. An address does not need to be ended by a navigation; it *is* one.
 *
 * **The two arrangements share every level below the group, and one component draws both.** The
 * tree, the row anatomy and the card beside it are the same in either view (`directory-tree.tsx`,
 * `tree-source.ts`); what differs is which rows sit under which node, and — in this file — one
 * component of the address. The groups view's splat is
 * `<project>/<groupId>/<testName>/<run>/<serial>/<…>`, and `archiveAddressOf` is the only thing
 * that turns it into the archive's own path by dropping the group id. Every read below a group goes
 * through it: the `list_archive` levels inside a run, the run's two files, and an open artifact's
 * bytes.
 *
 * **So closing a node in the tree moves the selection onto it, and this card follows** (#175's
 * gesture, #198's destination — `directory-tree.tsx`). Every row links to its own address and a
 * click toggles that row's branch, so closing an ancestor of the selection lands *on* that node and
 * the card beside the tree becomes its card — the cost §9 states rather than hides. Nothing here has
 * to know: it is a navigation like any other, onto levels this screen has already read. What no
 * longer happens is every *other* open branch closing with it.
 *
 * **Every state below is a state of this one screen** (§7's rule, applied to a second screen). The
 * breadcrumb, the describing line and the header row's shape are the same in all of them; the badge
 * is the only thing in the header that comes and goes, and it goes rather than reading `0`.
 *
 * **And there is one arrangement at every depth** (#160): the tree, then one card. What the parent
 * listing says the selection is decides what that card *draws* and nothing about whether the tree
 * is there —
 *
 * | The view's answer for its own root | What the content area is |
 * | --- | --- |
 * | nothing yet | one quiet line, no spinner |
 * | a listing | the tree, beside the selected address's own card |
 * | an empty listing, or nothing there | *Nothing in the archive* / *No testing groups* — and **no tree card** |
 * | unreadable | `ARCHIVE NOT READABLE` — and **no tree card** |
 *
 * The last two take the whole content area because **an empty tree beside a message is furniture**:
 * there is nothing to browse, so there is nothing for a tree to be a way into. They are the only
 * two states without a tree, and they gate the browsing layout **at and above the `<serial>`** —
 * no address *below* the `<serial>` ever waits on that root, in either view.
 *
 * Exported for `archive.test.tsx`, as `DevicesScreen` is: a route's component is otherwise
 * reachable only through a router instance, and what is worth asserting is which state renders what.
 */
export function ArchiveScreen({ view }: { readonly view: ArchiveView }) {
	// `strict: false` is what lets one component serve all four of this screen's routes.
	const params = useParams({ strict: false });
	// The cap is the archive's depth plus whatever this view puts in front of it — one component in
	// the groups view, none in the `All` view (#189 review).
	const selected = componentsFromSplat(params._splat, OFFSET[view]);
	const depths = depthsOf(view);
	/*
	 * **The whole of the groups arrangement above a run, in one request** (#181). It takes no
	 * parameter and there is no shape in which a second call could be made, so the levels this view
	 * draws down to a run cost exactly one round trip — and `view === 'groups'` is what keeps a
	 * reader who never opens it from paying for a walk of the archive they will not look at.
	 */
	const groups = useArchiveGroups(view === 'groups');
	/*
	 * **Which branches are open, held here rather than in the tree card** (#198). It is state for the
	 * reason the search text is — a reload and a shared link land on the *address* and not on somebody
	 * else's browsing (`open-branches.ts`) — and it is held *here* rather than one component lower
	 * because the levels asked for are the levels the tree draws, which is exactly what this decides.
	 *
	 * The bound is the deepest address this view's URL can carry, which is what `componentsFromSplat`
	 * caps a splat at: a row past it cannot be selected, so it is not opened either.
	 *
	 * It takes `selected` because it draws over it *and* absorbs from it: the hook writes the
	 * selection's strict ancestors into the set as the address moves, which costs no request — every
	 * level it takes over is one the floor already had drawn.
	 */
	const branches = useOpenBranches(selected, MAX_ARCHIVE_PATH_DEPTH + OFFSET[view]);
	/*
	 * **Which tests the reader has ticked `Keep` on** (`pinned-tests.ts`). Asked for here for one
	 * reason the open set above is not: the two cards that draw the checkbox — a test name's, and a
	 * run's — are never on screen at once, and they share one flag, so neither can be the one that
	 * asks.
	 *
	 * It is deliberately *not* addressable, and it is **not state of this screen's at all**: the
	 * flag is the host's, read once per mount out of `~/.rover/kept-tests.json` and written one
	 * press at a time (D33, #234). So a tick outlives the screen on purpose — that is what makes it
	 * a decision the host has been told about rather than a mark in one browser — and what this
	 * hook holds is a cache of the host's own answer, replaced by the answer to every press.
	 */
	const pinned = usePinnedTests();
	/*
	 * **One cache, asked as a function of itself** (`archive-levels.ts`). Some of these levels are
	 * addressed by a path *derived from* an answer — a run's `<serial>` is the level above's
	 * `onlyChild`, and the open folder's own listing is only wanted once its parent says it is a
	 * folder — and a second hook instance for those gave the screen two caches that each re-read what
	 * the other held (#140 review). `levelsWanted` is that derivation, run against what has answered
	 * so far.
	 */
	const levels = useArchiveLevels((known) => levelsWanted(view, selected, known, groups, branches));
	/** The archive's own path for the selection — the splat itself, minus the group id (#181). */
	const address = view === 'groups' ? archiveAddressOf(selected) : selected;
	const inRun = selected.length >= depths.below;
	/*
	 * What the open address turned out to be, out of the listing of the level above it — and *not*
	 * out of its own name (D22). Until that listing answers, nothing is fetched for it: a file is not
	 * read on a guess any more than a level is listed on one, and asking the byte route for a
	 * directory would put a warning in the host's log on every folder a reader opens.
	 */
	const open = inRun ? openEntryOf(levels, address) : 'unanswered';
	/*
	 * The one extra level a selected run needs, and in the `All` view it can only be asked for once
	 * the level above has answered: the `<serial>` directory's name is that answer's `onlyChild`. In
	 * the groups view the answer carries it outright, so there is nothing to wait for.
	 */
	const serial = serialOf(view, levels, groups, selected);
	const runLevel = runContents(view, levels, groups, selected);
	/*
	 * The run's `device_info.json`, read out of that same `<serial>` directory — the one thing on
	 * this screen that is a file's contents rather than a listing (#136, #131's byte route). It is
	 * addressed by the level, not by a path this screen composed, and it is not fetched at all for
	 * a run whose serial nobody has answered for.
	 *
	 * **And it is wanted at the run's own depth and nowhere else** (#160). The run's cards used to
	 * stand beside an open artifact, so both files were read for every address inside the run; the
	 * tree stands there now and nothing below the `<serial>` draws either of them, so a deep address
	 * reads neither. `runContents` is already guarded on the run's depth, so `null` is *there is no
	 * address yet* for both hooks (`archived-file.ts`).
	 */
	const device = useArchivedDeviceInfo(runLevel);
	/*
	 * And the lease's own description of the run, out of the same directory and on the same terms
	 * (#148). Two files per run rather than one; nothing else about the read changes, because both
	 * go through the one hook that owns the address and the one-request rule (`archived-file.ts`).
	 */
	const description = useArchivedTestDescription(runLevel);
	/*
	 * **What a selected labelled artifact is comparable with** (#199, `label-comparison.ts`), or
	 * `null` everywhere there is nothing to compare: the whole `All` view, an artifact with no label,
	 * and a label only one run in the group filed — one pane is not a comparison.
	 *
	 * It is computed **here** rather than in `Preview` because the artifact hook has to be gated on
	 * it: with the comparison drawn, each pane reads its own artifact, and the screen reading the
	 * selected one as well would read that file twice.
	 *
	 * **A deep link while the grouping walk is still out draws the single preview**, becoming the
	 * comparison once the walk answers. That is this screen's own established rule rather than an
	 * exception made here — *a deep group address browses while the grouping walk is still out*
	 * ({@link Content}) — and the cost is that one artifact read is repeated in that case. The
	 * ordinary path, a reader who opened the view and clicked down to the artifact, has the answer
	 * long before an artifact is selected.
	 */
	const comparison =
		view === 'groups' && inRun && open === 'artifact' && groups.status === 'listed'
			? comparisonAt(groups.groups, selected[0] ?? '', selected[1] ?? '', address)
			: null;
	/**
	 * The open artifact's own bytes. `null` while the address is a folder, not yet classified, or
	 * drawn by the comparison card — whose panes each own their own read of their own address.
	 */
	const artifact = useArchivedArtifact(open === 'artifact' && comparison === null ? address : null);
	/*
	 * **The tree card's search, held here rather than in the card** (#146). It stays here now that
	 * there is one arrangement (#160): the state outlives an address change either way, and the
	 * input is still absent wherever the card is — the two states with nothing to browse draw no
	 * tree, so they draw no field either, without anything having to say so twice.
	 *
	 * **Both views get one** (#207, reversing #181's *the `All` view's card alone* in place). The
	 * argument was about addresses — `search_archive` answers addresses of the archive, which the
	 * groups view does not own, so a hit found from there would have nowhere in that arrangement to
	 * land — and an address composes: `archiveAddressOf` drops the group id and `groupsAddressOf`
	 * puts it back. So the hook is the same hook, over the same one request per settled text, and
	 * what the groups view is handed is its answer **restricted to the runs that carry a group id**
	 * and re-addressed onto `/groups/$` (`group-search.ts`, which also folds the grouping answer's
	 * four states into the search's four and ORs the two walks' `truncated`).
	 */
	const search = useArchiveSearch();
	/*
	 * What the card is actually given. The `All` view's search is untouched — same field, same
	 * population, same addresses — and the groups view's is the same object with a restricted state,
	 * so the text, the setter and the debounce are one implementation in both.
	 */
	const shown =
		view === 'groups' ? { ...search, state: groupedSearch(search.state, groups) } : search;
	/** Where the tree's rows come from — the one thing the two views differ in (`tree-source.ts`). */
	const source = sourceFor(view, groups, levels);

	return (
		<>
			<PageHeader
				trail={trailFor(view, selected)}
				description={descriptionFor(view, selected, open, comparison)}
				aside={
					/*
					 * The toggle is the one thing in this row that is always there; the badge still comes
					 * and goes beside it, and it is absent in the groups view for the reason it is absent
					 * at a run — see {@link badgeFor}. The toggle sits last so a badge appearing does not
					 * move it.
					 */
					<div className="flex items-center gap-3">
						{view === 'all' ? badgeFor(selected.length, levelAt(levels, selected)) : undefined}
						<ArchiveViewToggle view={view} />
					</div>
				}
			/>
			<Content
				artifact={artifact}
				branches={branches}
				pinned={pinned}
				comparison={comparison}
				description={description}
				device={device}
				groups={groups}
				levels={levels}
				open={open}
				root={rootOf(view, levels, groups)}
				search={shown}
				selected={selected}
				serial={serial}
				source={source}
				view={view}
			/>
		</>
	);
}

/**
 * The content area — **one arrangement, and the two root answers that mean there is nothing to
 * browse at all** (#160).
 *
 * The two states with nothing in them take the whole area, because an empty tree beside a message is
 * furniture. Everything else is the tree beside one card, at every depth.
 *
 * **The root gate reaches the `<serial>` and no deeper.** An address below the `<serial>` draws the
 * tree from the first frame and the tree fills its own levels in as they arrive
 * (`directory-tree.tsx`); gating it on the root would make a deep link wait on a level it is not
 * waiting for anything else from. In the groups view that is the same rule over a different answer,
 * and it is what lets a deep group address browse while the grouping walk is still out: below the
 * `<serial>` every component of the archive address is in the URL already.
 */
function Content({
	view,
	root,
	selected,
	levels,
	groups,
	source,
	branches,
	serial,
	device,
	description,
	open,
	artifact,
	comparison,
	search,
	pinned,
}: {
	readonly view: ArchiveView;
	/** The state of this view's own root — {@link rootOf}. */
	readonly root: RootAnswer;
	readonly selected: readonly string[];
	/** The one cache, holding whatever has answered — the tree's levels and the run's `<serial>`. */
	readonly levels: ArchiveLevels;
	/** The one grouping answer, and `loading` throughout the `All` view, which reads none of it. */
	readonly groups: ArchiveGroups;
	readonly source: TreeSource;
	/** Which branches of the tree are open, and what a click on a row does to them (#198). */
	readonly branches: OpenBranches;
	readonly serial: RunSerial;
	readonly device: ArchivedDeviceInfo;
	readonly description: ArchivedTestDescription;
	/** Which of the three the address turned out to be — {@link OpenEntry}. */
	readonly open: OpenEntry;
	readonly artifact: ReturnType<typeof useArchivedArtifact>;
	/** What the open artifact is comparable with, or `null` when nothing is — {@link ComparisonCard}. */
	readonly comparison: LabelComparison | null;
	/**
	 * The tree card's search — **this view's own population** (#207): the whole archive in the `All`
	 * view, and the runs that carry a group id in the groups view.
	 */
	readonly search: ArchiveSearch;
	/** Which tests the reader has ticked `Keep` on — {@link usePinnedTests}. */
	readonly pinned: PinnedTests;
}) {
	if (selected.length < depthsOf(view).below) {
		if (root === 'loading') {
			// One line, and no spinner (§5). It is not an empty archive and must not read as one.
			return (
				<p aria-live="polite" className="mt-8 font-code-md text-code-md text-on-surface-variant">
					{view === 'groups'
						? "Reading the testing groups on this host's archive."
						: "Reading the host's artifact archive."}
				</p>
			);
		}
		if (root === 'empty') {
			return view === 'groups' ? (
				<NoTestingGroups truncated={groups.status === 'empty' && groups.truncated} />
			) : (
				<NothingArchived />
			);
		}
		if (root === 'unreadable') {
			// The same banner in both views, because it is the same fact about the same archive: the
			// host cannot read it, so neither arrangement of it can be drawn.
			return <ArchiveNotReadable />;
		}
	}

	return (
		<Columns>
			<DirectoryTree branches={branches} search={search} selected={selected} source={source} />
			<Preview
				artifact={artifact}
				comparison={comparison}
				description={description}
				device={device}
				groups={groups}
				levels={levels}
				open={open}
				pinned={pinned}
				selected={selected}
				serial={serial}
				view={view}
			/>
		</Columns>
	);
}

/**
 * The one card beside the tree, and **what it draws is the depth and what the parent listing says
 * the selection is — never whether the tree is there** (#160).
 *
 * | the selection | the card |
 * | --- | --- |
 * | a level above a run | that level's `LevelContents` |
 * | a run | `RunPanel` |
 * | a directory below the `<serial>` | that level's `LevelContents`, which is what the `<serial>` already draws |
 * | an artifact | `ArtifactPreview` **alone** — the run's identity and device cards are not beside it |
 * | an artifact **with a filed label, in the groups view** | `ComparisonCard` — one pane per artifact of this group under that label, oldest run left (#199) |
 * | an address nobody has answered for | {@link ReadingThisAddress}, claiming neither |
 *
 * **The preview holds one thing at a time, and the tree is what keeps the reader placed.** The run's
 * two cards used to stand beside it, from a layout where opening a file took the tree away; the tree
 * is there now, so the column beside it is the artifact and nothing else.
 *
 * **The comparison card is the one row of this table the two views do not share** (#199). It is
 * drawn in the groups view alone, for an artifact the answer filed under a label that a second run
 * in the same group also filed — everything else, the `All` view at every depth included, draws the
 * single preview it always drew. `comparisonAt` is what decides, and the screen has already asked it
 * ({@link ArchiveScreen}), because the artifact hook is gated on the answer.
 *
 * **The group-only depths are the same table one row up** (#181). A project's groups and a group's
 * test names are levels of an arrangement rather than of the filesystem, so their listing comes out
 * of the grouping answer instead of out of `list_archive` — and it is drawn by the same
 * `LevelContents` with the same three row shapes, fed the *archive* depth so that a group's test
 * names carry `RUNS` exactly as a project's do.
 */
function Preview({
	view,
	selected,
	levels,
	groups,
	serial,
	device,
	description,
	open,
	artifact,
	comparison,
	pinned,
}: {
	readonly view: ArchiveView;
	readonly selected: readonly string[];
	readonly levels: ArchiveLevels;
	readonly groups: ArchiveGroups;
	readonly serial: RunSerial;
	readonly device: ArchivedDeviceInfo;
	readonly description: ArchivedTestDescription;
	readonly open: OpenEntry;
	readonly artifact: ReturnType<typeof useArchivedArtifact>;
	/** The artifacts this one is comparable with, or `null` when there is nothing to compare. */
	readonly comparison: LabelComparison | null;
	/** Which tests the reader has ticked `Keep` on — {@link usePinnedTests}. */
	readonly pinned: PinnedTests;
}) {
	const depths = depthsOf(view);
	const address = view === 'groups' ? archiveAddressOf(selected) : selected;
	const pin = levelPin(view, selected, address, groups, pinned);

	if (selected.length >= depths.below) {
		if (open === 'artifact') {
			return comparison !== null ? (
				<ComparisonCard comparison={comparison} />
			) : (
				<ArtifactPreview artifact={artifact} path={address} />
			);
		}
		if (open === 'unanswered') {
			return <ReadingThisAddress path={selected} />;
		}
	}
	if (selected.length === depths.run) {
		/*
		 * **The run's own `<serial>` listing is not passed to it** (#161). It was `CONTENTS`, and the
		 * tree draws those entries under the run's node; what the card says about that level is what
		 * `serial` already carries, which is a fact about the run rather than a listing of it.
		 */
		return (
			<RunPanel
				description={description}
				device={device}
				/*
				 * **Bound to the test above this run, not to the run** (`pinned-tests.ts`). A run
				 * address is `<project>/<test_name>/<run>`, so the pair that names its test is always
				 * there — which is why the tuple is built here, at the one depth that can promise it,
				 * rather than checked for inside the card. `null` is the kept set not having answered,
				 * which is the one reason this card draws no tick.
				 */
				pin={pinned.stateFor([address[0], address[1]])}
				run={address}
				serial={serial}
			/>
		);
	}
	/*
	 * The heading is the address's own last component — the group id at a group, the test name at a
	 * test name — while the rows and their order come off the archive depth underneath it.
	 */
	return (
		<LevelContents
			depth={address.length}
			level={
				view === 'groups' && selected.length < depths.run
					? groupContents(groups, selected)
					: levelAt(levels, address)
			}
			path={selected}
			/*
			 * **At a group and at a test name, and at no other level this card draws** — it also draws
			 * the root, a project, and every directory below the `<serial>`, none of which is about a
			 * test. {@link pinFor} is the whole of that decision.
			 */
			pin={pin?.state}
			pinScope={pin?.scope}
		/>
	);
}

/**
 * One of the groups view's own levels, as a listing the contents card can draw.
 *
 * The four states are the grouping answer's four, unchanged — which is what keeps *no groups here*
 * and *the host cannot read the archive* apart in this card exactly as they are apart everywhere
 * else (D6). `childCount` is how many runs of the answer the row stands over, which is the one
 * measure this view has that costs no second request; `onlyChild` is a run's own `<serial>`, and
 * nothing in this card reads it.
 */
function groupContents(groups: ArchiveGroups, selected: readonly string[]): ArchiveLevel {
	if (groups.status !== 'listed') {
		return groups;
	}
	const rows = groupRowsAt(groups.groups, selected);
	if (rows === null || rows.length === 0) {
		return { status: 'empty' };
	}
	return {
		status: 'listed',
		entries: rows.map((row) => ({
			kind: 'directory',
			name: row.name,
			childCount: row.runs,
			onlyChild: row.serial,
		})),
	};
}

/**
 * The card for an address whose parent listing has not answered — **and it claims neither of the
 * two things the answer will decide between** (#160, replacing #143's wait-shaped arrangement).
 *
 * A name never says what an address is (D22), so until that listing arrives the screen does not know
 * whether this is a level or a file. The tree is beside it either way now, so the wait is no longer
 * a *layout* the screen could be caught in the wrong half of — what remains is that this card may
 * say nothing definite, which is the whole of this sentence. It says neither *level* nor *artifact*,
 * nothing is fetched for the address, and no spinner turns (§5).
 *
 * The header is the address's own last component, which is the one thing that is true of it whatever
 * it turns out to be.
 */
function ReadingThisAddress({ path }: { readonly path: readonly string[] }) {
	return (
		<ContentsCard header={<CardHeading>{path.at(-1) ?? ''}</CardHeading>}>
			<div className="px-6 py-5">
				<p aria-live="polite" className="font-code-md text-code-md text-on-surface-variant">
					Reading this address.
				</p>
			</div>
		</ContentsCard>
	);
}

/**
 * The content area's row, in one place because every state that browses shares it.
 *
 * **The split is a property of this row rather than of any card in it** (§9), and since #172 the
 * row is where both halves of it are written: `basis-2/5` for the tree and `basis-3/5` for the card
 * beside it. Neither child carries a width, a fixed size or a `shrink-0` any more, so the same
 * screen shows the same proportions on every monitor — the property §9 requires, and one the 320px
 * tree this replaces did not have: measured in Chrome, that tree was 48% of the row at `lg` and 25%
 * of it at a 1728px window.
 *
 * **The `--gutter` needs no `calc()`.** The two bases come to exactly the row, so the gap is the
 * row's one overflow and the default `flex-shrink: 1` takes it back in proportion to those bases —
 * 40% of it off the tree and 60% off the card, which leaves each with its fraction of what is
 * actually there to share. Writing the fractions as `basis-*` is what buys that; `w-2/5` would be
 * the same number and would push the row past the window by the gutter.
 *
 * **The child selectors are why both fractions can live here.** `ContentsCard` is `flex-1`, whose
 * shorthand carries a `0%` basis of its own; `.row > section` outranks a plain utility class, so
 * the fraction wins wherever the two meet, whatever order the stylesheet emits them in.
 *
 * **The row carries no maximum of its own** (§4, #240). It is as wide as the content box `<main>`
 * gives it, so its right edge and the header's are the same line at every window width; until #240
 * it stopped at the container measure and left a strip the header used and the content did not. The
 * fractions below are unchanged — they are fractions of *whatever the row is*, and what grew is the
 * row they divide.
 *
 * **And the row goes horizontal at `xl`, not `lg`** — the fraction and the breakpoint are one
 * decision, recorded in §9. 320px was a constant the row could afford from `lg` up; a *fraction*
 * cannot be, because at `lg` the 256px sidebar and the desktop margins leave a 688px row, of which
 * 40% is 267px — less than the tree had, so the narrowest horizontal window would have come out
 * worse. It only reaches 320px at a 1156px window. Below `xl` the stacked arrangement gives the
 * tree the whole width instead, which is where a six-deep name fits on one line. A floor under the
 * fraction was the alternative and is the thing §9 forbids: it would put the proportions back on
 * the window in exactly the band it applied to.
 */
function Columns({ children }: { readonly children: ReactNode }) {
	return (
		<div className="mt-8 flex flex-col gap-(--gutter) xl:flex-row xl:items-stretch xl:[&>aside]:basis-2/5 xl:[&>section]:basis-3/5">
			{children}
		</div>
	);
}

/** A run is three components deep in the archive: a project, a test name, a run. */
const RUN_DEPTH = 3;
/** And its `<serial>` is the fourth, which is part of an address and not a level of the tree. */
const SERIAL_DEPTH = 4;
/** The first depth that is *inside* a run — the shallowest address the parent listing classifies. */
const BELOW_THE_SERIAL = 5;

/**
 * Where a **group** sits, counted in the groups view's own address — `<project>/<groupId>`.
 *
 * It has no entry in {@link depthsOf} because it is not a depth both views count: the `All` view has
 * no group level at all, and the archive has no directory for one. So it is compared against
 * `selected`, and only ever under `view === 'groups'`.
 */
const GROUP_DEPTH = 2;

/**
 * How many components a view puts in front of the archive's own path (#181).
 *
 * One in the groups view — the `groupId`, which is a level of an arrangement and not a directory —
 * and none in the `All` view, where a splat *is* an archive path. It is the same number
 * `archiveAddressOf` drops, and every depth on this screen is the archive's own plus it, which is
 * what keeps one set of rules rather than two tables of magic numbers.
 */
const OFFSET: Record<ArchiveView, number> = { all: 0, groups: 1 };

/**
 * The `Keep` tick for the level card, or `null` where that card is not about a test.
 *
 * That card draws six different levels and exactly two of them carry a tick, so the decision is
 * here — the one place that already owns the depth arithmetic — rather than in the card working out
 * whether it should have a control (the rule `force-release-control.tsx` records: no branch for a
 * control that cannot exist). The run's card asks {@link PinnedTests.stateFor} at its own branch,
 * where the depth is already known and the level is certainly about a test — so the only `null` it
 * has to draw is the kept set's, and it passes that one straight through.
 *
 * | the level | the tick |
 * | --- | --- |
 * | a group, in the groups view | every test in it, as one bulk tick (`stateForAll`) |
 * | a test name, in either view | that test |
 * | the root, a project, a directory below the `<serial>` | none |
 *
 * **A group whose tests are not listed gets no control** — the walk is still out, the answer is
 * unreadable, or the group is empty. There is nothing to keep, and a tick over an empty group would
 * be a promise about runs nobody has seen.
 *
 * **And no level gets one until the kept set has answered**, which is the same rule one level up:
 * the set is the host's and `stateFor`/`stateForAll` answer `null` while it is out or unreadable
 * (`pinned-tests.ts`). A box drawn then would say *this test is not kept* about a test the panel
 * cannot ask about.
 */
function levelPin(
	view: ArchiveView,
	selected: readonly string[],
	address: readonly string[],
	groups: ArchiveGroups,
	pinned: PinnedTests,
): { readonly state: PinState; readonly scope: 'test' | 'group' } | null {
	if (view === 'groups' && selected.length === GROUP_DEPTH) {
		if (groups.status !== 'listed') {
			return null;
		}
		const project = selected[0] ?? '';
		const tests = testNamesOfGroup(groups.groups, project, selected[1] ?? '').map(
			(row): TestPath => [project, row.name],
		);
		if (tests.length === 0) {
			return null;
		}
		const state = pinned.stateForAll(tests);
		return state === null ? null : { state, scope: 'group' };
	}
	if (address.length === TEST_NAME_DEPTH) {
		const state = pinned.stateFor([address[0], address[1]]);
		return state === null ? null : { state, scope: 'test' };
	}
	return null;
}

/** The three depths one view counts in, so no call site does the arithmetic twice. */
function depthsOf(view: ArchiveView) {
	const offset = OFFSET[view];
	return {
		run: RUN_DEPTH + offset,
		serial: SERIAL_DEPTH + offset,
		below: BELOW_THE_SERIAL + offset,
	};
}

/** Where the tree's rows come from, in one place because two callers ask (`tree-source.ts`). */
function sourceFor(view: ArchiveView, groups: ArchiveGroups, levels: ArchiveLevels): TreeSource {
	return view === 'groups' ? groupRowSource(groups, levels) : allRowSource(levels);
}

/**
 * Which levels a selection needs read — **the prefixes of it with the run's `<serial>` substituted
 * at that one depth, plus whatever else the reader has opened**, over one cache
 * (`archive-levels.ts`).
 *
 * **The two halves answer two different questions, and both are levels on the screen** (#198). The
 * prefixes are what the *address* asks for: every one of them is an ancestor of the selection, so
 * the tree draws it whatever the open set holds, and naming them from the URL is what keeps a deep
 * link one parallel batch of requests rather than one round trip per depth. `drawnLevels` is what
 * the *reader* asked for: a walk of the drawn tree that stops at every shut row and at the first
 * level nothing has answered for, so an open branch beside the selection's costs exactly the levels
 * it draws and a click costs exactly one. Neither half can name a level nobody opened, which is the
 * whole of *still lazy*.
 *
 * Above a run the address's half is the prefixes and nothing else. At and below one the run's own level drops
 * out and its `<serial>` takes its place: a run's contents are that directory's, and its name comes
 * off the level above as `onlyChild`, so listing the run itself would be a `readdir` that draws
 * nothing. Below the `<serial>` the address already carries the serial, so it is a slice of the URL
 * rather than an answer — and the intermediate directories between it and the selection are each a
 * level the tree draws. The selection's **own** listing is added once its parent says it is a
 * folder, and never before (D22).
 *
 * **Every path here is a level the tree actually draws**, which is what makes the counts what they
 * are: a run **4**, the `<serial>` level **4**, a folder at depth 5 **5**, an artifact at depth 6
 * **5** listings and the artifact. Those are the counts for *arriving* at an address, which is what
 * a fresh mount's open set is (`open-branches.ts`); each row the reader then opens adds exactly one.
 *
 * **#133's saving is knowingly given up** (#160). The root, the project and the test level used not
 * to be read for an artifact, because the tree was not there to need them; the tree is there at
 * every depth now, so they are read for every address. Against it, the run's two files are read
 * only for a selected run, since nothing below the `<serial>` draws them any more.
 *
 * **Two of these addresses are derived from an answer rather than from the URL**, which is why this
 * takes the levels read so far: a selected run's `<serial>` is the level above's `onlyChild`, and
 * the open address's own listing is wanted only once its parent says it is a folder. They were a
 * second `useArchiveLevels` instance until #140's review — which meant the `<serial>` level a
 * selected run read was held by the *other* cache, so opening a file under that run re-`readdir`ed
 * it. Derived here, against `known`, the same key is asked for once across both depths.
 *
 * **The groups view reads none of the levels above a run** (#181), and that is the whole of what
 * differs. Its upper levels are one grouping answer rather than four listings, so `list_archive`
 * is asked for nothing at all until a run is opened — and then for exactly the same addresses,
 * because at and below the `<serial>` the two views are browsing the same directories. *Opened*
 * rather than *selected* since #198: a run's contents are drawn under its row wherever the selection
 * is, and it is the source that knows no level of that arrangement is a listing (`listedAt`).
 */
function levelsWanted(
	view: ArchiveView,
	selected: readonly string[],
	known: ArchiveLevels,
	groups: ArchiveGroups,
	branches: OpenBranches,
): readonly (readonly string[])[] {
	// Everything the reader has open, walked over what has answered so far — the same predicate the
	// tree draws with, so the levels asked for and the levels drawn cannot come apart.
	const opened = drawnLevels(sourceFor(view, groups, known), branches.isOpen);
	const depth = selected.length;
	const depths = depthsOf(view);
	// The archive's own path for one of this view's addresses — itself, outside the groups view.
	const addressOf = (components: readonly string[]) =>
		view === 'groups' ? archiveAddressOf(components) : components;
	const archived = addressOf(selected);
	if (depth < depths.run) {
		// The `All` view's levels above a run are the prefixes; the groups view's are the answer's.
		return [...opened, ...(view === 'groups' ? [] : levelsOf(selected))];
	}
	// The run's own level is never one of them, at any depth at or below it.
	const above = view === 'groups' ? [] : levelsOf(selected.slice(0, RUN_DEPTH)).slice(0, -1);
	const serial =
		depth > depths.run
			? addressOf(selected.slice(0, depths.serial))
			: runSerialLevel(view, known, groups, selected);
	if (serial === null) {
		// Nobody has answered where this run's contents are — the level above is still in flight in
		// the `All` view, the grouping answer is in the groups view, or the run names no single
		// child. There is no address to hop to, so nothing under it is asked for on a guess.
		return [...opened, ...above];
	}
	// Each intermediate directory between the `<serial>` and the selection — a node the tree expands
	// through, and the address itself is not one of them.
	const below = Array.from({ length: Math.max(depth - depths.below, 0) }, (_unused, index) =>
		addressOf(selected.slice(0, depths.below + index)),
	);
	/*
	 * And the selection's own listing, once its parent has said it is a folder. Guarded on the depth
	 * as well as on the answer: at and above the `<serial>` the address is already covered above, and
	 * a *run* is a directory its parent names — which would put the run's own level back.
	 */
	const own =
		depth >= depths.below && openEntryOf(known, archived) === 'directory' ? [archived] : [];
	return [...opened, ...above, serial, ...below, ...own];
}

/**
 * Where a **selected run's** contents are, as an archive address — `[…run, <serial>]` — or `null`
 * when nobody has said yet.
 *
 * The two views read the same fact from two places, and that is the one asymmetry between them: the
 * `All` view takes it off the level above the run as `onlyChild`, because a listing is all it has,
 * while the groups view has the run's own four-component address on the grouping answer. Both are
 * the archive's own path, so everything downstream of this — the two file reads, the tree's hop,
 * the levels asked for — is one code path.
 *
 * `archiveAddressOf` is not applied to the answer's serial: what comes back from `group-tree.ts` is
 * already the archive's, since the answer never carried the group id in a path.
 */
function runSerialLevel(
	view: ArchiveView,
	levels: ArchiveLevels,
	groups: ArchiveGroups,
	run: readonly string[],
): readonly string[] | null {
	if (view !== 'groups') {
		return runContentsLevel(levels, run);
	}
	const serial = groupSerialOf(groups, run);
	return serial === null ? null : [...archiveAddressOf(run), serial];
}

/** One run's `<serial>` out of the grouping answer, or `null` while nothing has answered for it. */
function groupSerialOf(groups: ArchiveGroups, run: readonly string[]): string | null {
	const [project, groupId, testName, name] = run;
	if (
		groups.status !== 'listed' ||
		project === undefined ||
		groupId === undefined ||
		testName === undefined ||
		name === undefined
	) {
		return null;
	}
	return groupRunSerial(groups.groups, project, groupId, testName, name);
}

/**
 * What the address inside a run names, as far as anything can honestly say yet.
 *
 * - `unanswered` — the level above has not answered, so nothing is known and nothing is fetched.
 * - `directory` — its parent's listing says so, and the card draws that level's own listing.
 * - `artifact` — anything else, including an address no listing names: the byte route is then what
 *   answers, and *nothing is filed at this address* is its answer to give rather than this
 *   function's to guess.
 */
type OpenEntry = 'unanswered' | 'directory' | 'artifact';

function openEntryOf(levels: ArchiveLevels, selected: readonly string[]): OpenEntry {
	const parent = levelAt(levels, selected.slice(0, -1));
	if (parent.status === 'loading') {
		return 'unanswered';
	}
	if (parent.status !== 'listed') {
		// The level above is empty or unreadable, so it lists nothing — including this. The byte route
		// gets asked and says which of the two it is, in the archive's own words.
		return 'artifact';
	}
	const entry = parent.entries.find((candidate) => candidate.name === selected.at(-1));
	return entry !== undefined && entry.kind === 'directory' ? 'directory' : 'artifact';
}

/**
 * One line per depth, and the deepest one covers a folder below a run.
 *
 * A path deeper than a run is reachable through the tree (#159), by typing and by following a
 * search hit, and it renders what it names at every depth the archive can hold.
 */
const DESCRIPTIONS = [
	'Projects with runs filed on this host.',
	'Tests recorded under this project.',
	'Runs filed under this test name, most recent first.',
	'Everything this lease wrote; nothing is added once it ends.',
	'Everything filed under this directory.',
] as const;

/**
 * The groups view's own lines, one per depth — the same list with the group id's in it (#181).
 *
 * The two below a group say what the standard arrangement says, because below a group it *is* the
 * standard arrangement; the two above it are what this view is for. The root's line says *grouped*
 * out loud, because the projects it lists are the ones with grouped runs and not every project the
 * archive holds — which is the one thing about this view a reader could otherwise get wrong.
 */
const GROUP_DESCRIPTIONS = [
	'Projects with runs filed under a testing group on this host.',
	'Testing groups the leases under this project named.',
	'Tests recorded under this testing group.',
	'Runs filed under this test name in this group, most recent first.',
	'Everything this lease wrote; nothing is added once it ends.',
	'Everything filed under this directory.',
] as const;

/** The design's own line for one open artifact, and it says what the preview claims: nothing more. */
const ONE_ARTIFACT = 'One artifact from this run, as it was written.';

/**
 * And the comparison card's own line, which **claims the order out loud** the way *most recent
 * first* is claimed one level up (#199) — the reversal is the whole point of the card, so it is said
 * rather than left to be inferred from two timestamps.
 *
 * Deliberately *the artifacts filed under this label* rather than *every artifact*: the grouping walk
 * is bounded and may have been cut short, and the tree already carries that sentence beside this
 * card. Nothing in it is a verdict, a count or a claim about what changed.
 */
const ONE_LABEL_COMPARED = 'The artifacts filed under this label in this group, oldest first.';

/**
 * The line for one address inside a run, and **`unanswered` gets the run's own line rather than the
 * artifact's** (#140 review).
 *
 * *One artifact from this run* is a claim about what the address is, and before the parent listing
 * arrives nobody has made it — a deep link into a folder read that sentence about a directory for as
 * long as the listing took. The run's line is true of everything under a run either way, so it is
 * what the header says until the answer decides between the other two.
 *
 * **And an artifact with something to compare gets a third line** (#199), because the card beside it
 * is not one artifact: it is every artifact of this group under one label. The header follows the
 * card rather than the depth, which is the rule this function already keeps for the other two.
 */
function descriptionFor(
	view: ArchiveView,
	selected: readonly string[],
	open: OpenEntry,
	comparison: LabelComparison | null,
): string {
	const depths = depthsOf(view);
	const lines = view === 'groups' ? GROUP_DESCRIPTIONS : DESCRIPTIONS;
	if (selected.length >= depths.below) {
		if (open === 'unanswered') {
			return lines[depths.run] ?? '';
		}
		if (open === 'directory') {
			return lines[depths.run + 1] ?? '';
		}
		return comparison !== null ? ONE_LABEL_COMPARED : ONE_ARTIFACT;
	}
	return lines[Math.min(selected.length, lines.length - 1)] ?? '';
}

/** What the badge counts, by depth. A run is not counted: its contents are not one of these. */
const COUNTED = ['project', 'test', 'run'] as const;

/**
 * The one number on the screen, and it is in the header rather than in the tree.
 *
 * **Absent rather than `0`**, exactly as §7 leaves the held/free counter absent: a `0 tests
 * archived` describes a set, and a level that is empty or unreadable is not a set of none. Absent
 * at a run too, where the thing selected is one run and not a count of anything — and absent for an
 * open artifact, which is the same rule and not an exception to it: the badge is a counter, and one
 * file has nothing to count.
 *
 * **And absent throughout the groups view** (#181, `docs/DESIGN.md` §9), which is the same rule
 * once more rather than an exception to it. That view is one *bounded* walk of the archive, so what
 * it holds at any level is what the host could examine and not what is filed — a badge over it
 * would read as a count of a set and be short without saying so. The tree says the answer was cut
 * short where a reader is looking at the rows it is short of; the header does not carry a number
 * that would need the same caveat.
 */
function badgeFor(depth: number, level: ArchiveLevel) {
	const noun = COUNTED[depth];
	if (noun === undefined || level.status !== 'listed' || level.entries.length === 0) {
		return undefined;
	}
	const count = level.entries.length;
	return (
		<div className="rounded-sm border-2 border-outline-variant bg-surface-container px-3 py-1 font-code-md text-[12px] text-on-surface">
			{`${count} ${noun}${count === 1 ? '' : 's'} archived`}
		</div>
	);
}

/**
 * `Archive > checkout-app > login-flow > …` — one segment per component, each linking to its own
 * level, and the last one not a link because that is where you are (§3).
 *
 * Names are verbatim and nothing but path segments goes in here: no count, no chip, no status.
 *
 * **Inside a run the trail grows one segment for the file, and the `<serial>` is absent from it.**
 * The serial is not a tree level (§9) and there is no screen to link it to; the open file is where
 * you are, so it is last, `text-tertiary`, not a link, and shown in full — wrapping rather than
 * shortening, which `Breadcrumb` already does for a 40-character run name.
 *
 * **In the groups view it is the same trail with the group id in it** (#181), on that view's own
 * routes: `Archive > checkout-app > app-bar-top-space > home_a_variant > …`. The first segment is
 * still *Archive*, because both arrangements are the archive and the sidebar names one destination;
 * where it goes is the view you are in, so a breadcrumb never moves the reader between them. That is
 * the toggle's job, and it is the one control that does it.
 */
function trailFor(view: ArchiveView, selected: readonly string[]): readonly BreadcrumbSegment[] {
	const depths = depthsOf(view);
	const inRun = selected.length >= depths.below;
	const levels = inRun ? selected.slice(0, depths.run) : selected;
	const root = view === 'groups' ? '/groups' : '/archive';
	const deeper = view === 'groups' ? '/groups/$' : '/archive/$';
	return [
		{ label: 'Archive', to: root },
		...levels.map((name, index) => ({
			label: name,
			to: deeper,
			params: { _splat: splatFromComponents(levels.slice(0, index + 1)) },
		})),
		...(inRun ? [{ label: selected.slice(depths.serial).join('/') }] : []),
	];
}

/**
 * The state of whichever answer a view's **root** comes out of — a `list_archive` level in the `All`
 * view, the whole grouping answer in the groups view.
 *
 * One word for both, because what the content area does with it is the same in either: nothing yet
 * is a quiet line, nothing there takes the whole area, and unreadable takes it too. Which *sentence*
 * the middle one gets is the view's, and is the only thing that differs.
 */
type RootAnswer = ArchiveLevel['status'];

function rootOf(view: ArchiveView, levels: ArchiveLevels, groups: ArchiveGroups): RootAnswer {
	return view === 'groups' ? groups.status : levelAt(levels, []).status;
}

/**
 * The run's `<serial>`, from the listing of the level above it — never a request of its own.
 *
 * **The level above's own state is carried out with it, never collapsed into a missing serial.** A
 * level still in flight and a level the host cannot read are answers the screen has not got, and
 * folding them into the same `null` as a run that names no single child made the panel state *there
 * is nothing to list for this run* about a run nobody had answered for yet — and, on the unreadable
 * path, about one nobody ever will. Each of the three is a different sentence (see `RunPanel`).
 *
 * An `empty` level above is `answered` with no serial: it named no runs at all, so this run is not
 * there, and *nothing to list* is the honest thing to say about it.
 *
 * **In the groups view the answer it comes out of is the grouping answer**, which has those same
 * four states — so a run whose serial is still in flight, one in an archive the host cannot read,
 * and one the answer simply does not hold stay three different sentences there too.
 *
 * Below the run this is not consulted at all: `RunPanel` is drawn at the run's own depth and
 * nowhere else, and the serial is in the address there anyway.
 */
function serialOf(
	view: ArchiveView,
	levels: ArchiveLevels,
	groups: ArchiveGroups,
	selected: readonly string[],
): RunSerial {
	if (selected.length !== depthsOf(view).run) {
		// Not a run, so nothing reads this — `answered` rather than a state that would draw one.
		return NO_SERIAL;
	}
	if (view === 'groups') {
		if (groups.status === 'loading' || groups.status === 'unreadable') {
			return { status: groups.status };
		}
		return { status: 'answered', serial: groupSerialOf(groups, selected) };
	}
	const parent = levelAt(levels, selected.slice(0, 2));
	if (parent.status === 'loading' || parent.status === 'unreadable') {
		return { status: parent.status };
	}
	if (parent.status === 'empty') {
		return NO_SERIAL;
	}
	const run = parent.entries.find((entry) => entry.name === selected[2]);
	return {
		status: 'answered',
		serial: run !== undefined && run.kind === 'directory' ? run.onlyChild : null,
	};
}

/** Answered, with no serial to give: the level above named no such run, or named nothing at all. */
const NO_SERIAL: RunSerial = { status: 'answered', serial: null };

/**
 * The archive path of a **selected run's** `<serial>` level, or `null` at any other depth and for a
 * run with no serial to read one for — the one level whose address is derived from an answer rather
 * than from the URL.
 *
 * The depth guard is this function's whole reason for existing beside {@link runSerialLevel}: every
 * level above a run may hold exactly one child too, so hopping at the wrong depth composes an
 * address nothing draws — and, through the two file hooks, reads two files out of it. The tree makes
 * the same hop through the same helpers, so one place knows where a run's contents are in each view.
 */
function runContents(
	view: ArchiveView,
	levels: ArchiveLevels,
	groups: ArchiveGroups,
	selected: readonly string[],
): readonly string[] | null {
	return selected.length === depthsOf(view).run
		? runSerialLevel(view, levels, groups, selected)
		: null;
}

/**
 * Nothing has ever been archived on this host — §7's *nothing attached* treatment, and normal
 * rather than a fault.
 *
 * It says what would change it, and **there is no tree card beside it**: an empty tree is furniture,
 * and this is the whole content area. The badge is absent rather than `0 projects archived`, which
 * would describe a set.
 */
function NothingArchived() {
	return (
		<QuietPanel heading="Nothing in the archive">
			A run is filed the first time a verb on a lease writes a screenshot, a recording or a log on
			this host. Nothing has been filed here yet.
		</QuietPanel>
	);
}

/**
 * The groups view's own empty hand: the archive has runs in it, or has none, and **no lease on this
 * host named a group** (#181).
 *
 * The same `QuietPanel` treatment for the same reason — normal, common and *finished* — and it
 * shares no phrase with *Nothing in the archive* or with `ARCHIVE NOT READABLE`, because the three
 * empty-handed answers of this screen must stay three (D6). What would change it is a `group_id` on
 * a lease, so that is what it says; where the runs are meanwhile is the `All` view, so it says that
 * too, and this state is the one place a reader could otherwise conclude the archive is empty.
 *
 * **A walk that was cut short gets the other sentence, and it is not a fourth state** (#189 review).
 * The host sets `truncated` when a directory that exists was not fully examined — a `group_id.json`
 * that is not JSON, an unreadable subtree, a bound reached — and it can do that having recorded no
 * group at all. *Nothing filed on this host has named a group* would then be a definitive negative
 * about a walk that never finished, which is the exact failure the flag exists to prevent and the
 * one `Searched` in `directory-tree.tsx` already avoids for a search that matched nothing. Same
 * heading, same instruction, one clause changed: the claim narrows to what was actually examined.
 */
function NoTestingGroups({ truncated }: { readonly truncated: boolean }) {
	return (
		<QuietPanel heading="No testing groups">
			{/* The one command on this screen, in the monospace face because it is one — `projects.tsx`
			    set that precedent, and the face is the token's rather than a treatment invented here. */}
			A run joins a group when the lease that produced it names one, with{' '}
			<span className="font-code-md">rover acquire --group-id</span>.{' '}
			{truncated
				? 'More is filed here than the host could examine, and no group was named in the part it could. A grouped run may be missing from this view.'
				: 'Nothing filed on this host has named a group, so there is no grouping to arrange.'}{' '}
			Every run is still listed in the All view.
		</QuietPanel>
	);
}

/**
 * The four routes, two views, one component (#181).
 *
 * **Two route families rather than one with a search parameter**, and each is two routes rather
 * than one — but not because a splat route fails to match the bare address. It matches both:
 * against @tanstack/react-router 1.170.32, `/archive`, `/archive/`, `/groups` and `/groups/` all
 * resolve to the `$` route with `_splat: ''`, and the bare route is never in `router.state.matches`
 * (`archive-path.test.tsx` pins it). **The bare routes exist because `to` is typed off the route
 * tree**: without them `/archive` and `/groups` are not link targets the router admits, and
 * `sidebar.tsx` and `view-toggle.tsx` — which point at the root of each family and must not put a
 * trailing `$` in a shared address — stop compiling. They are declarations for the type, and the
 * splat route is what actually renders (#189 review).
 *
 * **`/groups` rather than `/archive/groups/$`**, checked and rejected: a project literally named
 * `groups` would be shadowed by it in the `All` view, which is a silent bug in a vocabulary that is
 * deliberately opaque (D22). A `?view=groups&group=<id>` pair was rejected too — two carriers of one
 * piece of state, with the breadcrumb having to thread both.
 *
 * The sidebar's `Archive` item stays current on both, which `sidebar.tsx` states as the rule it is:
 * the panel has one Archive destination and two arrangements of it, not two destinations.
 */
export const archiveRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/archive',
	component: () => <ArchiveScreen view="all" />,
});

/** The same screen at a path — see {@link archiveRoute} for why it is a second route. */
export const archivePathRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/archive/$',
	component: () => <ArchiveScreen view="all" />,
});

/** The group-first arrangement of the same archive, at its own root. */
export const groupsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/groups',
	component: () => <ArchiveScreen view="groups" />,
});

/**
 * And at a path — `<project>/<groupId>/<testName>/<run>/<serial>/<…>`.
 *
 * The splat is the whole of *the selection is an address*: a reload lands on it and a shared link
 * lands on it, exactly as the `All` view's does. `archiveAddressOf` is what turns it into the
 * archive's own path for everything below the group.
 */
export const groupsPathRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/groups/$',
	component: () => <ArchiveScreen view="groups" />,
});
