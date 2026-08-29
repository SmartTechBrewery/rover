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
	/**
	 * Terminal once set. A stream whose framing has already run past the cap cannot be
	 * resynchronised — there is no way to tell where the next frame was meant to begin — so
	 * the decoder drops what it held and refuses every later chunk instead of quietly
	 * accumulating one the caller will never be able to use.
	 */
	private failure: FrameTooLargeError | undefined;
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
	 * accumulating — and stays failed afterwards. The caller answers with
	 * `malformed_frame` and destroys the connection.
	 *
	 * The cap is checked **before** the buffer grows, never after. Measuring a partial the
	 * decoder has already concatenated would make the cap a report rather than a bound: a
	 * peer that keeps writing past a throw the caller swallowed would still be growing the
	 * host's heap by the full input, which is the exact thing the cap exists to stop.
	 */
	push(chunk: string | Buffer): string[] {
		if (this.failure) {
			throw this.failure;
		}

		const incoming = typeof chunk === 'string' ? chunk : this.utf8.write(chunk);

		if (!incoming.includes('\n')) {
			// No frame can complete, so the whole chunk would extend the open one. Nothing is
			// retained unless it fits.
			this.requireWithinLimit(byteLength(this.buffered) + byteLength(incoming));
			this.buffered += incoming;
			return [];
		}

		// At least one frame closes here, so `buffered` is about to be consumed rather than
		// extended, and every remaining check is bounded by a chunk the caller already holds.
		const parts = (this.buffered + incoming).split('\n');
		const trailing = parts.pop() ?? '';

		const frames: string[] = [];
		for (const part of parts) {
			this.requireWithinLimit(byteLength(part));
			if (part.trim().length > 0) {
				frames.push(part);
			}
		}
		this.requireWithinLimit(byteLength(trailing));

		this.buffered = trailing;
		return frames;
	}

	private requireWithinLimit(bytes: number): void {
		if (bytes <= this.maxBytes) {
			return;
		}
		this.buffered = '';
		this.failure = new FrameTooLargeError(bytes, this.maxBytes);
		throw this.failure;
	}
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, 'utf8');
}
