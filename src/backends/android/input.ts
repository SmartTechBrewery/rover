/**
 * Argument construction for `adb shell input` — the pure half of the four `canInput`
 * primitives.
 *
 * Separate from `./backend.ts` for the reason the parsers are: this owns arithmetic and
 * text, `./adb.js` owns the process, and neither can be tested through the other. Nothing
 * here spawns anything, so every rule below is asserted in
 * `tests/unit/backends/android/input.test.ts` without a device — and every rule below was
 * *measured* on one first (PROJECT.md §6, API 37 / adb 37.0.0).
 *
 * The measurement is what this module is for. `input` is unusually willing to accept
 * nonsense in silence: an unknown keycode name, an off-screen coordinate and a tab
 * character are each exit 0 with zero bytes on both streams and nothing done. So the
 * checks that can be made before the call are made here, where they are loud, rather than
 * left to a predicate that will never see them.
 */

import type { DeviceKey, Point } from '../../core/device.js';

/**
 * The Android keycode each key of the neutral vocabulary maps to.
 *
 * `Record<DeviceKey, string>` rather than a lookup with a fallback, so a key added to
 * `DeviceKeySchema` is a compile error here instead of a runtime miss — and a runtime miss
 * is the worst shape it could take: `input keyevent NOT_A_KEY` exits **0 with zero bytes
 * on both streams** on API 37, so an unmapped key would report success and do nothing
 * (PROJECT.md §6). Nothing at runtime can catch that, which is why the whole map is pinned
 * in the unit suite and every entry is pressed against a real device in
 * `tests/device/android/input.test.ts`.
 *
 * Names rather than numbers, because `input keyevent` takes both and `KEYCODE_APP_SWITCH`
 * says what `187` does not.
 *
 * **`KEYCODE_WAKEUP`, not `KEYCODE_POWER`.** Power *toggles*, so a `wake` built on it puts
 * an already-woken device to sleep — the silent inversion this vocabulary exists to avoid.
 * All four were pressed on API 37 before this table was written.
 */
export const KEY_CODES = {
	back: 'KEYCODE_BACK',
	home: 'KEYCODE_HOME',
	recents: 'KEYCODE_APP_SWITCH',
	wake: 'KEYCODE_WAKEUP',
} as const satisfies Record<DeviceKey, string>;

/**
 * The one sequence `input text` reads rather than types: it substitutes a **space** for
 * every literal lowercase `%s` in its argument. `%S` and a `%` that is not followed by an
 * `s` are typed verbatim (measured — PROJECT.md §6), so this is the only string the
 * substitution touches.
 */
const SPACE_ESCAPE = '%s';

/**
 * The characters `input text` was observed to type. Printable ASCII, U+0020 to U+007E
 * inclusive, all 95 of them typed verbatim in one call on API 37.
 *
 * Everything outside it fails, and the two ways it fails are why this list exists rather
 * than a hopeful pass-through:
 *
 * - **A tab or a newline is dropped in silence** — exit 0, zero bytes on both streams, and
 *   the surrounding characters typed as if the caller had never asked for it. Nothing
 *   downstream can tell that happened.
 * - **Any non-ASCII character throws inside the device** — `java.lang.NullPointerException:
 *   Attempt to get length of null array` at exit 255, from `KeyCharacterMap` having no
 *   events for it, and **nothing at all is typed**, not even the ASCII around it. Loud, but
 *   as a Java stack trace about a null array rather than as anything a caller could act on.
 *
 * So both are refused by name, before anything is sent. The alternative for the second —
 * letting the device throw — is defensible and was rejected: the exception says nothing
 * about which character was the problem, and a caller told "`é` cannot be typed on this
 * device" can strip it, while a caller handed a stack trace cannot.
 */
const TYPEABLE = /^[\x20-\x7e]*$/;

/**
 * What `text` carries that this device will not type, as escapes a human can read back —
 * empty for a string it will.
 *
 * Escapes rather than the characters themselves, because most of what lands here is
 * invisible in a message: a tab, a non-breaking space and a zero-width joiner all print as
 * nothing or as a space, and a caller shown its own string back learns nothing from it.
 *
 * Answers rather than throws, and `./backend.ts` is what turns a non-empty answer into an
 * `UnsupportedTextError` — the error needs the serial, which is the caller's, not this
 * module's. Deduplicated and in first-seen order, so a paragraph of one wrong alphabet
 * names each letter once instead of five hundred times.
 */
export function untypeableCharacters(text: string): string[] {
	return [...new Set([...text].filter((character) => !TYPEABLE.test(character)))].map(
		(character) => {
			const code = character.codePointAt(0) ?? 0;
			return `U+${code.toString(16).toUpperCase().padStart(4, '0')} (${JSON.stringify(character)})`;
		},
	);
}

/**
 * The pieces to hand `input text`, in order, each still **unquoted** — quoting is
 * `../adb.js`'s `shellText` and happens at the call site.
 *
 * Normally one piece: `input text` types printable ASCII verbatim once the argument is one
 * shell word, spaces included, so the `%s` substitution every guide shows is not used here
 * at all.
 *
 * More than one piece only when the caller's text contains a literal `%s`, which is not
 * representable in a single call — `input text 'a%sb'` types `a b`. The string is cut
 * **between the `%` and the `s`** of each occurrence, so no piece contains the sequence and
 * the two halves arrive as themselves: `a%` then `sb` typed `a%sb` on API 37. This is the
 * one place where a caller's text costs more than one injection, and it is stated rather
 * than hidden: between two calls the focused field could change, so a `%s` in the middle of
 * a long string is a slightly weaker guarantee than the same string without one. The
 * alternative was refusing `%s` outright, which loses a legitimate string to protect
 * against a race nobody has seen.
 *
 * An empty string is one empty piece rather than none, so a `typeText` of `''` still
 * reaches the device and a device that has gone away is still reported.
 *
 * **Cutting only** — what the device will not type is {@link untypeableCharacters}, checked
 * by the caller before this runs. The two were one function and were split when the refusal
 * became an answer the wire carries (`src/verbs/failure.ts`): a rule that produces an error
 * needs the serial, and this one is arithmetic on a string.
 */
export function typeTextSegments(text: string): string[] {
	const segments: string[] = [];
	let start = 0;
	for (
		let found = text.indexOf(SPACE_ESCAPE, start);
		found !== -1;
		found = text.indexOf(SPACE_ESCAPE, start)
	) {
		// After the `%`, before the `s`: a trailing `%` and a leading `s` are each typed as
		// themselves, and neither piece can contain the sequence.
		const cut = found + 1;
		segments.push(text.slice(start, cut));
		start = cut;
	}
	segments.push(text.slice(start));

	return segments;
}

/**
 * A point in device-independent coordinates, as the physical pixels `input` takes.
 *
 * This conversion is the seam of the whole capability and it is invisible when it is wrong.
 * `PointSchema` is dp — `src/verbs/target.ts` range-checks against `screen.widthDp` — while
 * `input tap` takes pixels, and an unconverted dp point on a scale-3 device lands at a
 * third of the intended distance from the origin: on screen, plausible, and on the wrong
 * control. `scale` is `WmDensity.scale`, asked of the device (`./parsers/wm.js`); #13's
 * `readScreen` divides by the same number on the way back.
 *
 * **`Math.floor`, not `Math.round`**, because the question is which pixel a point is *in*,
 * not which pixel centre it is nearest: dp coordinates in `[i / scale, (i + 1) / scale)`
 * all lie inside pixel column `i`, and flooring is that mapping. A round is off by up to
 * half a pixel for every ordinary point, and at the far edge of the screen it is off by a
 * whole one — it turns a coordinate just inside the panel into `widthPx`, one column past
 * it, which `input tap` accepts without a word (exit 0, zero bytes, nothing tapped —
 * PROJECT.md §6).
 *
 * **The floor does not make that impossible, only vanishingly rare, and the difference is
 * worth stating.** In exact arithmetic `x < widthDp` gives `x * scale < widthPx` and the
 * floor lands in `[0, widthPx - 1]`. In binary floating point `widthDp` is `widthPx / scale`
 * rounded, so the single largest `x` the verb layer will admit can multiply back to exactly
 * `widthPx`: on the capture device `1280 / 3` is `426.6666666666667`, and that value times 3
 * is `1280`. One dp value out of the whole panel width, at the last column, produced by a
 * caller who asked for the very edge. Clamping it would need `widthPx`, which means a second
 * device query on the hot path of every injection, to move a tap that was already off the
 * last control by one pixel — so it is recorded rather than defended against.
 *
 * Non-finite coordinates are refused here rather than sent: `String(NaN)` is an argument
 * `input` rejects with a Java stack trace about invalid arguments, which is a true failure
 * wearing a disguise. The *range* is deliberately not checked — that needs a second query
 * and belongs to the layer that already holds the screen (D12).
 */
export function toDevicePixels(at: Point, scale: number): { x: number; y: number } {
	if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) {
		throw new Error(`Cannot tap at (${at.x}, ${at.y}): both coordinates must be finite numbers`);
	}
	if (!Number.isFinite(scale) || scale <= 0) {
		throw new Error(
			`Cannot convert a point at density scale ${scale}: it must be a positive number`,
		);
	}

	return { x: Math.floor(at.x * scale), y: Math.floor(at.y * scale) };
}

/**
 * The duration of a swipe, as the whole milliseconds `input swipe` takes.
 *
 * Rounded rather than floored, because this one is a duration and not a coordinate: there
 * is no last-addressable-value invariant to preserve, and the nearest millisecond is the
 * honest answer. Zero is allowed — `input swipe x y x y 0` is a flick, which is a thing a
 * caller can legitimately want; negative and non-finite are programmer errors and are
 * refused before anything reaches the device.
 */
export function toSwipeDuration(durationMs: number): number {
	if (!Number.isFinite(durationMs) || durationMs < 0) {
		throw new Error(
			`Cannot swipe for ${durationMs}ms: a duration must be a finite number of milliseconds, not negative`,
		);
	}
	return Math.round(durationMs);
}
