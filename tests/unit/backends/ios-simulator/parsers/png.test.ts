import { describe, expect, it } from 'vitest';
import { isPng, PNG_SIGNATURE } from '@/backends/ios-simulator/parsers/png.js';

/**
 * The capture predicate, which needs neither a process nor a simulator to be about anything —
 * the property this whole folder keeps (`../simctl.test.ts`).
 *
 * What it is guarding is `simctl io screenshot` exiting 0 having written something that is not
 * the image it was asked for, so every case here is a shape that could come back from the file
 * this backend staged: the real thing, an error the tool wrote there instead, a truncated write,
 * and nothing at all.
 */
const png = (...body: number[]): Uint8Array => Uint8Array.from([...PNG_SIGNATURE, ...body]);

describe('isPng', () => {
	it('accepts the signature the format starts with', () => {
		expect(isPng(png(0x00, 0x00, 0x00, 0x0d))).toBe(true);
	});

	// Nothing beyond the header is read: what the frame *shows* is the caller's to judge, and on
	// this platform an app cannot blank it anyway (`docs/IOS.md` §8, trap 8).
	it('accepts a capture whose contents say nothing', () => {
		expect(isPng(png(...new Array(64).fill(0x00)))).toBe(true);
	});

	it('rejects text the tool wrote where the image should have been', () => {
		expect(isPng(new TextEncoder().encode('An error was encountered processing the command'))).toBe(
			false,
		);
	});

	it('rejects a write that stopped inside the signature', () => {
		expect(isPng(PNG_SIGNATURE.subarray(0, 4))).toBe(false);
	});

	it('rejects a file with nothing in it', () => {
		expect(isPng(new Uint8Array())).toBe(false);
	});

	/**
	 * The one near miss worth pinning: a byte stream whose `0x0a` had been doubled is what the
	 * Android side's copy of this exists for, and it is refused here too — the signature carries
	 * `0d 0a 1a 0a` precisely so that a line-ending translation cannot pass unnoticed.
	 */
	it('rejects a signature whose line endings were translated', () => {
		expect(
			isPng(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0d, 0x0a, 0x1a, 0x0d, 0x0a])),
		).toBe(false);
	});
});
