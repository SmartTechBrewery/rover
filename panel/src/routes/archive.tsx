import {
	type ArchiveLevel,
	type ArchiveLevels,
	levelAt,
	useArchiveLevels,
} from '@panel/archive/archive-levels.js';
import { componentsFromSplat, levelsOf, splatFromComponents } from '@panel/archive/archive-path.js';
import { type ArchivedDeviceInfo, useArchivedDeviceInfo } from '@panel/archive/device-info.js';
import { ArchiveNotReadable } from '@panel/components/archive/contents-card.js';
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
	const serialLevel = serialPath(selected, serial);
	const runContents = useArchiveLevels(serialLevel === null ? NO_LEVELS : [serialLevel]);
	/*
	 * The run's `device_info.json`, read out of that same `<serial>` directory — the one thing on
	 * this screen that is a file's contents rather than a listing (#136, #131's byte route). It is
	 * addressed by the level, not by a path this screen composed, and it is not fetched at all for
	 * a run whose serial nobody has answered for.
	 */
	const device = useArchivedDeviceInfo(serialLevel);

	const level = levelAt(levels, selected);
	const depth = selected.length;

	return (
		<>
			<PageHeader
				trail={trailFor(selected)}
				description={DESCRIPTIONS[Math.min(depth, DESCRIPTIONS.length - 1)] ?? ''}
				aside={badgeFor(depth, level)}
			/>
			<Content
				device={device}
				levels={levels}
				runContents={runContents}
				selected={selected}
				serial={serial}
			/>
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
	device,
}: {
	readonly selected: readonly string[];
	readonly levels: ArchiveLevels;
	readonly serial: RunSerial;
	readonly runContents: ArchiveLevels;
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
			{selected.length === 3 ? (
				/*
				 * With no serial there is no level to read and `RunPanel` says so from `serial` alone
				 * without looking at `contents`; `[]` is a path `runContents` never holds, so it reads
				 * as `loading` and goes unused.
				 */
				<RunPanel
					contents={levelAt(runContents, serialPath(selected, serial) ?? [])}
					device={device}
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
 * **The level above's own state is carried out with it, never collapsed into a missing serial.** A
 * level still in flight and a level the host cannot read are answers the screen has not got, and
 * folding them into the same `null` as a run that names no single child made the panel state *there
 * is nothing to list for this run* about a run nobody had answered for yet — and, on the unreadable
 * path, about one nobody ever will. Each of the three is a different sentence (see `RunPanel`).
 *
 * An `empty` level above is `answered` with no serial: it named no runs at all, so this run is not
 * there, and *nothing to list* is the honest thing to say about it.
 */
function serialOf(levels: ArchiveLevels, selected: readonly string[]): RunSerial {
	if (selected.length !== 3) {
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
