import { type ArchiveLevel, type ArchiveLevels, levelAt } from '@panel/archive/archive-levels.js';
import type { ArchiveEntry } from '@panel/archive/archive-listing.js';
import { keyOf, splatFromComponents } from '@panel/archive/archive-path.js';
import {
	type ArchivedDeviceInfo,
	type DeviceFacts,
	deviceFactsFrom,
} from '@panel/archive/device-info.js';
import { formatBytes, formatChildCount, UNKNOWN } from '@panel/archive/file-size.js';
import { decomposeRunName } from '@panel/archive/run-identity.js';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, FileQuestionMark, FileText, Folder, FolderOpen } from 'lucide-react';
import {
	ArchiveNotReadable,
	CardHeading,
	ContentsCard,
	Field,
	NothingFiledHere,
	NotReadableInCard,
	ReadingLevel,
} from './contents-card.js';

/**
 * The run's `<serial>` **together with the state of the answer it was read out of**.
 *
 * The serial is the run directory's `onlyChild` on the level *above* the run, so *the host has not
 * answered for that level yet* and *the host cannot read that level* are states of an answer, not
 * the absence of a serial. Folding all three into `string | null` is what let a run whose parent
 * level was still in flight — or permanently unreadable — render as a run that wrote nothing.
 */
export type RunSerial =
	| { readonly status: 'loading' }
	| { readonly status: 'unreadable' }
	/** The host answered for the level above: `serial` is its `onlyChild`, `null` when it named none. */
	| { readonly status: 'answered'; readonly serial: string | null };

/**
 * One run: what it is, and everything it wrote (`docs/DESIGN.md` §9).
 *
 * **A run is the deepest level of the tree, and its `<serial>` is not a level.** One lease is one
 * device, so a run directory holds exactly one child, and the host publishes that name as
 * `onlyChild` on the run's own entry in the level above — a fact about the run rather than a round
 * trip (`src/ipc/methods.ts`). `SERIAL` reads that, and `CONTENTS` is the listing of
 * `[…run, serial]`, which is the one extra level a selected run needs read.
 *
 * **Nothing here is invented.** No duration, no trigger, no author, no environment panel, no
 * network figure and no file name that was not in the listing. Every field is either on the wire or
 * decomposed from the directory's own name, and a fact the host does not have says `unknown`.
 *
 * **`DEVICE — FROM device_info.json` is the one card here that is not a listing** (#136). It reads
 * the *contents* of an archived file, which `list_archive` cannot answer and #131's byte route can;
 * everything on it comes out of that file, with `docs/DESIGN.md` §6's three fallbacks and nothing
 * else. Its own three states are folded in {@link Device}.
 *
 * **This is also the column beside whatever else the address opens** (#133, #143) — a preview, or
 * the tree with a folder of this run open in `CONTENTS` — and it is this same column in less space:
 * the identity card and the device card do not change at all. Two things do, and both come from
 * `CONTENTS` having become how another address inside the run is chosen —
 *
 * - **the header keeps its left-aligned `Run Details`, and gains the back arrow before it while an
 *   *artifact* is open.** The arrow is there because a preview took the tree's place, so the column
 *   is the only way back; a folder opens *beside* the tree, which is its own way back, so a folder
 *   gets no control at all ({@link back}, `docs/DESIGN.md` §9).
 * - **`CONTENTS` expands down to and including the open address**, the open one carrying the
 *   selected treatment and every other folder staying summarised. That is the tree's own expansion
 *   rule (`directory-tree.tsx`) applied to the run's subtree, so there is no stored expansion state
 *   here either — a folder is expanded exactly when the open address is inside it, or is it.
 */
export function RunPanel({
	run,
	serial,
	contents,
	device,
	open,
	below,
	back,
}: {
	readonly run: readonly string[];
	/** The run directory's `onlyChild`, with the state of the answer it came from — {@link RunSerial}. */
	readonly serial: RunSerial;
	readonly contents: ArchiveLevel;
	/** This run's own `device_info.json` — {@link ArchivedDeviceInfo}. */
	readonly device: ArchivedDeviceInfo;
	/**
	 * The address open inside this run — an artifact or a folder — and `null` when nothing below the
	 * `<serial>` is addressed. It is what `CONTENTS` marks and expands, and nothing else.
	 */
	readonly open: readonly string[] | null;
	/** Every level below the `<serial>` directory that has been read — the expansions `CONTENTS` draws. */
	readonly below: ArchiveLevels;
	/**
	 * Whether the back arrow heads the strip — **true exactly when a preview is what took the tree's
	 * place**, which is the one state this column is the only way out of (#143). It is a fact about
	 * what is beside the column rather than about {@link open}, which is why it is its own input: a
	 * folder is marked and expanded in `CONTENTS` the same way and still has the tree to go back to.
	 */
	readonly back: boolean;
}) {
	const name = run.at(-1) ?? '';
	const identity = decomposeRunName(name);

	return (
		<ContentsCard header={<Header back={back} run={run} />}>
			<div className="space-y-6 p-6">
				<section className="rounded-lg border-2 border-outline-variant bg-surface p-5">
					<h3 className="mb-4 break-words font-code-md font-bold text-code-md text-on-surface">
						{name}
					</h3>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
						{/*
						 * `OWNER` is **the directory's own text**. It went through `pathSegment` on the
						 * way in, so it is not reversibly the caller's `owner` string and is never
						 * presented as one (D20, D22).
						 */}
						<Field label="OWNER">{identity.owner ?? UNKNOWN}</Field>
						<Field label="GRANTED">{identity.grantedAt ?? UNKNOWN}</Field>
						<Field label="SERIAL">{serialText(serial)}</Field>
					</div>
				</section>

				<section className="rounded-lg border-2 border-outline-variant bg-surface p-5">
					<h3 className="mb-4 font-label-caps text-[12px] text-on-surface uppercase">
						DEVICE — FROM device_info.json
					</h3>
					<Device device={device} serial={serial} />
				</section>

				<section className="rounded-lg border-2 border-outline-variant bg-surface p-5">
					<h3 className="mb-4 font-label-caps text-[12px] text-on-surface uppercase">CONTENTS</h3>
					<Contents below={below} contents={contents} open={open} run={run} serial={serial} />
				</section>
			</div>
		</ContentsCard>
	);
}

/**
 * The strip at the top of this column — **the arrow, then a left-aligned `Run Details`** (#143).
 *
 * That is the approved markup's own header, restored: the arrow was alone and *centred*, which put
 * the one control on the card off the axis every card under it sits on, while every other header on
 * this screen is left-aligned. The heading is the same one in both states, so the arrow appearing is
 * the whole of what changes when a preview opens — nothing in the strip is replaced by something
 * else.
 */
function Header({ run, back }: { readonly run: readonly string[]; readonly back: boolean }) {
	return (
		<div className="flex items-center gap-3">
			{back ? <BackToTheDirectory run={run} /> : null}
			<CardHeading>Run Details</CardHeading>
		</div>
	);
}

/**
 * The way out of a preview, and **the only state that has one**: a folder is open beside the tree,
 * and the tree is the way back from it (#143).
 *
 * A `<Link>` and not a `<button>`, because the whole of this screen's state is its address
 * (`docs/DESIGN.md` §9): closing the preview *is* navigating to the run, so the control is the run's
 * own address and the tree comes back because the address is three components deep again. One
 * control, one outcome — and nothing else in this strip navigates, so there is no second way to
 * leave.
 *
 * The label is the design's own, because what the arrow does is not obvious from the glyph.
 */
function BackToTheDirectory({ run }: { readonly run: readonly string[] }) {
	return (
		<Link
			aria-label="Close the preview and go back to the directory"
			className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border-2 border-outline-variant bg-surface text-on-surface-variant transition-colors hover:border-tertiary hover:text-tertiary"
			params={{ _splat: splatFromComponents(run) }}
			to="/archive/$"
		>
			<ArrowLeft aria-hidden="true" size={18} strokeWidth={2} />
		</Link>
	);
}

/**
 * What `SERIAL` reads, and **`unknown` is reserved for a run the host has answered about.**
 *
 * A serial nobody has answered for yet is *not known yet*, and one on a level the host cannot read
 * is *not readable* — neither is the run naming no single child, which is the only fact `unknown`
 * may stand for here (`docs/DESIGN.md` §9). All three are lower case for the reason `UNKNOWN` is:
 * it is the screen saying what it does not have, not a value the host sent.
 */
function serialText(serial: RunSerial): string {
	if (serial.status === 'loading') {
		return 'reading';
	}
	if (serial.status === 'unreadable') {
		return 'not readable';
	}
	return serial.serial ?? UNKNOWN;
}

/**
 * The device the lease held, entirely out of the run's own `device_info.json`.
 *
 * **The state of the level *above* is ordered first**, exactly as {@link Contents} orders it and for
 * the same reason: this file lives inside the run's `<serial>` directory, whose name is that
 * level's `onlyChild`, so with no serial there is no address to read it at. While that level is in
 * flight the card is *reading*; when the host cannot read it the card cannot say whether a file is
 * filed, which is *not readable*; and a run that names no single child has no `<serial>` directory
 * for a file to be in, which is *none filed*. Only then does the file's own answer decide.
 *
 * **Nothing is invented.** Six fields, every value from the file, and a fact the file does not
 * carry reads `unknown` (`device-info.ts`). No run duration, no trigger, no author, no environment
 * panel and no network figure — the same absences `docs/DESIGN.md` §9 requires of the rest of this
 * panel.
 */
function Device({
	device,
	serial,
}: {
	readonly device: ArchivedDeviceInfo;
	readonly serial: RunSerial;
}) {
	if (serial.status === 'loading') {
		return <ReadingDeviceInfo />;
	}
	if (serial.status === 'unreadable' || device.status === 'unreadable') {
		return <DeviceInfoNotReadable />;
	}
	if (serial.serial === null || device.status === 'missing') {
		return <NoDeviceInfo />;
	}
	if (device.status === 'reading') {
		return <ReadingDeviceInfo />;
	}
	return <Facts facts={deviceFactsFrom(device.info, serial.serial)} />;
}

/** The design's six fields, in the design's own order and its two-then-three column grid. */
function Facts({ facts }: { readonly facts: DeviceFacts }) {
	return (
		<div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
			<Field label="MODEL">{facts.model}</Field>
			{/*
			 * Verbatim, so it reads `android` and never `Android`. A display table mapping one onto
			 * the other would be a platform branch in shared code (`ai/RULES.md` §2), and the device
			 * card holds the same line.
			 */}
			<Field label="PLATFORM">{facts.platform}</Field>
			<Field label="OS VERSION">{facts.osVersion}</Field>
			<Field label="API LEVEL">{facts.apiLevel}</Field>
			<Field label="SCREEN">{facts.screen}</Field>
			<Field label="DENSITY">{facts.density}</Field>
		</div>
	);
}

/** One quiet line, `aria-live` and no spinner — {@link ReadingLevel}'s rule, about a file. */
function ReadingDeviceInfo() {
	return (
		<p aria-live="polite" className="font-code-md text-code-md text-on-surface-variant">
			Reading this run's device_info.json.
		</p>
	);
}

/**
 * Rover filed no `device_info.json` for this run — **said plainly, in {@link NothingFiledHere}'s
 * language and with its weight.** One sentence where the rows would have been: no alarm colour, no
 * warning icon, no error code and no retry control (`docs/DESIGN.md` §7).
 *
 * It says what would have produced one, so a reader can tell this from a device that answered
 * nothing: the file is the archive's static snapshot of the device, written beside the first
 * artifact a lease-device pair produces (D14, `src/daemon/archive.ts`).
 */
function NoDeviceInfo() {
	return (
		<p className="font-code-md text-code-md text-on-surface-variant">
			No device_info.json is filed for this run. Rover writes one beside the first artifact a lease
			produces, so this is an ordinary answer rather than a fault.
		</p>
	);
}

/**
 * The file is there and this host will not read it — **the sentence that must never read like
 * {@link NoDeviceInfo}'s**, which is the same pair *unreadable* and *empty* form one directory up
 * (D6, `docs/DESIGN.md` §9).
 *
 * Grey and plain, for {@link NoDeviceInfo}'s reasons, and **no error code**: the reason and the
 * path stay on the host by design (D19), so a code here would dress a refusal up as a diagnosis.
 */
function DeviceInfoNotReadable() {
	return (
		<p className="font-code-md text-code-md text-on-surface-variant">
			Rover cannot read this run's device_info.json. This is not the same as none being filed —
			there may well be one, and the host will not say what is in it.
		</p>
	);
}

/**
 * What the lease wrote, from one listing of the run's `<serial>` directory — **and how another file
 * is chosen** (#133).
 *
 * **The state of the level *above* is ordered before this level's own**, because the serial is read
 * off that level: while it is in flight there is nothing to list *yet*, and when it cannot be read
 * nobody can say whether there is. Only a level that answered and named no single child reaches
 * {@link Nothing} — a run directory holding something other than exactly one entry, which is a fact
 * to state rather than to go looking for with a second request, since one lease is one device.
 *
 * `SERIAL` above draws the same distinction, and neither ever invents a `0` or guesses a serial.
 *
 * **Every row is a `<Link>`** — `level-contents.tsx`'s already-recorded deviation from the approved
 * markup (`cursor-default` there), for its own reason: this is the only way into a file, so rows
 * that did nothing would make the larger half of a file explorer inert. Nothing else about a row
 * changes; it gains no control, no status and no count the listing did not carry.
 */
function Contents({
	serial,
	contents,
	run,
	open,
	below,
}: {
	readonly serial: RunSerial;
	readonly contents: ArchiveLevel;
	readonly run: readonly string[];
	readonly open: readonly string[] | null;
	readonly below: ArchiveLevels;
}) {
	if (serial.status === 'loading') {
		return <ReadingLevel />;
	}
	if (serial.status === 'unreadable') {
		return <NotReadableInCard />;
	}
	if (serial.serial === null) {
		return <Nothing />;
	}
	if (contents.status === 'loading') {
		return <ReadingLevel />;
	}
	if (contents.status === 'unreadable') {
		return <NotReadableInCard />;
	}
	if (contents.status === 'empty') {
		return <NothingFiledHere />;
	}
	// The addresses of this listing's entries. The `<serial>` is in the path and not in the tree,
	// which is why every address below a run carries it (`docs/DESIGN.md` §9).
	const base = [...run, serial.serial];
	return (
		<>
			<ul className="mb-6 space-y-3 font-code-md text-[13px] text-on-surface-variant">
				{contents.entries.map((entry) => (
					<li className="min-w-0" key={entry.name}>
						<Entry
							below={below}
							entry={entry}
							open={open}
							path={[...base, entry.name]}
							summarised
						/>
					</li>
				))}
			</ul>
			{/*
			 * The design's own footnote, kept: it is the sentence that stops a reader taking a short
			 * listing for a truncated one.
			 */}
			<p className="font-code-md text-[11px] text-outline italic">
				A directory that is not listed does not exist — a verb that produced no bytes wrote nothing.
			</p>
		</>
	);
}

const ROW = 'flex items-start gap-2 rounded-sm border-2 px-2 py-1 transition-colors';
const ROW_OPEN = 'border-tertiary bg-tertiary-container text-on-tertiary-container';
// Bordered transparent rather than unbordered, so opening a row does not shift it by 2px — the
// tree's own trick, and the sidebar's before it.
const ROW_CLOSED = 'border-transparent hover:bg-surface-container-high';

/**
 * One entry, as a link to its own address, and its children when the open address is inside it.
 *
 * **Expansion is derived, never stored**: a folder is expanded exactly when the open address is
 * *inside* it — or **is** it. The addressed folder expands under its own row (#143): a folder has no
 * column of its own any more, so there is no second place its listing could be drawn in, and the one
 * folder a reader actually pointed at is the last one that should refuse to open where it was
 * clicked.
 *
 * `summarised` is what a top-level row carries and a nested one does not: a count for a directory
 * and a size for a file. A nested row is a name, because at that depth the row is a control for
 * choosing another file rather than a report of what is filed — the design's own shape.
 */
function Entry({
	entry,
	path,
	open,
	below,
	summarised,
}: {
	readonly entry: ArchiveEntry;
	readonly path: readonly string[];
	readonly open: readonly string[] | null;
	readonly below: ArchiveLevels;
	readonly summarised?: boolean;
}) {
	const expanded = entry.kind === 'directory' && holds(path, open);
	const isOpen = open !== null && keyOf(open) === keyOf(path);
	return (
		<>
			<Link
				aria-current={isOpen ? 'page' : undefined}
				className={`${ROW} ${isOpen ? ROW_OPEN : ROW_CLOSED} ${summarised === true ? 'justify-between' : ''}`}
				params={{ _splat: splatFromComponents(path) }}
				to="/archive/$"
			>
				<span className="flex min-w-0 items-start gap-2">
					<Glyph entry={entry} expanded={expanded} />
					{/* A directory keeps its trailing separator; the name itself is verbatim. */}
					<span className="min-w-0 break-words">
						{entry.name}
						{entry.kind === 'directory' ? '/' : ''}
					</span>
				</span>
				{summarised === true ? <span className="shrink-0">{measure(entry)}</span> : null}
			</Link>
			{expanded ? <Expansion below={below} open={open} path={path} /> : null}
		</>
	);
}

/** Whether the open address **is** this directory or is inside it — a prefix, the address included. */
function holds(path: readonly string[], open: readonly string[] | null): boolean {
	return (
		open !== null && open.length >= path.length && keyOf(open.slice(0, path.length)) === keyOf(path)
	);
}

/**
 * A folder on the open path, expanded to its own entries — and it recurses, which is what makes
 * `recordings/001_frames/0001.png` reachable without the tree.
 *
 * A level that is not a listing reuses the screen's settled sentences, **indented and not
 * reworded**: the same three states this card draws one level up mean the same thing here.
 */
function Expansion({
	path,
	open,
	below,
}: {
	readonly path: readonly string[];
	readonly open: readonly string[] | null;
	readonly below: ArchiveLevels;
}) {
	const level = levelAt(below, path);
	if (level.status !== 'listed') {
		return (
			<div className="mt-1 pl-6">
				{level.status === 'loading' ? <ReadingLevel /> : null}
				{level.status === 'empty' ? <NothingFiledHere /> : null}
				{level.status === 'unreadable' ? <ArchiveNotReadable /> : null}
			</div>
		);
	}
	return (
		<ul className="mt-1 space-y-1 pl-6">
			{level.entries.map((entry) => (
				<li className="min-w-0" key={entry.name}>
					<Entry below={below} entry={entry} open={open} path={[...path, entry.name]} />
				</li>
			))}
		</ul>
	);
}

function Nothing() {
	return (
		<p className="font-code-md text-code-md text-on-surface-variant">
			There is nothing to list for this run.
		</p>
	);
}

/**
 * A folder, a file, or something the host could not classify (a symlink, a socket, a device
 * node). **No status glyph of any kind** — this says what an entry *is*, never how it went.
 *
 * An expanded folder is `FolderOpen` and a summarised one `Folder`, which is the tree's own idiom
 * for the same fact. The glyph is **not** per media type: a table mapping `.png` to a picture icon
 * would be a second extension vocabulary in the panel, and there is deliberately only one — the
 * host's (`panel/src/archive/artifact-body.ts`).
 */
function Glyph({ entry, expanded }: { readonly entry: ArchiveEntry; readonly expanded: boolean }) {
	const Icon =
		entry.kind === 'directory'
			? expanded
				? FolderOpen
				: Folder
			: entry.kind === 'file'
				? FileText
				: FileQuestionMark;
	return (
		<Icon aria-hidden="true" className="mt-0.5 shrink-0 text-outline" size={16} strokeWidth={2} />
	);
}

/** A count for a directory, a size for a file, and nothing at all for an entry that is neither. */
function measure(entry: ArchiveEntry): string {
	if (entry.kind === 'directory') {
		return formatChildCount(entry.childCount);
	}
	return entry.kind === 'file' ? formatBytes(entry.sizeBytes) : '';
}
