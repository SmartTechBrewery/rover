import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSystemBarInsets } from '@/backends/android/parsers/insets.js';

const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const DISPLAYS = fixture('dumpsys-window-d.api37-sdk-gphone16k-arm64.txt');

/** The device the fixture was captured on, `wm size`'s effective dimensions. */
const SCREEN = { width: 1280, height: 2856 };

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
