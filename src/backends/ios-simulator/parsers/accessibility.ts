/**
 * Parser for the accessibility read `idb_companion`'s `accessibility_info` answers with — the
 * payload `readScreen` maps onto `ScreenElement[]` (`PROJECT.md` R47 phase 4).
 *
 * Pure, like every parser here: it takes the string a companion already handed back and returns
 * shapes. The channel and the RPC belong to `../idb-client.js`, the mapping to `../screen.js`.
 *
 * **`LEGACY`, and the other two formats are not a preference.** The RPC takes a `Format`
 * (`../idb/idb.proto`) and all three were captured off the same screen on this bench, companion
 * v1.5.2 / Xcode 26.4.1 / iOS 26.4.1, 2026-09-08:
 *
 * - `LEGACY` is **one flat JSON array of nodes**, which is the shape `ScreenElement[]` is — and
 *   it is what `idb ui describe-all` asks for, so it is the format every measurement in
 *   `docs/IOS.md` §2 was taken through.
 * - `NESTED` is the same nodes under the same key names with a `children` array on each, so a
 *   consumer of it has to flatten a tree to answer the same question.
 * - `COMPLETE` **renames every key** — `AXLabel` → `label`, `AXValue` → `value`, `AXUniqueId` →
 *   `identifier` — drops `role` and `AXFrame` entirely, and wraps the tree in a document carrying
 *   the read's provenance. Its own proto comment says an older server does not recognise the
 *   value and silently serves `LEGACY` instead, so a client asking for it has to be able to read
 *   both shapes anyway. Nothing in this backend needs the provenance, and reading two shapes to
 *   get one list is a cost with nothing on the other side of it.
 *
 * **Three keys are projected out of sixteen, and the frame is the numeric one.** Each node in the
 * capture carries `frame` (four numbers) *and* `AXFrame` (the same rectangle as
 * `{{x, y}, {w, h}}`, printed at full double precision); the numbers are taken, because parsing
 * Apple's rectangle spelling back into numbers is work the tool has already done. `role`,
 * `traits`, `pid`, `subrole`, `enabled` and the rest are real and are deliberately unread —
 * `ScreenElement` has no field for any of them (`src/core/device.ts`), and projecting a value
 * nothing consumes is a claim about a key this backend does not check.
 *
 * **Non-`.strict()`, deliberately**, for `SimctlDeviceSchema`'s stated reason and idb's own: the
 * key set is Meta's, a release adds fields, and strictness would turn an idb upgrade into a
 * failed screen read in a module that reads three keys.
 *
 * **`frame` is required, and a node without one fails the whole read.** `ScreenElement.bounds` is
 * not nullable — there is no way to answer "this element is somewhere unspecified" — so the only
 * alternative to refusing the read is dropping the node, which is a screen read quietly missing
 * an element the device reported. All 50 nodes across the three committed captures carry it.
 *
 * **`AXValue` is a string even where it is a number.** The four toggles in the Settings > Camera
 * capture report `"0"` and `"1"` rather than `0`/`1` or `false`/`true`, which is what makes
 * `z.string()` a measurement here rather than an assumption — a switch is the most common control
 * on which this could have gone the other way.
 *
 * **`''` occurs in this payload**, so the empty string is not a defensive case: the same capture
 * carries `role_description: ''` on one node. `../screen.js` is where `''` becomes `null`,
 * because that is a decision about `ScreenElement` rather than about what the tool said.
 */

import { z } from 'zod';

/** How this read is named in a failure, so a person knows which call produced it. */
const ACCESSIBILITY_SOURCE = 'idb_companion accessibility_info';

/**
 * The `AccessibilityInfoRequest.Format` this module's schemas are the shape of.
 *
 * Exported from the parser rather than named at the call site, because the format and the shape
 * below are one decision: `NESTED` and `COMPLETE` are different documents (module header), so a
 * caller that asked for either would be handed a payload these schemas correctly refuse. The
 * enum's own name, spelled as `@grpc/proto-loader` accepts it under `enums: String`.
 */
export const ACCESSIBILITY_FORMAT = 'LEGACY';

/** How much of an unreadable payload the message carries — enough to recognise, not a log dump. */
const PAYLOAD_EXCERPT_LENGTH = 200;

/**
 * One node's rectangle, in **points**.
 *
 * The same space `ScreenInfo.widthDp`/`heightDp` are in, which is why `../screen.js` converts
 * nothing. Not integers: the captures are full of thirds — `y: 75.33333587646484`,
 * `height: 21.666664123535156` — because a point is a layout unit and a layout engine divides.
 *
 * **Nothing here bounds a coordinate to the screen**, and that is measured rather than lax: in
 * the Settings > Camera capture the last row sits at `y: 830.6666`, `height: 53` on an 874-point
 * screen, so it ends 9.67 points past the bottom edge. A schema that refused that would refuse a
 * scrolled list, and `src/verbs/target.ts` is the layer that decides what is addressable
 * (`../../android/screen.ts` makes the same point about a negative height on the other platform).
 */
export const AccessibilityFrameSchema = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
});
export type AccessibilityFrame = z.infer<typeof AccessibilityFrameSchema>;

/**
 * One node of the read, projected to what `ScreenElement` has a field for.
 *
 * **`AXLabel` and `AXValue` are two different strings and are kept apart.** The Safari capture is
 * why: its address field reports `AXLabel: 'Adres'` and
 * `AXValue: 'Szukaj lub podaj witrynę'` — the accessibility name of the control and the text
 * showing in it. Conflating them taps the wrong thing, which is the reason `ScreenElement` has
 * both fields (`src/core/device.ts`).
 *
 * Both are nullable and both really arrive as `null`: every one of the fifteen nodes in the
 * Compose capture has `AXValue: null`, and its `AXGroup` sibling in the Safari capture has
 * `AXLabel: null`. The key is required rather than optional, because all 50 nodes across the
 * three captures carry both keys — a release that stopped emitting one is a re-capture, and a
 * failed read naming the key is a better way to find that out than a screen full of `null`s.
 */
export const AccessibilityElementSchema = z.object({
	frame: AccessibilityFrameSchema,
	/** The control's accessibility name — `'Adres'` on Safari's address field. */
	AXLabel: z.string().nullable(),
	/** What is *in* it — `'Szukaj lub podaj witrynę'` on that same field, `'0'`/`'1'` on a toggle. */
	AXValue: z.string().nullable(),
});
export type AccessibilityElement = z.infer<typeof AccessibilityElementSchema>;

/**
 * One read: every node on the screen, flat, in the order the companion listed them.
 *
 * **A flat list is the shape, not a flattening this module performs** — see the header on
 * `LEGACY`. An empty array is a real answer and is returned as one: a screen with nothing
 * accessible on it is not a failure to surface, and the caller that has to tell the difference
 * has `ScreenElement[]`'s own length.
 */
export const AccessibilityReadSchema = z.array(AccessibilityElementSchema);
export type AccessibilityRead = z.infer<typeof AccessibilityReadSchema>;

/**
 * What the RPC answers with: the whole read, as a JSON string in one field.
 *
 * The nesting is idb's — `AccessibilityInfoResponse { string json = 1; }` — so the tree arrives
 * as text inside a protobuf message rather than as a message. Projected here rather than in
 * `../backend.ts` because it is a key name, and that file holds none (its header).
 *
 * Under `defaults: true` (`../idb-client.ts`' loader options) an unset field arrives as `''`
 * rather than as `undefined`, so a companion that answered with nothing at all reaches
 * {@link parseAccessibilityRead}'s failure quoting `''`, which is the readable version of it.
 */
const AccessibilityInfoResponseSchema = z.object({ json: z.string() });

/**
 * The read the companion answered `accessibility_info` with, envelope and payload both.
 *
 * Takes the gRPC response rather than the string inside it, so nothing above this has to know
 * which field the tree arrives in. Throws on anything that is not the array of nodes this read
 * is, with an excerpt of what came back instead — the payload is a whole screen and runs to
 * kilobytes, so it is excerpted rather than quoted verbatim (`./idb-notify.ts`' rule for a frame
 * it cannot read). A companion that answered at all and answered something else is a version
 * this projection has not seen, and the excerpt is the only place a reader would find out which.
 */
export function parseAccessibilityRead(response: unknown): AccessibilityRead {
	const envelope = AccessibilityInfoResponseSchema.safeParse(response);
	if (!envelope.success) {
		// The vendored proto and the companion have come apart over the response message itself —
		// `../idb-client.ts` says the same thing about the service, and for the same reason: the
		// alternative is a `TypeError` about a property of `undefined` at the first read of a lease.
		throw unreadable('a response carrying no accessibility payload', envelope.error);
	}

	try {
		return AccessibilityReadSchema.parse(JSON.parse(envelope.data.json));
	} catch (cause) {
		throw unreadable(`'${truncate(envelope.data.json)}'`, cause);
	}
}

function unreadable(got: string, cause: unknown): Error {
	return new Error(
		`${ACCESSIBILITY_SOURCE}: expected one flat JSON array of accessibility nodes, got ${got}`,
		{ cause },
	);
}

function truncate(payload: string): string {
	return payload.length <= PAYLOAD_EXCERPT_LENGTH
		? payload
		: `${payload.slice(0, PAYLOAD_EXCERPT_LENGTH)}…`;
}
