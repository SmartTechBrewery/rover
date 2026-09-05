import {
	type ArchiveLevel,
	type ArchiveLevels,
	levelAt,
	runContentsLevel,
	useArchiveLevels,
} from '@panel/archive/archive-levels.js';
import { componentsFromSplat, levelsOf, splatFromComponents } from '@panel/archive/archive-path.js';
import { type ArchiveSearch, useArchiveSearch } from '@panel/archive/archive-search.js';
import { useArchivedArtifact } from '@panel/archive/artifact.js';
import { type ArchivedDeviceInfo, useArchivedDeviceInfo } from '@panel/archive/device-info.js';
import {
	type ArchivedTestDescription,
	useArchivedTestDescription,
} from '@panel/archive/test-description.js';
import { ArtifactPreview } from '@panel/components/archive/artifact-preview.js';
import {
	ArchiveNotReadable,
	CardHeading,
	ContentsCard,
} from '@panel/components/archive/contents-card.js';
import { DirectoryTree } from '@panel/components/archive/directory-tree.js';
import { LevelContents } from '@panel/components/archive/level-contents.js';
import { RunPanel, type RunSerial } from '@panel/components/archive/run-panel.js';
import type { BreadcrumbSegment } from '@panel/components/layout/breadcrumb.js';
import { PageHeader } from '@panel/components/layout/page-header.js';
import { QuietPanel } from '@panel/components/quiet-panel.js';
import { createRoute, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { rootRoute } from './__root.js';

/**
 * The archive, as a file explorer over what past leases wrote (`docs/DESIGN.md` §9).
 *
 * **The path is in the URL, and the tree card's search text is the one piece of state that is
 * deliberately not** (#146). A reload lands where you were, a link is shareable, and the tree's
 * expansion is *derived* from the selection rather than stored beside it — so the tree and the
 * address bar cannot disagree about *where you are*, and the levels read are exactly the prefixes
 * of the path (`archive-levels.ts`). The search text is component state on purpose: a reload and a
 * shared link land on the **address**, without somebody else's search, and a hit is a navigation to
 * an address like any other, so nothing about it needs to be in the URL to survive being followed.
 *
 * **Every state below is a state of this one screen** (§7's rule, applied to a second screen). The
 * breadcrumb, the describing line and the header row's shape are the same in all of them; the badge
 * is the only thing in the header that comes and goes, and it goes rather than reading `0`.
 *
 * **And there is one arrangement at every depth** (#160): the tree, then one card. What the parent
 * listing says the selection is decides what that card *draws* and nothing about whether the tree
 * is there —
 *
 * | The host's answer for the root | What the content area is |
 * | --- | --- |
 * | nothing yet | one quiet line, no spinner |
 * | a listing | the tree, beside the selected address's own card |
 * | an empty listing, or nothing there | *Nothing in the archive* — and **no tree card** |
 * | unreadable | `ARCHIVE NOT READABLE` — and **no tree card** |
 *
 * The last two take the whole content area because **an empty tree beside a message is furniture**:
 * there is nothing to browse, so there is nothing for a tree to be a way into. They are the only
 * two states without a tree, and they gate the browsing layout **at and above the `<serial>`** —
 * no address *below* the `<serial>` ever waits on the archive root.
 *
 * Exported for `archive.test.tsx`, as `DevicesScreen` is: a route's component is otherwise
 * reachable only through a router instance, and what is worth asserting is which state renders what.
 */
export function ArchiveScreen() {
	// `strict: false` is what lets one component serve both `/archive` and `/archive/$`.
	const params = useParams({ strict: false });
	const selected = componentsFromSplat(params._splat);
	/*
	 * **One cache, asked as a function of itself** (`archive-levels.ts`). Some of these levels are
	 * addressed by a path *derived from* an answer — a run's `<serial>` is the level above's
	 * `onlyChild`, and the open folder's own listing is only wanted once its parent says it is a
	 * folder — and a second hook instance for those gave the screen two caches that each re-read what
	 * the other held (#140 review). `levelsWanted` is that derivation, run against what has answered
	 * so far.
	 */
	const levels = useArchiveLevels((known) => levelsWanted(selected, known));
	const inRun = selected.length >= BELOW_THE_SERIAL;
	/*
	 * What the open address turned out to be, out of the listing of the level above it — and *not*
	 * out of its own name (D22). Until that listing answers, nothing is fetched for it: a file is not
	 * read on a guess any more than a level is listed on one, and asking the byte route for a
	 * directory would put a warning in the host's log on every folder a reader opens.
	 */
	const open = inRun ? openEntryOf(levels, selected) : 'unanswered';
	/*
	 * The one extra level a selected run needs, and it can only be asked for once the level above
	 * has answered: the `<serial>` directory's name is that answer's `onlyChild`.
	 */
	const serial = serialOf(levels, selected);
	const runLevel = runContents(levels, selected);
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
	/** The open artifact's own bytes. `null` while the address is a folder, or not yet classified. */
	const artifact = useArchivedArtifact(open === 'artifact' ? selected : null);
	/*
	 * **The tree card's search, held here rather than in the card** (#146). It stays here now that
	 * there is one arrangement (#160): the state outlives an address change either way, and the
	 * input is still absent wherever the card is — the two states with nothing to browse draw no
	 * tree, so they draw no field either, without anything having to say so twice.
	 */
	const search = useArchiveSearch();

	const level = levelAt(levels, selected);
	const depth = selected.length;

	return (
		<>
			<PageHeader
				trail={trailFor(selected)}
				description={descriptionFor(selected, open)}
				aside={badgeFor(depth, level)}
			/>
			<Content
				artifact={artifact}
				description={description}
				device={device}
				levels={levels}
				open={open}
				search={search}
				selected={selected}
				serial={serial}
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
 * waiting for anything else from.
 */
function Content({
	selected,
	levels,
	serial,
	device,
	description,
	open,
	artifact,
	search,
}: {
	readonly selected: readonly string[];
	/** The one cache, holding whatever has answered — the tree's levels and the run's `<serial>`. */
	readonly levels: ArchiveLevels;
	readonly serial: RunSerial;
	readonly device: ArchivedDeviceInfo;
	readonly description: ArchivedTestDescription;
	/** Which of the three the address turned out to be — {@link OpenEntry}. */
	readonly open: OpenEntry;
	readonly artifact: ReturnType<typeof useArchivedArtifact>;
	readonly search: ArchiveSearch;
}) {
	const root = levelAt(levels, []);

	if (selected.length < BELOW_THE_SERIAL) {
		if (root.status === 'loading') {
			// One line, and no spinner (§5). It is not an empty archive and must not read as one.
			return (
				<p aria-live="polite" className="mt-8 font-code-md text-code-md text-on-surface-variant">
					Reading the host's artifact archive.
				</p>
			);
		}
		if (root.status === 'empty') {
			return <NothingArchived />;
		}
		if (root.status === 'unreadable') {
			return <ArchiveNotReadable />;
		}
	}

	return (
		<Columns>
			<DirectoryTree levels={levels} search={search} selected={selected} />
			<Preview
				artifact={artifact}
				description={description}
				device={device}
				levels={levels}
				open={open}
				selected={selected}
				serial={serial}
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
 * | a directory below the `<serial>` | that level's `LevelContents`, which is what depth 4 already draws |
 * | an artifact | `ArtifactPreview` **alone** — the run's identity and device cards are not beside it |
 * | an address nobody has answered for | {@link ReadingThisAddress}, claiming neither |
 *
 * **The preview holds one thing at a time, and the tree is what keeps the reader placed.** The run's
 * two cards used to stand beside it, from a layout where opening a file took the tree away; the tree
 * is there now, so the column beside it is the artifact and nothing else.
 */
function Preview({
	selected,
	levels,
	serial,
	device,
	description,
	open,
	artifact,
}: {
	readonly selected: readonly string[];
	readonly levels: ArchiveLevels;
	readonly serial: RunSerial;
	readonly device: ArchivedDeviceInfo;
	readonly description: ArchivedTestDescription;
	readonly open: OpenEntry;
	readonly artifact: ReturnType<typeof useArchivedArtifact>;
}) {
	if (selected.length >= BELOW_THE_SERIAL) {
		if (open === 'artifact') {
			return <ArtifactPreview artifact={artifact} path={selected} />;
		}
		if (open === 'unanswered') {
			return <ReadingThisAddress path={selected} />;
		}
	}
	if (selected.length === RUN_DEPTH) {
		/*
		 * **The run's own `<serial>` listing is not passed to it** (#161). It was `CONTENTS`, and the
		 * tree draws those entries under the run's node; what the card says about that level is what
		 * `serial` already carries, which is a fact about the run rather than a listing of it.
		 */
		return <RunPanel description={description} device={device} run={selected} serial={serial} />;
	}
	return <LevelContents level={levelAt(levels, selected)} path={selected} />;
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
 * **The split is a property of this row rather than of any card in it** (§9, whose equal halves
 * #160 collapsed to one card): the card is `flex-1 min-w-0` and carries no width, no percentage and
 * no `basis-*`, so what it is given does not depend on the window. The tree is the one child that is
 * sized, and it is `shrink-0` beside it.
 */
function Columns({ children }: { readonly children: ReactNode }) {
	return (
		<div className="mt-8 flex max-w-(--container-max) flex-col gap-(--gutter) lg:flex-row lg:items-stretch">
			{children}
		</div>
	);
}

/** A run is three components deep: a project, a test name, a run. */
const RUN_DEPTH = 3;
/** And its `<serial>` is the fourth, which is part of an address and not a level of the tree. */
const SERIAL_DEPTH = 4;
/** The first depth that is *inside* a run — the shallowest address the parent listing classifies. */
const BELOW_THE_SERIAL = 5;

/**
 * Which levels a selection needs read — **the prefixes of it with the run's `<serial>` substituted
 * at that one depth**, over one cache (`archive-levels.ts`).
 *
 * Above a run they are the prefixes and nothing else. At and below one the run's own level drops
 * out and its `<serial>` takes its place: a run's contents are that directory's, and its name comes
 * off the level above as `onlyChild`, so listing the run itself would be a `readdir` that draws
 * nothing. Below the `<serial>` the address already carries the serial, so it is a slice of the URL
 * rather than an answer — and the intermediate directories between it and the selection are each a
 * level the tree draws. The selection's **own** listing is added once its parent says it is a
 * folder, and never before (D22).
 *
 * **Every path here is a level the tree actually draws**, which is what makes the counts what they
 * are: a run **4**, the `<serial>` level **4**, a folder at depth 5 **5**, an artifact at depth 6
 * **5** listings and the artifact.
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
 */
function levelsWanted(
	selected: readonly string[],
	known: ArchiveLevels,
): readonly (readonly string[])[] {
	const depth = selected.length;
	if (depth < RUN_DEPTH) {
		return levelsOf(selected);
	}
	// The run's own level is never one of them, at any depth at or below it.
	const above = levelsOf(selected.slice(0, RUN_DEPTH)).slice(0, -1);
	const serial =
		depth > RUN_DEPTH ? selected.slice(0, SERIAL_DEPTH) : runContentsLevel(known, selected);
	if (serial === null) {
		// The level above has not answered, or the run names no single child: there is no address to
		// hop to, so nothing under it is asked for on a guess.
		return above;
	}
	// Each intermediate directory between the `<serial>` and the selection — a node the tree expands
	// through, and the address itself is not one of them.
	const below = Array.from({ length: Math.max(depth - BELOW_THE_SERIAL, 0) }, (_unused, index) =>
		selected.slice(0, BELOW_THE_SERIAL + index),
	);
	/*
	 * And the selection's own listing, once its parent has said it is a folder. Guarded on the depth
	 * as well as on the answer: at and above the `<serial>` the address is already covered above, and
	 * a *run* is a directory its parent names — which would put the run's own level back.
	 */
	const own =
		depth >= BELOW_THE_SERIAL && openEntryOf(known, selected) === 'directory' ? [selected] : [];
	return [...above, serial, ...below, ...own];
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

/** The design's own line for one open artifact, and it says what the preview claims: nothing more. */
const ONE_ARTIFACT = 'One artifact from this run, as it was written.';

/**
 * The line for one address inside a run, and **`unanswered` gets the run's own line rather than the
 * artifact's** (#140 review).
 *
 * *One artifact from this run* is a claim about what the address is, and before the parent listing
 * arrives nobody has made it — a deep link into a folder read that sentence about a directory for as
 * long as the listing took. The run's line is true of everything under a run either way, so it is
 * what the header says until the answer decides between the other two.
 */
function descriptionFor(selected: readonly string[], open: OpenEntry): string {
	if (selected.length >= BELOW_THE_SERIAL) {
		if (open === 'unanswered') {
			return DESCRIPTIONS[RUN_DEPTH] ?? '';
		}
		return open === 'directory' ? (DESCRIPTIONS[4] ?? '') : ONE_ARTIFACT;
	}
	return DESCRIPTIONS[Math.min(selected.length, DESCRIPTIONS.length - 1)] ?? '';
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
 */
function trailFor(selected: readonly string[]): readonly BreadcrumbSegment[] {
	const levels = selected.length >= BELOW_THE_SERIAL ? selected.slice(0, RUN_DEPTH) : selected;
	return [
		{ label: 'Archive', to: '/archive' },
		...levels.map((name, index) => ({
			label: name,
			to: '/archive/$',
			params: { _splat: splatFromComponents(levels.slice(0, index + 1)) },
		})),
		...(selected.length >= BELOW_THE_SERIAL
			? [{ label: selected.slice(SERIAL_DEPTH).join('/') }]
			: []),
	];
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
 * Below the run this is not consulted at all: `RunPanel` is drawn at the run's own depth and
 * nowhere else, and the serial is in the address there anyway.
 */
function serialOf(levels: ArchiveLevels, selected: readonly string[]): RunSerial {
	if (selected.length !== RUN_DEPTH) {
		// Not a run, so nothing reads this — `answered` rather than a state that would draw one.
		return NO_SERIAL;
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
 * The path of a **selected run's** `<serial>` level, or `null` at any other depth and for a run
 * with no serial to read one for — the one level whose address is derived from an answer rather
 * than from the URL.
 *
 * The depth guard is this function's whole reason for existing beside {@link runContentsLevel}:
 * every level above a run may hold exactly one child too, so calling that helper at the wrong depth
 * composes an address nothing draws — and, through the two file hooks, reads two files out of it.
 * The tree makes the same hop through the same helper, so one place knows a run holds one child.
 */
function runContents(levels: ArchiveLevels, selected: readonly string[]): readonly string[] | null {
	return selected.length === RUN_DEPTH ? runContentsLevel(levels, selected) : null;
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

export const archiveRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/archive',
	component: ArchiveScreen,
});

/**
 * The same screen at a path. Two routes rather than one optional splat, because TanStack matches a
 * splat route against `/archive/` and not against `/archive` — and `/archive` is the address the
 * navigation points at.
 */
export const archivePathRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/archive/$',
	component: ArchiveScreen,
});
