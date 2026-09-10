import { describe, expect, it } from 'vitest';
import { type Bitmap, differenceBetween } from './image-diff.js';

/**
 * The bitmaps are **built out of rows that are individually identifiable**, and that is not
 * incidental to these tests: the alignment anchors on rows whose signature occurs exactly once in
 * each image (`image-diff.ts`), so a fixture made of 64 identical rows would exercise the
 * positional path and prove nothing about the aligned one — which is the path this module exists
 * for.
 *
 * So every row carries an 8-column binary stamp of its own id, then {@link WIDE} minus 8 columns of
 * one shade. A band that moves takes its stamps with it, exactly as a line of text moving down a
 * screen keeps its own glyphs.
 */
const WIDE = 32;
const STAMP = 8;

/** Two shades, far enough apart to differ under any threshold this module uses. */
const DARK = '.';
const LIGHT = '#';

function row(id: number, shade: string): string {
	let stamp = '';
	for (let bit = STAMP - 1; bit >= 0; bit -= 1) {
		stamp += (id >> bit) & 1 ? LIGHT : DARK;
	}
	return stamp + shade.repeat(WIDE - STAMP);
}

/** `height` rows, ids running from `from`, all one shade. */
function band(from: number, height: number, shade: string): readonly string[] {
	return Array.from({ length: height }, (_, step) => row(from + step, shade));
}

function bitmapOf(rows: readonly string[]): Bitmap {
	const width = rows[0]?.length ?? 0;
	const pixels = new Uint8ClampedArray(width * rows.length * 4);
	rows.forEach((line, y) => {
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			const value = line[x] === LIGHT ? 255 : 0;
			pixels[at] = value;
			pixels[at + 1] = value;
			pixels[at + 2] = value;
			pixels[at + 3] = 255;
		}
	});
	return { width, height: rows.length, pixels };
}

/** The regions of a comparison that was made, failing the test if it was refused. */
function regionsOf(before: Bitmap, after: Bitmap) {
	const difference = differenceBetween(before, after);
	if (difference.outcome !== 'compared') {
		throw new Error(`expected a comparison, got ${difference.outcome}`);
	}
	return difference.regions;
}

describe('two artifacts of one label, compared', () => {
	it('finds nothing between an artifact and itself', () => {
		const image = bitmapOf(band(0, 64, DARK));

		expect(regionsOf(image, image)).toEqual([]);
	});

	it('marks a block that changed where it stood', () => {
		const before = bitmapOf(band(0, 64, DARK));
		// The middle sixteen rows, right across the width, so the change spans two tiles.
		const after = bitmapOf([...band(0, 16, DARK), ...band(16, 16, LIGHT), ...band(32, 32, DARK)]);

		expect(regionsOf(before, after)).toEqual([{ x: 0, y: 16, width: 32, height: 16 }]);
	});

	/**
	 * **The measurement this module was built around, as a fixture** (`image-diff.ts`). One band is
	 * inserted a quarter of the way down and everything below it moves; a positional diff marks the
	 * insertion *and the whole tail of the image*, which against two real arms of one investigation
	 * came to 38% of the screen. What is asserted here is the property that answer lacked: the
	 * inserted band is marked, and **the rows that merely moved are not**.
	 */
	it('marks an inserted band and not the rows it pushed down', () => {
		const before = bitmapOf(band(0, 64, DARK));
		const after = bitmapOf([
			...band(0, 16, DARK),
			...band(100, 16, LIGHT),
			// The same rows as `before` carried at y16 — the same stamps, sixteen rows lower.
			...band(16, 32, DARK),
		]);

		expect(regionsOf(before, after)).toEqual([{ x: 0, y: 16, width: 32, height: 16 }]);
	});

	/**
	 * A deletion has no place of its own in the compared image — the rows are simply not there — so
	 * what is marked is the seam it left, and the rows below it are again left alone.
	 */
	it('marks the seam a deleted band left behind', () => {
		const before = bitmapOf(band(0, 64, DARK));
		const after = bitmapOf([
			...band(0, 16, DARK),
			// `before`'s rows 32 onwards, sixteen rows higher, and a new band taking up the slack.
			...band(32, 32, DARK),
			...band(200, 16, LIGHT),
		]);

		expect(regionsOf(before, after)).toEqual([
			{ x: 0, y: 16, width: 32, height: 16 },
			{ x: 0, y: 48, width: 32, height: 16 },
		]);
	});

	/**
	 * The antialiasing floor. A handful of pixels inside one tile is a cursor, a clock digit or a
	 * glyph that re-rendered, and a mark drawn around every one of them traces the typography
	 * instead of the change.
	 */
	it('leaves a few stray pixels unmarked', () => {
		const before = bitmapOf(band(0, 64, DARK));
		const after = bitmapOf(band(0, 64, DARK));
		for (let x = 0; x < 4; x += 1) {
			const at = (20 * WIDE + STAMP + x) * 4;
			after.pixels[at] = 255;
			after.pixels[at + 1] = 255;
			after.pixels[at + 2] = 255;
		}

		expect(regionsOf(before, after)).toEqual([]);
	});

	/**
	 * **Two different screens are not compared at all** (D14). Both measurements are correct, and
	 * scaling one onto the other would invent an answer neither device supports — which is §9's
	 * *never stretched and never cropped* about the same pixels.
	 */
	it('refuses two artifacts of different dimensions', () => {
		const before = bitmapOf(band(0, 64, DARK));
		const after = bitmapOf(band(0, 48, DARK));

		expect(differenceBetween(before, after)).toEqual({ outcome: 'different-dimensions' });
		expect(differenceBetween(after, before)).toEqual({ outcome: 'different-dimensions' });
	});

	it('answers an empty image with no regions rather than a refusal', () => {
		const empty: Bitmap = { width: 0, height: 0, pixels: new Uint8ClampedArray(0) };

		expect(differenceBetween(empty, empty)).toEqual({ outcome: 'compared', regions: [] });
	});

	/** Top to bottom, then left to right — the order the overlay draws in and a test can assert. */
	it('gives its regions in reading order', () => {
		const before = bitmapOf(band(0, 96, DARK));
		const after = bitmapOf([
			...band(0, 16, DARK),
			...band(16, 16, LIGHT),
			...band(32, 32, DARK),
			...band(64, 16, LIGHT),
			...band(80, 16, DARK),
		]);

		const regions = regionsOf(before, after);
		expect(regions.map((region) => region.y)).toEqual([16, 64]);
	});
});
