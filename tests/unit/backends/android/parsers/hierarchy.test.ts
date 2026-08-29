import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseUiHierarchy, type UiNode } from '@/backends/android/parsers/hierarchy.js';
import { parseWmSize } from '@/backends/android/parsers/wm.js';

const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const HIERARCHY = fixture('uiautomator.api37-sdk-gphone16k-arm64.xml');
const WM_SIZE = fixture('wm-size.api37-sdk-gphone16k-arm64.txt');

/**
 * Child indices from the root, so a test can name a node without asserting its way down.
 * All from the captured Settings → Display & touch dump; see `tests/fixtures/adb/README.md`.
 */
const DARK_THEME_SWITCH = [0, 0, 0, 1, 0, 0, 0, 0, 0, 6, 0, 2, 0];
const DISPLAY_SIZE_TITLE = [0, 0, 0, 1, 0, 0, 0, 0, 0, 7, 0, 0, 0];
const COLOR_CONTRAST_ROW = [0, 0, 0, 1, 0, 0, 0, 0, 0, 12];
const COLOR_CONTRAST_TITLE = [...COLOR_CONTRAST_ROW, 0, 0, 0];
const COLLAPSING_TOOLBAR = [0, 0, 0, 0, 0];

function descend(root: UiNode, path: readonly number[]): UiNode {
	return path.reduce((node, index) => {
		const child = node.children[index];
		if (!child) throw new Error(`no child ${index} under '${node.className}'`);
		return child;
	}, root);
}

describe('parseUiHierarchy', () => {
	it('reads the rotation and the root node of a real dump', () => {
		const { rotation, root } = parseUiHierarchy(HIERARCHY);

		expect(rotation).toBe(0);
		expect(root.className).toBe('android.widget.FrameLayout');
		expect(root.packageName).toBe('com.android.settings');
	});

	// Two fixtures captured independently from the same device agreeing is the strongest
	// evidence available that both parsers are reading reality rather than each other.
	it('agrees with the `wm size` fixture about how big the screen is', () => {
		const { bounds } = parseUiHierarchy(HIERARCHY).root;
		const { physical } = parseWmSize(WM_SIZE);

		expect({ width: bounds.width, height: bounds.height }).toEqual(physical);
	});

	it('reaches a nested node at its own depth with its text byte-exact', () => {
		const title = descend(parseUiHierarchy(HIERARCHY).root, DISPLAY_SIZE_TITLE);

		expect(title.className).toBe('android.widget.TextView');
		expect(title.resourceId).toBe('android:id/title');
		expect(title.text).toBe('Display size & text');
	});

	it('decodes the entities uiautomator writes into text and content-desc', () => {
		const root = parseUiHierarchy(HIERARCHY).root;

		expect(HIERARCHY).toContain('&amp;');
		expect(descend(root, DISPLAY_SIZE_TITLE).text).not.toContain('&amp;');
		expect(descend(root, COLLAPSING_TOOLBAR).contentDesc).toBe('Display & touch');
	});

	it('converts the strings the XML holds into booleans and numbers', () => {
		const root = parseUiHierarchy(HIERARCHY).root;
		const switchNode = descend(root, DARK_THEME_SWITCH);

		expect(switchNode.className).toBe('android.widget.Switch');
		expect(switchNode.contentDesc).toBe('Dark theme');
		// `checkable` and `checked` disagree here, so a mapping that confused the two would show.
		expect(switchNode.checkable).toBe(true);
		expect(switchNode.checked).toBe(false);
		expect(switchNode.clickable).toBe(true);
		expect(switchNode.scrollable).toBe(false);
		expect(descend(root, COLOR_CONTRAST_ROW).index).toBe(12);
	});

	it('keeps a single-child node an array', () => {
		const root = parseUiHierarchy(HIERARCHY).root;

		expect(root.children).toHaveLength(1);
		expect(root.children[0]?.className).toBe('android.widget.LinearLayout');
	});

	it('derives bounds in pixels, converting nothing to dp', () => {
		const switchNode = descend(parseUiHierarchy(HIERARCHY).root, DARK_THEME_SWITCH);

		expect(switchNode.bounds).toEqual({
			left: 1028,
			top: 1510,
			right: 1184,
			bottom: 1654,
			width: 156,
			height: 144,
		});
	});

	// API 37, captured: a row scrolled past the bottom of its container comes back with its
	// top below its bottom. Clamping the height to zero would invent a rectangle the device
	// never described (PROJECT.md §6).
	it('reports a row clipped by its scroll container with the negative height adb printed', () => {
		const clipped = descend(parseUiHierarchy(HIERARCHY).root, COLOR_CONTRAST_TITLE);

		expect(clipped.text).toBe('Color contrast');
		expect(clipped.bounds).toMatchObject({ top: 2798, bottom: 2784, height: -14 });
	});
});

describe('parseUiHierarchy, on input it cannot trust', () => {
	it('throws on empty output', () => {
		expect(() => parseUiHierarchy('')).toThrow(/no <hierarchy> element/);
	});

	// Each case is the captured dump with one thing broken, rather than a document written
	// from memory — the same trick `getprop.test.ts` uses to build a negative case.
	it('throws naming the class and the raw value when bounds are malformed', () => {
		const corrupted = HIERARCHY.replace('bounds="[1028,1510][1184,1654]"', 'bounds="[1028,1510]"');

		expect(corrupted).not.toBe(HIERARCHY);
		expect(() => parseUiHierarchy(corrupted)).toThrow(/android\.widget\.Switch/);
		expect(() => parseUiHierarchy(corrupted)).toThrow(/\[1028,1510\]/);
	});

	it('throws rather than assuming portrait when the rotation is missing', () => {
		const corrupted = HIERARCHY.replace('<hierarchy rotation="0">', '<hierarchy>');

		expect(corrupted).not.toBe(HIERARCHY);
		expect(() => parseUiHierarchy(corrupted)).toThrow(/no rotation attribute/);
	});

	it('refuses a dump with more than one root node rather than reading only the first', () => {
		const bodyStart = HIERARCHY.indexOf('>', HIERARCHY.indexOf('<hierarchy')) + 1;
		const bodyEnd = HIERARCHY.lastIndexOf('</hierarchy>');
		const secondWindow = HIERARCHY.slice(bodyStart, bodyEnd);
		const twoWindows = HIERARCHY.slice(0, bodyEnd) + secondWindow + HIERARCHY.slice(bodyEnd);

		expect(() => parseUiHierarchy(twoWindows)).toThrow(/exactly one root <node>, found 2/);
	});
});
