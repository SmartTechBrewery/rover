import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseUiHierarchy } from '@/backends/android/parsers/hierarchy.js';
import { parseWmDensity, parseWmSize } from '@/backends/android/parsers/wm.js';
import { toScreenElements } from '@/backends/android/screen.js';
import { ScreenElementSchema } from '@/core/device.js';

/**
 * Driven off the same **captured** dump `parsers/hierarchy.test.ts` parses — an API 37
 * emulator (`sdk_gphone16k_arm64`), Settings → Display & touch, 75 nodes
 * (`tests/fixtures/adb/README.md`). What this proves is the mapping and the arithmetic;
 * that the numbers describe a real screen is `tests/device/android/backend.test.ts`'s
 * (ai/TESTING.md).
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

const HIERARCHY = fixture('uiautomator.api37-sdk-gphone16k-arm64.xml');
const WM_SIZE = fixture('wm-size.api37-sdk-gphone16k-arm64.txt');
const WM_DENSITY = fixture('wm-density.api37-sdk-gphone16k-arm64.txt');

const hierarchy = parseUiHierarchy(HIERARCHY);
/** 3, from the same device the hierarchy came off — 480 dpi over the 160 dpi baseline. */
const SCALE = parseWmDensity(WM_DENSITY).scale;
/** Deliberately not a whole number, so an accidental round shows up as a mismatch. */
const ODD_SCALE = 2.75;

/** The captured node scrolled past the bottom of its container — a height of -14 px. */
const CLIPPED = { left: 96, top: 2798, right: 399, bottom: 2784 };

describe('toScreenElements', () => {
	it('answers one element per node of the dump, and every one is a valid ScreenElement', () => {
		const elements = toScreenElements(hierarchy, SCALE);

		expect(elements).toHaveLength(HIERARCHY.split('<node').length - 1);
		for (const element of elements) expect(() => ScreenElementSchema.parse(element)).not.toThrow();
	});

	// Pre-order and unfiltered together: the root is first, and a container carrying no text
	// is present rather than dropped, because `scroll` addresses exactly those.
	it('walks depth-first pre-order, keeping the nodes that carry no content', () => {
		const elements = toScreenElements(hierarchy, SCALE);

		expect(elements[0].id).toBe('0');
		expect(elements.slice(0, 6).map((element) => element.id)).toEqual([
			'0',
			'0.0',
			'0.0.0',
			'0.0.0.0',
			'0.0.0.0.0',
			'0.0.0.0.0.0',
		]);
		expect(elements.some((element) => element.text === null && element.label === null)).toBe(true);
	});

	/**
	 * `findOnScreen()` filters on `element.id === target.id` and `src/verbs/errors.ts` treats
	 * two hits as the backend contradicting itself, so a repeat here is not a cosmetic flaw.
	 * The device's own `index` attribute repeats between differently parented nodes, which is
	 * why the id is the walk's ordinal path instead.
	 */
	it('gives every element of one read an id no other element has', () => {
		const ids = toScreenElements(hierarchy, SCALE).map((element) => element.id);

		expect(new Set(ids).size).toBe(ids.length);
	});

	it('gives the same node the same id on a second read of the same tree', () => {
		expect(toScreenElements(hierarchy, SCALE)).toEqual(toScreenElements(hierarchy, SCALE));
	});

	it('carries text and label across from the node that has them', () => {
		const elements = toScreenElements(hierarchy, SCALE);
		const title = elements.find((element) => element.text === 'Display size & text');

		expect(title).toBeDefined();
		expect(elements.some((element) => element.label === 'Navigate up')).toBe(true);
	});

	// `ScreenElement`'s two fields are nullable so that "carries neither" is representable;
	// an empty string would read as content that is not there, and would match a substring
	// target for `''`.
	it('reports an absent text or content-desc as null rather than an empty string', () => {
		const elements = toScreenElements(hierarchy, SCALE);

		expect(elements.every((element) => element.text !== '')).toBe(true);
		expect(elements.every((element) => element.label !== '')).toBe(true);
		expect(elements[0]).toMatchObject({ text: null, label: null });
	});

	/**
	 * The one assertion that catches a missing px→dp conversion. Asserted against the
	 * arithmetic rather than a rounded literal, because "exact quotient" is the claim.
	 */
	it('divides the device pixels by the scale exactly, at a whole scale and an odd one', () => {
		const { physical } = parseWmSize(WM_SIZE);

		for (const scale of [SCALE, ODD_SCALE]) {
			expect(toScreenElements(hierarchy, scale)[0].bounds).toEqual({
				x: 0,
				y: 0,
				width: physical.width / scale,
				height: physical.height / scale,
			});
		}
	});

	it('leaves the quotient unrounded', () => {
		const [root] = toScreenElements(hierarchy, ODD_SCALE);

		expect(Number.isInteger(root.bounds.width)).toBe(false);
		expect(root.bounds.width).toBeCloseTo(1280 / ODD_SCALE, 12);
	});

	/**
	 * `requireAddressable()` in `src/verbs/target.ts` reads this sign to raise
	 * `UnaddressableElementError` rather than tapping arithmetic. Clamping it here would
	 * delete the only evidence that layer has.
	 */
	it('preserves the negative height of the row clipped by its scrolling container', () => {
		const clipped = toScreenElements(hierarchy, SCALE).find(
			(element) =>
				element.bounds.x === CLIPPED.left / SCALE && element.bounds.y === CLIPPED.top / SCALE,
		);

		expect(HIERARCHY).toContain('bounds="[96,2798][399,2784]"');
		expect(clipped?.bounds.height).toBe((CLIPPED.bottom - CLIPPED.top) / SCALE);
		expect(clipped?.bounds.height).toBeLessThan(0);
	});

	// A NaN scale would otherwise turn every rectangle on the screen into NaNs that read as
	// a device with no geometry — the same refusal `toDevicePixels` makes.
	it.each([
		0,
		-3,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])('refuses a scale of %p by name', (scale) => {
		expect(() => toScreenElements(hierarchy, scale)).toThrow(/density scale/);
	});
});
