/**
 * The parser for `dumpsys window d` — **where this device draws its own system bars**.
 *
 * Pure, like `./wm.js` and `./devices.js`: the runner (R5) owns the process, this owns the text.
 *
 * **Why this exists at all.** The panel's comparison card marks where two screenshots of one
 * label differ (`docs/DESIGN.md` §9), and on every real pair two of those marks are the clock and
 * the signal glyph — the status bar differs between any two runs, because time passed between
 * them. Setting that band aside needs the band, and **the band is a fact only the device has**:
 * measured on this fixture's own device it is 156 px, which at `densityScale` 3 is **52 dp**, not
 * the 24 dp that every guide on the internet quotes. A constant written from memory would have been
 * wrong by more than half on the first device it met (PROJECT.md §6).
 *
 * **`dumpsys window d` and not `dumpsys window`.** The full dump is 762 lines and the window list
 * 469; the displays dump is 289 and carries the whole `InsetsState`, which is the section this
 * needs. `dumpsys window insets` does not exist — it answers `Bad window command` — and the
 * `StatusBar` *window* can be dumped by name, but the name of the bottom bar is the launcher's
 * (`Taskbar` on this device), so a parser keyed on window names would read one bar and miss the
 * other (all four verified on API 37, 2026-09-10).
 *
 * **The `InsetsState` block and never `InsetsSourceProviders`.** The same sources appear twice in
 * that dump: once in `InsetsState` as `InsetsSource id=…`, and once under `InsetsSourceProviders`
 * prefixed `mSource=`. {@link SOURCE_LINE} is anchored so only the first form matches, which is why
 * two identical frames in the output do not become two answers.
 */

import { type SystemBarInsets, SystemBarInsetsSchema } from '../../../core/device.js';
import { type Dimensions, DimensionsSchema } from './wm.js';

/** The two source types a reader means by *the system bars*. */
const BAR_TYPES = new Set(['statusBars', 'navigationBars']);

/**
 * One `InsetsSource` line of the `InsetsState` block.
 *
 * Anchored at a line start followed by whitespace and `InsetsSource`, so the `mSource=` repeats
 * under `InsetsSourceProviders` do not match. `flags` and `sideHint` are deliberately not captured
 * — see {@link sideOf} for why the geometry decides the side rather than the hint.
 */
const SOURCE_LINE =
	/^[ \t]*InsetsSource id=\S+ type=(\w+) frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\][^\n]*?visible=(true|false)/gm;

/** The marker for the block whose sources are the display's own. */
const INSETS_STATE = /^[ \t]*InsetsState\b/m;

/** `adb shell` may hand back CRLF; every parser here strips it rather than the fixtures. */
function normalise(stdout: string): string {
	return stdout.replace(/\r\n/g, '\n');
}

/**
 * The system bar insets this dump reports, or `null` when it reports none at all.
 *
 * **`null` is *this device did not say*, and it is not a failure** (ai/CODING_STANDARDS.md, "Error
 * handling"): an Android that does not print an `InsetsState` has answered every other screen fact
 * perfectly well, and the consumer's job is to carry on without this one rather than to lose the
 * whole of `device_info`. A dump that *has* the block and no visible bar sources in it answers four
 * zeros, which is a different thing — *this device draws no bars* — and is why the two cases are not
 * folded together.
 *
 * `dimensions` is the **effective** size, `WmSize.effective`, because that is what the device
 * renders at and therefore what these frames are stated against.
 */
export function parseSystemBarInsets(
	stdout: string,
	dimensions: Dimensions,
): SystemBarInsets | null {
	const text = normalise(stdout);
	if (!INSETS_STATE.test(text)) {
		return null;
	}
	const display = DimensionsSchema.parse(dimensions);
	const insets = { top: 0, bottom: 0, left: 0, right: 0 };

	SOURCE_LINE.lastIndex = 0;
	for (const source of text.matchAll(SOURCE_LINE)) {
		const [, type, left, top, right, bottom, visible] = source;
		if (!BAR_TYPES.has(type) || visible !== 'true') {
			continue;
		}
		const frame = {
			left: Number(left),
			top: Number(top),
			right: Number(right),
			bottom: Number(bottom),
		};
		const reach = sideOf(frame, display);
		if (reach !== null) {
			// The deeper of two sources on one side wins. Two bars can hint the same edge — a status
			// bar and a cutout of different depths both reach in from the top — and the inset a
			// consumer needs is the one that clears both.
			insets[reach.side] = Math.max(insets[reach.side], reach.depth);
		}
	}
	return SystemBarInsetsSchema.parse(insets);
}

/** One source's frame, in the display's own pixels. */
interface Frame {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

/**
 * Which edge a frame reaches in from, and how deep — or `null` for a frame that is not an edge
 * band at all.
 *
 * **The geometry decides this and not the dump's own `sideHint`.** The hint is named a hint, it is
 * `NONE` on sources in this very fixture, and it is a *hint about where the source is* rather than
 * a promise that the source spans that edge. A frame that does not span the full width or the full
 * height is not something a rectangle of pixels can be set aside for — a floating source, or the
 * empty `[0,0][0,0]` this dump uses for an absent one — so it is ignored rather than turned into an
 * inset that would hide part of the screen.
 */
function sideOf(
	frame: Frame,
	display: Dimensions,
): { readonly side: 'top' | 'bottom' | 'left' | 'right'; readonly depth: number } | null {
	const spansWidth = frame.left === 0 && frame.right === display.width;
	const spansHeight = frame.top === 0 && frame.bottom === display.height;
	if (frame.right <= frame.left || frame.bottom <= frame.top) {
		return null;
	}
	if (spansWidth && frame.top === 0 && frame.bottom < display.height) {
		return { side: 'top', depth: frame.bottom };
	}
	if (spansWidth && frame.bottom === display.height && frame.top > 0) {
		return { side: 'bottom', depth: display.height - frame.top };
	}
	if (spansHeight && frame.left === 0 && frame.right < display.width) {
		return { side: 'left', depth: frame.right };
	}
	if (spansHeight && frame.right === display.width && frame.left > 0) {
		return { side: 'right', depth: display.width - frame.left };
	}
	return null;
}
