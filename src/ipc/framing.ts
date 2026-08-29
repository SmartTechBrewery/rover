/**
 * Newline-delimited JSON framing.
 *
 * A stream delivers bytes, not messages, so something has to say where one message ends.
 * NDJSON is that something, and it is safe here for a specific reason: `JSON.stringify`
 * escapes a newline inside a string as `\n` (two characters), so an encoded frame can
 * never contain a raw newline — splitting on one can only ever split between frames.
 *
 * The decoder is transport-independent by construction: it consumes chunks and knows
 * nothing about where they came from.
 */

import { StringDecoder } from 'node:string_decoder';

/**
 * Cap on a single frame. An unbounded buffer fed by a peer you do not control is a
 * defect, not a hypothetical — R22 puts this same decoder on a network socket, where a
 * peer that opens a frame and never closes it would otherwise grow the host's heap until
 * it dies. 8 MiB is far above any legitimate frame (an artifact travels as its own
 * payload, and the largest is a screenshot).
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Thrown by {@link FrameDecoder.push} when a frame exceeds {@link MAX_FRAME_BYTES}. */
export class FrameTooLargeError extends Error {
	readonly maxBytes: number;
	readonly observedBytes: number;

	constructor(observedBytes: number, maxBytes: number) {
		super(`IPC frame of ${observedBytes} bytes exceeds the ${maxBytes}-byte limit`);
		this.name = 'FrameTooLargeError';
		this.maxBytes = maxBytes;
		this.observedBytes = observedBytes;
	}
}

/** Serialise one value as a frame, newline included. */
export function encodeFrame(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Accumulates chunks and yields whole frames. One instance per connection — it holds the
 * partial frame between chunks, so sharing one across connections would splice two peers'
 * bytes together.
 */
export class FrameDecoder {
	private buffered = '';
	private readonly maxBytes: number;
	/**
	 * A chunk boundary can fall in the middle of a multi-byte character, and
	 * `Buffer.toString()` would turn that half into a replacement character before the
	 * rest arrives. `StringDecoder` holds the incomplete sequence back instead.
	 */
	private readonly utf8 = new StringDecoder('utf8');

	constructor(maxBytes: number = MAX_FRAME_BYTES) {
		this.maxBytes = maxBytes;
	}

	/**
	 * Returns every frame completed by this chunk, in order, and keeps the trailing
	 * partial for the next call. Blank frames are skipped: a bare newline carries no
	 * message, and rejecting one would make a keepalive newline a protocol violation.
	 *
	 * Throws {@link FrameTooLargeError} for a frame over the cap — completed or still
	 * accumulating. The caller answers with `malformed_frame` and closes the connection;
	 * there is no way to resynchronise on a stream whose framing is already unbounded.
	 */
	push(chunk: string | Buffer): string[] {
		this.buffered += typeof chunk === 'string' ? chunk : this.utf8.write(chunk);

		const parts = this.buffered.split('\n');
		this.buffered = parts.pop() ?? '';
		this.requireWithinLimit(this.buffered);

		const frames: string[] = [];
		for (const part of parts) {
			this.requireWithinLimit(part);
			if (part.trim().length > 0) {
				frames.push(part);
			}
		}
		return frames;
	}

	private requireWithinLimit(frame: string): void {
		const bytes = Buffer.byteLength(frame, 'utf8');
		if (bytes > this.maxBytes) {
			throw new FrameTooLargeError(bytes, this.maxBytes);
		}
	}
}
