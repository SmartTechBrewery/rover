import {
	type ArchiveLevel,
	type ArchiveLevels,
	levelAt,
	useArchiveLevels,
} from '@panel/archive/archive-levels.js';
import { componentsFromSplat, levelsOf, splatFromComponents } from '@panel/archive/archive-path.js';
import { useArchivedArtifact } from '@panel/archive/artifact.js';
import { type ArchivedDeviceInfo, useArchivedDeviceInfo } from '@panel/archive/device-info.js';
import { ArtifactPreview } from '@panel/components/archive/artifact-preview.js';
import { ArchiveNotReadable, ReadingThisAddress } from '@panel/components/archive/contents-card.js';
import { DirectoryTree } from '@panel/components/archive/directory-tree.js';
import { LevelContents } from '@panel/components/archive/level-contents.js';
import { RunPanel, type RunSerial } from '@panel/components/archive/run-panel.js';
import type { BreadcrumbSegment } from '@panel/components/layout/breadcrumb.js';
import { PageHeader } from '@panel/components/layout/page-header.js';
import { QuietPanel } from '@panel/components/quiet-panel.js';
import { createRoute, useParams } from '@tanstack/react-router';
import { rootRoute } from './__root.js';

/**
 * The archive, as a file explorer over what past leases wrote (`docs/DESIGN.md` §9).
 *
 * **The path is in the URL and the screen has no other state.** A reload lands where you were, a
 * link is shareable, and the tree's expansion is *derived* from the selection rather than stored
 * beside it — so the tree and the address bar cannot disagree, and the levels read are exactly the
 * prefixes of the path (`archive-levels.ts`).
 *
 * **Every state below is a state of this one screen** (§7's rule, applied to a second screen). The
 * breadcrumb, the describing line and the header row's shape are the same in all of them; the badge
 * is the only thing in the header that comes and goes, and it goes rather than reading `0`.
 *
 * | The host's answer for the root | What the content area is |
 * | --- | --- |
 * | nothing yet | one quiet line, no spinner |
 * | a listing | the tree, beside the selected level's own card |
 * | an empty listing, or nothing there | *Nothing in the archive* — and **no tree card** |
 * | unreadable | `ARCHIVE NOT READABLE` — and **no tree card** |
 *
 * The last two take the whole content area because **an empty tree beside a message is furniture**:
 * there is nothing to browse, so there is nothing for a tree to be a way into.
 *
 * **And one state is not a state of the tree at all** (#133). An address *inside* a run — deeper
 * than its `<serial>` — replaces the tree with the run's own column, and puts what the address names
 * beside it: an artifact's preview, or that folder's listing. The layout is a function of the
 * **depth alone**, so a shared link to an artifact renders the preview immediately and never flips
 * columns while a listing is in flight, and the three root states above gate the browsing layout
 * only — a link to an artifact may not wait on the archive root, which is not even fetched.
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
	 * has answered: the `<serial>` directory's name is that answer's `onlyChild`. Inside the run the
	 * serial is in the address instead, so the level is a slice of the URL.
	 */
	const serial = serialOf(levels, selected);
	const serialLevel = inRun ? selected.slice(0, SERIAL_DEPTH) : serialPath(selected, serial);
	/*
	 * The run's `device_info.json`, read out of that same `<serial>` directory — the one thing on
	 * this screen that is a file's contents rather than a listing (#136, #131's byte route). It is
	 * addressed by the level, not by a path this screen composed, and it is not fetched at all for
	 * a run whose serial nobody has answered for. Inside the run the serial is in the address, so
	 * the card never waits on the level above the run.
	 */
	const device = useArchivedDeviceInfo(serialLevel);
	/** The open artifact's own bytes. `null` while the address is a folder, or not yet classified. */
	const artifact = useArchivedArtifact(open === 'artifact' ? selected : null);

	const level = levelAt(levels, selected);
	const depth = selected.length;

	return (
		<>
			<PageHeader
				trail={trailFor(selected)}
				description={descriptionFor(selected, open)}
				aside={badgeFor(depth, level)}
			/>
			{inRun ? (
				<InsideTheRun
					artifact={artifact}
					below={levels}
					contents={levelAt(levels, serialLevel ?? [])}
					device={device}
					folder={levelAt(levels, selected)}
					open={open}
					selected={selected}
				/>
			) : (
				<Content device={device} levels={levels} selected={selected} serial={serial} />
			)}
		</>
	);
}

/**
 * The content area, and the three answers for the **root** that decide whether there is anything to
 * browse at all.
 *
 * The two states with nothing in them take the whole area, because an empty tree beside a message is
 * furniture. Everything else is the tree beside one card.
 */
function Content({
	selected,
	levels,
	serial,
	device,
}: {
	readonly selected: readonly string[];
	readonly levels: ArchiveLevels;
	readonly serial: RunSerial;
	readonly device: ArchivedDeviceInfo;
}) {
	const root = levelAt(levels, []);

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

	return (
		<div className="mt-8 flex max-w-(--container-max) flex-col gap-(--gutter) lg:flex-row lg:items-stretch">
			<DirectoryTree levels={levels} selected={selected} />
			{selected.length === RUN_DEPTH ? (
				/*
				 * With no serial there is no level to read and `RunPanel` says so from `serial` alone
				 * without looking at `contents`; `[]` is a path this cache never holds, so it reads as
				 * `loading` and goes unused.
				 */
				<RunPanel
					below={NO_EXPANSIONS}
					contents={levelAt(levels, serialPath(selected, serial) ?? [])}
					device={device}
					open={null}
					run={selected}
					serial={serial}
				/>
			) : (
				<LevelContents level={levelAt(levels, selected)} path={selected} />
			)}
		</div>
	);
}

/**
 * An address inside a run: **two columns, equal halves, and the tree is not shown** (#133).
 *
 * The run's column takes the tree's place, and what the address names goes beside it. Both children
 * are `flex-1 min-w-0` inside the 1280 px maximum, and **neither carries a width, a percentage or a
 * `basis-*`**: the approved markup pins the preview to `lg:w-[580px]`, which makes the *split*
 * depend on the window, so the same screen shows different proportions on different monitors. §9
 * records the reversal.
 *
 * **Three cards go in that second slot, not two** (#140 review). *Nobody has said what this address
 * is yet* is a third answer, and folding it into `artifact` made the screen assert *One artifact from
 * this run* and *Reading this artifact* about a directory somebody deep-linked into — before its
 * parent listing arrived to flip the column. `ReadingThisAddress` is the one thing that is true then,
 * in the wording every other level of this screen already uses for the same wait.
 */
function InsideTheRun({
	selected,
	contents,
	below,
	device,
	folder,
	open,
	artifact,
}: {
	readonly selected: readonly string[];
	readonly contents: ArchiveLevel;
	readonly below: ArchiveLevels;
	readonly device: ArchivedDeviceInfo;
	/** The listing of the address, read only once {@link open} says it is a folder. */
	readonly folder: ArchiveLevel;
	/** Which of the three the address turned out to be — {@link OpenEntry}. */
	readonly open: OpenEntry;
	readonly artifact: ReturnType<typeof useArchivedArtifact>;
}) {
	return (
		<div className="mt-8 flex max-w-(--container-max) flex-col gap-(--gutter) lg:flex-row lg:items-stretch">
			<RunPanel
				below={below}
				contents={contents}
				device={device}
				open={selected}
				run={selected.slice(0, RUN_DEPTH)}
				/*
				 * **The serial comes from the URL here**, not from the level above the run. The address
				 * was built from a listing, so `selected[3]` *is* that directory's name — which removes
				 * a dependency, means neither this column nor the preview ever waits on the level above
				 * the run, and collapses `RunSerial` to `answered`, correctly: `reading` and `not
				 * readable` cannot apply to a serial the address already carries.
				 */
				serial={{ status: 'answered', serial: selected[RUN_DEPTH] ?? null }}
			/>
			<OpenAddress artifact={artifact} folder={folder} open={open} selected={selected} />
		</div>
	);
}

/**
 * The second column inside a run, and it says nothing about the address its parent has not said.
 *
 * The order is the order the answers arrive in: *not known yet*, then the listing or the preview.
 * The two that are known render exactly as they did; the third is the branch this used to be missing.
 */
function OpenAddress({
	selected,
	folder,
	open,
	artifact,
}: {
	readonly selected: readonly string[];
	readonly folder: ArchiveLevel;
	readonly open: OpenEntry;
	readonly artifact: ReturnType<typeof useArchivedArtifact>;
}) {
	if (open === 'unanswered') {
		return <ReadingThisAddress path={selected} />;
	}
	return open === 'directory' ? (
		<LevelContents level={folder} path={selected} />
	) : (
		<ArtifactPreview artifact={artifact} path={selected} />
	);
}

/** No level below a `<serial>` has been read, which is every state with the tree beside the run. */
const NO_EXPANSIONS: ArchiveLevels = new Map();

/** A run is three components deep: a project, a test name, a run. */
const RUN_DEPTH = 3;
/** And its `<serial>` is the fourth, which is part of an address and not a level of the tree. */
const SERIAL_DEPTH = 4;
/** The first depth that is *inside* a run — the shallowest address the preview state renders. */
const BELOW_THE_SERIAL = 5;

/**
 * Which levels a selection needs read — **one list, over one cache** (`archive-levels.ts`).
 *
 * Above a run: the prefixes of the path — **minus the run's own level when a run is selected.** A
 * run's contents are its `<serial>` directory, and that directory's name comes off the level above
 * as `onlyChild`; listing the run itself would be a fifth `readdir` that draws nothing. So a
 * selected run costs four requests, which is what `archive.test.tsx` pins.
 *
 * **Inside a run: the levels from the `<serial>` down, exclusive of the address itself.** Each one
 * is drawn — the first is `CONTENTS` and the rest are its expansions — and the root, the project and
 * the test level are **not fetched at all**, because the tree is not there to need them. *Each one a
 * level actually drawn* is held rather than weakened.
 *
 * **Two of these addresses are derived from an answer rather than from the URL**, which is why this
 * takes the levels read so far: the run's `<serial>` is the level above's `onlyChild`, and the open
 * address's own listing is wanted only once its parent says it is a folder. They were a second
 * `useArchiveLevels` instance until #140's review — which meant the `<serial>` level a selected run
 * read was held by the *other* cache, so opening a file under that run re-`readdir`ed it. Derived
 * here, against `known`, the same key is asked for once across both depths.
 */
function levelsWanted(
	selected: readonly string[],
	known: ArchiveLevels,
): readonly (readonly string[])[] {
	if (selected.length >= BELOW_THE_SERIAL) {
		const below = Array.from({ length: selected.length - SERIAL_DEPTH }, (_unused, index) =>
			selected.slice(0, SERIAL_DEPTH + index),
		);
		// An artifact is not a level, so an address that names one adds nothing — and an address
		// nobody has answered for yet adds nothing either, which is the whole of D22 here.
		return openEntryOf(known, selected) === 'directory' ? [...below, selected] : below;
	}
	const levels = levelsOf(selected);
	const own = selected.length === RUN_DEPTH ? levels.slice(0, -1) : levels;
	const serial = serialPath(selected, serialOf(known, selected));
	return serial === null ? own : [...own, serial];
}

/**
 * What the address inside a run names, as far as anything can honestly say yet.
 *
 * - `unanswered` — the level above has not answered, so nothing is known and nothing is fetched.
 * - `directory` — its parent's listing says so, and its own listing goes beside the run's column.
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
 * A path deeper than a run is not reachable through the tree — a run is a leaf — but it is reachable
 * from `CONTENTS` and by typing, so it renders what it names rather than nothing at all.
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
 * Inside the run this is not consulted at all: the serial is in the address (see `InsideTheRun`).
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
 * The path of the run's `<serial>` level, or `null` when there is no serial to read one for — the
 * one level whose address is derived from an answer rather than from the URL.
 */
function serialPath(selected: readonly string[], serial: RunSerial): readonly string[] | null {
	return serial.status === 'answered' && serial.serial !== null
		? [...selected, serial.serial]
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
