import {
	type ArchiveLevel,
	type ArchiveLevels,
	levelAt,
	useArchiveLevels,
} from '@panel/archive/archive-levels.js';
import { componentsFromSplat, levelsOf, splatFromComponents } from '@panel/archive/archive-path.js';
import { ArchiveNotReadable } from '@panel/components/archive/contents-card.js';
import { DirectoryTree } from '@panel/components/archive/directory-tree.js';
import { LevelContents } from '@panel/components/archive/level-contents.js';
import { RunPanel } from '@panel/components/archive/run-panel.js';
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
 * Exported for `archive.test.tsx`, as `DevicesScreen` is: a route's component is otherwise
 * reachable only through a router instance, and what is worth asserting is which state renders what.
 */
export function ArchiveScreen() {
	// `strict: false` is what lets one component serve both `/archive` and `/archive/$`.
	const params = useParams({ strict: false });
	const selected = componentsFromSplat(params._splat);
	const levels = useArchiveLevels(levelsFor(selected));
	/*
	 * The one extra level a selected run needs, and it can only be asked for once the level above
	 * has answered: the `<serial>` directory's name is that answer's `onlyChild`. A second call
	 * rather than one array because the paths this one wants are *derived from* what the first
	 * returned, which no single list of levels can express.
	 */
	const serial = serialOf(levels, selected);
	const runContents = useArchiveLevels(serial === null ? NO_LEVELS : [[...selected, serial]]);

	const level = levelAt(levels, selected);
	const depth = selected.length;

	return (
		<>
			<PageHeader
				trail={trailFor(selected)}
				description={DESCRIPTIONS[Math.min(depth, DESCRIPTIONS.length - 1)] ?? ''}
				aside={badgeFor(depth, level)}
			/>
			<Content levels={levels} runContents={runContents} selected={selected} serial={serial} />
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
	runContents,
}: {
	readonly selected: readonly string[];
	readonly levels: ArchiveLevels;
	readonly serial: string | null;
	readonly runContents: ArchiveLevels;
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
			{selected.length === 3 ? (
				/*
				 * With no serial there is no level to read and `RunPanel` says so without looking at
				 * `contents`; `[]` is a path `runContents` never holds, so it reads as `loading` and
				 * goes unused.
				 */
				<RunPanel
					contents={levelAt(runContents, serial === null ? [] : [...selected, serial])}
					run={selected}
					serial={serial}
				/>
			) : (
				<LevelContents level={levelAt(levels, selected)} path={selected} />
			)}
		</div>
	);
}

/** Stable, so the hook's effect does not see a new array on every render. */
const NO_LEVELS: readonly (readonly string[])[] = [];

/**
 * Which levels a selection needs read: the prefixes of the path — **minus the run's own level when
 * a run is selected.**
 *
 * A run's contents are its `<serial>` directory, and that directory's name comes off the level
 * above as `onlyChild`; listing the run itself would be a fifth `readdir` that draws nothing. So a
 * selected run costs four requests, which is what `archive.test.tsx` pins.
 */
function levelsFor(selected: readonly string[]): readonly (readonly string[])[] {
	const levels = levelsOf(selected);
	return selected.length === 3 ? levels.slice(0, -1) : levels;
}

/**
 * One line per depth, and the deepest one covers everything below a run.
 *
 * A path deeper than a run is not reachable through the tree — a run is a leaf — but it is
 * reachable by typing, so it renders the level it names rather than nothing at all.
 */
const DESCRIPTIONS = [
	'Projects with runs filed on this host.',
	'Tests recorded under this project.',
	'Runs filed under this test name, most recent first.',
	'Everything this lease wrote; nothing is added once it ends.',
	'Everything filed under this directory.',
] as const;

/** What the badge counts, by depth. A run is not counted: its contents are not one of these. */
const COUNTED = ['project', 'test', 'run'] as const;

/**
 * The one number on the screen, and it is in the header rather than in the tree.
 *
 * **Absent rather than `0`**, exactly as §7 leaves the held/free counter absent: a `0 tests
 * archived` describes a set, and a level that is empty or unreadable is not a set of none. Absent
 * at a run too, where the thing selected is one run and not a count of anything.
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
 */
function trailFor(selected: readonly string[]): readonly BreadcrumbSegment[] {
	return [
		{ label: 'Archive', to: '/archive' },
		...selected.map((name, index) => ({
			label: name,
			to: '/archive/$',
			params: { _splat: splatFromComponents(selected.slice(0, index + 1)) },
		})),
	];
}

/**
 * The run's `<serial>`, from the listing of the level above it — never a request of its own.
 *
 * `null` whenever the level above has not answered, does not name this run, or names it as
 * something other than a directory holding exactly one entry. Every one of those is a fact to
 * state rather than something to work around (see `RunPanel`).
 */
function serialOf(levels: ArchiveLevels, selected: readonly string[]): string | null {
	if (selected.length !== 3) {
		return null;
	}
	const parent = levelAt(levels, selected.slice(0, 2));
	if (parent.status !== 'listed') {
		return null;
	}
	const run = parent.entries.find((entry) => entry.name === selected[2]);
	return run !== undefined && run.kind === 'directory' ? run.onlyChild : null;
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
