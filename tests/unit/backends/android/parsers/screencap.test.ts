import { describe, expect, it } from 'vitest';
import { isPng, PNG_SIGNATURE } from '@/backends/android/parsers/screencap.js';

/**
 * The payload predicate on its own. What it is for is the mangled stream — a capture that
 * went through something that thought it was text — so the cases below are the shapes that
 * actually arrive rather than random noise.
 */
const png = (...body: number[]): Uint8Array => Uint8Array.from([...PNG_SIGNATURE, ...body]);

describe('isPng', () => {
	it('accepts a payload carrying the signature', () => {
		expect(isPng(png(0x00, 0x00, 0x00, 0x0d))).toBe(true);
	});

	// The whole reason `screenshot` uses `exec-out`: a pty turns every 0x0a into 0x0d 0x0a,
	// which lands inside the signature itself and is invisible to anything but this check.
	it('rejects a signature whose newlines were translated on the way here', () => {
		expect(
			isPng(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0d, 0x0a, 0x1a, 0x0d, 0x0a])),
		).toBe(false);
	});

	it('rejects text, which is what an error message decoded as a capture looks like', () => {
		expect(isPng(new TextEncoder().encode('error: device offline\n'))).toBe(false);
	});

	it('rejects an empty capture', () => {
		expect(isPng(new Uint8Array())).toBe(false);
	});

	// Shorter than the signature: the loop must not read past the end and call it a match.
	it('rejects a payload that is only the start of a signature', () => {
		expect(isPng(PNG_SIGNATURE.subarray(0, 4))).toBe(false);
	});

	/**
	 * The deliberate non-check (PROJECT.md §6). An app blocking screen capture yields a
	 * valid, entirely black PNG, and that is a true answer about the device — judging it
	 * belongs to whoever knows what was supposed to be on screen, not here.
	 */
	it('accepts a valid PNG regardless of what it depicts', () => {
		expect(isPng(png(...new Array(64).fill(0x00)))).toBe(true);
	});
});
