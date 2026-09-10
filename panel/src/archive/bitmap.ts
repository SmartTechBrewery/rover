import type { Bitmap } from './image-diff.js';

/**
 * **One artifact's pixels, out of the address the panel already holds for its bytes** — the one
 * step of the comparison overlay that needs a browser, kept in a module of its own so
 * `image-diff.ts` needs none (`docs/DESIGN.md` §9).
 *
 * **The address is already a `blob:` URL of this tab's own bytes** (`archive.ts`), which is what
 * makes this possible at all: an authenticated byte route cannot be an `<img src>` (D20), so the
 * panel fetches with the session header and hands the browser a handle — and a `blob:` handle is
 * **same-origin**, so the canvas it is drawn into is not tainted and `getImageData` is allowed.
 * Reading pixels off an artifact served straight from the host would not be.
 *
 * **No second request, and no second copy of the bytes.** The panes have both files buffered
 * already, this reads the handles they hold, and the two bitmaps live for as long as one comparison
 * takes. What it does cost is stated rather than worked around, in §9's way: RGBA is four bytes a
 * pixel, so a 1280x2856 screenshot is 14 MB decoded and a pair of them 29 MB, on top of the encoded
 * artifacts the panes already hold. That is why the decode happens **only when the reader asks for
 * the marks** and never on the way to drawing a pane.
 *
 * **`null` is *this browser will not give up the pixels*, and it is not an error.** A missing 2D
 * context (jsdom in the panel's own test project has none), an image the browser declines to
 * decode, a tainted canvas: all three answer the same way, and the card says *the marks cannot be
 * drawn* in one sentence rather than reporting a failure the reader can do nothing about.
 */
export async function bitmapOf(url: string): Promise<Bitmap | null> {
	const image = await decoded(url);
	if (image === null) {
		return null;
	}
	// `naturalWidth`/`naturalHeight` rather than `width`/`height`: the latter are the layout
	// attributes, which are 0 on an image that was never in the document, and this one never is.
	const width = image.naturalWidth;
	const height = image.naturalHeight;
	if (width === 0 || height === 0) {
		return null;
	}
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	// `willReadFrequently` is the hint for exactly this shape — draw once, read the whole surface
	// back once — and it keeps the browser from putting the surface on the GPU only to read it down.
	const surface = canvas.getContext('2d', { willReadFrequently: true });
	if (surface === null) {
		return null;
	}
	try {
		surface.drawImage(image, 0, 0);
		return { width, height, pixels: surface.getImageData(0, 0, width, height).data };
	} catch {
		return null;
	}
}

/**
 * The image element, decoded — or `null` for one the browser would not take.
 *
 * `decode()` rather than an `onload` race: it resolves *after* the frame is ready to be drawn,
 * which is the guarantee `drawImage` needs, and it rejects rather than sitting there forever on
 * bytes that are not an image. It is not in jsdom, so its absence is one of the ways this answers
 * `null`.
 */
async function decoded(url: string): Promise<HTMLImageElement | null> {
	const image = new Image();
	image.src = url;
	if (typeof image.decode !== 'function') {
		return null;
	}
	try {
		await image.decode();
		return image;
	} catch {
		return null;
	}
}
