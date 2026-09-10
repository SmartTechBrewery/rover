// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';
import { readPanelSources } from '../../helpers/panel-source-scan.js';

/**
 * `docs/DESIGN.md` §5 and §10's fourth piece of motion, as an executable gate: **a card the
 * Projects screen's next answer no longer carries collapses out over a short transition, and that
 * transition is not an animation** (#285).
 *
 * `branch-motion-is-a-transition.test.ts`'s shape, for #280's reasons, and the rule it guards is the
 * same one: §5 forbids a *looping* animation, `no-looping-animation.test.ts` is the executable form
 * of that and is narrower than the prose, and **neither is relaxed by this file**. What changed with
 * #285 is §5's inventory of what moves, not its rule — so what is pinned here is that the new motion
 * stays inside the category §5 already permits, and that a reader who has asked for no motion gets
 * none of it.
 *
 * Three halves rather than that file's two, because this mechanism has a piece that CSS cannot
 * carry:
 *
 * - a real cascade over the panel's own `@layer base`, for the two declarations that let a grid
 *   track shrink below its content and for the one thing the cascade deliberately does **not** do
 *   (`jsdom does not descend into @layer`, so the layer is unwrapped rather than injected whole —
 *   a rule left inside one parses, is ignored, and every assertion below fails rather than passing
 *   vacuously);
 * - a source scan for the questions jsdom cannot answer: is it a transition, is its duration in the
 *   band, is the gutter cancelled, is the suppression floored;
 * - the number the transition runs for against the number the unmount timer waits for. Those are
 *   written in two languages and there is no way to make them one declaration, so this is the only
 *   thing keeping them equal.
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

/**
 * The hook's own source, read rather than imported.
 *
 * Every gate in this directory scans text, and this one has to as well: the panel tree is a
 * separate TypeScript project with its own `@panel/*` alias (`panel/tsconfig.json`), and the
 * repo-wide config these tests are checked under deliberately does not carry it — one alias never
 * means two trees. `panel/src/routes/projects.test.tsx` imports the constant properly, from inside
 * the project that owns it.
 */
const HOOK = readPanelSources().find(
	(file) => file.path === 'panel/src/projects/drawn-registrations.ts',
);

/** One declaration block by its selector, out of the comment-free stylesheet. */
function ruleFor(selector: string): string {
	const rules = baseLayerOf(INDEX_CSS?.sourceWithoutComments ?? '');
	const at = rules.indexOf(`${selector} {`);
	if (at === -1) throw new Error(`no \`${selector}\` rule in index.css`);
	return rules.slice(at, rules.indexOf('}', at));
}

/** The band #280 settled and this motion joins: long enough to read, short enough not to hold up. */
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

	// The list's own shape — `projects.tsx`'s `ProjectList`: the box on every card, one of them shut
	// and `inert` because the host's latest answer no longer carries it.
	document.body.innerHTML = `
		<div>
			<div class="card-collapse" id="staying">
				<div class="card-collapse-clip">
					<article id="staying-card"><button type="button">Delete project checkout-web</button></article>
				</div>
			</div>
			<div class="card-collapse card-collapse-shut" id="leaving" inert>
				<div class="card-collapse-clip">
					<article id="leaving-card"><button type="button">Delete project rover-sandbox</button></article>
				</div>
			</div>
		</div>
	`;
});

describe('a card on its way off the Projects screen', () => {
	it('injected the panel’s own base rules, not an empty stylesheet', () => {
		expect(STYLESHEETS.map((sheet) => sheet.path)).toContain('panel/src/index.css');
		expect(STYLESHEETS.some((sheet) => baseLayerOf(sheet.source).trim() !== '')).toBe(true);
	});

	/*
	 * The track collapses only because the box's one grid item is not `overflow: visible` — a grid
	 * item's automatic minimum size is content-based while it is. Both ways of saying that are
	 * declared, and this is the one a reader is most likely to "tidy" away.
	 */
	it('lets the box’s one item shrink below the card in it', () => {
		const clip = styleOf('.card-collapse-clip');

		expect(clip.overflow).toBe('clip');
		expect(clip.minHeight).toBe('0px');
	});

	/*
	 * **The one thing the cascade must not do**, and the reason `inert` is on the box at all. A shut
	 * branch of the archive tree is `visibility: hidden`, which takes it out of the tab order and out
	 * of the accessibility tree in one stroke; a card that is leaving has to stay *visible* for the
	 * length of the motion, so no rule here can do that job and the attribute has to.
	 */
	it('is still visible while it collapses, so nothing in the cascade hides it', () => {
		expect(styleOf('#leaving').visibility).toBe('visible');
		expect(styleOf('#leaving-card').visibility).toBe('visible');
		expect(styleOf('#staying-card').visibility).toBe('visible');
	});

	// Said in the fixture above because it is what `projects.tsx` renders, and asserted here so this
	// file fails if the attribute is ever dropped for a CSS rule that cannot replace it.
	// `projects.test.tsx` is where it is asserted against the real component.
	it('carries `inert`, and the card that is staying does not', () => {
		expect(document.querySelector('#leaving')?.hasAttribute('inert')).toBe(true);
		expect(document.querySelector('#staying')?.hasAttribute('inert')).toBe(false);
	});
});

describe('and it leaves by a transition rather than by an animation', () => {
	// Mounted open, on every card: a CSS transition does not run on an element's first style
	// computation, so a box that appeared already shut would take the card in one frame.
	it('mounts the box open and shuts it with a class', () => {
		expect(ruleFor('.card-collapse')).toContain('grid-template-rows: 1fr');
		expect(ruleFor('.card-collapse')).toMatch(/transition:[^;]*grid-template-rows/);
		expect(ruleFor('.card-collapse-shut')).toContain('grid-template-rows: 0fr');
	});

	/*
	 * **The gutter collapses with the card.** The list is a flex column with `gap-(--gutter)` and a
	 * zero-height item still has a gap on each side of it, so a card shrunk to nothing would leave a
	 * stray gutter standing and the list would jump by one at unmount — the jump this motion exists
	 * to remove, arriving 160ms late instead. Both the cancelling margin and its transition are
	 * asserted, because the margin without the transition is a jump of its own.
	 */
	it('cancels the gutter its own row was holding, over the same duration', () => {
		expect(ruleFor('.card-collapse-shut')).toContain('margin-bottom: calc(-1 * var(--gutter))');
		expect(ruleFor('.card-collapse')).toMatch(/transition:[^;]*margin-bottom/);
	});

	// The same refusal `no-looping-animation.test.ts` makes over every stylesheet, said again where
	// the motion actually is — so this file fails on its own if the mechanism is ever swapped.
	it('declares no animation of any kind on any of the three rules', () => {
		for (const selector of ['.card-collapse', '.card-collapse-clip', '.card-collapse-shut']) {
			expect(ruleFor(selector)).not.toMatch(/\banimation[a-z-]*\s*:/);
			expect(ruleFor(selector)).not.toContain('@keyframes');
		}
	});

	/*
	 * One duration for the panel's one-shot motion, at `:root` under a panel-level name rather than
	 * the tree's — #280 declared it inside `.tree-branch`, and this is the second motion to read it.
	 * `branch-motion-is-a-transition.test.ts` asserts the branch reads the same property.
	 */
	it('reads the panel’s one motion duration, in the 120–200ms band', () => {
		const declared = /--panel-motion:\s*(\d+)ms/.exec(ruleFor(':root'));
		const ms = Number(declared?.[1]);

		expect(ms).toBeGreaterThanOrEqual(SHORTEST_MS);
		expect(ms).toBeLessThanOrEqual(LONGEST_MS);
		expect(ruleFor('.card-collapse')).toContain('grid-template-rows var(--panel-motion)');
		expect(ruleFor('.card-collapse')).toContain('margin-bottom var(--panel-motion)');
	});

	/*
	 * **The transition and the unmount are written in two languages, and this is what keeps them one
	 * number.** No stylesheet can drop a React child, and `transitionend` is the wrong instrument —
	 * `grid-template-rows` is not interpolable in every engine, and an event that never fires would
	 * leave the card standing for good rather than for 160ms.
	 */
	it('waits exactly as long in JavaScript as the transition runs in CSS', () => {
		const declared = /--panel-motion:\s*(\d+)ms/.exec(ruleFor(':root'));
		const held = /PANEL_MOTION_MS\s*=\s*(\d+)\b/.exec(HOOK?.sourceWithoutComments ?? '');

		expect(held).not.toBeNull();
		expect(Number(held?.[1])).toBe(Number(declared?.[1]));
	});

	/*
	 * **The CSS half inherits the panel's existing suppression; the timer had to be told.** A floored
	 * duration reaches this transition, so under `reduce` nothing moves — but nothing in the cascade
	 * reaches a `setTimeout`, so `drawn-registrations.ts` reads the query itself and holds no card at
	 * all. The delay line is asserted because #280 added it and a card left half-collapsed is exactly
	 * what dropping it would produce.
	 */
	it('is suppressed under prefers-reduced-motion, in the cascade and in the timer', () => {
		const css = INDEX_CSS?.sourceWithoutComments ?? '';
		const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
		const block = css.slice(at, css.indexOf('}', css.indexOf('}', at) + 1));

		expect(at).toBeGreaterThan(-1);
		expect(block).toContain('transition-duration: 0.01ms !important');
		expect(block).toContain('transition-delay: 0.01ms !important');

		expect(HOOK?.sourceWithoutComments).toContain('(prefers-reduced-motion: reduce)');
	});
});
