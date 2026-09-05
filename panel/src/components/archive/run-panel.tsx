import {
	type ArchivedDeviceInfo,
	type DeviceFacts,
	deviceFactsFrom,
} from '@panel/archive/device-info.js';
import { UNKNOWN } from '@panel/archive/file-size.js';
import { decomposeRunName } from '@panel/archive/run-identity.js';
import type { ArchivedTestDescription } from '@panel/archive/test-description.js';
import { CardHeading, ContentsCard, Field } from './contents-card.js';

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
 * One run: what it is, and the device it was recorded on (`docs/DESIGN.md` §9).
 *
 * **Two cards, and neither of them is a listing** (#161). What the run wrote is the tree's to say:
 * it reaches every address inside a run since #159 and stands beside this card at every depth since
 * #160, so `CONTENTS` was a second explorer of the addresses the tree had just been given. **Nothing
 * on this card navigates** while it is showing a level — it says what this run *is*, and moving is
 * done in the one place that is for it.
 *
 * **A run is not the deepest level of the tree, and its `<serial>` is still not a level of it.** One
 * lease is one device, so a run directory holds exactly one child, and the host publishes that name
 * as `onlyChild` on the run's own entry in the level above — a fact about the run rather than a
 * round trip (`src/ipc/methods.ts`). `SERIAL` reads it, and the tree hops it to draw the run's own
 * entries under the run's node.
 *
 * **Nothing here is invented.** No duration, no trigger, no author, no environment panel, no
 * network figure and no file name that was not in a listing. Every field is either on the wire or
 * decomposed from the directory's own name, and a fact the host does not have says `unknown`.
 *
 * **`DEVICE — FROM device_info.json` is a file's contents rather than a listing** (#136). It reads
 * an archived file, which `list_archive` cannot answer and #131's byte route can; everything on it
 * comes out of that file, with `docs/DESIGN.md` §6's three fallbacks and nothing else. Its own three
 * states are folded in {@link Device}.
 *
 * **`DESCRIPTION` on the identity card is the second such read** (#148): the lease's own account of
 * what this run was checking, filed with the run so it outlives the lease. Same route, same three
 * states, folded in {@link descriptionText} — and still nothing invented, because every word of it
 * was written by the lease that took the device.
 *
 * **Whether the run's `<serial>` level is empty or unreadable is said in the tree** (#161,
 * `directory-tree.tsx`). `CONTENTS` was where that pair was drawn apart, and it may never render
 * alike (D6); this card is not a listing any more, so the one quiet line under the run's node is
 * where it is said instead.
 *
 * **This card is drawn at the run's own depth and nowhere else** (#160). It stood beside an open
 * artifact and beside a folder of the run while the tree came and went; the tree is beside the card
 * at every depth now, so the run's column is what a *selected run* is and nothing else opens it.
 */
export function RunPanel({
	run,
	serial,
	device,
	description,
}: {
	readonly run: readonly string[];
	/** The run directory's `onlyChild`, with the state of the answer it came from — {@link RunSerial}. */
	readonly serial: RunSerial;
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
 * **The state of the level *above* is ordered first**, exactly as {@link descriptionText} orders it
 * and for the same reason: this file lives inside the run's `<serial>` directory, whose name is that
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
