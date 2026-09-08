import { describe, expect, it } from 'vitest';
import {
	lineOf,
	type PanelSource,
	readShippedPanelSources,
} from '../../helpers/panel-source-scan.js';

/**
 * `docs/DESIGN.md` §4's right-edge rule, as an executable gate: **a screen's content row takes the
 * width `<main>` gives it**, the shell's own padding a side and nothing else, so the header's right
 * edge and the content's are the same line at every window width (#240).
 *
 * What went wrong is that two widths were in play and only one of them was capped. `PageHeader`
 * never had a measure of its own, so it filled the content box, while the Archive's tree-plus-card
 * row and the Projects list each carried `max-w-(--container-max)` — 1280px. On a 1920px window the
 * content box is `1920 − 256 − 2 × 40 = 1584px`, so the row stopped 304px short of the toggle
 * sitting in the header above it; at 2560px the strip is 944px. The cap and the header were never
 * written in one place, so they could not have agreed by construction — which is why removing the
 * two utilities needs a gate rather than a note.
 *
 * The exception list has exactly two entries, and both are rules of their own:
 *
 * - `max-w-prose` — a *prose* measure, which is the one place §4 says a measure earns its keep.
 *   The Profile screen's two paragraphs are what carry it.
 * - `max-w-[calc(3*380px+2*var(--gutter))]`, in `panel/src/routes/devices.tsx` only — §4's *at
 *   most three columns, and a card is never full-width* ceiling (#126), argued there with its
 *   arithmetic. The Devices grid is therefore narrower than its own header **by design**, and
 *   nothing in #240 reverses that.
 *
 * The second half is about `--container-max` itself. It stays **defined and unused**: it is an
 * Analog Horizon token, and `tokens-are-the-source-of-truth.test.ts` requires every design-system
 * value to reach `tokens.css`, so deleting it fails that gate — a token the panel defines and no
 * longer applies to a content row is the correct end state, not something for a later cleanup to
 * tidy away. That gate still owns its *value* against the design fixture; this one owns *where it
 * is applied*, which is nowhere.
 *
 * **Its limit, in the family's own terms** (`tests/helpers/panel-source-scan.ts`): the first half
 * reads `panel/src/routes/`, so a content row moved into a component outside that directory would
 * escape it, and the second half covers only the token that caused #240. A floor under the rule
 * rather than a proof of it — jsdom lays nothing out, so nothing here can measure a right edge,
 * the same choice §4 already records for the Devices ceiling.
 *
 * Plain `.ts` in the `unit` project, and here rather than beside the components, because
 * `panel-source-scan.ts` imports `node:fs` and `panel/tsconfig.json` declares no `@types/node`.
 */

/** Every `max-w-…` utility, bracketed or custom-property arbitrary values included. */
const MAX_WIDTH_UTILITY = /\bmax-w-(?:\[[^\]]*\]|\([^)]*\)|[a-z0-9-]+)/g;

/** A measure a screen's content may carry, and the one file it may carry it in. */
interface Allowed {
	readonly utility: string;
	readonly file?: string;
}

const ALLOWED: readonly Allowed[] = [
	{ utility: 'max-w-prose' },
	{ utility: 'max-w-[calc(3*380px+2*var(--gutter))]', file: 'panel/src/routes/devices.tsx' },
];

const TOKENS = 'panel/src/tokens.css';
const CONTAINER_MAX = '--container-max';

const shipped = readShippedPanelSources();
const routes = shipped.filter(
	(file) => file.path.startsWith('panel/src/routes/') && file.path.endsWith('.tsx'),
);

/** Every measure a file carries, as `path:line: 'utility'`. */
function measuresIn(file: PanelSource): { where: string; utility: string }[] {
	MAX_WIDTH_UTILITY.lastIndex = 0;
	return Array.from(file.sourceWithoutComments.matchAll(MAX_WIDTH_UTILITY), (match) => ({
		where: `${file.path}:${lineOf(file.sourceWithoutComments, match.index)}: '${match[0]}'`,
		utility: match[0],
	}));
}

/** An entry's `file`, where it has one, is the only place that measure is allowed. */
function permits(utility: string, path: string): boolean {
	return ALLOWED.some(
		(entry) => entry.utility === utility && (entry.file === undefined || entry.file === path),
	);
}

describe('a screen’s content ends where its header does', () => {
	it('scanned the panel’s screens', () => {
		expect(routes.length).toBeGreaterThan(0);
		expect(routes.map((file) => file.path)).toEqual(
			expect.arrayContaining([
				'panel/src/routes/archive.tsx',
				'panel/src/routes/devices.tsx',
				'panel/src/routes/projects.tsx',
			]),
		);
	});

	it('gives no screen’s content row a measure of its own', () => {
		const offences: string[] = [];

		for (const file of routes) {
			for (const { where, utility } of measuresIn(file)) {
				if (!permits(utility, file.path)) offences.push(where);
			}
		}

		expect(offences).toEqual([]);
	});

	/*
	 * The way a scan gate dies is an exception nobody needs sitting there green, so each entry has
	 * to still be reached by something — `pointer-on-what-can-be-pressed.test.ts`'s *scanned
	 * components that actually draw buttons* and the colour gate's *exactly one entry* are the
	 * precedents.
	 */
	it('keeps both exceptions earning their place, and adds no third', () => {
		const used = new Set(
			routes.flatMap((file) =>
				measuresIn(file)
					.filter(({ utility }) => permits(utility, file.path))
					.map(({ utility }) => utility),
			),
		);

		expect(Array.from(used).sort()).toEqual(ALLOWED.map((entry) => entry.utility).sort());
	});
});

describe('and `--container-max` stays defined with no user', () => {
	it('is still declared in the token file, at its fixture value', () => {
		const tokens = shipped.find((file) => file.path === TOKENS);

		expect(tokens?.sourceWithoutComments).toContain(`${CONTAINER_MAX}: 1280px;`);
	});

	it('is applied nowhere else in the panel', () => {
		const offences: string[] = [];

		for (const file of shipped) {
			if (file.path === TOKENS) continue;
			let at = file.sourceWithoutComments.indexOf(CONTAINER_MAX);
			while (at !== -1) {
				offences.push(`${file.path}:${lineOf(file.sourceWithoutComments, at)}`);
				at = file.sourceWithoutComments.indexOf(CONTAINER_MAX, at + 1);
			}
		}

		expect(offences).toEqual([]);
	});
});
