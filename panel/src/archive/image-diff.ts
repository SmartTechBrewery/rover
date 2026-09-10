/**
 * **Where the second of two screenshots differs from the first** — as a pure function over two
 * decoded bitmaps, with no DOM, no canvas and no React (`docs/DESIGN.md` §9).
 *
 * This is the panel's first computed claim about the *contents* of an artifact, and it is the one
 * §9 spent three paragraphs refusing. What changed is not the reasoning but the operator's decision
 * about it: the marks are **chrome over the artifact rather than a verdict on it** — no score, no
 * pass, no fail, no baseline, and nothing about which arm is right. Two arms of one investigation
 * differ *by design*, so what is drawn is *here is where they differ*, in one colour, and the
 * person still decides what that means (`ai/RULES.md` §1).
 *
 * **The whole design decision is that the diff is aligned rather than positional**, and it was
 * settled by measuring the archive rather than by reasoning about it. Against the two arms of
 * `giotto-ai-demo/home-composer-suggestions` (1280x2856, one emulator, 2026-09-09), a plain
 * per-pixel threshold marks **38 regions covering 38% of the screen** on a pair whose real
 * difference is a clock and a scroll offset: variant B's list sits a few dozen pixels lower, so
 * every line of text below the shift registers as changed and the answer is noise with a number on
 * it. Aligning the rows first collapses that same pair to **2 bands over 5.5%**. A screenshot is a
 * *flowing layout*, an arm that adds one element pushes everything under it down, and a diff that
 * cannot say so marks the whole tail of the screen instead of the insertion.
 *
 * So the shape is the one a text diff has, one dimension up:
 *
 * 1. every row of both images becomes a **signature** — a quantised sample of its own pixels;
 * 2. signatures that occur **exactly once in each image** are candidate anchors, and the longest
 *    strictly increasing run of them is the alignment. Unique-row anchoring is patience diff's
 *    core, and it is the right half of that algorithm to borrow here: a screenshot's uniform
 *    background rows repeat by the hundred and are useless as anchors, while a row of text is
 *    distinctive, which is exactly the row whose movement a reader would notice;
 * 3. rows between two anchors pair up one-to-one **when both sides hold the same number of them**
 *    — the segment moved or its contents changed, and comparing them row by row is honest. When
 *    the counts differ, the rows on the second side are an **insertion**: something is there that
 *    has no counterpart, so the band is marked whole rather than compared against the wrong rows;
 * 4. differing pixels are counted per **tile**, tiles are clustered, and each cluster's bounding
 *    box is one region. Tiles rather than pixels because antialiased text differs by a pixel along
 *    every glyph edge, and a per-pixel mask over a screenshot of text marks the typography rather
 *    than the change.
 *
 * **Nothing here is scaled, cropped or normalised.** Two bitmaps of different dimensions are
 * `different-dimensions` and get no regions at all — D14's rule cashed in on the one screen that
 * could quietly break it: two arms may have run on devices of different densities, both
 * measurements are correct, and stretching one onto the other would invent a comparison neither
 * device supports. §9's *never stretched and never cropped* is the same sentence about the same
 * pixels.
 *
 * **Regions are in the second image's own pixel coordinates**, and never in rendered ones. The
 * overlay carries them into an `<svg viewBox>` of the image's natural size, so nothing in the panel
 * ever converts a region into layout pixels — which is what keeps the marks on the pixels they are
 * about under `object-contain`, at every card width, with no measuring and no resize listener.
 */

/** One decoded artifact — `CanvasRenderingContext2D.getImageData()`'s own layout, unchanged. */
export interface Bitmap {
	readonly width: number;
	readonly height: number;
	/** RGBA, four bytes per pixel, row-major. Length is always `width * height * 4`. */
	readonly pixels: Uint8ClampedArray;
}

/** One marked rectangle, in the compared image's own pixels. */
export interface DiffRegion {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * What comparing two bitmaps answered.
 *
 * `different-dimensions` is not an error and not a failure: it is the honest answer for two arms
 * that ran on devices with different screens, and the card says so in a sentence rather than
 * drawing an empty overlay that would read as *nothing differs*.
 */
export type ImageDifference =
	| { readonly outcome: 'compared'; readonly regions: readonly DiffRegion[] }
	| { readonly outcome: 'different-dimensions' };

/**
 * How many columns a row is reduced to before it is hashed.
 *
 * Each sample is the **mean** of its own band rather than one pixel out of it: point sampling makes
 * a one-pixel vertical rule decide whether two rows are the same row, and a divider moving by a
 * pixel would then break every anchor below it. 64 over a 1280-wide screenshot is a 20px band per
 * sample, which distinguishes lines of text from one another and from the background — the property
 * anchoring needs — while ignoring subpixel movement inside a band.
 */
const SIGNATURE_COLUMNS = 64;

/**
 * The quantisation step of a signature sample, over 0–255 luma.
 *
 * Coarse on purpose: two runs of one app on one device still differ by a shade or two across a
 * gradient, and a signature that resolved those would find no anchors at all on exactly the pairs
 * this feature exists for. It is *only* used to decide whether two rows are the same row; whether
 * two pixels differ is {@link PIXEL_THRESHOLD}'s question and a much finer one.
 */
const SIGNATURE_STEP = 24;

/**
 * How far two pixels must be apart, on their furthest channel, to count as differing.
 *
 * Per-channel rather than on luma, so a colour change at the same brightness — the thing an arm of
 * a design test is most likely to be — is not invisible to it.
 */
const PIXEL_THRESHOLD = 24;

/** The side of one tile, in pixels. 16 is the grain the measurement above was made at. */
const TILE = 16;

/**
 * What fraction of a tile's compared pixels must differ before the tile is marked.
 *
 * This is the antialiasing floor, and it is what stops the marks from tracing glyph edges: a tile
 * holding one line of text that merely re-rendered differs on a few percent of its pixels, while a
 * tile whose content actually changed differs on tens of them.
 */
const TILE_FILL = 0.08;

/**
 * The smallest cluster that is still a region.
 *
 * A single tile is 16x16 of a 1280x2856 screen and is far more often a cursor, a clock digit or a
 * signal bar than something a reader wants a box drawn around. Two is deliberately low rather than
 * safe: dropping real evidence is the worse failure of the two, and the status bar is going to
 * light up on every pair anyway (see the card).
 */
const MIN_TILES = 2;

/**
 * Every region where {@link after} differs from {@link before}, top to bottom.
 *
 * The order is deterministic — by `y`, then by `x` — because it is what a test asserts against and
 * what the overlay draws in; nothing downstream may depend on the order clustering happened to
 * find them in.
 */
export function differenceBetween(before: Bitmap, after: Bitmap): ImageDifference {
	if (before.width !== after.width || before.height !== after.height) {
		return { outcome: 'different-dimensions' };
	}
	const { width, height } = after;
	if (width === 0 || height === 0) {
		return { outcome: 'compared', regions: [] };
	}
	const across = Math.ceil(width / TILE);
	const down = Math.ceil(height / TILE);
	const marked = markedTiles(before, after, across, down);
	return { outcome: 'compared', regions: regionsOf(marked, across, down, width, height) };
}

/**
 * Which tiles of `after` differ, as one flag per tile of an `across` by `down` grid.
 *
 * A row with no counterpart marks its whole tile row and is never compared; a paired row is counted
 * pixel by pixel. The threshold is applied at the end rather than per row, because a tile spans
 * {@link TILE} rows and it is the tile's own fraction that decides it.
 */
function markedTiles(before: Bitmap, after: Bitmap, across: number, down: number): Uint8Array {
	const differing = new Uint32Array(across * down);
	const compared = new Uint32Array(across * down);
	const marked = new Uint8Array(across * down);

	for (const { of, against } of alignmentOf(before, after)) {
		const row = Math.floor(of / TILE) * across;
		if (against === null) {
			marked.fill(1, row, row + across);
		} else {
			countRow(before, after, of, against, row, differing, compared);
		}
	}
	for (let tile = 0; tile < marked.length; tile += 1) {
		if (marked[tile] === 0 && compared[tile] > 0) {
			marked[tile] = differing[tile] / compared[tile] > TILE_FILL ? 1 : 0;
		}
	}
	return marked;
}

/** One paired row, counted into the tiles of the tile row it belongs to. */
function countRow(
	before: Bitmap,
	after: Bitmap,
	of: number,
	against: number,
	row: number,
	differing: Uint32Array,
	compared: Uint32Array,
): void {
	let mine = of * after.width * 4;
	let theirs = against * before.width * 4;
	for (let x = 0; x < after.width; x += 1) {
		const tile = row + Math.floor(x / TILE);
		compared[tile] += 1;
		if (apart(after.pixels, mine, before.pixels, theirs) > PIXEL_THRESHOLD) {
			differing[tile] += 1;
		}
		mine += 4;
		theirs += 4;
	}
}

/** How far two pixels are apart, on their furthest channel — alpha included. */
function apart(mine: Uint8ClampedArray, at: number, theirs: Uint8ClampedArray, from: number) {
	return Math.max(
		Math.abs(mine[at] - theirs[from]),
		Math.abs(mine[at + 1] - theirs[from + 1]),
		Math.abs(mine[at + 2] - theirs[from + 2]),
		Math.abs(mine[at + 3] - theirs[from + 3]),
	);
}

/**
 * One row of `after`, and the row of `before` it is to be compared against — or `null` for a row
 * that has no counterpart at all.
 *
 * Rows of `before` that no row of `after` corresponds to are **not** in this list, because they
 * have nowhere to be drawn: the marks go on `after`, and something that is only in `before` is a
 * deletion. What it leaves behind is the seam it was removed at, and the row on either side of that
 * seam is what carries it — see {@link alignmentOf}.
 */
interface AlignedRow {
	readonly of: number;
	readonly against: number | null;
}

/**
 * How the rows of the two images line up, as one pass over the anchors.
 *
 * Between two consecutive anchors each side holds a gap. **Equal gaps pair up one-to-one** — the
 * segment either moved as a block or changed in place, and either way row *n* of one gap is the row
 * to compare row *n* of the other against. **Unequal gaps are an insertion or a deletion**, and
 * neither is compared: pairing rows across a length change is what produces the 38% answer this
 * module exists to avoid.
 *
 * A **deletion** — a gap in `before` with nothing opposite it — still gets one marked row, the
 * first row after the seam, because *something used to be here* is a difference a reader has to be
 * able to see. Without it a removed element would be the one change the overlay drew nothing for.
 */
function alignmentOf(before: Bitmap, after: Bitmap): readonly AlignedRow[] {
	const anchors = anchorsOf(signaturesOf(before), signaturesOf(after));
	const rows: AlignedRow[] = [];
	let mine = 0;
	let theirs = 0;

	const upTo = (myEnd: number, theirEnd: number) => {
		const gap = myEnd - mine;
		if (gap === theirEnd - theirs) {
			for (let step = 0; step < gap; step += 1) {
				rows.push({ of: mine + step, against: theirs + step });
			}
		} else if (gap > 0) {
			for (let step = 0; step < gap; step += 1) {
				rows.push({ of: mine + step, against: null });
			}
		} else if (myEnd < after.height) {
			rows.push({ of: myEnd, against: null });
		}
		mine = myEnd;
		theirs = theirEnd;
	};

	for (const [theirRow, myRow] of anchors) {
		upTo(myRow, theirRow);
		rows.push({ of: mine, against: theirs });
		mine += 1;
		theirs += 1;
	}
	upTo(after.height, before.height);
	return rows;
}

/**
 * One hash per row, over {@link SIGNATURE_COLUMNS} quantised means of its own pixels.
 *
 * FNV-1a, which is a hash and not a fingerprint: two unrelated rows *can* collide, and a collision
 * would pair two rows that are not the same row. The damage is bounded by the anchors having to be
 * strictly increasing on both sides — a wrongly paired row can only displace an anchor, never
 * reorder the alignment — and by the region floor absorbing the rest, which is a better trade than
 * carrying a 128-bit digest per row of a 2856-row screenshot.
 */
function signaturesOf({ width, height, pixels }: Bitmap): Uint32Array {
	const signatures = new Uint32Array(height);
	const columns = Math.min(SIGNATURE_COLUMNS, width);
	for (let y = 0; y < height; y += 1) {
		let hash = 0x811c9dc5;
		for (let column = 0; column < columns; column += 1) {
			const from = Math.floor((column * width) / columns);
			const to = Math.max(from + 1, Math.floor(((column + 1) * width) / columns));
			let sum = 0;
			for (let x = from; x < to; x += 1) {
				const at = (y * width + x) * 4;
				// Rec. 601 luma in integer arithmetic. The alpha channel is deliberately not in the
				// signature: a screenshot is opaque, and a recording's extracted frame is too.
				sum += (pixels[at] * 77 + pixels[at + 1] * 150 + pixels[at + 2] * 29) >> 8;
			}
			hash ^= Math.floor(sum / (to - from) / SIGNATURE_STEP);
			hash = Math.imul(hash, 0x01000193);
		}
		signatures[y] = hash >>> 0;
	}
	return signatures;
}

/**
 * The rows the two images are pinned together at, as `[row of before, row of after]` pairs
 * strictly increasing in both.
 *
 * A candidate is a signature occurring **exactly once in each image**, which is what makes it an
 * anchor rather than a guess: a row that repeats has no single counterpart, and choosing one of its
 * copies is how an alignment ends up worse than none. The longest increasing subsequence over the
 * candidates is then the largest set of them that can all be true at once.
 */
function anchorsOf(
	before: Uint32Array,
	after: Uint32Array,
): readonly (readonly [number, number])[] {
	const rowOf = (signatures: Uint32Array) => {
		const rows = new Map<number, number>();
		const repeated = new Set<number>();
		signatures.forEach((signature, row) => {
			if (rows.has(signature)) {
				repeated.add(signature);
			} else {
				rows.set(signature, row);
			}
		});
		for (const signature of repeated) {
			rows.delete(signature);
		}
		return rows;
	};

	const theirs = rowOf(after);
	const candidates: (readonly [number, number])[] = [];
	for (const [signature, row] of rowOf(before)) {
		const mine = theirs.get(signature);
		if (mine !== undefined) {
			candidates.push([row, mine]);
		}
	}
	candidates.sort((left, right) => left[0] - right[0]);
	return increasingRun(candidates);
}

/**
 * The longest strictly increasing subsequence of the second component, over pairs already sorted by
 * the first — patience sorting with a predecessor chain, so what comes back is the subsequence
 * itself rather than its length.
 */
function increasingRun(
	candidates: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
	const endsAt: number[] = [];
	const cameFrom = new Int32Array(candidates.length).fill(-1);
	for (let at = 0; at < candidates.length; at += 1) {
		let low = 0;
		let high = endsAt.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (candidates[endsAt[middle]][1] < candidates[at][1]) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		cameFrom[at] = low > 0 ? endsAt[low - 1] : -1;
		endsAt[low] = at;
	}

	const run: (readonly [number, number])[] = [];
	for (let at = endsAt.length > 0 ? endsAt[endsAt.length - 1] : -1; at >= 0; at = cameFrom[at]) {
		run.push(candidates[at]);
	}
	return run.reverse();
}

/**
 * The marked tiles, clustered into bounding boxes and clamped to the image.
 *
 * Eight-connected rather than four, so a diagonal run of tiles down the edge of a moved element is
 * one region instead of a staircase of them.
 */
function regionsOf(
	marked: Uint8Array,
	across: number,
	down: number,
	width: number,
	height: number,
): readonly DiffRegion[] {
	const seen = new Uint8Array(marked.length);
	const regions: DiffRegion[] = [];
	for (let tile = 0; tile < marked.length; tile += 1) {
		if (marked[tile] === 0 || seen[tile] === 1) {
			continue;
		}
		seen[tile] = 1;
		const cluster = clusterFrom(tile, marked, seen, across, down);
		if (cluster.size < MIN_TILES) {
			continue;
		}
		const x = cluster.left * TILE;
		const y = cluster.top * TILE;
		regions.push({
			x,
			y,
			width: Math.min((cluster.right + 1) * TILE, width) - x,
			height: Math.min((cluster.bottom + 1) * TILE, height) - y,
		});
	}
	// By `y`, then by `x`: what a test asserts against and what the overlay draws in, so nothing
	// downstream depends on the order the flood fill happened to reach them in.
	return regions.sort((left, right) => left.y - right.y || left.x - right.x);
}

/** One cluster of marked tiles: how many, and the tile bounds it spans. */
interface Cluster {
	readonly size: number;
	readonly left: number;
	readonly right: number;
	readonly top: number;
	readonly bottom: number;
}

/**
 * The cluster reachable from one marked tile, by flood fill.
 *
 * Iterative rather than recursive, because a screenshot-sized grid of marked tiles — which is
 * exactly what an insertion near the top of a screen produces — would overflow the call stack.
 */
function clusterFrom(
	start: number,
	marked: Uint8Array,
	seen: Uint8Array,
	across: number,
	down: number,
): Cluster {
	const stack = [start];
	let size = 0;
	let left = across;
	let right = -1;
	let top = down;
	let bottom = -1;
	while (stack.length > 0) {
		const at = stack.pop() as number;
		const x = at % across;
		const y = Math.floor(at / across);
		size += 1;
		left = Math.min(left, x);
		right = Math.max(right, x);
		top = Math.min(top, y);
		bottom = Math.max(bottom, y);
		for (const next of neighbours(x, y, across, down)) {
			if (marked[next] === 1 && seen[next] === 0) {
				seen[next] = 1;
				stack.push(next);
			}
		}
	}
	return { size, left, right, top, bottom };
}

/** The eight tiles around one, minus whatever falls outside the grid. */
function neighbours(x: number, y: number, across: number, down: number): readonly number[] {
	const around: number[] = [];
	for (let dy = -1; dy <= 1; dy += 1) {
		for (let dx = -1; dx <= 1; dx += 1) {
			const nx = x + dx;
			const ny = y + dy;
			if (nx >= 0 && ny >= 0 && nx < across && ny < down && (dx !== 0 || dy !== 0)) {
				around.push(ny * across + nx);
			}
		}
	}
	return around;
}
