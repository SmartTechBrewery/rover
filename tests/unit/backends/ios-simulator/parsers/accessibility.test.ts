import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	ACCESSIBILITY_FORMAT,
	AccessibilityElementSchema,
	parseAccessibilityRead,
} from '@/backends/ios-simulator/parsers/accessibility.js';

/**
 * The projection against **three real accessibility reads**, taken through this repository's own
 * gRPC client from a booted iPhone 17 — companion v1.5.2, Xcode 26.4.1 / iOS 26.4.1, 2026-09-08
 * (`tests/fixtures/ios-simulator/README.md`).
 *
 * Three rather than one, because a single capture cannot make the case. The Compose app is the
 * subject `docs/IOS.md` §2 argued from and every one of its fifteen nodes has `AXValue: null`, so
 * a mapping that hard-coded `null` for the text would pass against it alone; Apple's own Settings
 * and Safari are what carry a value, an unlabelled node, an empty string and a frame off the
 * bottom of the screen.
 *
 * Nothing here spawns anything, so this suite runs on a machine with no idb, no Xcode and no
 * macOS.
 */
const capture = (name: string): string =>
	readFileSync(
		new URL(
			`../../../../fixtures/ios-simulator/accessibility.${name}.idbcompanion1.5.2-xcode26.4.1-ios26.4.1.json`,
			import.meta.url,
		),
		'utf8',
	);

/**
 * The captures wrapped the way the companion delivers one — the tree is a JSON *string* in a
 * protobuf field, so a suite that handed the parser the array would skip the envelope the real
 * call goes through.
 */
const responseOf = (name: string): { json: string } => ({ json: capture(name) });

/** A Compose Multiplatform app's own screen: 15 nodes, every `AXValue` null. */
const COMPOSE = responseOf('compose');
/** Settings › Camera: four toggles carrying a value, and a row off the bottom edge. */
const TOGGLES = responseOf('uikit-toggles');
/** Safari's start page: an address field whose label and value are different strings. */
const TEXTFIELD = responseOf('uikit-textfield');

/** Every node of every capture, which is what the "all 50" claims below are counted over. */
const ALL_NODES = [COMPOSE, TOGGLES, TEXTFIELD].flatMap((response) =>
	parseAccessibilityRead(response),
);

/** The vendored service definition, read for the enum this module's format has to be one of. */
const IDB_PROTO = readFileSync(
	new URL('../../../../../src/backends/ios-simulator/idb/idb.proto', import.meta.url),
	'utf8',
);

describe('parseAccessibilityRead, against the three real captures', () => {
	/**
	 * The read is **flat**, which is the whole reason `LEGACY` is the format asked for: this is
	 * the shape `ScreenElement[]` is, and the other two formats are trees.
	 */
	it('reads each capture as one flat array of the nodes the tool listed', () => {
		expect(parseAccessibilityRead(COMPOSE)).toHaveLength(15);
		expect(parseAccessibilityRead(TOGGLES)).toHaveLength(17);
		expect(parseAccessibilityRead(TEXTFIELD)).toHaveLength(18);
	});

	/**
	 * `frame` is required rather than optional, and this is the evidence for that being safe:
	 * every node of every capture carries all four numbers. A node without one could not be a
	 * `ScreenElement` at all — `bounds` is not nullable — so the alternative to requiring it is
	 * quietly dropping an element the device reported.
	 */
	it('gives every one of the 50 nodes a frame of four numbers', () => {
		expect(ALL_NODES).toHaveLength(50);
		for (const node of ALL_NODES) {
			expect(node.frame).toEqual({
				x: expect.any(Number),
				y: expect.any(Number),
				width: expect.any(Number),
				height: expect.any(Number),
			});
		}
	});

	/**
	 * The two fields are kept apart because they are two different strings, and Safari's address
	 * field is the capture that proves it: conflating them is how a verb taps the control whose
	 * *placeholder* it matched (`ScreenElementSchema`).
	 */
	it('keeps the accessibility label and the value apart', () => {
		const address = parseAccessibilityRead(TEXTFIELD)[15];

		expect(address?.AXLabel).toBe('Adres');
		expect(address?.AXValue).toBe('Szukaj lub podaj witrynę');
	});

	/**
	 * `AXValue` on a toggle is the string `'0'` or `'1'` — not a number and not a boolean. A
	 * switch is the most common control on which `z.string()` could have been the wrong schema, so
	 * this is the measurement rather than an assumption.
	 */
	it('reads a toggle value as the string the tool wrote', () => {
		const toggles = parseAccessibilityRead(TOGGLES).slice(12, 16);

		expect(toggles.map((node) => node.AXValue)).toEqual(['0', '0', '0', '1']);
	});

	/** A node carrying neither is real, and arrives as `null` rather than as an absent key. */
	it('accepts a node with no label and no value', () => {
		const group = parseAccessibilityRead(TEXTFIELD)[1];

		expect(group?.AXLabel).toBeNull();
		expect(group?.AXValue).toBeNull();
	});

	/**
	 * A frame is not bounded to the screen and must not be: this row ends 9.67 points below an
	 * 874-point panel because the list it is in is scrolled. Refusing it here would refuse a
	 * scrolled list, and `src/verbs/target.ts` is the layer that decides what is addressable.
	 */
	it('keeps a frame that extends past the bottom of the screen', () => {
		const last = parseAccessibilityRead(TOGGLES)[16];

		expect(last?.frame.y).toBeCloseTo(830.6667, 4);
		expect((last?.frame.y ?? 0) + (last?.frame.height ?? 0)).toBeGreaterThan(874);
	});
});

describe('the shape of the projection', () => {
	/**
	 * Non-`.strict()`, `SimctlDeviceSchema`'s stance: the key set is Meta's and a release adds
	 * fields, so strictness would turn an idb upgrade into a failed screen read. Inline because
	 * the key an idb release will add next is not in any capture yet — which is the point.
	 */
	it('ignores keys it does not read, including ones no release has added yet', () => {
		const node = AccessibilityElementSchema.parse({
			frame: { x: 1, y: 2, width: 3, height: 4 },
			AXLabel: 'a',
			AXValue: null,
			role: 'AXButton',
			traits: ['Button'],
			something_idb_1_6_added: { deeply: ['nested'] },
		});

		expect(node).toEqual({
			frame: { x: 1, y: 2, width: 3, height: 4 },
			AXLabel: 'a',
			AXValue: null,
		});
	});

	/**
	 * Inline, and the case none of the captures makes: the payload does emit `''` — the Settings ›
	 * Camera read carries `role_description: ''` on one node — but never in either mapped key, so
	 * the empty string has to be admitted here for `../screen.ts` to be the place that turns it
	 * into `null`.
	 */
	it('admits an empty string, leaving what it means to the mapping', () => {
		expect(
			AccessibilityElementSchema.parse({
				frame: { x: 0, y: 0, width: 0, height: 0 },
				AXLabel: '',
				AXValue: '',
			}),
		).toMatchObject({ AXLabel: '', AXValue: '' });
	});

	/**
	 * An empty screen is an answer, not a failure: a caller that has to tell "nothing accessible
	 * here" from "the read failed" would otherwise be handed an exception for the former.
	 */
	it('reads an empty read as an empty list', () => {
		expect(parseAccessibilityRead({ json: '[]' })).toEqual([]);
	});
});

describe('parseAccessibilityRead, on answers it cannot read', () => {
	/**
	 * The format the RPC is asked for and the shape parsed here are one decision, so the constant
	 * is checked against the **vendored proto** rather than against a literal in this suite — the
	 * same reason `../no-idb-file-push.test.ts` reads its RPC name out of that file. An idb release
	 * that renamed the enum value would otherwise leave this repository asking for a format the
	 * companion no longer has.
	 */
	it('names a format the vendored proto defines', () => {
		expect(IDB_PROTO).toMatch(new RegExp(`^\\s*${ACCESSIBILITY_FORMAT} = \\d+;`, 'm'));
	});

	/** A `NESTED` or `COMPLETE` answer is a different document, and is refused rather than mined. */
	it('refuses a payload that is not the flat array, naming the call', () => {
		expect(() => parseAccessibilityRead({ json: '{"elements":[],"backend":"ax"}' })).toThrow(
			/accessibility_info: expected one flat JSON array/,
		);
	});

	/** Not JSON at all — quoted, because that text is the only place the reason lives. */
	it('quotes output that is not JSON', () => {
		expect(() => parseAccessibilityRead({ json: 'not a tree' })).toThrow(/'not a tree'/);
	});

	/**
	 * Excerpted rather than quoted whole: a real payload is kilobytes, and a failure that pasted
	 * a whole screen into a message is a log dump rather than an explanation.
	 */
	it('excerpts a long payload instead of quoting all of it', () => {
		const long = `[{"frame":${'x'.repeat(5_000)}}]`;

		expect(() => parseAccessibilityRead({ json: long })).toThrow(/…/);
		try {
			parseAccessibilityRead({ json: long });
		} catch (error) {
			expect((error as Error).message.length).toBeLessThan(400);
		}
	});

	/**
	 * The envelope, not the payload: a companion whose response message does not carry the field
	 * at all means the vendored proto and the program have come apart, and the alternative to
	 * saying so is a `TypeError` about a property of `undefined` at the first read of a lease.
	 */
	it('refuses a response carrying no payload', () => {
		expect(() => parseAccessibilityRead({})).toThrow(/carrying no accessibility payload/);
		expect(() => parseAccessibilityRead(null)).toThrow(/carrying no accessibility payload/);
	});
});
