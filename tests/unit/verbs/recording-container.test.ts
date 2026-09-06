import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readRecordingContainer } from '@/verbs/recording-container.js';

/**
 * What a recording contains, read off the container — the field #183 added to `record_video`'s
 * answer so a capture of a screen that never moved stops reading as a broken tool.
 *
 * **The headline case is a real device's bytes.** The committed finished-recording fixture is
 * itself a capture of an idle screen: an `mvhd` declaring duration 0 at timescale 10000 and a
 * single `vide` track whose `stsz` declares one sample — which is exactly the `nb_frames=1` /
 * `duration=0.000000` an agent found with `ffprobe` and filed as a defect. So the still-screen
 * branch is asserted against the file rather than against a mock of it.
 *
 * Everything else is hand-built, which is the split `./../backends/android/parsers/
 * screenrecord.test.ts` already argues for: the subject is the container grammar rather than
 * what a device prints, and a truncated box or a zero-length one is not something a recorder
 * produces on purpose.
 */
const FINISHED = new Uint8Array(
	readFileSync(
		new URL(
			'../../fixtures/adb/screenrecord.finished.api37-sdk-gphone16k-arm64.mp4',
			import.meta.url,
		),
	),
);

const uint32 = (value: number): number[] => [
	(value >>> 24) & 0xff,
	(value >>> 16) & 0xff,
	(value >>> 8) & 0xff,
	value & 0xff,
];

const chars = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/** One box: its own length, its four type characters, then whatever body it was given. */
const box = (type: string, body: number[] = []): number[] => [
	...uint32(8 + body.length),
	...chars(type),
	...body,
];

/** An `mvhd` version 0 — a 32-bit creation, modification, timescale and duration. */
const mvhd = (timescale: number, duration: number): number[] =>
	box('mvhd', [
		...uint32(0),
		...uint32(0),
		...uint32(0),
		...uint32(timescale),
		...uint32(duration),
	]);

/** An `mvhd` version 1 — 64-bit times and a 64-bit duration around the same timescale. */
const mvhdV1 = (timescale: number, duration: number): number[] =>
	box('mvhd', [
		0x01,
		0,
		0,
		0,
		...uint32(0),
		...uint32(0),
		...uint32(0),
		...uint32(0),
		...uint32(timescale),
		...uint32(0),
		...uint32(duration),
	]);

/** One track of `handler` type whose sample table declares `sampleCount` samples. */
const trak = (handler: string, sampleCount: number): number[] =>
	box(
		'trak',
		box('mdia', [
			...box('hdlr', [...uint32(0), ...uint32(0), ...chars(handler)]),
			...box(
				'minf',
				box('stbl', box('stsz', [...uint32(0), ...uint32(0), ...uint32(sampleCount)])),
			),
		]),
	);

/** A whole file: the container header, then whatever `moov` these boxes make. */
const recording = (...inMoov: number[][]): Uint8Array =>
	Uint8Array.from([...box('ftyp'), ...box('moov', inMoov.flat())]);

describe('a recording of a screen that changed', () => {
	it('reports the sample count and the duration the container declares', () => {
		// Timescale 10 000 and duration 51 570 is the 5.157 s / 306 frames measured on a device
		// with motion on screen (#183): the two numbers are read off the file, and neither of
		// them is the duration the caller asked for.
		const container = readRecordingContainer(recording(mvhd(10_000, 51_570), trak('vide', 306)));

		expect(container).toEqual({ kind: 'samples', sampleCount: 306, durationMs: 5_157 });
	});

	it('reads a version 1 movie header, which puts both numbers somewhere else', () => {
		const container = readRecordingContainer(recording(mvhdV1(1_000, 4_926), trak('vide', 292)));

		expect(container).toEqual({ kind: 'samples', sampleCount: 292, durationMs: 4_926 });
	});

	/**
	 * The fixture carries one `vide` track and two `meta` ones, so a walk that took the first
	 * `trak` would be right there by luck. Here the metadata track comes first and declares a
	 * different count, so picking by position gives a different — and wrong — answer.
	 */
	it('counts the video track rather than whichever track came first', () => {
		const container = readRecordingContainer(
			recording(mvhd(1_000, 3_000), trak('meta', 7), trak('vide', 42)),
		);

		expect(container).toMatchObject({ sampleCount: 42 });
	});

	/**
	 * A recording under half a millisecond long is still a recording of something. The
	 * still-screen branch is decided on the **declared** duration being exactly zero, so
	 * rounding can never move a capture into a case it is not.
	 */
	it('does not round a very short recording into the still-screen case', () => {
		const container = readRecordingContainer(recording(mvhd(10_000, 1), trak('vide', 1)));

		expect(container).toEqual({ kind: 'samples', sampleCount: 1, durationMs: 0 });
	});
});

describe('a recording of a screen that did not change', () => {
	it('is what the committed capture of an idle screen actually is', () => {
		const container = readRecordingContainer(FINISHED);

		expect(container).toMatchObject({ kind: 'still-screen', sampleCount: 1, durationMs: 0 });
	});

	/**
	 * The AC of #183, and the whole point of the field: an agent that reads this before it
	 * reaches for `ffprobe` is told the screen did not change, that the virtual display works
	 * that way, and that this is not a fault.
	 */
	it('says in words why one sample of no duration is a true answer about the device', () => {
		const container = readRecordingContainer(FINISHED);

		if (container.kind !== 'still-screen')
			throw new Error('the idle capture read as something else');
		expect(container.message).toMatch(/nothing on the screen changed/i);
		expect(container.message).toMatch(/virtual display/i);
		expect(container.message).toMatch(/rather than a fault/i);
	});

	it('is the same shape when it is built rather than recorded', () => {
		const container = readRecordingContainer(recording(mvhd(10_000, 0), trak('vide', 1)));

		expect(container).toMatchObject({ kind: 'still-screen', sampleCount: 1, durationMs: 0 });
	});
});

/**
 * A container this walk cannot read is `unreadable` rather than a throw or a zero: a backend
 * "promises video bytes without saying in which container", so throwing would turn a legitimate
 * recording into the refusal #183 rules out, and `sampleCount: 0` would be the plausible-looking
 * empty result ai/RULES.md §2 forbids. Every case below says what was missing.
 */
describe('a recording whose container says nothing usable', () => {
	it.each([
		['no moov at all', Uint8Array.from([...box('ftyp'), ...box('free')]), /no 'moov' box/],
		['no movie header', recording(trak('vide', 3)), /carries no 'mvhd'/],
		['no video track', recording(mvhd(1_000, 3_000), trak('meta', 3)), /no 'vide' track/],
		[
			'a video track with no sample table',
			Uint8Array.from([
				...box('ftyp'),
				...box('moov', [
					...mvhd(1_000, 3_000),
					...box('trak', box('mdia', box('hdlr', [...uint32(0), ...uint32(0), ...chars('vide')]))),
				]),
			]),
			/no readable 'stsz'/,
		],
		['a timescale of zero', recording(mvhd(0, 3_000), trak('vide', 3)), /timescale of zero/],
		[
			'a duration the format calls unknown',
			recording(mvhd(1_000, 0xffff_ffff), trak('vide', 3)),
			/"unknown"/,
		],
		[
			'a track declaring no samples',
			recording(mvhd(1_000, 3_000), trak('vide', 0)),
			/no encoded samples/,
		],
		['nothing at all', new Uint8Array(0), /no 'moov' box/],
		// An 8-byte `mvhd` at the very end of the file is the one box whose body starts one past
		// the last byte. It reached the version read before this walk checked it had a body, and
		// a `DataView` throws there — which is the one thing this module promises never to do.
		[
			'an mvhd with no body as the last box in the file',
			Uint8Array.from([...box('ftyp'), ...box('moov', box('mvhd'))]),
			/'mvhd' box has no body/,
		],
		// The same box arrived at the other way: `size === 0` is the format's "to the end of this
		// container", so eight trailing bytes are a header and nothing else.
		[
			'an mvhd declaring a length of zero as the last box in the file',
			Uint8Array.from([...box('ftyp'), ...box('moov', [...uint32(0), ...chars('mvhd')])]),
			/'mvhd' box has no body/,
		],
	])('names what was missing when there is %s', (_case, bytes, expected) => {
		const container = readRecordingContainer(bytes);

		expect(container.kind).toBe('unreadable');
		if (container.kind !== 'unreadable') throw new Error('unreachable');
		expect(container.message).toMatch(expected);
	});

	/**
	 * Both are bounded exits rather than loops, in `isFinishedRecording`'s discipline. A
	 * zero-length box is the one that would spin: the walk must treat it as "to the end of this
	 * container" and stop, not advance by nothing forever.
	 */
	it('stops on a truncated box rather than reading past the end', () => {
		const truncated = recording(mvhd(1_000, 3_000), trak('vide', 3)).slice(0, 40);

		expect(readRecordingContainer(truncated).kind).toBe('unreadable');
	});

	it('terminates on a box that declares a length of zero', () => {
		const zeroLength = Uint8Array.from([...uint32(0), ...chars('ftyp'), 0, 0, 0, 0]);

		expect(readRecordingContainer(zeroLength).kind).toBe('unreadable');
	});

	/**
	 * The message says what could not be read and stops there. Both halves are read before
	 * either is reported, so a file whose `mvhd` is unusable does not have its perfectly
	 * readable `stsz` written off with it — an answer saying more than it checked is the fault
	 * #183 is about, pointed the other way.
	 */
	it('says only the duration is unknown when the sample table was readable', () => {
		const container = readRecordingContainer(recording(mvhd(0, 3_000), trak('vide', 3)));

		if (container.kind !== 'unreadable') throw new Error('unreachable');
		expect(container.message).toMatch(/what is unknown is what duration it declares/);
		expect(container.message).not.toMatch(/how many encoded samples/);
	});

	it('says only the sample count is unknown when the movie header was readable', () => {
		const container = readRecordingContainer(recording(mvhd(1_000, 3_000), trak('vide', 0)));

		if (container.kind !== 'unreadable') throw new Error('unreachable');
		expect(container.message).toMatch(/what is unknown is how many encoded samples it holds,/);
		expect(container.message).not.toMatch(/what duration it declares/);
	});

	it('names both, and both reasons, when neither half could be read', () => {
		const container = readRecordingContainer(recording(mvhd(0, 3_000), trak('vide', 0)));

		if (container.kind !== 'unreadable') throw new Error('unreachable');
		expect(container.message).toMatch(/no encoded samples at all; and .*timescale of zero/);
		expect(container.message).toMatch(
			/what is unknown is how many encoded samples it holds and what duration it declares/,
		);
	});

	/**
	 * The bytes may be a perfectly good recording this host simply could not parse, so the
	 * message says so rather than implying the file is broken — the video is in the answer
	 * either way.
	 */
	it('does not claim the recording itself is damaged', () => {
		const container = readRecordingContainer(Uint8Array.from(box('ftyp')));

		if (container.kind !== 'unreadable') throw new Error('unreachable');
		expect(container.message).toMatch(/may play perfectly/i);
	});
});
