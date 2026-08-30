import { describe, expect, it } from 'vitest';
import { shellText } from '@/backends/android/adb.js';
import {
	KEY_CODES,
	toDevicePixels,
	toSwipeDuration,
	typeTextSegments,
	untypeableCharacters,
} from '@/backends/android/input.js';
import { DeviceKeySchema } from '@/core/device.js';

/**
 * The pure half of the input primitives — the keycode table, the dp→px arithmetic and the
 * text rules. No process and no device (ai/TESTING.md); what a device does with any of it
 * was measured first and is recorded in PROJECT.md §6, and
 * `tests/device/android/input.test.ts` is the half that keeps that honest.
 *
 * Every text case below is one the device was actually asked. The comments say what came
 * back, because that — not this file — is the reason each rule is the shape it is.
 */

describe('KEY_CODES', () => {
	/**
	 * Pinned literally rather than derived, and worth the tedium here more than anywhere
	 * else in this backend: `input keyevent NOT_A_KEY` exits 0 with zero bytes on both
	 * streams (PROJECT.md §6), so a typo in this table is a key that reports success and
	 * does nothing. Nothing at runtime can see that, and no device test can either.
	 */
	it('maps every key of the vocabulary to the keycode measured on a device', () => {
		expect(KEY_CODES).toEqual({
			back: 'KEYCODE_BACK',
			home: 'KEYCODE_HOME',
			recents: 'KEYCODE_APP_SWITCH',
			wake: 'KEYCODE_WAKEUP',
		});
	});

	// The compile-time exhaustiveness is `satisfies Record<DeviceKey, string>`; this is the
	// runtime half, so a key added to the enum without an entry here is red rather than
	// `undefined` reaching a command line.
	it('covers the whole DeviceKey vocabulary and nothing else', () => {
		expect(Object.keys(KEY_CODES).sort()).toEqual([...DeviceKeySchema.options].sort());
	});

	/**
	 * `wake` must not be `KEYCODE_POWER`. Power toggles, so a `wake` built on it puts an
	 * already-woken device to sleep — a verb that does the opposite of its name on half the
	 * devices it runs on, silently.
	 */
	it('wakes with KEYCODE_WAKEUP rather than the toggle', () => {
		expect(KEY_CODES.wake).toBe('KEYCODE_WAKEUP');
		expect(Object.values(KEY_CODES)).not.toContain('KEYCODE_POWER');
	});
});

/**
 * The two refusals, and the difference between them is why both are refused before the call
 * rather than left to the device:
 *
 * - a tab or a newline is **dropped in silence** — exit 0, zero bytes, the surrounding
 *   characters typed as if the caller never asked;
 * - a non-ASCII character throws `NullPointerException` inside the device at exit 255 and
 *   types nothing at all, naming no character.
 */
describe('untypeableCharacters', () => {
	it.each([
		['a tab', 'a\tb', 'U+0009'],
		['a newline', 'a\nb', 'U+000A'],
		['Latin beyond ASCII', 'zażółć', 'U+017C'],
		['a non-Latin script', '日本語', 'U+65E5'],
		['an astral-plane character', 'a🙂b', 'U+1F642'],
	])('names the character of %s', (_what, text, codepoint) => {
		expect(untypeableCharacters(text).join(' ')).toContain(codepoint);
	});

	// Every printable ASCII character typed verbatim in one call on API 37, so none of them is
	// here — including the space, which is content and not formatting.
	it.each([
		'hello world',
		"don't",
		'100%',
		'a%sb',
		'  padded  ',
		'',
	])('finds nothing to refuse in %p', (text) => {
		expect(untypeableCharacters(text)).toEqual([]);
	});

	// A paragraph of one wrong alphabet should name each letter once, not once per occurrence.
	it('names each character once, in the order it was first seen', () => {
		expect(untypeableCharacters('éé😀é😀')).toEqual(['U+00E9 ("é")', 'U+1F600 ("😀")']);
	});

	// The escape, not the character: a tab and four spaces are the same picture in a message.
	it('answers escapes a human can read back rather than the characters themselves', () => {
		expect(untypeableCharacters('a\tb')).toEqual(['U+0009 ("\\t")']);
	});
});

describe('toDevicePixels', () => {
	// The capture device: 1280×2856 at density 480, so scale 3 and 426.66… dp across.
	it('multiplies by the density scale', () => {
		expect(toDevicePixels({ x: 100, y: 200 }, 3)).toEqual({ x: 300, y: 600 });
	});

	it('is the identity at scale 1, where dp and pixels coincide', () => {
		expect(toDevicePixels({ x: 640, y: 1428 }, 1)).toEqual({ x: 640, y: 1428 });
	});

	it('handles a fractional scale', () => {
		// 2.75 is `wm density 440`, an extremely common phone density.
		expect(toDevicePixels({ x: 100, y: 100 }, 2.75)).toEqual({ x: 275, y: 275 });
	});

	/**
	 * Why this is not `Math.round`: a dp coordinate inside the last pixel column has to land
	 * on that column, and a round pushes it one past the panel — where `input tap` does
	 * nothing and says nothing (PROJECT.md §6).
	 */
	it('keeps a coordinate inside the last pixel column on that column', () => {
		const widthPx = 1280;
		const scale = 3;
		const insideLastColumn = (widthPx - 0.5) / scale;

		expect(toDevicePixels({ x: insideLastColumn, y: 0 }, scale).x).toBe(widthPx - 1);
		// What the alternative would have done with the same point.
		expect(Math.round(insideLastColumn * scale)).toBe(widthPx);
	});

	/**
	 * The one case the floor does **not** cover, pinned so it stays a known limit rather
	 * than a surprise. `widthDp` is `widthPx / scale` rounded to a double, so the largest
	 * `x` the verb layer admits can multiply back to exactly `widthPx` — one column past
	 * the panel. Clamping it would cost a `wm size` query on every injection to move a tap
	 * that already missed the last control by a pixel; the module comment records the
	 * trade rather than paying for it.
	 */
	it('can still reach one column past the panel at the exact floating-point edge', () => {
		const widthPx = 1280;
		const scale = 3;
		const widthDp = widthPx / scale; // 426.6666666666667, not the exact quotient

		expect(toDevicePixels({ x: widthDp, y: 0 }, scale).x).toBe(widthPx);
	});

	it('keeps the origin at the origin', () => {
		expect(toDevicePixels({ x: 0, y: 0 }, 3)).toEqual({ x: 0, y: 0 });
	});

	// `String(NaN)` is an argument `input` answers with a Java stack trace about invalid
	// arguments — a programmer error arriving as a device failure. Refused before the call.
	it.each([
		['x', { x: Number.NaN, y: 1 }],
		['y', { x: 1, y: Number.POSITIVE_INFINITY }],
	])('refuses a non-finite %s rather than sending it', (_axis, point) => {
		expect(() => toDevicePixels(point, 3)).toThrow(/finite/);
	});

	it('refuses a scale that is not a positive number', () => {
		expect(() => toDevicePixels({ x: 1, y: 1 }, 0)).toThrow(/positive/);
		expect(() => toDevicePixels({ x: 1, y: 1 }, Number.NaN)).toThrow(/positive/);
	});
});

describe('toSwipeDuration', () => {
	it('rounds to whole milliseconds', () => {
		expect(toSwipeDuration(299.6)).toBe(300);
		expect(toSwipeDuration(300)).toBe(300);
	});

	// A flick is a swipe with no hold, and a caller can legitimately want one.
	it('allows zero', () => {
		expect(toSwipeDuration(0)).toBe(0);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('refuses %p', (durationMs) => {
		expect(() => toSwipeDuration(durationMs)).toThrow(/duration/);
	});
});

describe('typeTextSegments', () => {
	it('leaves ordinary text as one segment', () => {
		expect(typeTextSegments('hello')).toEqual(['hello']);
	});

	/**
	 * The `%s` substitution every guide shows is not used here at all. Once the argument is
	 * one shell word, `input text 'hello world'` typed `hello world` — so a space is a space
	 * and needs no escape.
	 */
	it('does not split on a space, because quoting already carries one', () => {
		expect(typeTextSegments('hello world')).toEqual(['hello world']);
		expect(typeTextSegments('a  b')).toEqual(['a  b']);
	});

	// Measured: `input text 'a%sb'` typed `a b`. So the caller's literal `%s` is cut between
	// the `%` and the `s`, and `a%` followed by `sb` typed `a%sb`.
	it('cuts a literal %s so each piece is typed as itself', () => {
		expect(typeTextSegments('a%sb')).toEqual(['a%', 'sb']);
		expect(typeTextSegments('%s')).toEqual(['%', 's']);
	});

	it('cuts every occurrence, including overlapping ones', () => {
		expect(typeTextSegments('%%s')).toEqual(['%%', 's']);
		expect(typeTextSegments('%s%s')).toEqual(['%', 's%', 's']);
	});

	/** The rejoined pieces are always the caller's string — the cut adds and drops nothing. */
	it.each([
		'a%sb',
		'%s',
		'%%s',
		'%s%s',
		'a %s b %s c',
	])('rejoins to the original for %p', (text) => {
		expect(typeTextSegments(text).join('')).toBe(text);
	});

	// Measured: `100%` typed `100%`, `%S` typed `%S`, `a%` typed `a%`. Only the literal
	// lowercase `%s` is read by `input text`.
	it.each(['100%', '%S', 'a%', '%%'])('leaves %p alone — only lowercase %%s is special', (text) => {
		expect(typeTextSegments(text)).toEqual([text]);
	});

	/**
	 * One empty piece rather than none, so `typeText('')` still reaches the device: typing
	 * nothing on a device that has gone away should report the device, not resolve.
	 */
	it('answers one empty segment for an empty string', () => {
		expect(typeTextSegments('')).toEqual(['']);
	});

	// Every printable ASCII character typed verbatim in one call on API 37.
	it('accepts the whole printable ASCII range in one segment', () => {
		const printable = Array.from({ length: 0x7f - 0x20 }, (_, index) =>
			String.fromCharCode(0x20 + index),
		)
			.join('')
			.replace('%s', '%'); // the one sequence that is not a character
		expect(typeTextSegments(printable)).toEqual([printable]);
	});

	/**
	 * Cutting only. What the device will not type is {@link untypeableCharacters}, below, and
	 * `./backend.ts` asks that before it asks this — so nothing here has an opinion about a
	 * string it is handed.
	 */
	it('cuts a string the device would refuse, because refusing is not its job', () => {
		expect(typeTextSegments('café')).toEqual(['café']);
	});

	/**
	 * The seam with the quoter: what this answers is **unquoted**, and `shellText` is what
	 * makes each piece one word on the device. Asserted together because a segmenter that
	 * quoted its own output would double-quote everything at the call site, and the failure
	 * would be a device typing quote marks rather than an error.
	 */
	it('answers unquoted pieces, which shellText then makes one shell word each', () => {
		expect(typeTextSegments("don't")).toEqual(["don't"]);
		expect(shellText("don't")).toBe("'don'\\''t'");
	});
});
