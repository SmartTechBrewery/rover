import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DP_BASELINE_DPI, parseWmDensity, parseWmSize } from '@/backends/android/parsers/wm.js';

const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const SIZE = fixture('wm-size.api37-sdk-gphone16k-arm64.txt');
const SIZE_OVERRIDE = fixture('wm-size.override.api37-sdk-gphone16k-arm64.txt');
const DENSITY = fixture('wm-density.api37-sdk-gphone16k-arm64.txt');
const DENSITY_OVERRIDE = fixture('wm-density.override.api37-sdk-gphone16k-arm64.txt');

describe('parseWmSize', () => {
	it('reads the physical size and reports no override', () => {
		expect(parseWmSize(SIZE)).toEqual({
			physical: { width: 1280, height: 2856 },
			override: null,
			effective: { width: 1280, height: 2856 },
		});
	});

	it('makes the override effective when `wm size <w>x<h>` has been applied', () => {
		expect(parseWmSize(SIZE_OVERRIDE)).toEqual({
			physical: { width: 1280, height: 2856 },
			override: { width: 720, height: 1600 },
			effective: { width: 720, height: 1600 },
		});
	});

	it('tolerates the CRLF that `adb shell` sometimes returns', () => {
		expect(parseWmSize('Physical size: 1080x2400\r\n').physical).toEqual({
			width: 1080,
			height: 2400,
		});
	});

	it.each([
		['', /wm size: no 'Physical' line/],
		["Error: Can't find service: window", /Can't find service: window/],
	])('throws on %j, quoting the output', (stdout, expected) => {
		expect(() => parseWmSize(stdout)).toThrow(expected);
	});
});

describe('parseWmDensity', () => {
	it('reads the physical density and derives the dp scale from it', () => {
		expect(parseWmDensity(DENSITY)).toEqual({
			physical: 480,
			override: null,
			effective: 480,
			scale: 3,
		});
	});

	it('derives the scale from the override when one is applied', () => {
		expect(parseWmDensity(DENSITY_OVERRIDE)).toEqual({
			physical: 480,
			override: 320,
			effective: 320,
			scale: 2,
		});
	});

	// The exact arithmetic, not a rounded value: a scale that is a few percent off is the
	// px→dp bug PROJECT.md §6 describes, and rounding would hide it.
	it.each([
		[160, 1],
		[420, 2.625],
		[560, 3.5],
	])('scales density %i to %f', (density, scale) => {
		expect(parseWmDensity(`Physical density: ${density}\n`).scale).toBe(scale);
	});

	it('computes the scale against the dp baseline of 160', () => {
		expect(DP_BASELINE_DPI).toBe(160);
		expect(parseWmDensity(DENSITY).scale).toBe(480 / DP_BASELINE_DPI);
	});

	it.each([
		['', /wm density: no 'Physical' line/],
		["Error: Can't find service: window", /Can't find service: window/],
	])('throws on %j, quoting the output', (stdout, expected) => {
		expect(() => parseWmDensity(stdout)).toThrow(expected);
	});
});
