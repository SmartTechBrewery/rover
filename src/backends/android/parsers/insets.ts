/**
 * The parser for `dumpsys window d` — **the facts only the window manager has**.
 *
 * Three of them now: where this device draws its own system bars, whether its on-screen
 * keyboard is up, and which application is in the foreground. The first two come out of the one
 * `InsetsState` block, off the one line shape {@link SOURCE_LINE} matches, and the third off the
 * display section's `mFocusedApp` line, so this module is about *that dump* rather than about the
 * bars alone — a second file over the same dump would be a second thing to keep in sync with a
 * format neither of them owns.
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

import {
	type OnScreenKeyboard,
	OnScreenKeyboardSchema,
	type SystemBarInsets,
	SystemBarInsetsSchema,
} from '../../../core/device.js';
import { type Dimensions, DimensionsSchema } from './wm.js';

/** The two source types a reader means by *the system bars*. */
const BAR_TYPES = new Set(['statusBars', 'navigationBars']);

/**
 * The source types the window manager gives the on-screen keyboard — `ime` from the API level that
 * gave every source an `id=`, `ITYPE_IME` before it.
 *
 * **Both, because the older spelling is not a guess.** On API 33 / Android 13 (a Zebra TC58,
 * 2026-10-06, `PROJECT.md` §6) the line reads `InsetsSource type=ITYPE_IME frame=[0,1251][1080,2160]
 * visibleFrame=… visible=true` — no `id=`, and the old constant's name for the type. A parser that
 * knew only the newer line found no keyboard source in that block and answered *no keyboard is up*
 * while one covered half the screen, which is the one wrong answer `hide_keyboard` cannot survive:
 * it would never dismiss anything on that device, and say `ok` every time.
 *
 * The bar sources have the same older names (`ITYPE_STATUS_BAR`, `ITYPE_NAVIGATION_BAR`) and are
 * deliberately not added to {@link BAR_TYPES} here: that changes what `systemBars` reports, which is
 * a different fact with a different consumer, and it belongs to the change that measures it.
 */
const IME_TYPES = new Set(['ime', 'ITYPE_IME']);

/**
 * One `InsetsSource` line of the `InsetsState` block.
 *
 * Anchored at a line start followed by whitespace and `InsetsSource`, so the `mSource=` repeats
 * under `InsetsSourceProviders` do not match. The `id=` is optional because API 33 prints none
 * ({@link IME_TYPES}). `flags` and `sideHint` are deliberately not captured
 * — see {@link sideOf} for why the geometry decides the side rather than the hint.
 */
const SOURCE_LINE =
	/^[ \t]*InsetsSource (?:id=\S+ )?type=(\w+) frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\][^\n]*?visible=(true|false)/gm;

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

/**
 * Whether this device's on-screen keyboard is up, and where — or `null` when the dump says
 * nothing about insets at all.
 *
 * **No second device query.** The `type=ime` source sits in the same `InsetsState` block as the
 * two bar sources above, printed by the dump `deviceInfo()` already runs, so this is a read of
 * text that is in hand rather than another round trip to the device. `dumpsys input_method`'s
 * `mInputShown` is the other route and is deliberately not taken: it is a second query for a fact
 * this dump already carries, and a second source is a second thing that can disagree with the
 * first.
 *
 * **`frame` and never `visibleFrame`.** Captured on API 37 / Android 17 (2026-10-06, `PROJECT.md`
 * §6) with a text field focused, the source reads
 * `type=ime frame=[0,1848][1280,2856] visibleFrame=[0,1848][1280,2856] visible=true` — both fields
 * carry the keyboard. With the keyboard dismissed the same source reads
 * `frame=[0,0][0,0] visibleFrame=[0,2712][1280,2856] visible=false`: `frame` collapses to the
 * empty rectangle the dump uses for an absent source, while `visibleFrame` keeps a band that is
 * not a keyboard and not anything else either. So `frame` is the field that means what it says,
 * and it is the one {@link SOURCE_LINE} already captures.
 *
 * The three answers are distinct on purpose, on {@link parseSystemBarInsets}' terms:
 *
 * - **`null`** — no `InsetsState` in the dump. *This device did not say*, and it is not a failure:
 *   it answered every other screen fact perfectly well.
 * - **`{ shown: false, bounds: null }`** — the block is there and either carries no `ime` source
 *   (observed on this device after an application restart) or carries one with `visible=false`.
 *   *This device says no keyboard is up*, which is a different thing from not saying. The frame of
 *   a keyboard that is down is not a rectangle anything may be refused against, so it is dropped
 *   rather than reported.
 * - **`{ shown: true, bounds }`** — `visible=true`, with the frame divided by `scale` into the dp
 *   space `ScreenElement.bounds` is stated in. A degenerate frame answers `shown: true` with
 *   `bounds: null`: the device said the keyboard is up and gave no rectangle, and inventing one is
 *   worse than saying so (`core/device.ts` spells out why that state is not *nothing is covered*).
 *
 * `scale` is `WmDensity.scale`, the same number `../screen.ts`'s `toScreenElements` divides by,
 * and the quotients are exact and unrounded for its reason: rounding is a presentation decision,
 * and a backend that rounds leaves no way to ask what the device said.
 */
export function parseKeyboard(stdout: string, scale: number): OnScreenKeyboard | null {
	if (!Number.isFinite(scale) || scale <= 0) {
		throw new Error(
			`Cannot read the on-screen keyboard at density scale ${scale}: it must be a positive number`,
		);
	}
	const text = normalise(stdout);
	if (!INSETS_STATE.test(text)) {
		return null;
	}

	SOURCE_LINE.lastIndex = 0;
	for (const source of text.matchAll(SOURCE_LINE)) {
		const [, type, left, top, right, bottom, visible] = source;
		if (!IME_TYPES.has(type)) {
			continue;
		}
		if (visible !== 'true') {
			return OnScreenKeyboardSchema.parse({ shown: false, bounds: null });
		}
		const frame = {
			left: Number(left),
			top: Number(top),
			right: Number(right),
			bottom: Number(bottom),
		};
		const degenerate = frame.right <= frame.left || frame.bottom <= frame.top;
		return OnScreenKeyboardSchema.parse({
			shown: true,
			bounds: degenerate
				? null
				: {
						x: frame.left / scale,
						y: frame.top / scale,
						width: (frame.right - frame.left) / scale,
						height: (frame.bottom - frame.top) / scale,
					},
		});
	}
	return OnScreenKeyboardSchema.parse({ shown: false, bounds: null });
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

/**
 * The display section's `mFocusedApp` line, capturing the package out of
 * `ActivityRecord{<hash> u<user> <package>/<activity> t<task>}` — which API 33 prints with a stray
 * second `}` and API 37 without, so nothing after the `/` is matched.
 */
const FOCUSED_APP_LINE = /^[ \t]*mFocusedApp=ActivityRecord\{\S+ u\d+ ([^\s/]+)\//m;

/** What a package name looks like — one segment allowed, because a system component may be one. */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;

/**
 * The package of the application in the foreground, or `null` when this dump does not name one.
 *
 * **No second device query**, for {@link parseKeyboard}'s reason: the line is in the dump
 * `deviceInfo()` already runs.
 *
 * **`mFocusedApp` and never `mCurrentFocus`.** `mCurrentFocus` is the *window* with input focus,
 * and on a TC58 on API 33 (2026-10-07, `PROJECT.md` §6) it named `NotificationShade` with the
 * shade down over Settings, `Application Error: com.android.settings` with a crash dialog up, and
 * `null` in the first read after `am crash` — while `mFocusedApp` named Settings, Settings and the
 * launcher, agreeing each time with the activity the activity manager reports resumed. The root
 * of a `uiautomator` dump is a window's package too (`com.android.systemui` under the shade), so it
 * has `mCurrentFocus`'s problem and would make this depend on a screen read besides.
 *
 * **The first such line wins**, the rule {@link parseKeyboard} applies to the first `ime` source it
 * meets: the default display is listed first, and a second display's focus is not what is in
 * front of the user.
 *
 * **`null` is *this device did not say*, and this never throws.** It answers `null` for a dump
 * with no such line, for `mFocusedApp=null` — which that same device printed for as long as the
 * launcher sat in front after a crash dialog was dismissed, so it is a state a responsive device
 * really reports — and for a line whose shape is not the one above. `deviceInfo` throwing would
 * take every verb's answer with it, so a line this cannot read costs this one fact and nothing
 * else.
 */
export function parseForegroundApp(stdout: string): string | null {
	const match = FOCUSED_APP_LINE.exec(normalise(stdout));
	if (match === null) {
		return null;
	}
	const [, name] = match;
	return PACKAGE_NAME.test(name) ? name : null;
}
