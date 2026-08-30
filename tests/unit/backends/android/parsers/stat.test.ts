import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDeviceStat } from '@/backends/android/parsers/stat.js';

/**
 * The probe both transfers put to the device, against captures rather than against what
 * `stat` is remembered to print.
 *
 * The capture is what earns its keep here: `%F` for a zero-byte file is **`regular empty
 * file`**, not `regular file`, so a parser written from memory would either call an empty
 * file a directory or refuse it outright — and an empty file is one this repository already
 * decided is a file like any other (`Base64PayloadSchema`, "Zero bytes is legal").
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

describe('parseDeviceStat', () => {
	it('reads the size and the kind of a regular file', () => {
		expect(parseDeviceStat(fixture('stat.file.api37-sdk-gphone16k-arm64.txt'))).toEqual({
			byteLength: 11,
			kind: 'other',
			description: 'regular file',
		});
	});

	// The capture this parser exists to be pinned against — see the file header.
	it('reads an empty file as a file, not as something it has no word for', () => {
		expect(parseDeviceStat(fixture('stat.empty-file.api37-sdk-gphone16k-arm64.txt'))).toEqual({
			byteLength: 0,
			kind: 'other',
			description: 'regular empty file',
		});
	});

	it('reads a directory as one, which is the only distinction a caller acts on', () => {
		expect(parseDeviceStat(fixture('stat.directory.api37-sdk-gphone16k-arm64.txt'))).toEqual({
			byteLength: 4096,
			kind: 'directory',
			description: 'directory',
		});
	});

	/**
	 * Captured for the record rather than parsed: a missing path exits 1, so `./adb.js`
	 * rejects before this is reached. Pinned anyway, because it is the evidence that the
	 * common push — to a path that does not exist yet — never gets an answer here, which is
	 * why `statOnDevice` treats a failed run as "nothing to add" instead of a failure.
	 */
	it('has nothing to read in what a missing path prints', () => {
		expect(parseDeviceStat(fixture('stat.missing.api37-sdk-gphone16k-arm64.txt'))).toBeNull();
	});

	/**
	 * `%F` is a phrase with spaces in it, which is why the size goes first and the split is on
	 * the *first* space. A device whose toybox words a kind differently still parses.
	 */
	it('keeps a multi-word kind whole', () => {
		expect(parseDeviceStat('33 symbolic link\n')).toEqual({
			byteLength: 33,
			kind: 'other',
			description: 'symbolic link',
		});
	});

	it.each([
		['nothing at all', ''],
		['only whitespace', '  \n'],
		['a size with no kind', '4096\n'],
		['a kind with no size', 'directory\n'],
		['a size that is not a number', 'some directory\n'],
	])('answers null for %s, so the caller proceeds as if it never asked', (_case, output) => {
		expect(parseDeviceStat(output)).toBeNull();
	});
});
