/**
 * Parser for the `uiautomator dump` view hierarchy.
 *
 * Pure, like its siblings in this folder: the runner (R5) owns the process and the
 * `adb exec-out cat` that fetches the document, this owns the text.
 *
 * Bounds come back in **physical pixels**, exactly as the device reported them. The px→dp
 * scale is `./wm.js`'s `WmDensity.scale` and is applied a layer up (R5, R13): a parser that
 * converted here would leave no way to ask what the device actually said, and the
 * screenshot-width scale PROJECT.md §6 warns about is precisely the bug that hides in a
 * conversion nobody can see the input to.
 *
 * Nothing here reads the shape of a serial — this parser never sees one.
 */

import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

const ATTRIBUTE_PREFIX = '@_';

/** `bounds="[left,top][right,bottom]"`, anchored and signed — see {@link RectSchema}. */
const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

/**
 * How much of the document an error quotes. Its siblings here quote the whole output, which
 * is a line or two; a 28 KB hierarchy pasted whole is not a readable error message.
 */
const ERROR_EXCERPT_CHARS = 200;

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: ATTRIBUTE_PREFIX,
	// Off deliberately. `true` reads `text="0123"` as the number 123 and `text="true"` as a
	// boolean — silently changing what is on the screen, which is the exact class of bug this
	// module exists to prevent. Every attribute stays the string the device wrote, and the
	// schema below converts the ones that are not text.
	parseAttributeValue: false,
	// `text` and `content-desc` are screen content: a leading or trailing space in a label is
	// the device's, not whitespace to tidy away.
	trimValues: false,
	// Without this a node with exactly one child parses to a bare object, so the shape of the
	// tree would depend on how many children a node happens to have.
	isArray: (name) => name === 'node',
	// `processEntities` stays at its default: uiautomator entity-encodes `&` and `<` in text
	// and content-desc, and the decoded value is what a caller wants.
});

/**
 * A node's rectangle in physical pixels.
 *
 * `width` and `height` are plain subtractions and **may be negative**: on API 37 a row
 * scrolled past the bottom of its container is reported with its top below its bottom —
 * `bounds="[96,2798][399,2784]"` in the captured fixture, a height of -14. Clamping that
 * to zero would invent a rectangle the device never described, so the arithmetic is left
 * honest; whether a node is on screen is the caller's question, not this parser's.
 */
export const RectSchema = z
	.object({
		left: z.number().int(),
		top: z.number().int(),
		right: z.number().int(),
		bottom: z.number().int(),
		width: z.number().int(),
		height: z.number().int(),
	})
	.strict();
export type Rect = z.infer<typeof RectSchema>;

/**
 * One `<node>` of the hierarchy.
 *
 * Hand-written, which `ai/CODING_STANDARDS.md` otherwise forbids: the schema is recursive,
 * so it has to go through `z.lazy`, and `z.infer` cannot see through that on zod 3. The
 * annotation below is what makes the recursion type-check, and this interface is what the
 * annotation needs. Keep the two in step by hand — there is no way around it until zod 4.
 *
 * Attributes outside this list (`hint`, `drawing-order`, and whatever a newer API adds) are
 * **dropped, not preserved**. They become visible when a fixture from a newer API level is
 * captured, which is the mechanism `ai/TESTING.md` already prescribes.
 */
export interface UiNode {
	index: number;
	text: string;
	/** `resource-id` */
	resourceId: string;
	/** `class` */
	className: string;
	/** `package` */
	packageName: string;
	/** `content-desc` */
	contentDesc: string;
	checkable: boolean;
	checked: boolean;
	clickable: boolean;
	enabled: boolean;
	focusable: boolean;
	focused: boolean;
	scrollable: boolean;
	/** `long-clickable` */
	longClickable: boolean;
	password: boolean;
	selected: boolean;
	bounds: Rect;
	children: UiNode[];
}

export const UiNodeSchema: z.ZodType<UiNode> = z.lazy(() =>
	z
		.object({
			index: z.number().int(),
			text: z.string(),
			resourceId: z.string(),
			className: z.string(),
			packageName: z.string(),
			contentDesc: z.string(),
			checkable: z.boolean(),
			checked: z.boolean(),
			clickable: z.boolean(),
			enabled: z.boolean(),
			focusable: z.boolean(),
			focused: z.boolean(),
			scrollable: z.boolean(),
			longClickable: z.boolean(),
			password: z.boolean(),
			selected: z.boolean(),
			bounds: RectSchema,
			children: z.array(UiNodeSchema),
		})
		.strict(),
);

/** `<hierarchy rotation="…">` and its single root node. */
export const UiHierarchySchema = z
	.object({
		/** Surface rotation in quarter turns, as `<hierarchy>` reported it. */
		rotation: z.number().int(),
		root: UiNodeSchema,
	})
	.strict();
export type UiHierarchy = z.infer<typeof UiHierarchySchema>;

/** The `@_`-prefixed bag fast-xml-parser produces for one element. */
type RawNode = Record<string, unknown>;

function unparseable(reason: string, xml: string): Error {
	const excerpt = xml.slice(0, ERROR_EXCERPT_CHARS);
	const ellipsis = xml.length > ERROR_EXCERPT_CHARS ? '…' : '';
	return new Error(`uiautomator dump: ${reason}, in:\n${excerpt}${ellipsis}`);
}

function attribute(node: RawNode, name: string): string | undefined {
	const value = node[`${ATTRIBUTE_PREFIX}${name}`];
	return typeof value === 'string' ? value : undefined;
}

/** Absent attributes default rather than throwing — an older API simply has fewer of them. */
function text(node: RawNode, name: string): string {
	return attribute(node, name) ?? '';
}

function flag(node: RawNode, name: string): boolean {
	return attribute(node, name) === 'true';
}

/**
 * Throws on anything the anchored regex rejects, naming the node's `class` and the raw
 * value. Every target resolution downstream is addressed through this rectangle, so a
 * silently zeroed one is not a degraded answer — it is a tap in the corner of the screen.
 */
function parseBounds(raw: string | undefined, className: string): Rect {
	const match = raw === undefined ? null : BOUNDS.exec(raw);
	if (!match) {
		throw new Error(
			`uiautomator dump: node '${className}' has unparseable bounds ${JSON.stringify(raw)}, ` +
				'expected "[left,top][right,bottom]"',
		);
	}

	const left = Number(match[1]);
	const top = Number(match[2]);
	const right = Number(match[3]);
	const bottom = Number(match[4]);

	return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function toNode(raw: RawNode): UiNode {
	const className = text(raw, 'class');
	const children = raw.node;

	return {
		index: Number(attribute(raw, 'index') ?? 0),
		text: text(raw, 'text'),
		resourceId: text(raw, 'resource-id'),
		className,
		packageName: text(raw, 'package'),
		contentDesc: text(raw, 'content-desc'),
		checkable: flag(raw, 'checkable'),
		checked: flag(raw, 'checked'),
		clickable: flag(raw, 'clickable'),
		enabled: flag(raw, 'enabled'),
		focusable: flag(raw, 'focusable'),
		focused: flag(raw, 'focused'),
		scrollable: flag(raw, 'scrollable'),
		longClickable: flag(raw, 'long-clickable'),
		password: flag(raw, 'password'),
		selected: flag(raw, 'selected'),
		bounds: parseBounds(attribute(raw, 'bounds'), className),
		children: Array.isArray(children) ? children.map((child) => toNode(child as RawNode)) : [],
	};
}

/**
 * Parse the XML written by `uiautomator dump` into a validated tree.
 *
 * Throws rather than returning a partial tree. A hierarchy is the whole basis on which a
 * verb decides where to tap, so "some of the screen" is not a useful answer to hand back —
 * unlike a device list, where an empty result below the header is a real answer.
 *
 * A dump with more than one root node (split screen, or a second display) is refused for
 * the same reason: reading only the first window would answer confidently about a screen
 * the caller is not looking at. Supporting it needs a fixture that has one.
 */
export function parseUiHierarchy(xml: string): UiHierarchy {
	const parsed = parser.parse(xml) as RawNode;
	const hierarchy = parsed.hierarchy as RawNode | undefined;

	if (typeof hierarchy !== 'object' || hierarchy === null) {
		throw unparseable('no <hierarchy> element', xml);
	}

	const rotation = attribute(hierarchy, 'rotation');
	if (rotation === undefined) {
		// Never defaulted to 0: a landscape hierarchy read as portrait puts every coordinate
		// derived from it somewhere else on the screen.
		throw unparseable('<hierarchy> has no rotation attribute', xml);
	}

	const roots = hierarchy.node;
	if (!Array.isArray(roots) || roots.length !== 1) {
		const count = Array.isArray(roots) ? roots.length : 0;
		throw unparseable(`expected exactly one root <node>, found ${count}`, xml);
	}

	return UiHierarchySchema.parse({
		rotation: Number(rotation),
		root: toNode(roots[0] as RawNode),
	});
}
