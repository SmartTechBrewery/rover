import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	isFinishedRecording,
	isRecorderRunning,
	recorderPids,
} from '@/backends/android/parsers/screenrecord.js';

/**
 * The two predicates behind `record_video`, on their own.
 *
 * `pidof`'s output is pinned against the capture, the way every text parser here is. The
 * box walk is the one place a **hand-built** input is the right fixture rather than the
 * forbidden one: the subject is the container grammar, not what a device prints, and the
 * cases that matter — a truncated header, a zero-length box — are ones no device produces
 * on purpose. The two real recordings are here as well, and they are what the whole verb
 * rests on: one finished, one pulled mid-write, byte for byte off an API 37 emulator.
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const bytes = (name: string): Uint8Array =>
	new Uint8Array(readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url)));

const PIDOF_RUNNING = fixture('screenrecord-pidof.running.api37-sdk-gphone16k-arm64.txt');
const FINISHED = bytes('screenrecord.finished.api37-sdk-gphone16k-arm64.mp4');
const UNFINISHED = bytes('screenrecord.unfinished.api37-sdk-gphone16k-arm64.mp4');

/** One top-level box: a 32-bit length, four type characters, then `body` filler bytes. */
function box(type: string, body = 0): number[] {
	const size = 8 + body;
	return [
		(size >> 24) & 0xff,
		(size >> 16) & 0xff,
		(size >> 8) & 0xff,
		size & 0xff,
		...[...type].map((character) => character.charCodeAt(0)),
		...new Array(body).fill(0),
	];
}

const file = (...boxes: number[][]): Uint8Array => Uint8Array.from(boxes.flat());

describe('isRecorderRunning', () => {
	// The capture: one bare pid and a newline, on stdout, while a recording is in flight.
	it('sees a recorder in the captured pidof output', () => {
		expect(isRecorderRunning(PIDOF_RUNNING)).toBe(true);
	});

	/**
	 * `pidof screenrecord` prints **nothing** once the recorder has exited, and exits 1 —
	 * which is why the backend runs it with a `|| true` and why this predicate reads the
	 * output rather than the status. Empty is the answer the wait is looking for.
	 */
	it('sees no recorder in an empty answer', () => {
		expect(isRecorderRunning('')).toBe(false);
		expect(isRecorderRunning('\n')).toBe(false);
		expect(isRecorderRunning('  \r\n')).toBe(false);
	});

	it('sees a recorder when several pids come back', () => {
		expect(isRecorderRunning('29633 29640\n')).toBe(true);
	});
});

describe('recorderPids', () => {
	it('names the pid the capture reported, for a timeout that has to say what it found', () => {
		expect(recorderPids(PIDOF_RUNNING)).toEqual(['29633']);
	});

	it('splits the several pids pidof separates with spaces', () => {
		expect(recorderPids('29633 29640\n')).toEqual(['29633', '29640']);
	});

	it('names nothing when nothing is running', () => {
		expect(recorderPids('')).toEqual([]);
	});
});

describe('isFinishedRecording', () => {
	/**
	 * **The headline criterion of this whole verb, twice over**, and both inputs came off a
	 * real device rather than out of this file: the finished recording is `ftyp`, `moov`,
	 * `free`, `mdat`; the one pulled while `screenrecord` was still running is `ftyp`, `free`
	 * — the reserved gap the index will go into — and an `mdat` claiming a 64-bit length of
	 * 4557430888798830399 over 3232 bytes. Nothing but the `moov` separates them: both start
	 * with a well-formed header, both are plausible file sizes, and the device exited 0 for
	 * each.
	 */
	it('accepts the recording captured after screenrecord exited', () => {
		expect(isFinishedRecording(FINISHED)).toBe(true);
	});

	it('rejects the recording captured while screenrecord was still writing', () => {
		expect(isFinishedRecording(UNFINISHED)).toBe(false);
	});

	it('accepts a header, a payload and an index, in that order', () => {
		expect(isFinishedRecording(file(box('ftyp', 16), box('mdat', 64), box('moov', 32)))).toBe(true);
	});

	// The index written before the payload, which is the order the captured recording has.
	it('accepts an index that comes before the payload', () => {
		expect(isFinishedRecording(file(box('ftyp', 16), box('moov', 32), box('mdat', 64)))).toBe(true);
	});

	it('rejects a header and a payload with no index after them', () => {
		expect(isFinishedRecording(file(box('ftyp', 16), box('mdat', 64)))).toBe(false);
	});

	it('rejects bytes that do not start with the container header', () => {
		expect(isFinishedRecording(file(box('mdat', 64), box('moov', 32)))).toBe(false);
	});

	it('rejects a PNG, which is what the other capture verb on this device answers with', () => {
		expect(
			isFinishedRecording(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
		).toBe(false);
	});

	it('rejects an empty pull, which is what a file that was never written looks like', () => {
		expect(isFinishedRecording(new Uint8Array())).toBe(false);
	});

	it('rejects a header cut off part-way through', () => {
		expect(isFinishedRecording(Uint8Array.from([0, 0, 0, 24, 0x66, 0x74]))).toBe(false);
	});

	/**
	 * `size === 0` means "to the end of the file" in the format, so nothing follows it. The
	 * assertion that matters is that this **returns** rather than advancing by zero forever;
	 * a walk over attacker- or accident-shaped bytes that can loop is a host that hangs.
	 */
	it('stops on a zero-length box instead of walking it forever', () => {
		const zeroLength = Uint8Array.from([...box('ftyp', 8), 0, 0, 0, 0, 0x6d, 0x64, 0x61, 0x74]);

		expect(isFinishedRecording(zeroLength)).toBe(false);
	});

	it('stops on a length that runs past the bytes there are', () => {
		expect(isFinishedRecording(Uint8Array.from([0, 0, 0x40, 0x00, 0x66, 0x74, 0x79, 0x70]))).toBe(
			false,
		);
	});

	// The extended form the captured recordings both use for `mdat`: `size === 1`, then a
	// 64-bit length. The unfinished one's is garbage, so the two cases are both real.
	it('walks a 64-bit extended length to the index behind it', () => {
		const extended = Uint8Array.from([
			...box('ftyp', 16),
			0,
			0,
			0,
			1,
			0x6d,
			0x64,
			0x61,
			0x74,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			24,
			...new Array(8).fill(0),
			...box('moov', 32),
		]);

		expect(isFinishedRecording(extended)).toBe(true);
	});

	it('stops on a 64-bit length larger than the file, rather than trusting it', () => {
		const garbage = Uint8Array.from([
			...box('ftyp', 16),
			0,
			0,
			0,
			1,
			0x6d,
			0x64,
			0x61,
			0x74,
			0x3f,
			0x3f,
			0x3f,
			0x3f,
			0x3f,
			0x3f,
			0x3f,
			0x3f,
			...box('moov', 32),
		]);

		expect(isFinishedRecording(garbage)).toBe(false);
	});

	// A `Uint8Array` that is a window onto a larger buffer — which is what slicing a pulled
	// `Buffer` produces — must be read at its own offset, not at the underlying buffer's.
	it('reads a view onto a larger buffer at its own offset', () => {
		const finished = file(box('ftyp', 16), box('moov', 32));
		const padded = new Uint8Array(finished.byteLength + 8);
		padded.set(finished, 8);

		expect(isFinishedRecording(padded.subarray(8))).toBe(true);
	});
});
