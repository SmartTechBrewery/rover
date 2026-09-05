import type { ArchiveLevel } from '@panel/archive/archive-levels.js';
import type { ArchiveEntry } from '@panel/archive/archive-listing.js';
import { splatFromComponents } from '@panel/archive/archive-path.js';
import {
	type ArchivedDeviceInfo,
	type DeviceFacts,
	deviceFactsFrom,
} from '@panel/archive/device-info.js';
import { formatBytes, formatChildCount, UNKNOWN } from '@panel/archive/file-size.js';
import { decomposeRunName } from '@panel/archive/run-identity.js';
import type { ArchivedTestDescription } from '@panel/archive/test-description.js';
import { Link } from '@tanstack/react-router';
import { FileQuestionMark, FileText, Folder } from 'lucide-react';
import {
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
 * **`DESCRIPTION` on the identity card is the second such read** (#148): the lease's own account of
 * what this run was checking, filed with the run so it outlives the lease. Same route, same three
 * states, folded in {@link descriptionText} — and still nothing invented, because every word of it
 * was written by the lease that took the device.
 *
 * **This card is drawn at the run's own depth and nowhere else** (#160). It stood beside an open
 * artifact and beside a folder of the run while the tree came and went; the tree is beside the card
 * at every depth now, so the run's column is what a *selected run* is and nothing else opens it. Two
 * things went with that arrangement — the back arrow, which existed because a preview took the
 * tree's place, and `CONTENTS`' expansion of the open address, which existed because the tree could
 * not reach a file. `CONTENTS` is a flat listing of the `<serial>` level again (`docs/DESIGN.md`
 * §9), and #159's third phase is what takes it off this card altogether.
 */
export function RunPanel({
	run,
	serial,
	contents,
	device,
	description,
}: {
	readonly run: readonly string[];
	/** The run directory's `onlyChild`, with the state of the answer it came from — {@link RunSerial}. */
	readonly serial: RunSerial;
	readonly contents: ArchiveLevel;
	/** This run's own `device_info.json` — {@link ArchivedDeviceInfo}. */
	readonly device: ArchivedDeviceInfo;
	/** This run's own `test_description.json` — {@link ArchivedTestDescription}. */
	readonly description: ArchivedTestDescription;
}) {
	const name = run.at(-1) ?? '';
	const identity = decomposeRunName(name);

	return (
		<ContentsCard header={<CardHeading>Run Details</CardHeading>}>
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
					{/*
					 * **What the lease said it was about** (#148, `docs/DESIGN.md` §9) — the run's own
					 * `test_description.json`, and the second file on this screen whose *contents* are
					 * read rather than listed. Full width and below the three-column grid, because it
					 * is a sentence rather than a measured value.
					 *
					 * **It is always drawn, which the live device card's field is not**, and the
					 * asymmetry is the point: on a device card absence is a fact the answer carries —
					 * no key, so nothing to draw — while here absence is a *file that is not there*,
					 * and *reading* and *not readable* have to be tellable from it. There is nowhere
					 * else on this card to say those, so the field says all four
					 * ({@link descriptionText}).
					 */}
					<div className="mt-4">
						<Field label="DESCRIPTION">{descriptionText(description, serial)}</Field>
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
					<Contents contents={contents} run={run} serial={serial} />
				</section>
			</div>
		</ContentsCard>
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
 * What `DESCRIPTION` reads, and **the three answers that are not a description share no phrase**
 * (`docs/DESIGN.md` §9, `test-description.ts`).
 *
 * *none filed* is a lease that never described itself — ordinary, and the common case for every run
 * filed before #148 — while *not readable* is the host declining to say what is in a file that is
 * there. Reading them as the same thing is the mistake this vocabulary exists to prevent, one level
 * up and here alike (D6).
 *
 * **The state of the level *above* is ordered first**, exactly as {@link Device} orders it and for
 * the same reason: the file lives inside the run's `<serial>` directory, so with no serial there is
 * no address to read it at. All three are lower case for the reason `UNKNOWN` is — it is the screen
 * saying what it does not have, not a value the host sent.
 */
function descriptionText(description: ArchivedTestDescription, serial: RunSerial): string {
	if (serial.status === 'loading') {
		return 'reading';
	}
	if (serial.status === 'unreadable' || description.status === 'unreadable') {
		return 'not readable';
	}
	if (serial.serial === null || description.status === 'missing') {
		return 'none filed';
	}
	if (description.status === 'reading') {
		return 'reading';
	}
	return description.description;
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
}: {
	readonly serial: RunSerial;
	readonly contents: ArchiveLevel;
	readonly run: readonly string[];
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
						<Entry entry={entry} path={[...base, entry.name]} />
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

const ROW =
	'flex items-start justify-between gap-2 rounded-sm border-2 px-2 py-1 transition-colors';
// Bordered transparent rather than unbordered, so hovering a row does not shift it by 2px — the
// tree's own trick, and the sidebar's before it.
const ROW_RESTING = 'border-transparent hover:bg-surface-container-high';

/**
 * One entry of the `<serial>` level, as a link to its own address — **a flat listing again** (#160).
 *
 * It expanded down to and including whatever address was open, which is the tree's own rule applied
 * to the run's subtree; that existed because a file was reachable from this card and nowhere else.
 * The tree reaches every address now (#159) and this card is drawn only for a *selected* run, so
 * there is no open address below it to mark and nothing to expand — and no stored expansion state
 * went away with it, because there never was any.
 *
 * Every row keeps its measure: a count for a directory and a size for a file, which is this card's
 * job — saying what the run wrote.
 */
function Entry({
	entry,
	path,
}: {
	readonly entry: ArchiveEntry;
	readonly path: readonly string[];
}) {
	return (
		<Link
			className={`${ROW} ${ROW_RESTING}`}
			params={{ _splat: splatFromComponents(path) }}
			to="/archive/$"
		>
			<span className="flex min-w-0 items-start gap-2">
				<Glyph entry={entry} />
				{/* A directory keeps its trailing separator; the name itself is verbatim. */}
				<span className="min-w-0 break-words">
					{entry.name}
					{entry.kind === 'directory' ? '/' : ''}
				</span>
			</span>
			<span className="shrink-0">{measure(entry)}</span>
		</Link>
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
 * A folder is `Folder` and never `FolderOpen`: nothing on this listing opens in place any more
 * (#160), so there is no expanded state for a glyph to say. The glyph is **not** per media type: a
 * table mapping `.png` to a picture icon
 * would be a second extension vocabulary in the panel, and there is deliberately only one — the
 * host's (`panel/src/archive/artifact-body.ts`).
 */
function Glyph({ entry }: { readonly entry: ArchiveEntry }) {
	const Icon =
		entry.kind === 'directory' ? Folder : entry.kind === 'file' ? FileText : FileQuestionMark;
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
