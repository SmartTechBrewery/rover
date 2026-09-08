// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';
import {
	lineOf,
	readPanelSources,
	readShippedPanelSources,
} from '../../helpers/panel-source-scan.js';

/**
 * `docs/DESIGN.md` §5's cursor rule, as an executable gate: **a pointer on what can be pressed,
 * and nothing on what cannot** (#180).
 *
 * Tailwind v4's preflight carries no `cursor: pointer` for `button` the way v3's did, so until
 * this rule landed every control in the panel hovered as the user agent's arrow and nothing in
 * the interface read as clickable at all — the Archive's `All` / `Testing groups` toggle is
 * where that was noticed, not where it lived.
 *
 * The mechanism is one base rule on the `button` element, so this gate is in two halves.
 *
 * The first runs the panel's **own** `@layer base` body through a real cascade and reads the
 * cursor back, because a string match on `index.css` would say nothing about what the selector
 * reaches: an enabled button, a disabled one, a read-only archive row and a link are all asked.
 * jsdom is asked for it per-file rather than for the whole `unit` project, Swarm's pragma the
 * way `panel-source-scan.ts` describes it. **jsdom does not descend into `@layer`**, so the
 * layer is unwrapped rather than injected whole — a rule left inside one parses, is ignored, and
 * every assertion below fails rather than passing vacuously.
 *
 * The second half is the ordinary source scan the other gates here are, and it exists because a
 * base rule is only as good as the utilities that do not override it: a `cursor-*` class on one
 * control is exactly how the next component silently ships without the affordance, or with one
 * it should not have.
 *
 * A base rule adds no class, so `level-contents.test.tsx`'s assertion that the rendered markup
 * contains no `cursor-pointer` holds unchanged and still says what it always said.
 */

/** The body of `@layer base { … }` in a stylesheet, or `''` if it declares none. */
function baseLayerOf(css: string): string {
	const start = css.indexOf('@layer base');
	if (start === -1) return '';

	const open = css.indexOf('{', start);
	let depth = 0;
	for (let at = open; at < css.length; at += 1) {
		if (css[at] === '{') depth += 1;
		else if (css[at] === '}') {
			depth -= 1;
			if (depth === 0) return css.slice(open + 1, at);
		}
	}
	return '';
}

const STYLESHEETS = readPanelSources().filter((file) => file.path.endsWith('.css'));
const COMPONENTS = readShippedPanelSources().filter((file) => file.path.endsWith('.tsx'));

/** Every `cursor-…` utility. `cursor-not-allowed` is the one a disabled control may carry. */
const CURSOR_UTILITY = /\bcursor-[a-z-]+/g;

function cursorOn(selector: string): string {
	const element = document.querySelector(selector);
	if (element === null) throw new Error(`nothing matched \`${selector}\``);
	return window.getComputedStyle(element).cursor;
}

beforeAll(() => {
	for (const sheet of STYLESHEETS) {
		const style = document.createElement('style');
		style.textContent = baseLayerOf(sheet.source);
		document.head.append(style);
	}

	// The shapes the rule has to tell apart. The row is the archive contents row's own —
	// a `<div>` inside an `<li>`, read and not followed (#161, `docs/DESIGN.md` §9) — and the last
	// two are the Archive screen's `Keep` tick with the label that wraps it (§9), beside a
	// `<label>` over a text field, which the rule must leave alone.
	document.body.innerHTML = `
		<button id="pressable" type="button">All</button>
		<button disabled id="unpressable" type="submit">Checking…</button>
		<ul><li><div id="row">20260826T101155Z-issue-104-2fd913c7</div></li></ul>
		<a href="/archive" id="link">checkout-app</a>
		<label id="tick"><input id="box" type="checkbox" /><span>Archive</span></label>
		<label id="field-label">Search<input id="field" type="text" /></label>
	`;
});

describe('the panel points at what can be pressed', () => {
	it('injected the panel’s own base rules, not an empty stylesheet', () => {
		expect(STYLESHEETS.map((sheet) => sheet.path)).toContain('panel/src/index.css');
		expect(STYLESHEETS.some((sheet) => baseLayerOf(sheet.source).trim() !== '')).toBe(true);
	});

	it('points at a button', () => {
		expect(cursorOn('#pressable')).toBe('pointer');
	});

	/*
	 * §5's reason for a disabled control dropping `.control-tactile` rather than keeping a
	 * weakened shadow, applied to the cursor: it would promise a press that does nothing.
	 * `cursor-not-allowed` is what these carry instead, and that promises nothing.
	 */
	it('points at nothing on a disabled control', () => {
		expect(cursorOn('#unpressable')).not.toBe('pointer');
	});

	it('points at nothing on a read-only archive row', () => {
		expect(cursorOn('#row')).not.toBe('pointer');
	});

	/*
	 * **Links needed nothing, and this is where that stays true.** Every user agent already
	 * points at an `a[href]` and preflight leaves that alone, so the sidebar, the breadcrumb and
	 * the archive tree were never part of the defect. The panel's own rules are in this document,
	 * so an author rule that took the pointer back off a link would fail here.
	 */
	it('leaves a link pointing, without a rule of its own', () => {
		expect(cursorOn('#link')).toBe('pointer');
	});

	/*
	 * **A checkbox is pressable, so the rule reaches it** — and reaches the `<label>` that wraps
	 * one, because the word beside the box toggles it and is the larger half of the hit area. It is
	 * the same base rule rather than a utility on the one control, for the reason the rule itself
	 * records: a class on this checkbox is the one the next checkbox forgets.
	 */
	it('points at a checkbox, and at the label that wraps it', () => {
		expect(cursorOn('#box')).toBe('pointer');
		expect(cursorOn('#tick')).toBe('pointer');
	});

	/*
	 * `:has(> input[type='checkbox'])` is what keeps that to a label over a checkbox. A label over
	 * a text field is not a press, and the archive search field's is one of them.
	 */
	it('points at nothing on a label over a text field', () => {
		expect(cursorOn('#field-label')).not.toBe('pointer');
	});
});

describe('and nothing in the panel takes that pointer away', () => {
	it('scanned components that actually draw buttons', () => {
		const drawing = COMPONENTS.filter((file) => file.sourceWithoutComments.includes('<button'));

		expect(drawing.length).toBeGreaterThan(0);
	});

	/*
	 * **One declaration, whatever the selector list grows to.** The checkbox joined it rather than
	 * taking a `cursor-pointer` of its own (§9), so what this pins is that there is still exactly
	 * one place a cursor is declared — the property the scan below depends on — and not how many
	 * elements that one rule reaches.
	 */
	it('declares a cursor in exactly one place, on the pressable-elements rule', () => {
		const declared: string[] = [];

		for (const sheet of STYLESHEETS) {
			const rules = baseLayerOf(sheet.sourceWithoutComments);
			for (const match of rules.matchAll(/([^{}]+)\{[^{}]*\bcursor\s*:/g)) {
				declared.push(`${sheet.path}: ${match[1]?.trim()}`);
			}
		}

		expect(declared).toEqual([
			"panel/src/index.css: button:not(:disabled),\n\tinput[type='checkbox']:not(:disabled),\n\tlabel:has(> input[type='checkbox']:not(:disabled))",
		]);
	});

	/*
	 * The base rule reaches every button there will ever be; a utility on one control is what
	 * takes it back. `cursor-not-allowed` is the only one allowed, and only where a control is
	 * disabled — the three that carry it today are all a `disabled` branch of a class expression.
	 */
	it('uses no cursor utility but `cursor-not-allowed`, and only where a control is disabled', () => {
		const offences: string[] = [];

		for (const file of COMPONENTS) {
			CURSOR_UTILITY.lastIndex = 0;
			for (const match of file.sourceWithoutComments.matchAll(CURSOR_UTILITY)) {
				const where = `${file.path}:${lineOf(file.sourceWithoutComments, match.index)}`;
				if (match[0] !== 'cursor-not-allowed') {
					offences.push(`${where}: '${match[0]}'`);
				} else if (!file.sourceWithoutComments.includes('disabled=')) {
					offences.push(`${where}: 'cursor-not-allowed' on nothing disabled`);
				}
			}
		}

		expect(offences).toEqual([]);
	});
});
