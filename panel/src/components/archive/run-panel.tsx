import type { ArchiveLevel } from '@panel/archive/archive-levels.js';
import type { ArchiveEntry } from '@panel/archive/archive-listing.js';
import { formatBytes, formatChildCount, UNKNOWN } from '@panel/archive/file-size.js';
import { decomposeRunName } from '@panel/archive/run-identity.js';
import { FileQuestionMark, FileText, Folder } from 'lucide-react';
import {
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
 * **The `DEVICE — FROM device_info.json` card is deliberately absent.** It needs the *contents* of
 * an archived file and `list_archive` answers directory listings only. The bytes have an address
 * since #131 (`GET /artifact/<component>/…`), but nothing in the panel fetches one yet, so the card
 * waits on the preview that first does — issue #133. The gap is on the page on purpose rather than
 * closed with a guess.
 */
export function RunPanel({
	run,
	serial,
	contents,
}: {
	readonly run: readonly string[];
	/** The run directory's `onlyChild`, with the state of the answer it came from — {@link RunSerial}. */
	readonly serial: RunSerial;
	readonly contents: ArchiveLevel;
}) {
	const name = run.at(-1) ?? '';
	const identity = decomposeRunName(name);

	return (
		<ContentsCard title="Run Details">
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
					<h3 className="mb-4 font-label-caps text-[12px] text-on-surface uppercase">CONTENTS</h3>
					<Contents contents={contents} serial={serial} />
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
 * What the lease wrote, from one listing of the run's `<serial>` directory.
 *
 * **The state of the level *above* is ordered before this level's own**, because the serial is read
 * off that level: while it is in flight there is nothing to list *yet*, and when it cannot be read
 * nobody can say whether there is. Only a level that answered and named no single child reaches
 * {@link Nothing} — a run directory holding something other than exactly one entry, which is a fact
 * to state rather than to go looking for with a second request, since one lease is one device.
 *
 * `SERIAL` above draws the same distinction, and neither ever invents a `0` or guesses a serial.
 */
function Contents({
	serial,
	contents,
}: {
	readonly serial: RunSerial;
	readonly contents: ArchiveLevel;
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
	return (
		<>
			<ul className="mb-6 space-y-3 font-code-md text-[13px] text-on-surface-variant">
				{contents.entries.map((entry) => (
					<li className="flex items-start justify-between gap-4" key={entry.name}>
						<span className="flex min-w-0 items-start gap-2">
							<Glyph entry={entry} />
							{/* A directory keeps its trailing separator; the name itself is verbatim. */}
							<span className="min-w-0 break-words">
								{entry.name}
								{entry.kind === 'directory' ? '/' : ''}
							</span>
						</span>
						<span className="shrink-0">{measure(entry)}</span>
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
