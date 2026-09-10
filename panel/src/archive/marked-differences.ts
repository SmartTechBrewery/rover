import { useEffect, useRef, useState } from 'react';
import type { ArchivedArtifactState } from './artifact.js';
import { bitmapOf } from './bitmap.js';
import { type ArchivedDeviceInfo, systemBarsShared } from './device-info.js';
import { type DiffRegion, differenceBetween, type EdgeInsets } from './image-diff.js';

/**
 * **The comparison card's marks, from the moment the reader asks for them** — the one hook between
 * the two artifacts a pair of panes already holds and the regions the overlay draws
 * (`docs/DESIGN.md` §9).
 *
 * **Nothing is decoded until the reader presses the control**, and that is the whole reason this is
 * a hook with a first argument rather than a `useMemo` over two bodies. A pair of 1280x2856
 * screenshots is 29 MB of RGBA and one comparison of them takes ~50 ms of the main thread (measured
 * in Node against `giotto-ai-demo/home-composer-suggestions`, 2026-09-10); spending that on every
 * reader who opens a labelled artifact, for a mark most of them did not ask to see, is the cost §9
 * refuses everywhere else on this screen.
 *
 * **And it is decoded once per pair.** The answer is held against the two object URLs it was
 * computed from, so turning the marks off and on again draws the held regions rather than repeating
 * the work — while a *different* pair of files, which is a different pair of URLs, measures afresh.
 * The URLs are the right key rather than the addresses: a re-read of one address creates a new
 * handle, and regions measured off the handle that was revoked are regions about bytes this tab no
 * longer has.
 *
 * **Nothing is fetched here.** Both files are already buffered by the panes that drew them
 * (`artifact.ts`), so this reads the handles they hold and the card stays what §9 requires of it —
 * one host answer, no second request.
 */
export type MarkedDifferences =
	/** The reader has not asked for the marks. Nothing has been decoded and nothing is held. */
	| { readonly status: 'idle' }
	/** One of the two artifacts is still being read, so there is not yet a pair to compare. */
	| { readonly status: 'reading' }
	/** Both files are here and the comparison is running. */
	| { readonly status: 'measuring' }
	/** Where the second differs from the first — **empty when they do not differ at all**. */
	| {
			readonly status: 'marked';
			readonly marks: ImageMarks;
			/**
			 * How many regions the two runs' own system bars took off the answer.
			 *
			 * **Said out loud rather than swallowed** (`docs/DESIGN.md` §9): setting a band aside
			 * hides real differences inside it — the clock, and an arm that hid the bar altogether —
			 * so the card names the count instead of quietly drawing a smaller answer.
			 */
			readonly setAside: number;
	  }
	/**
	 * The two artifacts are different sizes, so there is no comparison to draw. Not an error: two
	 * arms may have run on devices with different screens, both measurements are correct, and
	 * scaling one onto the other would invent an answer neither device supports (D14).
	 */
	| { readonly status: 'different-dimensions' }
	/**
	 * There are no pixels to compare — a labelled recording or log rather than a screenshot, a file
	 * the host would not serve, or a browser that would not give up a canvas. One answer for all of
	 * them, because what the card has to say is the same sentence in every case.
	 */
	| { readonly status: 'unavailable' };

/**
 * The regions, **with the pixels they are in** — the compared artifact's own natural size.
 *
 * The dimensions travel with the regions because the overlay's coordinate space is the artifact's
 * own (`difference-marks.tsx`): its `viewBox` is these two numbers, and a region is written into
 * the markup unconverted. Carrying them here rather than measuring the rendered `<img>` is what
 * keeps the panel from ever holding a second opinion about how big the artifact is.
 */
export interface ImageMarks {
	readonly regions: readonly DiffRegion[];
	readonly width: number;
	readonly height: number;
}

const IDLE: MarkedDifferences = { status: 'idle' };
const READING: MarkedDifferences = { status: 'reading' };
const MEASURING: MarkedDifferences = { status: 'measuring' };
const UNAVAILABLE: MarkedDifferences = { status: 'unavailable' };

export function useMarkedDifferences(
	asked: boolean,
	reference: ArchivedArtifactState,
	compared: ArchivedArtifactState,
	referenceDevice: ArchivedDeviceInfo,
	comparedDevice: ArchivedDeviceInfo,
): MarkedDifferences {
	/*
	 * **The bands come from the two runs' own `device_info.json`**, and the two device reads are
	 * arguments for the same reason the two artifact states are: this hook decides *when* there is
	 * a pair to compare, and a run whose device facts are still in flight is not one yet. Reading
	 * without them and re-reading with them would decode 29 MB twice for one press.
	 */
	const bars = systemBarsShared(referenceDevice, comparedDevice);
	/*
	 * **Nothing may be measured while any of the four reads is still out**, and this is a
	 * correction rather than a belt-and-braces check: without it a press while the device files
	 * were in flight measured once against *no* bands, then again when they landed and the key
	 * changed — two decodes and two comparisons of 29 MB for one press, which is the cost this
	 * whole hook is arranged to spend once. `comparison-card.test.tsx` pins it.
	 */
	const waiting =
		reference.status === 'reading' ||
		compared.status === 'reading' ||
		referenceDevice.status === 'reading' ||
		comparedDevice.status === 'reading';
	/*
	 * The two handles as one string, which is both the cache key and the whole of what the effect
	 * needs — `useArchivedArtifact`'s `JSON.stringify(path)` idiom, and for its reason: an array
	 * rebuilt every render cannot be a dependency, and a newline separates two `blob:` URLs
	 * unambiguously because neither can contain one.
	 */
	const key = keyOfPixels(reference, compared, bars);
	const [held, setHeld] = useState<{ readonly of: string; readonly answer: MarkedDifferences }>({
		of: '',
		answer: IDLE,
	});
	/*
	 * Which pair has been measured, as a ref rather than state — the same shape `useArchivedArtifact`
	 * uses against React 19's double effect, and for the same reason: read inside the effect to
	 * decide whether to do the work, so it cannot be a dependency and cannot re-trigger it.
	 */
	const measured = useRef<string | null>(null);

	useEffect(() => {
		if (!asked || waiting || key === null || measured.current === key) {
			return;
		}
		measured.current = key;
		setHeld({ of: key, answer: MEASURING });
		let live = true;
		const [reading, against] = key.split('\n');
		const ignore = ignoreOf(key);
		void (async () => {
			const [first, second] = await Promise.all([bitmapOf(reading), bitmapOf(against)]);
			if (!live) {
				return;
			}
			if (first === null || second === null) {
				setHeld({ of: key, answer: UNAVAILABLE });
				return;
			}
			const difference = differenceBetween(first, second, ignore);
			setHeld({
				of: key,
				answer:
					difference.outcome === 'compared'
						? {
								status: 'marked',
								marks: { regions: difference.regions, width: second.width, height: second.height },
								setAside: difference.setAside,
							}
						: { status: 'different-dimensions' },
			});
		})();
		return () => {
			live = false;
		};
	}, [asked, key, waiting]);

	if (!asked) {
		return IDLE;
	}
	if (waiting) {
		return READING;
	}
	if (key === null) {
		return UNAVAILABLE;
	}
	// A held answer about a different pair is not an answer about this one — `useArchivedArtifact`'s
	// *the state carries the address it is about* rule, one level up.
	return held.of === key ? held.answer : MEASURING;
}

/**
 * The two object URLs to compare, as one key — or `null` when there is no pair of images here.
 *
 * Both have to be `image`: a recording and a log are drawn by the same pane and compared by the
 * same card, and neither has pixels this can align. `opaque` carries no URL at all by construction.
 */
function keyOfPixels(
	reference: ArchivedArtifactState,
	compared: ArchivedArtifactState,
	bars: EdgeInsets | null,
): string | null {
	if (reference.status !== 'read' || compared.status !== 'read') {
		return null;
	}
	if (reference.body.kind !== 'image' || compared.body.kind !== 'image') {
		return null;
	}
	// The bands are **in** the key: an answer measured with a band set aside is not an answer about
	// the same question as one measured without it, so the two must never be served for each other.
	return `${reference.body.url}\n${compared.body.url}\n${JSON.stringify(bars)}`;
}

/** The bands back out of the key, so the effect depends on one string and not on an object. */
function ignoreOf(key: string): EdgeInsets | null {
	return JSON.parse(key.split('\n')[2] ?? 'null') as EdgeInsets | null;
}
