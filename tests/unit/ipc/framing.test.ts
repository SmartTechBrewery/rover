import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, FrameTooLargeError, MAX_FRAME_BYTES } from '@/ipc/framing.js';

/** Runs `act` exactly once and hands back the {@link FrameTooLargeError} it must throw. */
function throwFrom(act: () => unknown): FrameTooLargeError {
	try {
		act();
	} catch (error) {
		expect(error).toBeInstanceOf(FrameTooLargeError);
		return error as FrameTooLargeError;
	}
	throw new Error('expected the push to throw FrameTooLargeError');
}

describe('encodeFrame', () => {
	it('appends exactly one newline', () => {
		expect(encodeFrame({ a: 1 })).toBe('{"a":1}\n');
	});

	/**
	 * The invariant NDJSON rests on: a newline inside a string is escaped by
	 * `JSON.stringify`, so an encoded frame never contains a raw one and splitting on a
	 * newline can only ever split between frames.
	 */
	it('escapes a newline inside a string, so it cannot split a frame', () => {
		const encoded = encodeFrame({ text: 'first\nsecond' });

		expect(encoded.indexOf('\n')).toBe(encoded.length - 1);
		expect(new FrameDecoder().push(encoded).map((frame) => JSON.parse(frame))).toEqual([
			{ text: 'first\nsecond' },
		]);
	});
});

describe('FrameDecoder', () => {
	it('reassembles one frame split across three chunks', () => {
		const decoder = new FrameDecoder();

		expect(decoder.push('{"a"')).toEqual([]);
		expect(decoder.push(':1')).toEqual([]);
		expect(decoder.push('}\n')).toEqual(['{"a":1}']);
	});

	it('yields two frames from one chunk, in order', () => {
		expect(new FrameDecoder().push('{"a":1}\n{"a":2}\n')).toEqual(['{"a":1}', '{"a":2}']);
	});

	it('keeps a trailing partial for the next chunk', () => {
		const decoder = new FrameDecoder();

		expect(decoder.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
		expect(decoder.push(':2}\n')).toEqual(['{"b":2}']);
	});

	it('accepts a Buffer chunk split mid-character', () => {
		const bytes = Buffer.from(encodeFrame({ text: '☃' }), 'utf8');
		const decoder = new FrameDecoder();
		const split = 10; // lands inside the three-byte snowman

		const first = decoder.push(bytes.subarray(0, split));
		const second = decoder.push(bytes.subarray(split));

		expect([...first, ...second].map((frame) => JSON.parse(frame))).toEqual([{ text: '☃' }]);
	});

	it('skips a blank line rather than reporting an empty frame', () => {
		expect(new FrameDecoder().push('\n\n{"a":1}\n')).toEqual(['{"a":1}']);
	});

	it('throws once a completed frame exceeds the cap', () => {
		const decoder = new FrameDecoder(16);

		expect(() => decoder.push(`${'x'.repeat(20)}\n`)).toThrow(FrameTooLargeError);
	});

	it('throws while a partial frame is still growing, before it is ever completed', () => {
		const decoder = new FrameDecoder(16);

		// The reason the cap exists: a peer that opens a frame and never closes it must not
		// be able to grow the host's buffer without bound.
		expect(() => decoder.push('y'.repeat(20))).toThrow(FrameTooLargeError);
	});

	/**
	 * The cap has to be a *bound*, not a report. A caller that swallows the throw and keeps
	 * reading — which is exactly what a stream's `data` listener does — must not be able to
	 * grow the decoder by the full input while every push dutifully throws.
	 */
	it('does not keep buffering once the cap is exceeded', () => {
		const decoder = new FrameDecoder(16);

		const first = throwFrom(() => decoder.push('y'.repeat(20)));
		const second = throwFrom(() => decoder.push('y'.repeat(20)));

		// 40 here would mean the second chunk was appended to the first before being measured.
		expect(first.observedBytes).toBe(20);
		expect(second.observedBytes).toBe(20);
	});

	it('stays failed, so a later well-formed frame is refused rather than decoded', () => {
		const decoder = new FrameDecoder(16);

		// The oversized frame was *completed*, so resuming here would look reasonable — but a
		// stream that already ran past the cap gives no evidence that this newline is a frame
		// boundary rather than one inside whatever the peer was really sending.
		expect(() => decoder.push(`${'y'.repeat(20)}\n`)).toThrow(FrameTooLargeError);
		expect(() => decoder.push('{"a":1}\n')).toThrow(FrameTooLargeError);
	});

	it('accepts a chunk of many small frames whose total exceeds the cap', () => {
		// The cap bounds one frame, not one chunk: a batch of legitimate frames arriving
		// together must not be mistaken for an unterminated one.
		const decoder = new FrameDecoder(16);

		expect(decoder.push('{"a":1}\n{"a":2}\n{"a":3}\n')).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
	});

	it('defaults to a cap far above any legitimate frame', () => {
		expect(MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
	});
});
