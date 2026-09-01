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
 * an archived file and `list_archive` answers directory listings only; reading an artifact's bytes
 * is issue #131. The gap is on the page on purpose rather than closed with a guess.
 */
export function RunPanel({
	run,
	serial,
	contents,
}: {
	readonly run: readonly string[];
	/** The run directory's `onlyChild`, or `null` — see {@link Contents}. */
	readonly serial: string | null;
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
						<Field label="SERIAL">{serial ?? UNKNOWN}</Field>
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
 * What the lease wrote, from one listing of the run's `<serial>` directory.
 *
 * **A `null` `serial` is not worked around.** It means the run directory holds something other than
 * exactly one entry, or the host could not read into it; there is no second request to go looking,
 * because one lease is one device and a run directory that is not that shape is a fact to state.
 * `SERIAL` reads `unknown` above and this says there is nothing to list — never an invented `0` and
 * never a guessed serial.
 */
function Contents({
	serial,
	contents,
}: {
	readonly serial: string | null;
	readonly contents: ArchiveLevel;
}) {
	if (serial === null) {
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
