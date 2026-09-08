import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	IdbNotifyFrameDecoder,
	IdbNotifyFramingError,
	IdbTargetListSchema,
	IdbTargetSchema,
} from '@/backends/ios-simulator/parsers/idb-notify.js';

/**
 * The decoder and the vendor schema against the **bytes** of a real `idb_companion --notify
 * stdout` run — companion v1.5.2 on Xcode 26.6 / iOS 26.5, with one simulator booted and shut
 * down again while it streamed (`tests/fixtures/ios-simulator/README.md`).
 *
 * Read as a Buffer, never as a string: what a decoder exists to get right is a byte boundary, and
 * a fixture decoded before it reaches the decoder would prove the one thing it cannot do.
 *
 * Nothing here spawns anything, so the suite runs on a machine with no idb, no Xcode and no
 * macOS.
 */
const CAPTURE = readFileSync(
	new URL(
		'../../../../fixtures/ios-simulator/idb-notify.idbcompanion1.5.2-xcode26.6-ios26.5.txt',
		import.meta.url,
	),
);

/** Every frame of the capture, from one push of the whole thing. */
const FRAMES = new IdbNotifyFrameDecoder().push(CAPTURE);

/** The udid of the simulator that was booted and shut down during the capture. */
const TRANSITIONING = 'D85C3449-4D0C-4E93-B8EC-77FD0E5A8F3F';

/** The capture, split into chunks of `size` bytes, fed in order. */
function decodeInChunks(size: number): unknown[] {
	const decoder = new IdbNotifyFrameDecoder();
	const frames: unknown[] = [];
	for (let at = 0; at < CAPTURE.length; at += size) {
		frames.push(...decoder.push(CAPTURE.subarray(at, at + size)));
	}
	return frames;
}

/** What one target's `state` was in each frame, in order. */
function statesOf(udid: string): string[] {
	return FRAMES.map((frame) => frame.find((target) => target.udid === udid)?.state ?? 'absent');
}

describe('IdbNotifyFrameDecoder', () => {
	/**
	 * Five frames: the set as it stood, then the four transitions one `simctl boot` and one
	 * `simctl shutdown` produced. Each is the **full** set of eleven targets, not a delta, which
	 * is `DeviceWatcher.onDevices`' contract to the letter.
	 */
	it('decodes the captured run into one frame per change, each the full set', () => {
		expect(FRAMES).toHaveLength(5);
		for (const frame of FRAMES) {
			expect(frame).toHaveLength(11);
		}
	});

	it('reports the transitions the booted-and-shut-down simulator went through', () => {
		expect(statesOf(TRANSITIONING)).toEqual([
			'Shutdown',
			'Booting',
			'Booted',
			'Shutting Down',
			'Shutdown',
		]);
	});

	/**
	 * The chunk sizes the capture arrived in were `1784, 1, 1784, 1783, 1789, 1, 1785` — a frame
	 * and its terminating newline delivered as two reads, twice in five frames. So the boundary a
	 * chunk falls on is not the boundary a frame ends on, and every size below has to agree.
	 * Byte 1 in particular reproduces the bare-newline read that a `split('\n')` per chunk would
	 * have choked on.
	 */
	it.each([
		1,
		7,
		64,
		1783,
		1784,
		1785,
		4096,
		CAPTURE.length,
	])('decodes identically when the same bytes arrive in %i-byte chunks', (size) => {
		expect(decodeInChunks(size)).toEqual(FRAMES);
	});

	/** The trailing partial is held, not emitted: a half-read frame is not a device set. */
	it('keeps a partial trailing frame rather than emitting it', () => {
		const decoder = new IdbNotifyFrameDecoder();
		const firstEnd = CAPTURE.indexOf(0x0a);

		expect(decoder.push(CAPTURE.subarray(0, firstEnd))).toEqual([]);
		expect(decoder.push(CAPTURE.subarray(firstEnd, firstEnd + 1))).toEqual([FRAMES[0]]);
	});

	/**
	 * A frame that cannot be read is terminal for that run of the companion: framing that has lost
	 * sync cannot be resynchronised, and a device set assembled from a guess is worse than none.
	 */
	it('refuses a frame that is not the JSON array of targets, and stays failed', () => {
		const decoder = new IdbNotifyFrameDecoder();

		expect(() => decoder.push(Buffer.from('Notifying stdout\n'))).toThrow(IdbNotifyFramingError);
		expect(() => decoder.push(CAPTURE)).toThrow(IdbNotifyFramingError);
	});

	/** A JSON array whose entries are not targets is the same failure, not a quietly empty set. */
	it('refuses a frame of valid JSON that is not a target list', () => {
		const decoder = new IdbNotifyFrameDecoder();

		expect(() => decoder.push(Buffer.from('[{"udid":"a-udid"}]\n'))).toThrow(IdbNotifyFramingError);
	});

	/** The excerpt is what makes the failure recognisable without turning it into a log dump. */
	it('carries an excerpt of the frame it could not read', () => {
		const decoder = new IdbNotifyFrameDecoder();

		expect(() => decoder.push(Buffer.from('Notifying stdout\n'))).toThrow(/Notifying stdout/);
	});
});

describe('the vendor target schema', () => {
	/** The six keys the capture carries, read off the capture rather than off a table here. */
	it('accepts every target of the capture', () => {
		for (const frame of FRAMES) {
			expect(IdbTargetListSchema.parse(frame)).toEqual(frame);
		}
		expect(Object.keys(FRAMES[0]?.[0] ?? {}).sort()).toEqual([
			'model',
			'name',
			'os_version',
			'state',
			'type',
			'udid',
		]);
	});

	/**
	 * Non-`.strict()` on purpose: the key set is Meta's and a release adds fields, so strictness
	 * would turn an idb upgrade into a load-time failure in a module that reads five keys.
	 */
	it('tolerates a key this repository has never seen', () => {
		const target = { ...FRAMES[0]?.[0], architecture: 'arm64' };

		expect(IdbTargetSchema.parse(target)).toMatchObject({ udid: FRAMES[0]?.[0]?.udid });
	});

	/** A missing key that *is* read is refused, and the complaint names the key. */
	it('refuses a target missing a key the mapping reads, by that key’s own name', () => {
		const { os_version: _dropped, ...withoutVersion } = FRAMES[0]?.[0] ?? {};

		const result = IdbTargetSchema.safeParse(withoutVersion);

		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(['os_version']);
	});

	/**
	 * `state` and `type` are open strings, not enums, for the reason the module's header gives:
	 * the token list is longer than any capture pins, and this bench had no physical target
	 * paired at all — a schema that made `type` an enum would refuse the one frame the exclusion
	 * rule in `../devices.ts` exists for.
	 */
	it('accepts a state and a type no capture on this bench carries', () => {
		const target = {
			...FRAMES[0]?.[0],
			state: 'Creating',
			type: 'device',
		};

		expect(IdbTargetSchema.parse(target)).toMatchObject({ state: 'Creating', type: 'device' });
	});

	/**
	 * The spelling that makes the mapping's normalisation necessary: idb puts the platform word in
	 * front of the version where `simctl`'s runtime reports it bare.
	 */
	it('reports os_version with the platform word idb prefixes it with', () => {
		for (const target of FRAMES[0] ?? []) {
			expect(target.os_version).toMatch(/^iOS \d/);
		}
	});
});
