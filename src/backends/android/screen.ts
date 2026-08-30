/**
 * The parsed view hierarchy, as the neutral `ScreenElement[]` the contract answers with.
 *
 * Sibling in spirit to `./input.ts`: pure arithmetic and vocabulary, no process. `./adb.js`
 * owns the calls, `./parsers/hierarchy.js` owns the XML, and this owns the mapping — which
 * is the layer that parser's header defers the px→dp conversion to ("applied a layer up
 * (R5, R13)"). Nothing here spawns anything, so every rule below is asserted in
 * `tests/unit/backends/android/screen.test.ts` against the captured 28 KB hierarchy rather
 * than against a device.
 *
 * Four decisions, each load-bearing:
 *
 * - **Every node, depth-first pre-order, unfiltered.** A container with no text is exactly
 *   what `scroll`'s `ScrollOptions.target` addresses (`src/verbs/input.ts`), and deciding
 *   which nodes are "interesting" is a policy the verb layer already applies by matching on
 *   text — a backend that dropped them would be answering a question it was not asked.
 *   `describeScreen()` already bounds what reaches a message, so a long list costs nothing
 *   there.
 * - **The id is the child-ordinal path** this walk computes (`0`, `0.1.3`), **not** the
 *   node's `index` attribute — which is the device's, repeats between differently parented
 *   nodes and may be absent. Uniqueness within one read is what `findOnScreen()` needs: it
 *   filters on `element.id === target.id` and treats two hits as the backend contradicting
 *   itself (`src/verbs/errors.ts`).
 * - **Empty text is `null`.** `ScreenElement`'s two fields are nullable precisely so
 *   "carries neither" is representable; an empty string reads as content that is not there,
 *   and would match a substring target for `''`.
 * - **Bounds are exact quotients, and a negative one survives.** See {@link toScreenElements}.
 *
 * **The id is stable only for as long as the tree shape is**, and that limit is the honest
 * claim rather than a caveat. Insert a row above an element and every id below it moves. A
 * caller that remembers one across a turn and resolves it against a changed tree has built
 * D12(a)'s remembered coordinate wearing a different hat — which is why the verb layer
 * re-reads the screen inside every verb instead.
 */

import type { ScreenElement } from '../../core/device.js';
import { parseElementId } from '../../core/ids.js';
import type { UiHierarchy, UiNode } from './parsers/hierarchy.js';

/** What joins one child ordinal to the next in an element id. */
const ID_SEPARATOR = '.';

/** `''` is "carries neither", which `ScreenElement` spells `null`. */
function content(value: string): string | null {
	return value.length === 0 ? null : value;
}

/**
 * Flatten the tree, pre-order, appending each node's ordinal to its parent's id.
 *
 * Recursive rather than an explicit stack: the depth of a view hierarchy is bounded by
 * what a layout engine will lay out — the captured 75-node fixture is 14 deep — and the
 * recursion reads as the shape it walks.
 */
function walk(node: UiNode, id: string, scale: number, into: ScreenElement[]): void {
	const { left, top, width, height } = node.bounds;

	into.push({
		id: parseElementId(id),
		text: content(node.text),
		label: content(node.contentDesc),
		bounds: {
			x: left / scale,
			y: top / scale,
			width: width / scale,
			height: height / scale,
		},
	});

	node.children.forEach((child, ordinal) => {
		walk(child, `${id}${ID_SEPARATOR}${ordinal}`, scale, into);
	});
}

/**
 * The hierarchy's nodes as screen elements, with bounds converted from the device's
 * physical pixels to the device-independent coordinates every verb speaks.
 *
 * `scale` is `WmDensity.scale` (`./parsers/wm.js`), asked of the device for this read —
 * the same number `./input.js`'s `toDevicePixels` multiplies by on the way out. The two
 * have to be the same number or a tap lands somewhere the caller did not point: this
 * divides where that multiplies, and both are wrong together or right together.
 *
 * **Exact quotients, unrounded**, matching `ScreenInfo`'s own `widthDp`/`heightDp`. The
 * reason is the same: rounding is a presentation decision, and a backend that rounds
 * leaves no way to ask what the device actually said. `x = left/scale`,
 * `y = top/scale`, `width = (right-left)/scale`, `height = (bottom-top)/scale` — the
 * subtractions are already `Rect`'s, done in pixels where they are integers.
 *
 * **A negative width or height is preserved.** On API 37 a row scrolled past the bottom of
 * its container is reported with its top below its bottom — `bounds="[96,2798][399,2784]"`
 * in the captured fixture, a height of -14 px (PROJECT.md §6). `requireAddressable()` in
 * `src/verbs/target.ts` reads that sign to raise `UnaddressableElementError` rather than
 * tapping the arithmetic centre of a rectangle that is not on the screen. Clamping here
 * would delete the only evidence that layer has.
 *
 * A non-finite or non-positive `scale` is refused by name rather than propagated, exactly
 * as `toDevicePixels` refuses one: a `NaN` scale would otherwise turn every rectangle on
 * the screen into `NaN`s that read as a device with no geometry.
 */
export function toScreenElements(hierarchy: UiHierarchy, scale: number): ScreenElement[] {
	if (!Number.isFinite(scale) || scale <= 0) {
		throw new Error(`Cannot read a screen at density scale ${scale}: it must be a positive number`);
	}

	const elements: ScreenElement[] = [];
	walk(hierarchy.root, '0', scale, elements);
	return elements;
}
