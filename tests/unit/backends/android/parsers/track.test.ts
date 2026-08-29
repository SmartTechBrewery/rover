import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TrackFrameDecoder, TrackFramingError } from '@/backends/android/parsers/track.js';

/**
 * The decoder against the **bytes** of a real `adb track-devices -l` run
 * (tests/fixtures/adb/README.md). Read as a Buffer, never as a string: what this module
 * exists to get right is a byte count, and a fixture decoded before it reaches the
 * decoder would prove the one thing it cannot do.
 */
const CAPTURE = readFileSync(
	new URL(
		'../../../../fixtures/adb/track-devices-l.connect-disconnect.api37-sdk-gphone16k-arm64.txt',
		import.meta.url,
	),
);

/** Every payload of the capture, from one push of the whole thing. */
const PAYLOADS = new TrackFrameDecoder().push(CAPTURE);

/** The capture, split into chunks of `size` bytes, fed in order. */
function decodeInChunks(size: number): string[] {
	const decoder = new TrackFrameDecoder();
	const payloads: string[] = [];
	for (let at = 0; at < CAPTURE.length; at += size) {
		payloads.push(...decoder.push(CAPTURE.subarray(at, at + size)));
	}
	return payloads;
}

describe('TrackFrameDecoder', () => {
	it('decodes the captured run into one payload per frame', () => {
		// Seven changes: the first snapshot, four while the second entry negotiated, the one
		// where both are `device`, and the two closing it out.
		expect(PAYLOADS).toHaveLength(7);
		expect(PAYLOADS[0]).toBe(
			'emulator-5554          device product:sdk_gphone16k_arm64 model:sdk_gphone16k_arm64 device:emu64a16k transport_id:1\n',
		);
	});

	/**
	 * The length prefix counts the payload's bytes **including its trailing newline**: the
	 * first frame is announced as `0074` = 116, which is exactly the line plus its `\n`.
	 * Off by one here and every later frame is sliced at the wrong offset.
	 */
	it('reads the length as covering the payload and nothing else', () => {
		expect(CAPTURE.subarray(0, 4).toString()).toBe('0074');
		expect(Buffer.byteLength(PAYLOADS[0] as string)).toBe(0x74);
		expect(PAYLOADS[0]).toMatch(/\n$/);
	});

	// The whole point of the class: a chunk boundary is wherever the kernel put it.
	it.each([
		1, 3, 4, 5, 7, 116, 120, 512,
	])('yields the same payloads when the bytes arrive %d at a time', (size) => {
		expect(decodeInChunks(size)).toEqual(PAYLOADS);
	});

	it('keeps a trailing partial frame back until the rest of it arrives', () => {
		const decoder = new TrackFrameDecoder();
		const head = CAPTURE.subarray(0, 60);
		const rest = CAPTURE.subarray(60, 4 + 0x74);

		expect(decoder.push(head)).toEqual([]);
		expect(decoder.push(rest)).toEqual([PAYLOADS[0]]);
	});

	// Every change re-emits the whole list, so a snapshot naming two devices is what a
	// second entry looks like — the D18 case, captured rather than imagined.
	it('carries a whole device list per frame, never a delta', () => {
		const both = PAYLOADS.find((payload) => payload.includes('localhost:5555')) ?? '';

		expect(both.split('\n').filter(Boolean)).toHaveLength(2);
		expect(both).toContain('emulator-5554');
		expect(PAYLOADS.at(-1)).not.toContain('localhost:5555');
	});

	/**
	 * Inline, not captured: a second adb server on a spare port still discovers the running
	 * emulator, so no capture on the writing host had an empty list in it
	 * (tests/fixtures/adb/README.md, "shapes with no fixture yet"). The framing is the
	 * fixture's; only the emptiness is asserted from the format.
	 */
	it('decodes a zero-length frame as an empty payload rather than as nothing', () => {
		expect(new TrackFrameDecoder().push(Buffer.from('0000', 'utf8'))).toEqual(['']);
	});

	it('decodes a payload whose characters span a chunk boundary', () => {
		const payload = 'emulator-5554\tdevice model:Ünïcøde\n';
		const frame = Buffer.from(
			`${Buffer.byteLength(payload).toString(16).padStart(4, '0')}${payload}`,
			'utf8',
		);
		const decoder = new TrackFrameDecoder();

		// Split inside the two bytes of `Ü`, which a string-based decoder would corrupt.
		const split = frame.indexOf(0xc3) + 1;
		expect(decoder.push(frame.subarray(0, split))).toEqual([]);
		expect(decoder.push(frame.subarray(split))).toEqual([payload]);
	});

	it('refuses a prefix that is not four hex digits, quoting what arrived', () => {
		expect(() => new TrackFrameDecoder().push(Buffer.from('oops0000', 'utf8'))).toThrow(
			TrackFramingError,
		);
		expect(() => new TrackFrameDecoder().push(Buffer.from('oops0000', 'utf8'))).toThrow(/'oops'/);
	});

	// Terminal, like the IPC decoder's own cap failure: framing that lost sync cannot be
	// resynchronised, and payloads sliced at a guessed offset are worse than none.
	it('stays failed once the framing has been lost', () => {
		const decoder = new TrackFrameDecoder();

		expect(() => decoder.push(Buffer.from('nope', 'utf8'))).toThrow(TrackFramingError);
		expect(() => decoder.push(CAPTURE)).toThrow(TrackFramingError);
	});
});
