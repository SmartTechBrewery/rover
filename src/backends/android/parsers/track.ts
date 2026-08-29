/**
 * Decoder for the framing `adb track-devices` writes.
 *
 * Verified against `adb` 37.0.1-15733141 on 2026-08-29 (PROJECT.md §6): the tracker
 * writes **four lowercase hex digits giving the payload's byte length, then the payload**,
 * with nothing between one frame and the next frame's digits.
 *
 * ```
 * 0074emulator-5554          device product:… model:… device:… transport_id:1\n
 * ```
 *
 * `0x74` is 116, which is that line **including its trailing newline** — the length covers
 * every byte of the payload and the payload alone.
 *
 * Pure, like every parser here: it takes bytes a runner already captured and returns
 * payloads. The process, its argv and its end belong to `../adb.js` (R5).
 */

/** The width of the length prefix, in bytes. */
const PREFIX_BYTES = 4;

/** Exactly the prefix, and nothing that merely starts like one. */
const HEX_PREFIX = /^[0-9a-f]{4}$/i;

/**
 * A prefix that is not four hex digits.
 *
 * Its own error class, and terminal, for the reason `../../../ipc/framing.ts` gives for
 * its own: framing that has lost sync cannot be resynchronised — there is no way to tell
 * where the next frame was meant to begin — so the decoder refuses every later chunk
 * rather than emitting payloads sliced at guessed offsets. A device list assembled from a
 * guess is worse than none.
 */
export class TrackFramingError extends Error {
	constructor(prefix: string) {
		super(`adb track-devices: expected a 4-hex-digit length prefix, got '${prefix}'`);
		this.name = 'TrackFramingError';
	}
}

/**
 * Accumulates chunks and yields whole payloads.
 *
 * One instance per run of the tracker: it holds the partial frame between chunks, and a
 * restarted tracker begins its framing again from the first byte.
 *
 * Byte-based rather than string-based, deliberately. The prefix counts **bytes**, so a
 * decoder that worked on strings would mis-slice the first frame carrying a multi-byte
 * character (a device whose model name is not ASCII), and a chunk boundary can fall inside
 * one — the payload is only decoded once all of its bytes are present.
 *
 * There is no size cap here, unlike the IPC decoder, because the format already is one: a
 * four-digit prefix cannot describe more than 65535 bytes, so the buffer this holds is
 * bounded by construction at that plus the prefix.
 */
export class TrackFrameDecoder {
	private buffered: Buffer = Buffer.alloc(0);
	private failure: TrackFramingError | undefined;

	/**
	 * Every payload completed by this chunk, in order; the trailing partial is kept for the
	 * next call. A `0000` frame is a real, empty payload and is returned as one — the
	 * tracker's way of saying no devices are attached.
	 *
	 * Throws {@link TrackFramingError} on a prefix that is not four hex digits, and stays
	 * failed afterwards.
	 */
	push(chunk: Buffer): string[] {
		if (this.failure) throw this.failure;

		this.buffered = Buffer.concat([this.buffered, chunk]);
		const payloads: string[] = [];

		while (this.buffered.length >= PREFIX_BYTES) {
			// latin1 so the check reads the raw bytes: any byte maps to one character, so a
			// non-ASCII byte where a digit belongs is reported rather than decoded away.
			const prefix = this.buffered.subarray(0, PREFIX_BYTES).toString('latin1');
			if (!HEX_PREFIX.test(prefix)) {
				this.buffered = Buffer.alloc(0);
				this.failure = new TrackFramingError(prefix);
				throw this.failure;
			}

			const length = Number.parseInt(prefix, 16);
			const end = PREFIX_BYTES + length;
			if (this.buffered.length < end) break;

			payloads.push(this.buffered.subarray(PREFIX_BYTES, end).toString('utf8'));
			this.buffered = this.buffered.subarray(end);
		}

		return payloads;
	}
}
