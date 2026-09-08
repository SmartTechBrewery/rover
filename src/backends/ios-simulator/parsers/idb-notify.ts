/**
 * Parser for what `idb_companion --notify stdout` prints — the framing, then the target shape.
 *
 * Pure, like every parser here: it takes bytes a runner already captured and returns shapes. The
 * process, its argv and its supervision belong to a later phase (R5).
 *
 * **The framing is one JSON array per line, newline-terminated**, and each line is the *full*
 * current set of targets rather than a delta — which is `DeviceWatcher.onDevices`' contract to
 * the letter (`docs/IOS.md` §7). Measured against `idb_companion` v1.5.2 (built 2026-09-01) on
 * Xcode 26.6 / iOS 26.5, 2026-09-08, and committed as
 * `tests/fixtures/ios-simulator/idb-notify.idbcompanion1.5.2-xcode26.6-ios26.5.txt`: booting one
 * simulator and shutting it down again produced five frames of eleven targets each —
 * `Shutdown → Booting → Booted → Shutting Down → Shutdown`.
 *
 * **The line's terminating newline arrives in its own write**, which is the whole reason this is
 * a decoder and not a `split('\n')`. The chunk sizes read off that capture were
 * `1784, 1, 1784, 1783, 1789, 1, 1785` — a frame and its newline delivered as two reads, twice in
 * five frames. A consumer that treated one read as one frame would have parsed three of the five
 * and choked on the two bare newlines.
 *
 * Byte-based rather than string-based, for `../../android/parsers/track.ts`' reason: a chunk
 * boundary can fall inside a multi-byte character — a simulator whose operator-chosen name is not
 * ASCII — so a frame is only decoded once all of its bytes are present.
 */

import { z } from 'zod';

/** The byte the companion ends each frame with. */
const FRAME_DELIMITER = 0x0a;

/** How this stream is named in a failure, so a person knows which program produced it. */
const IDB_NOTIFY_SOURCE = 'idb_companion --notify';

/** How much of an unparseable frame the message carries — enough to recognise, not a log dump. */
const FRAME_EXCERPT_LENGTH = 120;

/**
 * A frame that is not the JSON array every frame is.
 *
 * Its own error class, and **terminal for that run of the companion**, which is
 * `TrackFramingError`'s reasoning: framing that has lost sync cannot be resynchronised — there is
 * no way to tell where the next frame was meant to begin — so the decoder refuses every later
 * chunk rather than emitting a device set sliced at a guessed offset. A device list assembled
 * from a guess is worse than none, and the caller's answer is one `onInterrupted` and a restart.
 */
export class IdbNotifyFramingError extends Error {
	constructor(frame: string, cause: unknown) {
		super(
			`${IDB_NOTIFY_SOURCE}: expected one JSON array of targets per line, got ` +
				`'${truncate(frame)}'`,
			{ cause },
		);
		this.name = 'IdbNotifyFramingError';
	}
}

/**
 * One target as the companion reports it.
 *
 * **Non-`.strict()`, deliberately**, for `SimctlDeviceSchema`'s stated reason: the key set is
 * Meta's, not this repository's, and a release adds fields — strictness would turn an idb upgrade
 * into a load-time failure in a module that reads five keys. Every one of the six keys the v1.5.2
 * capture carries is here, because five of them are read and the sixth (`model`) is what
 * distinguishes the *hardware* from the operator-chosen `name` and is worth pinning while the
 * evidence is in front of us.
 *
 * **`state` is an open string, not an enum**, exactly as on the simctl side: the capture pins
 * `Booted`, `Booting`, `Shutting Down` and `Shutdown`, and that is not the whole token list. The
 * one meaning that is verified is encoded in `../devices.js` and nowhere else.
 *
 * **`type` is an open string too, and that is what the allowlist in `../devices.js` reads.** This
 * bench had no physical target paired, so `Simulator` is the only value the capture pins; a
 * schema that made it an enum would refuse to parse the frame from a machine with an iPhone
 * plugged in, which is the one frame the exclusion rule exists for.
 *
 * **`os_version` carries the platform word** — `iOS 26.5`, where `simctl`'s runtime reports a bare
 * `26.5` for the same runtime. Reported verbatim here; reconciling the two spellings is
 * `../devices.js`' job and is not this module's to decide.
 */
export const IdbTargetSchema = z.object({
	udid: z.string().min(1),
	/** `Simulator` for everything on this bench; see the header note above. */
	type: z.string().min(1),
	/** Operator-chosen, and the same field under the same name as `simctl`'s `name`. */
	name: z.string().min(1),
	/** The device type, which `name` starts out as and stops being the moment anyone renames it. */
	model: z.string().min(1),
	/** `iOS 26.5` — platform word included. */
	os_version: z.string().min(1),
	/** `Booted`, `Booting`, `Shutting Down`, `Shutdown`, … — see the header note above. */
	state: z.string().min(1),
});
export type IdbTarget = z.infer<typeof IdbTargetSchema>;

/** One frame: the full current set of targets. */
export const IdbTargetListSchema = z.array(IdbTargetSchema);
export type IdbTargetList = z.infer<typeof IdbTargetListSchema>;

/**
 * Accumulates chunks and yields whole frames.
 *
 * One instance per run of the companion: it holds the partial frame between chunks, and a
 * restarted companion begins its output again from the first byte.
 */
export class IdbNotifyFrameDecoder {
	private buffered: Buffer = Buffer.alloc(0);
	private failure: IdbNotifyFramingError | undefined;

	/**
	 * Every frame completed by this chunk, in order; the trailing partial is kept for the next
	 * call.
	 *
	 * Throws {@link IdbNotifyFramingError} on a frame that is not the JSON array of targets every
	 * frame is, and stays failed afterwards.
	 */
	push(chunk: Buffer): IdbTargetList[] {
		if (this.failure) throw this.failure;

		this.buffered = Buffer.concat([this.buffered, chunk]);
		const frames: IdbTargetList[] = [];

		for (;;) {
			const end = this.buffered.indexOf(FRAME_DELIMITER);
			if (end === -1) break;

			const frame = this.buffered.subarray(0, end).toString('utf8');
			this.buffered = this.buffered.subarray(end + 1);
			frames.push(this.decode(frame));
		}

		return frames;
	}

	private decode(frame: string): IdbTargetList {
		try {
			return IdbTargetListSchema.parse(JSON.parse(frame));
		} catch (error) {
			// Everything after a frame this module could not read is refused, including whatever is
			// already buffered: see the class comment on the error.
			this.buffered = Buffer.alloc(0);
			this.failure = new IdbNotifyFramingError(frame, error);
			throw this.failure;
		}
	}
}

function truncate(frame: string): string {
	return frame.length <= FRAME_EXCERPT_LENGTH ? frame : `${frame.slice(0, FRAME_EXCERPT_LENGTH)}…`;
}
