import { describe, expect, it } from 'vitest';
import {
	lineOf,
	readPanelSources,
	readShippedPanelSources,
} from '../../helpers/panel-source-scan.js';

/**
 * `docs/DESIGN.md` §5, as an executable gate: **no looping animation anywhere in the panel.**
 * Nothing pulses, blinks, flickers, glows in and out or breathes.
 *
 * The rule was written after a `crt-flicker` animating the whole document's opacity on a
 * 0.15 s loop — roughly seven flickers a second, inside the frequency band that matters for
 * photosensitivity, and a full-page repaint every frame. The reference screen no longer
 * carries it, so this gate has nothing to remove; it exists to keep it that way, because the
 * next component library's defaults will offer one back.
 *
 * The static scanline texture is a *background*, not an animation, and stays.
 *
 * Whatever motion the panel does have — hover and press feedback, and one day the lease
 * countdown changing its digits — is suppressed under `prefers-reduced-motion`. The
 * suppression block is stripped before matching, since it necessarily names the very
 * properties being forbidden; everywhere else, an `animation` declaration is a violation.
 */

const ANIMATION_DECLARATION = /\banimation[a-z-]*\s*:/g;
const KEYFRAMES = /@keyframes\b/g;
/** Tailwind's animation utilities. `animate-none` is the opposite of one and is allowed. */
const ANIMATE_UTILITY = /\banimate-(?!none\b)[a-z0-9-]+/g;

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

/** Blank the reduced-motion at-rule and its body, preserving offsets and newlines. */
function withoutReducedMotionBlock(css: string): string {
	const start = css.indexOf(REDUCED_MOTION);
	if (start === -1) return css;

	let depth = 0;
	let end = start;
	for (let at = css.indexOf('{', start); at < css.length; at += 1) {
		if (css[at] === '{') depth += 1;
		else if (css[at] === '}') {
			depth -= 1;
			if (depth === 0) {
				end = at + 1;
				break;
			}
		}
	}

	const blanked = css.slice(start, end).replace(/[^\n]/g, ' ');
	return css.slice(0, start) + blanked + css.slice(end);
}

describe('the panel has no looping animation', () => {
	const sources = readPanelSources();
	const stylesheets = sources.filter((file) => file.path.endsWith('.css'));
	const components = readShippedPanelSources().filter((file) => file.path.endsWith('.tsx'));

	it('scanned both stylesheets and components', () => {
		expect(stylesheets.length).toBeGreaterThan(0);
		expect(components.length).toBeGreaterThan(0);
	});

	it('declares no @keyframes and no animation property in any stylesheet', () => {
		const offences: string[] = [];

		for (const file of stylesheets) {
			const scanned = withoutReducedMotionBlock(file.sourceWithoutComments);
			for (const pattern of [KEYFRAMES, ANIMATION_DECLARATION]) {
				pattern.lastIndex = 0;
				for (const match of scanned.matchAll(pattern)) {
					offences.push(`${file.path}:${lineOf(scanned, match.index)}: '${match[0].trim()}'`);
				}
			}
		}

		expect(offences).toEqual([]);
	});

	it('uses no animation utility in any component', () => {
		const offences: string[] = [];

		for (const file of components) {
			ANIMATE_UTILITY.lastIndex = 0;
			for (const match of file.sourceWithoutComments.matchAll(ANIMATE_UTILITY)) {
				offences.push(
					`${file.path}:${lineOf(file.sourceWithoutComments, match.index)}: '${match[0]}'`,
				);
			}
		}

		expect(offences).toEqual([]);
	});

	it('suppresses whatever motion remains under prefers-reduced-motion', () => {
		const declaring = stylesheets.filter((file) => file.source.includes(REDUCED_MOTION));

		expect(declaring.map((file) => file.path)).toContain('panel/src/index.css');
	});
});
