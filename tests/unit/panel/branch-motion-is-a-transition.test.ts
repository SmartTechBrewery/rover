// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';
import { readPanelSources } from '../../helpers/panel-source-scan.js';

/**
 * `docs/DESIGN.md` §5 and §9's second piece of motion, as an executable gate: **a branch of the
 * Archive tree opens and closes over a short transition, and that transition is not an animation**
 * (#280).
 *
 * The rule §5 carries is *no looping animation, anywhere*, and
 * `tests/unit/panel/no-looping-animation.test.ts` is its executable form — narrower than the prose,
 * forbidding `@keyframes`, `animation*:` declarations and `animate-*` utilities and saying nothing
 * about `transition`. **That gate is not relaxed by this one and must stay exactly as strict**: what
 * changed with #280 is §5's *inventory* of what moves, not its rule. So this file pins the two things
 * that keep the new motion inside the category §5 already permits — that it is a transition, and
 * that a reader who has asked for no motion gets none of it.
 *
 * It is in two halves, `pointer-on-what-can-be-pressed.test.ts`'s shape and for its reasons.
 *
 * The first runs the panel's **own** `@layer base` body through a real cascade, because a string
 * match on `index.css` would say nothing about what the rules reach. What is asked of it is the
 * accessibility claim rather than the motion: a shut branch is `visibility: hidden`, **and so is
 * every row inside it**, which is what takes a branch that is not on screen out of the tab order and
 * out of the accessibility tree in one stroke. **jsdom does not descend into `@layer`**, so the layer
 * is unwrapped rather than injected whole — a rule left inside one parses, is ignored, and every
 * assertion below fails rather than passing vacuously.
 *
 * The second is the ordinary source scan the other gates here are. jsdom resolves no transition and
 * runs no clock, so *is it a transition*, *is its duration in the band the issue asked for* and *is
 * the delay floored under `prefers-reduced-motion`* are questions about the declarations themselves.
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

const INDEX_CSS = STYLESHEETS.find((file) => file.path === 'panel/src/index.css');

/** One declaration block by its selector, out of the comment-free stylesheet. */
function ruleFor(selector: string): string {
	const rules = baseLayerOf(INDEX_CSS?.sourceWithoutComments ?? '');
	const at = rules.indexOf(`${selector} {`);
	if (at === -1) throw new Error(`no \`${selector}\` rule in index.css`);
	return rules.slice(at, rules.indexOf('}', at));
}

/** The band the issue asked the motion to sit in: long enough to read as movement, short enough not
 *  to make the tree feel slow. */
const SHORTEST_MS = 120;
const LONGEST_MS = 200;

function styleOf(selector: string): CSSStyleDeclaration {
	const element = document.querySelector(selector);
	if (element === null) throw new Error(`nothing matched \`${selector}\``);
	return window.getComputedStyle(element);
}

beforeAll(() => {
	for (const sheet of STYLESHEETS) {
		const style = document.createElement('style');
		style.textContent = baseLayerOf(sheet.source);
		document.head.append(style);
	}

	// The tree's own shape, at the two states a branch is in — `directory-tree.tsx`'s `Subtree`
	// around `BRANCH_CHROME` around one row.
	document.body.innerHTML = `
		<ul>
			<li>
				<a href="/archive/checkout-app" id="open-row">checkout-app</a>
				<div class="tree-branch tree-branch-open" id="open-branch">
					<div class="tree-branch-clip">
						<div><ul><li><a href="/archive/checkout-app/login-flow" id="drawn">login-flow</a></li></ul></div>
					</div>
				</div>
			</li>
			<li>
				<a href="/archive/payments-web" id="shut-row">payments-web</a>
				<div class="tree-branch" id="shut-branch">
					<div class="tree-branch-clip">
						<div><ul><li><a href="/archive/payments-web/refund-flow" id="undrawn">refund-flow</a></li></ul></div>
					</div>
				</div>
			</li>
		</ul>
	`;
});

describe('a shut branch of the archive tree is not on screen', () => {
	it('injected the panel’s own base rules, not an empty stylesheet', () => {
		expect(STYLESHEETS.map((sheet) => sheet.path)).toContain('panel/src/index.css');
		expect(STYLESHEETS.some((sheet) => baseLayerOf(sheet.source).trim() !== '')).toBe(true);
	});

	it('hides a shut branch, and every row inside it', () => {
		expect(styleOf('#shut-branch').visibility).toBe('hidden');
		// The one that matters: `visibility: hidden` is inherited, so the row is out of the tab
		// order and out of the accessibility tree rather than merely invisible. This is why the
		// mechanism is not `aria-hidden`, which would leave it tabbable.
		expect(styleOf('#undrawn').visibility).toBe('hidden');
	});

	it('shows an open branch and its rows', () => {
		expect(styleOf('#open-branch').visibility).toBe('visible');
		expect(styleOf('#drawn').visibility).toBe('visible');
	});

	// The row itself is never inside its own branch, so a collapse can never take the focused row
	// with it: the click that collapses lands on the row above the subtree.
	it('leaves the row that toggles a branch on screen in either state', () => {
		expect(styleOf('#open-row').visibility).toBe('visible');
		expect(styleOf('#shut-row').visibility).toBe('visible');
	});

	/*
	 * The track collapses only because the wrapper's one grid item is not `overflow: visible` — a
	 * grid item's automatic minimum size is content-based while it is. Both ways of saying that are
	 * declared, and this is the one a reader is most likely to "tidy" away.
	 */
	it('lets the wrapper’s one item shrink below its content', () => {
		const clip = styleOf('.tree-branch-clip');
		expect(clip.overflow).toBe('clip');
		expect(clip.minHeight).toBe('0px');
		// `clip` rather than `hidden`, with a margin, so a row's focus ring against this box's own
		// right edge is not shaved off. Still not `visible`, so the track still collapses.
		expect(clip.getPropertyValue('overflow-clip-margin')).toBe('2px');
	});
});

describe('and it opens and closes by a transition rather than by an animation', () => {
	it('transitions the grid track the branch is drawn in', () => {
		const rule = ruleFor('.tree-branch');

		expect(rule).toContain('grid-template-rows: 0fr');
		expect(rule).toMatch(/transition:[^;]*grid-template-rows/);
		expect(ruleFor('.tree-branch-open')).toContain('grid-template-rows: 1fr');
	});

	// The same refusal `no-looping-animation.test.ts` makes over every stylesheet, said again where
	// the motion actually is — so this file fails on its own if the mechanism is ever swapped.
	it('declares no animation of any kind on either rule', () => {
		for (const selector of ['.tree-branch', '.tree-branch-open']) {
			expect(ruleFor(selector)).not.toMatch(/\banimation[a-z-]*\s*:/);
			expect(ruleFor(selector)).not.toContain('@keyframes');
		}
	});

	/*
	 * One duration, declared once as a custom property and read by both rules — so the closing
	 * direction's `visibility` delay cannot drift from the shrink it is waiting for.
	 */
	it('keeps the duration in the 120–200ms band, in one place', () => {
		const declared = /--tree-branch-motion:\s*(\d+)ms/.exec(ruleFor('.tree-branch'));
		const ms = Number(declared?.[1]);

		expect(ms).toBeGreaterThanOrEqual(SHORTEST_MS);
		expect(ms).toBeLessThanOrEqual(LONGEST_MS);
		expect(ruleFor('.tree-branch')).toContain('visibility 0s linear var(--tree-branch-motion)');
		expect(ruleFor('.tree-branch-open')).toContain('visibility 0s linear 0s');
	});

	/*
	 * **The suppression is the panel's existing global block, and it had to floor the delay too.**
	 * A floored *duration* does not reach a delayed `visibility`, so under `reduce` a shut branch
	 * would stay focusable for the length of a transition that never ran — nothing on screen, and a
	 * state the criterion says must not exist.
	 */
	it('is suppressed under prefers-reduced-motion, delay included', () => {
		const css = INDEX_CSS?.sourceWithoutComments ?? '';
		const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
		const block = css.slice(at, css.indexOf('}', css.indexOf('}', at) + 1));

		expect(at).toBeGreaterThan(-1);
		expect(block).toContain('transition-duration: 0.01ms !important');
		expect(block).toContain('transition-delay: 0.01ms !important');
	});
});
