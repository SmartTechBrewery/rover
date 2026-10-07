import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	parseForegroundApp,
	parseKeyboard,
	parseSystemBarInsets,
} from '@/backends/android/parsers/insets.js';

const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const DISPLAYS = fixture('dumpsys-window-d.api37-sdk-gphone16k-arm64.txt');
const KEYBOARD_SHOWN = fixture('dumpsys-window-d.keyboard-shown.api37-sdk-gphone16k-arm64.txt');
const API33_KEYBOARD_SHOWN = fixture('dumpsys-window-d.keyboard-shown.api33-tc58.txt');
const API33_KEYBOARD_DISMISSED = fixture('dumpsys-window-d.keyboard-dismissed.api33-tc58.txt');
const API33_NOTIFICATION_SHADE = fixture('dumpsys-window-d.notification-shade.api33-tc58.txt');
const API33_AFTER_CRASH = fixture('dumpsys-window-d.after-crash.api33-tc58.txt');
const API33_CRASH_DIALOG = fixture('dumpsys-window-d.crash-dialog.api33-tc58.txt');
const API33_FOCUSED_APP_NULL = fixture('dumpsys-window-d.focused-app-null.api33-tc58.txt');

/** The device the fixture was captured on, `wm size`'s effective dimensions. */
const SCREEN = { width: 1280, height: 2856 };

/** `wm density`'s scale on that same device: 480 dpi, so three pixels to the dp. */
const SCALE = 3;

describe('parseSystemBarInsets', () => {
	/**
	 * **The numbers in this test are the reason the feature is not a constant.** 156 px at
	 * `densityScale` 3 is 52 dp, where every guide quotes a 24 dp status bar — so a band written
	 * from memory would have been wrong by more than half on the first device it met (PROJECT.md
	 * §6). The bottom 72 px is the gesture bar of the same device.
	 */
	it('reads both bars off a real displays dump', () => {
		expect(parseSystemBarInsets(DISPLAYS, SCREEN)).toEqual({
			top: 156,
			bottom: 72,
			left: 0,
			right: 0,
		});
	});

	/**
	 * The same sources appear twice in that dump — once in `InsetsState`, once under
	 * `InsetsSourceProviders` prefixed `mSource=` — and only the first form may match, or one bar
	 * would be counted as two answers about one edge.
	 */
	it('reads the InsetsState block and not the providers that repeat it', () => {
		const providersOnly = DISPLAYS.replace(
			/^([ \t]*)InsetsSource id=/gm,
			'$1mSource=InsetsSource id=',
		);

		expect(parseSystemBarInsets(providersOnly, SCREEN)).toEqual({
			top: 0,
			bottom: 0,
			left: 0,
			right: 0,
		});
	});

	it('tolerates the CRLF that `adb shell` sometimes returns', () => {
		expect(parseSystemBarInsets(DISPLAYS.replace(/\n/g, '\r\n'), SCREEN)).toEqual({
			top: 156,
			bottom: 72,
			left: 0,
			right: 0,
		});
	});

	/**
	 * **`null` is *this device did not say* and four zeros are *this device draws no bars*.** They
	 * must not fold together: the first leaves a consumer with nothing to set aside, the second
	 * tells it there is nothing to set aside, and a screenshot filter behaves differently for each.
	 */
	it('answers null for a dump with no insets state at all', () => {
		expect(
			parseSystemBarInsets('WINDOW MANAGER DISPLAY CONTENTS\n  Display: mDisplayId=0\n', SCREEN),
		).toBeNull();
	});

	it('answers zeros for an insets state with no visible bars in it', () => {
		const hidden = DISPLAYS.replace(
			/(type=(?:statusBars|navigationBars)[^\n]*?)visible=true/g,
			'$1visible=false',
		);

		expect(parseSystemBarInsets(hidden, SCREEN)).toEqual({
			top: 0,
			bottom: 0,
			left: 0,
			right: 0,
		});
	});

	/**
	 * A source whose frame does not span an edge is not a band of pixels anything can be set aside
	 * for, and the empty `[0,0][0,0]` this dump uses for an absent source is the common case of
	 * that. Turning either into an inset would hide part of the screen on the strength of a
	 * rectangle that is not on it.
	 */
	it('ignores a source that does not span an edge', () => {
		const floating = [
			'  InsetsState',
			'    InsetsSource id=1 type=statusBars frame=[100,0][200,156] visible=true flags= sideHint=TOP',
			'    InsetsSource id=2 type=navigationBars frame=[0,0][0,0] visible=true flags= sideHint=NONE',
		].join('\n');

		expect(parseSystemBarInsets(floating, SCREEN)).toEqual({
			top: 0,
			bottom: 0,
			left: 0,
			right: 0,
		});
	});

	/** Landscape: the bars reach in from the sides, and the same geometry answers for them. */
	it('reads a bar that reaches in from the left or the right', () => {
		const landscape = [
			'  InsetsState',
			'    InsetsSource id=1 type=statusBars frame=[0,0][156,1280] visible=true flags= sideHint=LEFT',
			'    InsetsSource id=2 type=navigationBars frame=[2784,0][2856,1280] visible=true flags= sideHint=RIGHT',
		].join('\n');

		expect(parseSystemBarInsets(landscape, { width: 2856, height: 1280 })).toEqual({
			top: 0,
			bottom: 0,
			left: 156,
			right: 72,
		});
	});

	/** Two sources reaching in from one edge: the inset a consumer needs clears both. */
	it('takes the deeper of two sources on one side', () => {
		const stacked = [
			'  InsetsState',
			'    InsetsSource id=1 type=statusBars frame=[0,0][1280,156] visible=true flags= sideHint=TOP',
			'    InsetsSource id=2 type=navigationBars frame=[0,0][1280,192] visible=true flags= sideHint=TOP',
		].join('\n');

		expect(parseSystemBarInsets(stacked, SCREEN)?.top).toBe(192);
	});
});

describe('parseKeyboard', () => {
	/**
	 * **Both captures are of the same device on the same build**, taken minutes apart with and
	 * without a text field focused (API 37 / Android 17, `PROJECT.md` §6) — which is what makes
	 * the pair evidence rather than a guess about a format.
	 *
	 * The open frame is `[0,1848][1280,2856]` in the device's own pixels. Over a `densityScale`
	 * of 3 that is `x = 0`, `y = 616`, `width = 1280/3`, `height = 336` dp — the same space
	 * `ScreenElement.bounds` is stated in, because what this rectangle gets compared against is a
	 * touch point. The width is deliberately left as the exact quotient: 1280 over 3 is not a
	 * whole number of dp, and rounding it here would leave no way to ask what the device said.
	 */
	it('reads the keyboard rectangle in dp off a dump captured with it open', () => {
		expect(parseKeyboard(KEYBOARD_SHOWN, SCALE)).toEqual({
			shown: true,
			bounds: { x: 0, y: 616, width: 1280 / 3, height: 336 },
		});
	});

	/**
	 * The companion capture, with nothing focused: the `type=ime` source is still printed, with
	 * `frame=[0,0][0,0]` and `visible=false`.
	 *
	 * **Its `visibleFrame` is `[0,2712][1280,2856]` and is deliberately not read.** That is a
	 * 144 px band at the bottom of a screen with no keyboard on it, so a parser that preferred
	 * `visibleFrame` would report a rectangle for a keyboard that is down — which is exactly the
	 * false fact phase 3 would then refuse a legitimate tap against.
	 */
	it('answers shown false with no rectangle when the device says the keyboard is down', () => {
		expect(parseKeyboard(DISPLAYS, SCALE)).toEqual({ shown: false, bounds: null });
	});

	/**
	 * **`null` is *this device did not say*, and `{ shown: false }` is *no keyboard is up*.** They
	 * must not fold together, for `parseSystemBarInsets`' reason one describe above: the first
	 * leaves a consumer knowing nothing about what covers the screen, the second is the device
	 * stating that nothing does.
	 */
	it('answers null for a dump with no insets state at all', () => {
		expect(
			parseKeyboard('WINDOW MANAGER DISPLAY CONTENTS\n  Display: mDisplayId=0\n', SCALE),
		).toBeNull();
	});

	/**
	 * Observed on the capture device right after an application restart: the block is printed and
	 * carries no `ime` source at all. A device that answered, with no keyboard up.
	 */
	it('answers shown false for an insets state that names no ime source', () => {
		const barsOnly = [
			'  InsetsState',
			'    InsetsSource id=1 type=statusBars frame=[0,0][1280,156] visible=true flags= sideHint=TOP',
		].join('\n');

		expect(parseKeyboard(barsOnly, SCALE)).toEqual({ shown: false, bounds: null });
	});

	/**
	 * The `mSource=` repeats under `InsetsSourceProviders` carry the identical line, and only the
	 * `InsetsState` form may match — the same anchoring `parseSystemBarInsets` relies on. Stripped
	 * of the first form, the shown capture must stop reading as a keyboard that is up.
	 */
	it('reads the InsetsState block and not the providers that repeat it', () => {
		const providersOnly = KEYBOARD_SHOWN.replace(
			/^([ \t]*)InsetsSource id=/gm,
			'$1mSource=InsetsSource id=',
		);

		expect(parseKeyboard(providersOnly, SCALE)).toEqual({ shown: false, bounds: null });
	});

	it('tolerates the CRLF that `adb shell` sometimes returns', () => {
		expect(parseKeyboard(KEYBOARD_SHOWN.replace(/\n/g, '\r\n'), SCALE)).toEqual({
			shown: true,
			bounds: { x: 0, y: 616, width: 1280 / 3, height: 336 },
		});
	});

	/**
	 * **`shown: true` with no rectangle is a real answer and the hardest one to get right.** The
	 * device said the keyboard is up and gave the empty frame it uses for an absent source, so
	 * something is covering the screen and this device did not say where. Reporting `shown: false`
	 * would turn that into *nothing is covered*; inventing a rectangle would be worse still.
	 */
	it('answers shown with no rectangle for a visible source whose frame is degenerate', () => {
		const degenerate = [
			'  InsetsState',
			'    InsetsSource id=3 type=ime frame=[0,0][0,0] visibleFrame=[0,1848][1280,2856] visible=true flags= sideHint=BOTTOM',
		].join('\n');

		expect(parseKeyboard(degenerate, SCALE)).toEqual({ shown: true, bounds: null });
	});

	/**
	 * **API 33 prints the line without an `id=` and names the type `ITYPE_IME`**
	 * (`InsetsSource type=ITYPE_IME frame=[0,1251][1080,2160] … visible=true`, a Zebra TC58 at
	 * 480 dpi, `PROJECT.md` §6). A parser that knew only the API 37 line answered `shown: false`
	 * here with the keyboard covering the bottom 909 px — so `hide_keyboard` would have pressed
	 * nothing and said `ok`. Over a scale of 3 the frame is `y = 417`, `width = 360`, `height = 303`.
	 */
	it('reads the keyboard off an API 33 dump, which names the source ITYPE_IME and gives it no id', () => {
		expect(parseKeyboard(API33_KEYBOARD_SHOWN, SCALE)).toEqual({
			shown: true,
			bounds: { x: 0, y: 417, width: 360, height: 303 },
		});
	});

	/** The same device after `input keyevent KEYCODE_BACK` closed it, once the animation ended. */
	it('answers shown false off the API 33 dump taken after the keyboard was dismissed', () => {
		expect(parseKeyboard(API33_KEYBOARD_DISMISSED, SCALE)).toEqual({ shown: false, bounds: null });
	});

	/** The scale divides every number here, so a `NaN` one would silently poison the rectangle. */
	it.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])('refuses a density scale of %s by name', (scale) => {
		expect(() => parseKeyboard(KEYBOARD_SHOWN, scale)).toThrow(
			`Cannot read the on-screen keyboard at density scale ${scale}`,
		);
	});
});

describe('parseForegroundApp', () => {
	it('names the launcher off a dump taken with nothing else in front', () => {
		expect(parseForegroundApp(DISPLAYS)).toBe('com.google.android.apps.nexuslauncher');
	});

	// A keyboard that is up is a window of its own, and it does not displace the application.
	it('names the application under a keyboard that is up', () => {
		expect(parseForegroundApp(KEYBOARD_SHOWN)).toBe('com.google.android.settings.intelligence');
		expect(parseForegroundApp(API33_KEYBOARD_SHOWN)).toBe(
			'com.google.android.googlequicksearchbox',
		);
	});

	// API 33 closes the record with a stray second `}` (`… t224}`), which is why nothing after the
	// package is matched.
	it('reads the older line shape', () => {
		expect(parseForegroundApp(API33_KEYBOARD_DISMISSED)).toBe(
			'com.google.android.googlequicksearchbox',
		);
	});

	/**
	 * **The case that decides `mFocusedApp` over `mCurrentFocus`.** With the shade down over
	 * Settings the focused *window* is `NotificationShade` and a screen read's root is
	 * `com.android.systemui`, while the application in front is still Settings.
	 */
	it('names the application, not the notification shade drawn over it', () => {
		expect(API33_NOTIFICATION_SHADE).toMatch(/mCurrentFocus=Window\{\S+ u0 NotificationShade\}/);
		expect(parseForegroundApp(API33_NOTIFICATION_SHADE)).toBe('com.android.settings');
	});

	// The read the issue's acceptance criterion is about: the first dump after `am crash`, in which
	// the focused window is already `null` and the focused application is the launcher.
	it('names the launcher in the first dump after the application crashed', () => {
		expect(API33_AFTER_CRASH).toMatch(/mCurrentFocus=null/);
		expect(parseForegroundApp(API33_AFTER_CRASH)).toBe('com.android.launcher3');
	});

	// The *keeps stopping* dialog is a window titled after the app, and the activity manager reports
	// that app's activity resumed behind it — so that is what is in front, and what is answered.
	it('names the application a crash dialog is drawn over, not the dialog', () => {
		expect(API33_CRASH_DIALOG).toMatch(/mCurrentFocus=Window\{\S+ u0 Application Error: /);
		expect(parseForegroundApp(API33_CRASH_DIALOG)).toBe('com.android.settings');
	});

	/**
	 * **A responsive device really prints `mFocusedApp=null`**: this capture is the launcher in
	 * front, focused and resumed, after that dialog was dismissed with `back`. `null` is the
	 * device not saying, which is what the field's `null` means.
	 */
	it('answers null for a device that prints no focused application', () => {
		expect(API33_FOCUSED_APP_NULL).toMatch(/^[ \t]*mFocusedApp=null$/m);
		expect(parseForegroundApp(API33_FOCUSED_APP_NULL)).toBeNull();
	});

	it('answers null for a dump with no such line at all', () => {
		expect(parseForegroundApp('')).toBeNull();
		expect(parseForegroundApp(DISPLAYS.replace(/^[ \t]*mFocusedApp=.*$/m, ''))).toBeNull();
	});

	// A line this does not recognise costs this one fact, never the whole of `device_info`.
	it('answers null rather than throwing for a line of another shape', () => {
		const odd = DISPLAYS.replace(/^([ \t]*mFocusedApp=ActivityRecord\{\S+ u0 )\S+/m, '$1/x');
		expect(odd).toMatch(/mFocusedApp=ActivityRecord\{\S+ u0 \/x/);
		expect(parseForegroundApp(odd)).toBeNull();
	});

	it('reads CRLF output the same way', () => {
		expect(parseForegroundApp(API33_AFTER_CRASH.replace(/\n/g, '\r\n'))).toBe(
			'com.android.launcher3',
		);
	});
});
