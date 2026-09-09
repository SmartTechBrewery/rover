import { describe, expect, it } from 'vitest';
import { readPanelSources } from '../../helpers/panel-source-scan.js';

/**
 * Four of issue #200's acceptance criteria, as an executable gate: **every label badge's fill is a
 * step of one palette family, legible at badge size, distinguishable from the fill of the number
 * beside it, and never close enough to a colour that already means something to read as an
 * outcome** (`docs/DESIGN.md` §9, §5).
 *
 * Since #206 the badges are unbounded numbers and the ramps are not, so `label-badge.tsx` wraps at
 * the last cycle this file declares — which makes the sequence of fills **periodic in twenty-eight**
 * and means one period plus one covers every consecutive pair a group can produce, the wrap
 * included. The component's own ceiling is read back out of its source below and compared with
 * what `index.css` declares, so the two cannot drift into two ideas of how many cycles there are.
 *
 * Nothing here trusts a hex written in a test. The colours come out of `panel/src/tokens.css`, the
 * per-family and per-cycle mix percentages come out of `panel/src/index.css`, and every fill is
 * recomputed by the same per-channel arithmetic `color-mix(in srgb, …)` performs — which is why
 * the ramp is declared `in srgb` rather than in a perceptual space (`index.css` says so at the
 * ramp). Change a token, a percentage or an end of a ramp and this file recomputes and re-judges.
 *
 * That arithmetic is not taken on trust either: all twenty-eight stops were cross-checked against
 * lightningcss — the engine the panel's own Vite build runs — evaluating the very `color-mix()`
 * calls the ramp declares, and every one agrees byte for byte with the values `docs/DESIGN.md` §9
 * records.
 *
 * **The distance metric is CIE76 ΔE over Lab**, ~20 lines of arithmetic and blunt by modern
 * standards — deliberately, because both thresholds below are *calibrated against colours already
 * in the repository* rather than picked off a table, so the metric only has to be the same one on
 * both sides of the comparison:
 *
 * - **ΔE ≥ 10 from a colour that means something.** The palette's own tightest margin is cycle 1's
 *   `--color-tertiary-fixed` (`#47ffb8`) against §5's free-device green `--color-tertiary`
 *   (`#00e29d`): 9.9. That pair shipped in #182 and #200 does not touch it, so 10 is the floor it
 *   sets — *a derived step may never be closer to a meaning-bearing colour than the shipped palette
 *   already is*. Cycle 1 is asserted separately to be the token itself, which is what exempts it.
 * - **ΔE ≥ 15 between the fills of two consecutive numbers.** A plain repeat — what `1`…`4` gave
 *   `5`…`8` before #200 — puts `4`'s neutral `#e2e2e6` beside `5`'s `#dde1ff` at 13.6, the
 *   pair #197 had to record as the weak one. The threshold is set above it, so this gate fails if
 *   the modulation is ever removed or flattened back into a repeat.
 *
 * Contrast is WCAG 2.x relative luminance: **4.5:1** for the number on its fill, because the badge
 * draws it at 12px bold and that is not "large text"; **3:1** for the fill against the card's
 * `--color-surface-container`, which is 1.4.11's floor for a graphical object — a badge has to read
 * as a badge before the number in it can be read at all.
 *
 * What this file does *not* check is which number gets which family and cycle — that is
 * `label-badge.tsx`'s arithmetic and `label-badge.test.tsx` pins it against the rendered classes.
 * Here the same three lines are re-derived over `1`, `2`, `3`, … so the adjacency claim is about
 * the order a reader actually sees.
 */

/** `--color-<name>: #<hex>;` out of the token file — the only file allowed to write a colour. */
function tokensOf(source: string): ReadonlyMap<string, string> {
	const tokens = new Map<string, string>();
	for (const match of source.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})\s*;/g)) {
		tokens.set(match[1], match[2]);
	}
	return tokens;
}

interface Family {
	/** The light end of the ramp, and the fill cycle 1 draws on. */
	readonly hue: string;
	/** The dark end. A step is an interpolation towards it, never a new colour. */
	readonly shade: string;
	/** The number's own colour, on every cycle of this family. */
	readonly ink: string;
	/** The mix percentage of each cycle, cycle 1 first. Cycle 1 is the ramp's implied identity. */
	readonly steps: readonly number[];
}

/**
 * The families and their steps, read out of `index.css`'s own rules: `.label-badge-<family>` for
 * the three tokens a ramp runs over, `.label-badge-<family>.label-badge-cycle-<n>` for its step.
 *
 * Read from the comment-stripped source, so a percentage discussed in a docblock is not mistaken
 * for a declaration. Cycle 1 has no rule of its own — it is the utility pair the component draws
 * `1`…`4` with — so it enters here as the 100% that makes the mix the identity.
 */
function familiesOf(css: string): ReadonlyMap<string, Family> {
	const ends = new Map<string, { hue: string; shade: string; ink: string }>();
	for (const match of css.matchAll(/\.label-badge-([a-z]+)\s*\{([^}]*)\}/g)) {
		const [, name, body] = match;
		if (name === 'step') continue;
		const read = (property: string) =>
			new RegExp(`--badge-${property}:\\s*var\\(--color-([\\w-]+)\\)`).exec(body)?.[1] ?? '';
		ends.set(name, { hue: read('hue'), shade: read('shade'), ink: read('ink') });
	}

	const steps = new Map<string, Map<number, number>>([...ends.keys()].map((n) => [n, new Map()]));
	for (const match of css.matchAll(
		/\.label-badge-([a-z]+)\.label-badge-cycle-(\d+)\s*\{\s*--badge-step:\s*(\d+)%/g,
	)) {
		const family = steps.get(match[1]);
		if (family === undefined) {
			throw new Error(`.label-badge-${match[1]} has a cycle step but no ramp of its own`);
		}
		family.set(Number(match[2]), Number(match[3]));
	}

	return new Map(
		[...ends].map(([name, end]) => {
			const declared = steps.get(name) ?? new Map<number, number>();
			const cycles = [...declared.keys()].sort((a, b) => a - b);
			if (cycles.some((cycle, at) => cycle !== at + 2)) {
				throw new Error(`${name}'s cycle rules are not 2…${cycles.length + 1}: ${cycles}`);
			}
			return [
				name,
				{ ...end, steps: [100, ...cycles.map((cycle) => Number(declared.get(cycle)))] },
			];
		}),
	);
}

/**
 * The three §5 gives a device state to, the not-ready grey, and both halves of `error` — the six
 * colours a badge may never be mistaken for, because a badge that reads as one of them reads as an
 * outcome and Rover has none (`ai/RULES.md` §1).
 */
const MEANS_SOMETHING = [
	'tertiary',
	'primary-container',
	'secondary-container',
	'outline',
	'error',
	'error-container',
] as const;

/**
 * The card a badge is drawn on — a step may not collapse into it.
 *
 * `surface-container-highest` used to be here as well, as `@`'s own inverted fill. #206 removed the
 * overflow, so there is no second quiet colour for a step to collide with and nothing left to
 * measure against.
 */
const CARD = 'surface-container';

const MEANING_DELTA_E = 10;
const ADJACENT_DELTA_E = 15;
/** Two stops of one family sit four numbers apart, so a *perceptible* step is the whole ask. */
const SAME_FAMILY_DELTA_E = 3;
const INK_CONTRAST = 4.5;
const CARD_CONTRAST = 3;

type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb {
	return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb;
}

function hex(colour: Rgb): string {
	return `#${colour.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** `color-mix(in srgb, a p%, b)` — per-channel arithmetic on the gamma-encoded bytes. */
function mix(a: Rgb, b: Rgb, percent: number): Rgb {
	const p = percent / 100;
	return a.map((channel, at) => channel * p + b[at] * (1 - p)) as unknown as Rgb;
}

function linear(channel: number): number {
	const s = channel / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(colour: Rgb): number {
	const [r, g, b] = colour.map(linear);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
	const [x, y] = [luminance(a), luminance(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** CIE Lab, D65, the sRGB matrix — the input to CIE76 below and nothing else. */
function lab(colour: Rgb): readonly [number, number, number] {
	const [r, g, b] = colour.map(linear);
	const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
	const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
	const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
	const [fx, fy, fz] = [f(x), f(y), f(z)];
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a: Rgb, b: Rgb): number {
	const [x, y] = [lab(a), lab(b)];
	return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const SOURCES = readPanelSources();

function sourceOf(path: string): string {
	const file = SOURCES.find((candidate) => candidate.path === path);
	if (file === undefined) throw new Error(`${path} is not under panel/src`);
	return file.sourceWithoutComments;
}

const TOKENS = tokensOf(sourceOf('panel/src/tokens.css'));
const FAMILIES = familiesOf(sourceOf('panel/src/index.css'));

/**
 * The palette's ceiling as the **component** states it — `PALETTE_CYCLES` out of
 * `label-badge.tsx`, read as source text because a `.tsx` cannot be imported from this project
 * (`tsconfig.typecheck.json` enables no JSX).
 *
 * It is read rather than written down because #206 made it load-bearing: the numbers are unbounded,
 * so this constant is what stops the component naming a `label-badge-cycle-8` no rule defines, and
 * a ramp added here without raising it would simply never be drawn.
 */
const COMPONENT_CYCLES = Number(
	/export const PALETTE_CYCLES = (\d+);/.exec(
		sourceOf('panel/src/components/archive/label-badge.tsx'),
	)?.[1],
);

function token(name: string): Rgb {
	const value = TOKENS.get(name);
	if (value === undefined) throw new Error(`--color-${name} is not in tokens.css`);
	return rgb(value);
}

function fillOf(family: string, cycle: number): Rgb {
	const spec = FAMILIES.get(family);
	if (spec === undefined) throw new Error(`no .label-badge-${family} rule in index.css`);
	const step = spec.steps[cycle - 1];
	if (step === undefined) throw new Error(`${family} has no cycle ${cycle}`);
	return mix(token(spec.hue), token(spec.shade), step);
}

/** Every stop of every ramp, recomputed once. `at` is how a failure below names the offender. */
const STEPS = [...FAMILIES].flatMap(([family, spec]) =>
	spec.steps.map((step, index) => ({
		at: `${family} cycle ${index + 1} (${step}%)`,
		family,
		cycle: index + 1,
		ink: token(spec.ink),
		fill: fillOf(family, index + 1),
	})),
);

/** Cycles 2…7 — what this phase derives, and what the thresholds below judge. */
const DERIVED = STEPS.filter((step) => step.cycle > 1);

/**
 * The badges as they are drawn — `label-badge.tsx`'s own three lines, re-derived here. The family
 * order is the order the four rules are declared in `index.css`, which is the order cycle 1's four
 * utility pairs are declared in the component; `label-badge.test.tsx` is what pins the two
 * together at the class name.
 *
 * One period **plus one**: the fills repeat every `families × cycles` numbers, so `29` is `1`'s
 * fill again and the pair `28`/`29` is the wrap boundary. Including it is what makes the
 * adjacency claim below cover every consecutive pair an unbounded numbering can reach, rather than
 * every pair up to some number somebody chose.
 */
const FAMILY_ORDER = [...FAMILIES.keys()];
const PERIOD = FAMILY_ORDER.length * COMPONENT_CYCLES;
const DRAWN = Array.from({ length: PERIOD + 1 }, (_, index) => ({
	number: index + 1,
	family: FAMILY_ORDER[index % FAMILY_ORDER.length],
	cycle: (Math.floor(index / FAMILY_ORDER.length) % COMPONENT_CYCLES) + 1,
}));

describe('the label badge palette, recomputed from the tokens', () => {
	// A gate that resolved nothing would pass everything below by never looking.
	it('reads four families of seven steps out of index.css, over tokens.css', () => {
		expect(FAMILY_ORDER).toEqual(['primary', 'secondary', 'tertiary', 'neutral']);
		expect(TOKENS.size).toBe(47);
		// The component's ceiling and the stylesheet's are one number (#206).
		expect(COMPONENT_CYCLES).toBe(7);

		for (const [name, family] of FAMILIES) {
			expect(family.steps, `${name} steps`).toHaveLength(7);
			expect(family.steps[0], `${name} cycle 1`).toBe(100);
			// Monotonic and distinct: a cycle is always deeper into the shade than the last.
			expect(family.steps, `${name} steps descend`).toEqual(
				[...family.steps].sort((a, b) => b - a),
			);
			expect(new Set(family.steps).size, `${name} steps are distinct`).toBe(7);
			for (const end of [family.hue, family.shade, family.ink]) {
				expect(TOKENS.has(end), `${name}: --color-${end}`).toBe(true);
			}
		}
	});

	/*
	 * **Cycle 1 is unchanged, as a computation rather than a claim.** Mixing at 100% is the
	 * identity, so the first stop of every ramp *is* the token the component's own Tailwind utility
	 * pair draws `A`…`D` on — the ramp and the utility class cannot drift apart into two ideas of
	 * what the first cycle is.
	 */
	it('starts every ramp at the token cycle 1 already draws', () => {
		for (const [name, family] of FAMILIES) {
			expect(hex(fillOf(name, 1)), `${name} cycle 1`).toBe(TOKENS.get(family.hue));
		}
		// The four cycle 1 fills, spelled out: #182's palette, which nothing since has touched.
		expect([...FAMILIES.keys()].map((name) => hex(fillOf(name, 1)))).toEqual([
			'#dde1ff',
			'#ffdbce',
			'#47ffb8',
			'#e2e2e6',
		]);
	});

	/*
	 * **Every number is legible on its own fill, and every badge reads as a badge.** Both floors
	 * are stated in this file's docblock with the reason the number is that number.
	 */
	it('carries its number at 4.5:1 and sits 3:1 off the card', () => {
		const failures = STEPS.flatMap((step) => {
			const ink = contrast(step.fill, step.ink);
			const card = contrast(step.fill, token(CARD));
			return [
				...(ink < INK_CONTRAST ? [`${step.at} ${hex(step.fill)}: ink ${ink.toFixed(2)}:1`] : []),
				...(card < CARD_CONTRAST
					? [`${step.at} ${hex(step.fill)}: card ${card.toFixed(2)}:1`]
					: []),
			];
		});

		expect(failures).toEqual([]);
		expect(STEPS).toHaveLength(28);
	});

	/*
	 * **No badge may read as an outcome** (`docs/DESIGN.md` §5, §9): not the free-device green, the
	 * held blue or the warning orange, not the not-ready grey, and not either half of `error`. This
	 * is the criterion #182 and #197 both argued from the token names; a derived step cannot be
	 * argued that way, so here it is measured.
	 *
	 * Cycle 1 is exempt and is asserted above to be the shipped token itself: its own margin
	 * (`tertiary-fixed` against the free green, 9.9) is where the threshold comes from.
	 */
	it('keeps every derived step clear of every colour that already means something', () => {
		const failures = DERIVED.flatMap((step) =>
			MEANS_SOMETHING.map((meaning) => ({
				meaning,
				distance: deltaE(step.fill, token(meaning)),
				at: `${step.at} ${hex(step.fill)}`,
			}))
				.filter((measured) => measured.distance < MEANING_DELTA_E)
				.map(
					(measured) =>
						`${measured.at} is ΔE ${measured.distance.toFixed(1)} from --color-${measured.meaning}`,
				),
		);

		expect(failures).toEqual([]);
		expect(DERIVED).toHaveLength(24);
	});

	/*
	 * **A step may not collapse into the card it sits on**, which is the 3:1 above stated as a
	 * distance rather than as a contrast ratio: a badge has to read as a badge. Judged at the
	 * adjacency threshold, since a badge and the card are always side by side.
	 */
	it('keeps every step clear of the card', () => {
		const failures = STEPS.filter((step) => deltaE(step.fill, token(CARD)) < ADJACENT_DELTA_E).map(
			(step) =>
				`${step.at} ${hex(step.fill)} is ΔE ${deltaE(step.fill, token(CARD)).toFixed(1)} from --color-${CARD}`,
		);

		expect(failures).toEqual([]);
	});

	/*
	 * **No two consecutive numbers read as one colour, every boundary included** — the cycle
	 * boundaries #200 closed, and the **wrap** #206 adds. Before #200, `4`/`5` was `#e2e2e6`
	 * beside `#dde1ff` at ΔE 13.6, the weakest adjacency in the set.
	 *
	 * One period plus one is the whole claim rather than a sample: the fills repeat every
	 * twenty-eight numbers, so `1`/`2` … `28`/`29` is every consecutive pair that exists, and
	 * `28`/`29` is the wrap — a neutral cycle 7 beside cycle 1's lavender, which is the same kind
	 * of boundary as `4`/`5` and is measured as one.
	 */
	it('separates every pair of consecutive numbers, the wrap included', () => {
		const failures: string[] = [];
		let closest = { pair: '', distance: Number.POSITIVE_INFINITY };

		for (const [at, next] of DRAWN.entries()) {
			if (at === 0) continue;
			const previous = DRAWN[at - 1];
			const distance = deltaE(
				fillOf(previous.family, previous.cycle),
				fillOf(next.family, next.cycle),
			);
			const pair = `#${previous.number}/#${next.number} (${previous.family} cycle ${previous.cycle} / ${next.family} cycle ${next.cycle})`;
			if (distance < closest.distance) closest = { pair, distance };
			if (distance < ADJACENT_DELTA_E) {
				failures.push(`${pair}: ΔE ${distance.toFixed(1)}`);
			}
		}

		expect(failures).toEqual([]);
		expect(DRAWN).toHaveLength(29);
		// `29` is `1`'s fill again: the colour repeats and the digits are what distinguish them.
		expect(DRAWN.at(-1)).toEqual({ ...DRAWN[0], number: PERIOD + 1 });
		// No boundary is the plain repeat's 13.6 any more, the wrap least of all.
		expect(closest.distance).toBeGreaterThan(ADJACENT_DELTA_E);
	});

	/*
	 * **The cycle is a cycle**: seven stops of one hue, each a perceptible step off the last, so
	 * `5` is recognisably `1`'s family at another level rather than a repeat of it or a new
	 * colour. Two stops of one family are four numbers apart, never adjacent, which is why this
	 * floor is the perceptible one and not the adjacency one.
	 */
	it('makes every cycle of a family a step off the last', () => {
		const failures = DERIVED.map((step) => ({
			at: `${step.family} cycle ${step.cycle - 1} → ${step.cycle}`,
			distance: deltaE(fillOf(step.family, step.cycle - 1), step.fill),
		}))
			.filter((measured) => measured.distance < SAME_FAMILY_DELTA_E)
			.map((measured) => `${measured.at}: ΔE ${measured.distance.toFixed(1)}`);

		expect(failures).toEqual([]);
		// Seven stops, seven colours: no two numbers of one period share a family's step.
		for (const family of FAMILIES.keys()) {
			const drawn = STEPS.filter((step) => step.family === family).map((step) => hex(step.fill));
			expect(new Set(drawn).size, `${family} draws seven colours`).toBe(7);
		}
	});

	/*
	 * **The `-fixed-dim` family is not a free second cycle**, which is the shortcut #200 was
	 * expected to take. Asserted rather than only written down, because the numbers are what make
	 * the rejection stick: two of the three are byte-identical to a colour already spent, and the
	 * third is inside the threshold of `error`.
	 */
	it('records why the `-fixed-dim` tokens cannot be a cycle', () => {
		expect(TOKENS.get('tertiary-fixed-dim')).toBe(TOKENS.get('tertiary'));
		expect(TOKENS.get('primary-fixed-dim')).toBe(TOKENS.get('primary'));
		expect(deltaE(token('secondary-fixed-dim'), token('error'))).toBeLessThan(MEANING_DELTA_E);

		// No family's ramp runs over one of them, either as an end or as a step.
		for (const family of FAMILIES.values()) {
			for (const end of [family.hue, family.shade, family.ink]) {
				expect(end).not.toContain('fixed-dim');
			}
		}
	});
});
