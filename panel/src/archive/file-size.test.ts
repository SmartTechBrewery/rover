import { describe, expect, it } from 'vitest';
import { formatBytes, formatChildCount } from './file-size.js';

describe('a file size', () => {
	// A size the host could not read is a gap the screen names. `0 B` would be a claim about an
	// empty file, which is a different fact.
	it('says `unknown` rather than closing a gap up with a zero', () => {
		expect(formatBytes(null)).toBe('unknown');
	});

	it('says nothing else for an empty file', () => {
		expect(formatBytes(0)).toBe('0 B');
	});

	it('steps at 1024', () => {
		expect(formatBytes(1023)).toBe('1023 B');
		expect(formatBytes(1024)).toBe('1 KB');
		expect(formatBytes(412_331)).toBe('403 KB');
		expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
		expect(formatBytes(3_411_920)).toBe('3.3 MB');
		expect(formatBytes(4 * 1024 ** 3)).toBe('4.0 GB');
	});

	// Nothing above GB, because the archive has nothing that size and a unit nobody can produce
	// is a unit nobody has checked.
	it('stops at gigabytes rather than inventing a unit', () => {
		expect(formatBytes(4096 * 1024 ** 3)).toBe('4096.0 GB');
	});
});

describe('a child count', () => {
	it('says `unknown` for a directory the host could not read into', () => {
		expect(formatChildCount(null)).toBe('unknown');
	});

	// `1 files` is the kind of thing that makes a reader wonder what else the page is guessing at,
	// and one recording under a run is the common case.
	it('counts one file in the singular', () => {
		expect(formatChildCount(1)).toBe('1 file');
	});

	it('counts the rest in the plural, including none', () => {
		expect(formatChildCount(0)).toBe('0 files');
		expect(formatChildCount(3)).toBe('3 files');
	});
});
