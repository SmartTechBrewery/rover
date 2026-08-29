import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, FrameTooLargeError, MAX_FRAME_BYTES } from '@/ipc/framing.js';

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

	it('defaults to a cap far above any legitimate frame', () => {
		expect(MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
	});
});
