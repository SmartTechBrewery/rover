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
 * **Seven keys are projected out of sixteen, and the frame is the numeric one.** It said *four*
 * until #336 and *five* until #329, and the sentence is edited in place rather than left to be
 * out-counted (the three paragraphs below say which keys moved and why). Each node in the capture carries `frame` (four numbers) *and* `AXFrame` (the same rectangle as
 * `{{x, y}, {w, h}}`, printed at full double precision); the numbers are taken, because parsing
 * Apple's rectangle spelling back into numbers is work the tool has already done. `role`,
 * `subrole` and the rest are real and are deliberately unread — `ScreenElement` has no field for
 * any of them (`src/core/device.ts`), and projecting a value nothing consumes is a claim about a
 * key this backend does not check.
 *
 * **`traits` was one of those five and is the one that moved** (#298; this paragraph is edited in
 * place with its reasoning rewritten rather than deleted, `ai/RULES.md` §1). It is read now
 * because it is the only place in this payload where the device **names the software keyboard**:
 * every key node carries {@link KEYBOARD_KEY_TRAIT} and each cell of the strip above the keys
 * carries {@link KEYBOARD_CANDIDATE_TRAIT}, so the union of their frames is the drawn panel. That
 * is what makes it the exception to the rule above rather than a hole in it — the other three
 * still feed nothing (four, until `pid` moved below), and `traits` feeds `ScreenInfo.keyboard` (`../screen.js`'s
 * `toOnScreenKeyboard`) rather than `ScreenElement`, which has no field for it either.
 *
 * **`pid` was another of those five, and it moved second** (#336; this paragraph sits beside the
 * one above rather than replacing it, `ai/RULES.md` §1). It was unread for the same reason the
 * rest still are, and the list above no longer names it. It is read now because it is the only
 * place in this payload that says **which process drew the screen**: every node of one read carries the
 * same pid — Settings 99145 and 16162, Safari 17263 and the Compose app 14900 across the five
 * captures — and `launchctl list` inside the device names the application running under it. That
 * feeds `DeviceInfo.foregroundApp` (`../backend.ts`'s `#foregroundAppOf`), not `ScreenElement`.
 *
 * **`AXUniqueId` and `enabled` moved third** (#329; beside the two above, not replacing them).
 * `ScreenElement` gained a field for each — the developer-assigned `identifier` and the
 * `enabled` state — so they stopped being values nothing consumes. `AXUniqueId` still is **not**
 * the element id, for the reason `../screen.ts`' `toScreenElements` gives (it repeats within one
 * read). `traits` gains two more readers in the same change: {@link SELECTED_TRAIT} and
 * {@link TOGGLE_TRAIT} answer `ScreenElement.selected` and `checked`.
 *
 * **`traits` is required but nullable, and the nullability was measured the hard way.** It is on
 * all 50 nodes across the three captures that predate #298 and on all 52 across the pair that
 * capture carried in, so it stays required — a release that stopped emitting it is a re-capture,
 * and a read failing by the key's own name is a better way to find that out than a keyboard that
 * silently stops being reported. Its *value*, though, is `null` on one node this project already
 * had a name for: the zero-framed `AXApplication` placeholder a cold launch reads back before the
 * process has drawn (`../backend.ts`'s `noScreenYet`, #300). That is a real read of a real device
 * and the commonest transient on this platform, so rejecting it would have made `readScreen`
 * unreadable for a field `readScreen` does not even use — see {@link AccessibilityElementSchema}.
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
 * The trait every key of the software keyboard carries, and the one that means *a keyboard is up*.
 *
 * Measured on this bench — a throwaway iPhone 17, companion v1.5.2, Xcode 26.4.1 / iOS 26.4.1,
 * 2026-10-06, captured as `accessibility.uikit-keyboard.*.json`: **34** nodes carry it with the
 * Polish system keyboard up on Settings' search field — every letter, `shift`, `usuń`, `cyfry`,
 * `Emoji`, the space bar, `szukaj`, `Następna klawiatura` and `Dyktuj` — and **none** carries it on
 * any of the four captures taken with no keyboard drawn.
 *
 * Named here beside the format rather than in `../screen.js`, because it is a fact about what this
 * payload says rather than about how `ScreenInfo` is shaped.
 */
export const KEYBOARD_KEY_TRAIT = 'KeyboardKey';

/**
 * The trait the three cells of the autocorrect strip above the keys carry.
 *
 * It is part of the **drawn panel** and not part of the keys: in the same capture the strip sits at
 * `y: 539` over a full 402-point width while the topmost key row starts at `y: 590`, so a rectangle
 * built from {@link KEYBOARD_KEY_TRAIT} alone is 51 points short at the top and misses a band a
 * touch would land in. It does **not** by itself mean a keyboard is up (`../screen.js`): the keys
 * are what that fact is about, and the strip is what the rectangle has to cover.
 */
export const KEYBOARD_CANDIDATE_TRAIT = 'AutoCorrectCandidate';

/**
 * The trait a selected tab, segment or key carries — `ScreenElement.selected`.
 *
 * Measured on the committed captures: the selected `Assistant` tab of the Compose capture carries
 * it and its eight sibling tabs do not; `shift` carries it in the keyboard capture.
 */
export const SELECTED_TRAIT = 'Selected';

/**
 * The trait a switch or checkbox carries — the one node kind whose `AXValue` is its checked state.
 *
 * Measured on the Settings > Camera capture: its four `AXCheckBox` rows carry it, with `AXValue`
 * `'0'`/`'0'`/`'0'`/`'1'`, and no other node of any capture does. `../screen.ts` answers
 * `ScreenElement.checked` only for a node that claims it, for the rule that field states.
 */
export const TOGGLE_TRAIT = 'Toggle';

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
 *
 * **`traits` is the fourth, and it is the keyboard's** — see the module header for why it is the
 * one of the five unprojected keys that moved, and {@link KEYBOARD_KEY_TRAIT} for what is in it.
 * **`pid` is the fifth, and it is the foreground app's** (#336) — the header says why it moved too.
 * **`AXUniqueId` and `enabled` are the sixth and seventh** (#329), and both are required and
 * nullable on `pid`'s terms: all 132 nodes across the seven committed captures carry both keys, so
 * a release that dropped one is a re-capture that should fail by the key's name, while a `null`
 * value costs only that field, never the read.
 */
export const AccessibilityElementSchema = z.object({
	frame: AccessibilityFrameSchema,
	/** The control's accessibility name — `'Adres'` on Safari's address field. */
	AXLabel: z.string().nullable(),
	/** What is *in* it — `'Szukaj lub podaj witrynę'` on that same field, `'0'`/`'1'` on a toggle. */
	AXValue: z.string().nullable(),
	/**
	 * What the system says this node *is* — `["KeyboardKey", "PlaysSound", "Scrollable"]` on a key,
	 * `["None"]` on the application node.
	 *
	 * **Nullable, and that is measured rather than defensive.** It arrives as an array on all 52
	 * nodes of the keyboard pair and all 50 of the three captures that predate #298, which is what
	 * this comment originally claimed was the whole story — it said *not nullable and not
	 * optional*, and the device suite disproved it within the hour, so this is rewritten in place
	 * with its reasoning rather than quietly widened (`ai/RULES.md` §1). The node that answers
	 * `null` is the **launching-app placeholder**: the single zero-framed `AXApplication` node a
	 * cold launch reads back before the process has drawn, the one {@link AccessibilityReadSchema}
	 * describes and `../backend.ts`'s `noScreenYet` refuses. It is a real read of a real device, so
	 * a schema that rejected it would turn the most ordinary transient on this platform into an
	 * unreadable payload — and it would do it to `readScreen`, which had nothing to do with #298.
	 *
	 * `null` and `[]` both mean *this node claims no trait*, and `../screen.ts` reads them the same
	 * way; neither can be a keyboard key, because a keyboard key is a node that said so. Nothing
	 * here checks the membership, because an unknown trait is a trait this backend does not read
	 * rather than a payload it cannot understand — the same argument that keeps the schema
	 * non-`.strict()`.
	 */
	traits: z.array(z.string()).nullable(),
	/**
	 * The process that drew this node — the same on every node of one read, so the first node's is
	 * the screen's (module header). On the home screen it is SpringBoard's.
	 *
	 * **Required**, because every node of the five committed captures and every read taken on the
	 * #336 bench carried it — including the launching-app placeholder, whose single zero-framed node
	 * already carries the **launching app's** pid (`traits: null` beside it), so a cold launch is
	 * attributed to the app being launched rather than to nothing.
	 *
	 * **Nullable, and that is a choice about cost rather than a measurement**, stated as one so
	 * nobody reads it as the second kind: no `null` pid has been seen. What decides it is who pays
	 * when one arrives. A `null` here costs `foregroundApp` its answer — `null`, which is that
	 * field's *not answered* already — while refusing it would cost `readScreen` a whole read for a
	 * key `readScreen` does not use, the exact trade `traits` above was rewritten
	 * for.
	 */
	pid: z.number().int().nullable(),
	/**
	 * The identifier the application's developer assigned — `'TabBarItemTitle'` on Safari's address
	 * field, `null` on every node of the Compose capture. Repeats within one read (Safari's three
	 * favourites tiles share `favoritesItemIdentifierContent`), which is why it is never the id.
	 */
	AXUniqueId: z.string().nullable(),
	/** `false` on Safari's greyed-out `Wróć` button and on the keyboard capture's `szukaj` key. */
	enabled: z.boolean().nullable(),
});
export type AccessibilityElement = z.infer<typeof AccessibilityElementSchema>;

/**
 * One read: every node on the screen, flat, in the order the companion listed them.
 *
 * **A flat list is the shape, not a flattening this module performs** — see the header on
 * `LEGACY`. An empty array is a real answer and is returned as one: a screen with nothing
 * accessible on it is not a failure to surface, and the caller that has to tell the difference
 * has `ScreenElement[]`'s own length.
 *
 * **That paragraph stands, and #300 did not narrow it** — what it added sits one layer up. The
 * read taken in the first fraction of a second of a cold launch is not empty: it is one
 * `AXApplication` node with a zero-sized frame, the launching process before it has drawn
 * (`../backend.ts`'s `noScreenYet`, measured over 2623 reads). `../backend.ts` refuses *that* as
 * `UnreadableScreenError`, because what the companion **said** and what it **means for
 * `ScreenElement[]`** are two decisions — the same split that puts `'' → null` in `../screen.ts`
 * rather than here. An empty array still arrives here as one, is still parsed as one, and was
 * never observed in any of those reads.
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
