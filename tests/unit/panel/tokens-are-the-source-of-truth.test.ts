import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fixture from '../../fixtures/design/analog-horizon-tokens.json' with { type: 'json' };
import { lineOf, panelSourcePath, readPanelSources } from '../../helpers/panel-source-scan.js';

/**
 * The headline acceptance criterion of issue #111, as an executable gate: **the Analog
 * Horizon tokens are the panel's source of truth for colour, type, spacing and radius, and
 * a hex code written inline in a component is a failure.**
 *
 * Two halves, and both are needed. The first checks that every value the design system
 * defines actually reached `panel/src/tokens.css` — a token file that quietly lost half the
 * palette passes the second half trivially. The second checks that nothing under `panel/src`
 * writes a colour anywhere else, which is the failure `docs/DESIGN.md` §1 says this rule
 * exists to prevent.
 *
 * The fixture is `designMd` captured verbatim from `get_project` (`ai/RULES.md` §8), in the
 * spirit of `ai/TESTING.md`'s "fixtures come off a real device": it is the design system's
 * own words, not what somebody believed they said. Deliberately **not** the Tailwind config
 * the reference screen's emitted HTML carries — that config's `borderRadius` block is shifted
 * one step down from `designMd`'s `rounded` map and gives `full: 0.75rem`, which cannot be a
 * pill.
 */

/**
 * The design's `rounded` names under Tailwind v4's. v4 shifted its radius scale one step, so
 * this is a rename and not a re-valuing: `sm` here is v4's `xs`, and so on down. `full` has
 * no v4 theme key — `rounded-full` is built in — so it is asserted absent rather than mapped.
 */
const RADIUS_NAMES: Readonly<Record<string, string>> = {
	sm: 'xs',
	DEFAULT: 'sm',
	md: 'md',
	lg: 'lg',
	xl: 'xl',
};

/**
 * The design's `unit` is v4's whole spacing scale (a single multiplier), so it maps onto
 * `--spacing`. The four named measures stay plain custom properties: `--container-max` inside
 * `@theme` would land in v4's `--container-*` namespace and emit a `max-w-max` shadowing the
 * built-in `max-width: max-content`.
 */
const SPACING_NAMES: Readonly<Record<string, string>> = {
	unit: '--spacing',
	gutter: '--gutter',
	'margin-mobile': '--margin-mobile',
	'margin-desktop': '--margin-desktop',
	'container-max': '--container-max',
};

/**
 * The one file in the panel allowed to write a colour value. Asserted to be exactly one
 * entry, because the way this gate dies is somebody adding their own file to the list rather
 * than moving their colour into the token file.
 */
const COLOUR_LITERALS_ALLOWED_IN: readonly string[] = ['panel/src/tokens.css'];

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\bcolor\(/g;

const TOKENS_CSS = readFileSync(panelSourcePath('tokens.css'), 'utf8');

// The fixture is read through `with { type: 'json' }`, so its keys are literal types. These
// views say what it is: four maps of design name to value.
const COLOURS: Readonly<Record<string, string>> = fixture.colors;
const RADII: Readonly<Record<string, string>> = fixture.rounded;
const MEASURES: Readonly<Record<string, string>> = fixture.spacing;

interface TypeStep {
	readonly fontFamily: string;
	readonly fontSize: string;
	readonly lineHeight?: string;
	readonly fontWeight?: string;
	readonly letterSpacing?: string;
}

const TYPE_STEPS: Readonly<Record<string, TypeStep>> = fixture.typography;

/** The `--text-<step>--*` metrics Tailwind v4 hangs off a size token, by their fixture key. */
const TYPE_METRICS = [
	['lineHeight', 'line-height'],
	['fontWeight', 'font-weight'],
	['letterSpacing', 'letter-spacing'],
] as const;

function missingFrom(step: string, spec: TypeStep): string[] {
	const missing: string[] = [];

	if (!new RegExp(`--font-${step}\\s*:[^;]*${escapeValue(spec.fontFamily)}`).test(TOKENS_CSS)) {
		missing.push(`--font-${step}: ${spec.fontFamily}`);
	}
	if (!declares(`--text-${step}`, spec.fontSize)) {
		missing.push(`--text-${step}: ${spec.fontSize}`);
	}
	for (const [key, property] of TYPE_METRICS) {
		const value = spec[key];
		if (value !== undefined && !declares(`--text-${step}--${property}`, value)) {
			missing.push(`--text-${step}--${property}: ${value}`);
		}
	}

	return missing;
}

function declares(property: string, value: string): boolean {
	return new RegExp(`${property.replace(/[-]/g, '\\-')}\\s*:\\s*${escapeValue(value)}\\s*;`).test(
		TOKENS_CSS,
	);
}

function escapeValue(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('the Analog Horizon tokens reached tokens.css', () => {
	it('carries every colour the design system defines, under its Tailwind v4 name', () => {
		const missing = Object.entries(COLOURS)
			.filter(([name, hex]) => !declares(`--color-${name}`, hex))
			.map(([name, hex]) => `--color-${name}: ${hex}`);

		expect(missing).toEqual([]);
		// A fixture that silently emptied would make the assertion above vacuous.
		expect(Object.keys(COLOURS).length).toBe(47);
	});

	it('carries every type step, with its family, size and metrics', () => {
		const missing = Object.entries(TYPE_STEPS).flatMap(([step, spec]) => missingFrom(step, spec));

		expect(missing).toEqual([]);
		expect(Object.keys(TYPE_STEPS).length).toBe(7);
	});

	it('carries the radius scale under the v4 names, and leaves `full` to the built-in', () => {
		const missing = Object.entries(RADIUS_NAMES)
			.filter(([design, v4]) => !declares(`--radius-${v4}`, RADII[design]))
			.map(([design, v4]) => `--radius-${v4} (design '${design}'): ${RADII[design]}`);

		expect(missing).toEqual([]);
		expect(TOKENS_CSS).not.toContain('--radius-full');
	});

	it('carries the spacing unit and the four named measures', () => {
		const missing = Object.entries(SPACING_NAMES)
			.filter(([design, property]) => !declares(property, MEASURES[design]))
			.map(([design, property]) => `${property} (design '${design}'): ${MEASURES[design]}`);

		expect(missing).toEqual([]);
	});
});

describe('no colour is written outside tokens.css', () => {
	it('exempts exactly one file', () => {
		expect(COLOUR_LITERALS_ALLOWED_IN).toEqual(['panel/src/tokens.css']);
	});

	it('finds no hex, rgb(), hsl() or oklch() anywhere else under panel/src', () => {
		const sources = readPanelSources();
		const offences: string[] = [];

		for (const file of sources) {
			if (COLOUR_LITERALS_ALLOWED_IN.includes(file.path)) continue;
			COLOUR_LITERAL.lastIndex = 0;
			for (const match of file.sourceWithoutComments.matchAll(COLOUR_LITERAL)) {
				const line = lineOf(file.sourceWithoutComments, match.index);
				offences.push(`${file.path}:${line}: '${match[0]}' — colours come from tokens.css`);
			}
		}

		expect(offences).toEqual([]);
		// A walk that silently resolved nothing would pass the assertion above by never looking.
		expect(sources.length).toBeGreaterThan(10);
	});

	// docs/DESIGN.md §5: the chromatic text-shadow is for the wordmark only. Never on data —
	// serials, UTC timestamps, short hashes and file names stay crisp.
	it('applies the wordmark chroma in exactly one component', () => {
		const users = readPanelSources().filter(
			(file) =>
				!file.path.endsWith('.css') && file.sourceWithoutComments.includes('wordmark-chroma'),
		);

		expect(users.map((file) => file.path)).toEqual(['panel/src/components/layout/sidebar.tsx']);
	});
});
