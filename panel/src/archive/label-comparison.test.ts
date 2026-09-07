import type { ArchiveGroup, ArchiveGroupArtifact } from '@panel/archive/archive-listing.js';
import { describe, expect, it } from 'vitest';
import { comparisonAt } from './label-comparison.js';

const PROJECT = 'c-ai';

/** The investigation's name — the half of the group id an agent typed and can have put in a test name. */
const INVESTIGATION = 'statistics-deliveries';

/**
 * The group id the host actually files since #205: the investigation's name, the reserved separator
 * and the minted suffix. The fixtures run against this rather than a bare name, so the wiring is
 * exercised against what `list_archive_groups` answers with for a group filed today.
 */
const GROUP = `${INVESTIGATION}.h57ssn4`;
const SERIAL = 'R5CT30ABCDE';

/**
 * The evidence case, in the host's own answer order: two arms of one investigation are two sibling
 * **test names**, and a group's runs come back in test-name order with each name's runs
 * chronological inside it. So `variantB`'s run may be answered before `variantA`'s and still be the
 * later one — which is the case a reversal gets wrong and a sort does not.
 */
const ARM_A = `${INVESTIGATION}_variantA`;
const ARM_B = `${INVESTIGATION}_variantB`;
const FIRST = '20260901T090000Z-issue-199-1111aaaa';
const SECOND = '20260902T090000Z-issue-199-2222bbbb';
const THIRD = '20260903T090000Z-issue-199-3333cccc';

const DELIVERIES = 'deliveries-list';
const EMPTY_STATE = 'deliveries-empty';

function artifact(run: readonly string[], name: string, label: string): ArchiveGroupArtifact {
	return { path: [...run, 'screenshots', name], label };
}

/** One run of a group, filing one artifact per label named — the common arity. */
function run(testName: string, name: string, labels: readonly string[]) {
	const path = [PROJECT, testName, name, SERIAL];
	return {
		path,
		artifacts: labels.map((label, index) => artifact(path, `00${index + 1}_${label}.png`, label)),
	};
}

function group(...runs: readonly ReturnType<typeof run>[]): ArchiveGroup {
	return { project: PROJECT, groupId: GROUP, runs: [...runs] };
}

/** The same group as an archive written before #205 holds it — the id carries no minted suffix. */
function unmintedGroup(...runs: readonly ReturnType<typeof run>[]): ArchiveGroup {
	return { project: PROJECT, groupId: INVESTIGATION, runs: [...runs] };
}

/** The address of the artifact a test selects — the archive's own path, with no group id in it. */
function addressOf(testName: string, name: string, label: string, index = 1): readonly string[] {
	return [PROJECT, testName, name, SERIAL, 'screenshots', `00${index}_${label}.png`];
}

describe('the artifacts one label is filed on across a group', () => {
	it('finds the selected artifact’s label and returns every artifact filed under it', () => {
		const groups = [
			group(
				run(ARM_A, FIRST, [DELIVERIES, EMPTY_STATE]),
				run(ARM_B, SECOND, [DELIVERIES, EMPTY_STATE]),
			),
		];

		const comparison = comparisonAt(groups, PROJECT, GROUP, addressOf(ARM_A, FIRST, DELIVERIES));

		expect(comparison?.label).toBe(DELIVERIES);
		// The panes are that label's artifacts and nothing else — the second label is a second card.
		expect(comparison?.panes.map((pane) => pane.path.at(-1))).toEqual([
			`001_${DELIVERIES}.png`,
			`001_${DELIVERIES}.png`,
		]);
		expect(comparison?.panes.map((pane) => pane.run)).toEqual([
			[PROJECT, ARM_A, FIRST, SERIAL],
			[PROJECT, ARM_B, SECOND, SERIAL],
		]);
	});

	/*
	 * **Oldest run first, across two test-name arms** — the deliberate departure from *most recent
	 * first*, and the reason it is a **sort** rather than a reversal: the answer lists the arms in
	 * test-name order, so the later-running arm can be answered first and reversing would order by
	 * name instead of by time.
	 */
	it('orders the panes oldest run first even when the answer lists the later arm first', () => {
		const groups = [group(run(ARM_A, SECOND, [DELIVERIES]), run(ARM_B, FIRST, [DELIVERIES]))];

		const comparison = comparisonAt(groups, PROJECT, GROUP, addressOf(ARM_A, SECOND, DELIVERIES));

		expect(comparison?.panes.map((pane) => pane.run.at(-2))).toEqual([FIRST, SECOND]);
	});

	// A group may hold more than two runs (R41: *a group may have seven*), and nothing caps N.
	it('takes more than two runs, still oldest first', () => {
		const groups = [
			group(
				run(ARM_B, THIRD, [DELIVERIES]),
				run(ARM_A, FIRST, [DELIVERIES]),
				run(ARM_A, SECOND, [DELIVERIES]),
			),
		];

		const comparison = comparisonAt(groups, PROJECT, GROUP, addressOf(ARM_A, FIRST, DELIVERIES));

		expect(comparison?.panes.map((pane) => pane.run.at(-2))).toEqual([FIRST, SECOND, THIRD]);
	});

	/*
	 * **Nothing enforces arity** (R41), so an arm may file one label three times. All three are
	 * panes, in the answer's own order and adjacent: showing the first of them would drop evidence
	 * and invent a selection the archive never made (D22).
	 */
	it('gives two artifacts of one run two adjacent panes, in the answer’s order', () => {
		const path = [PROJECT, ARM_A, FIRST, SERIAL];
		const groups = [
			group(
				{
					path,
					artifacts: [
						artifact(path, 'before.png', DELIVERIES),
						artifact(path, 'after.png', DELIVERIES),
					],
				},
				run(ARM_B, SECOND, [DELIVERIES]),
			),
		];

		const comparison = comparisonAt(groups, PROJECT, GROUP, [...path, 'screenshots', 'before.png']);

		expect(comparison?.panes.map((pane) => pane.path.at(-1))).toEqual([
			'before.png',
			'after.png',
			`001_${DELIVERIES}.png`,
		]);
	});

	// The label is what the archive filed, and nothing here normalises it (D22).
	it('returns the label verbatim, and two labels differing by case are two labels', () => {
		const groups = [
			group(run(ARM_A, FIRST, [' Home_Baseline ']), run(ARM_B, SECOND, ['home_baseline'])),
		];

		const comparison = comparisonAt(groups, PROJECT, GROUP, [
			PROJECT,
			ARM_A,
			FIRST,
			SERIAL,
			'screenshots',
			'001_ Home_Baseline .png',
		]);

		// One run filed ` Home_Baseline ` and the other `home_baseline`, so neither has a partner.
		expect(comparison).toBeNull();
	});

	/*
	 * **The badge letter is the tree's, not a second assignment.** The card draws it over every pane
	 * (`comparison-card.tsx`), so it has to be `lettersOfGroup`'s answer for this group — insertion
	 * order over the host's own walk, which is where the tree's badges come from too. `A` is the
	 * first label the walk met and `B` the second, whichever of them was selected.
	 */
	it('carries the letter this label takes in this group', () => {
		const groups = [
			group(
				run(ARM_A, FIRST, [DELIVERIES, EMPTY_STATE]),
				run(ARM_B, SECOND, [DELIVERIES, EMPTY_STATE]),
			),
		];

		expect(comparisonAt(groups, PROJECT, GROUP, addressOf(ARM_A, FIRST, DELIVERIES))?.letter).toBe(
			'A',
		);
		expect(
			comparisonAt(groups, PROJECT, GROUP, addressOf(ARM_A, FIRST, EMPTY_STATE, 2))?.letter,
		).toBe('B');
	});

	/*
	 * Past the twenty-sixth distinct label the alphabet is out and the badge stops distinguishing —
	 * `@` on the pane exactly as on the tree row, rather than a letter that means something else.
	 */
	it('carries `@` for a label past the end of the alphabet', () => {
		const many = Array.from({ length: 27 }, (_unused, index) => `label-${index}`);
		const groups = [group(run(ARM_A, FIRST, many), run(ARM_B, SECOND, many))];
		const last = many.at(-1) ?? '';

		const comparison = comparisonAt(groups, PROJECT, GROUP, [
			PROJECT,
			ARM_A,
			FIRST,
			SERIAL,
			'screenshots',
			`0027_${last}.png`,
		]);

		expect(comparison?.label).toBe(last);
		expect(comparison?.letter).toBe('@');
	});

	it('keeps a label with surrounding whitespace exactly as it was filed', () => {
		const groups = [group(run(ARM_A, FIRST, [' spaced ']), run(ARM_B, SECOND, [' spaced ']))];

		const comparison = comparisonAt(groups, PROJECT, GROUP, [
			PROJECT,
			ARM_A,
			FIRST,
			SERIAL,
			'screenshots',
			'001_ spaced .png',
		]);

		expect(comparison?.label).toBe(' spaced ');
	});
});

/**
 * **Every pane carries the arm its run names**, which `variant-name.ts` decides and tests on its
 * own. What is asserted here is the wiring: the arm comes off the pane's **own** run, so two panes
 * of one comparison carry two different ones.
 */
describe('the arm each pane names', () => {
	it('carries each pane’s own arm, off that pane’s own test name', () => {
		const groups = [group(run(ARM_A, FIRST, [DELIVERIES]), run(ARM_B, SECOND, [DELIVERIES]))];

		const comparison = comparisonAt(groups, PROJECT, GROUP, addressOf(ARM_A, FIRST, DELIVERIES));

		// The group id's name half off the front of each — `statistics-deliveries_variantA` in
		// `statistics-deliveries.h57ssn4` is `variantA`. A whole minted id is never the front of a
		// test name, which is the regression #205 introduced and this case is the call site's guard.
		expect(comparison?.panes.map((pane) => pane.variant)).toEqual(['variantA', 'variantB']);
	});

	// An archive filed before #205 is not rewritten, so its whole group id is still what comes off.
	it('carries each pane’s arm for a group filed before the host minted ids', () => {
		const groups = [
			unmintedGroup(run(ARM_A, FIRST, [DELIVERIES]), run(ARM_B, SECOND, [DELIVERIES])),
		];

		const comparison = comparisonAt(
			groups,
			PROJECT,
			INVESTIGATION,
			addressOf(ARM_A, FIRST, DELIVERIES),
		);

		expect(comparison?.panes.map((pane) => pane.variant)).toEqual(['variantA', 'variantB']);
	});

	// The arm is the caller's own slice, unphrased: `variantPhrase` is the pane head's, not the data's.
	it('carries the arm as the caller wrote it, with no re-casing on the way', () => {
		const groups = [
			group(
				run(`${INVESTIGATION}_ Variant A `, FIRST, [DELIVERIES]),
				run(ARM_B, SECOND, [DELIVERIES]),
			),
		];

		const comparison = comparisonAt(groups, PROJECT, GROUP, [
			PROJECT,
			`${INVESTIGATION}_ Variant A `,
			FIRST,
			SERIAL,
			'screenshots',
			`001_${DELIVERIES}.png`,
		]);

		expect(comparison?.panes.at(0)?.variant).toBe(' Variant A ');
	});
});

describe('what draws no comparison at all', () => {
	// An artifact the answer filed under no label — every row of the `All` view by construction.
	it('is an artifact with no label', () => {
		const groups = [group(run(ARM_A, FIRST, [DELIVERIES]), run(ARM_B, SECOND, [DELIVERIES]))];

		const unlabelled = [PROJECT, ARM_A, FIRST, SERIAL, 'screenshots', '099_screenshot.png'];

		expect(comparisonAt(groups, PROJECT, GROUP, unlabelled)).toBeNull();
	});

	// **One pane is not a comparison** — so a label only one run filed keeps the single preview.
	it('is a label only one run in the group filed', () => {
		const groups = [
			group(run(ARM_A, FIRST, [DELIVERIES, EMPTY_STATE]), run(ARM_B, SECOND, [DELIVERIES])),
		];

		expect(
			comparisonAt(groups, PROJECT, GROUP, addressOf(ARM_A, FIRST, EMPTY_STATE, 2)),
		).toBeNull();
	});

	// Including while the grouping walk is still out, which is *this answer holds no such group*.
	it('is a (project, groupId) the answer does not hold', () => {
		const groups = [group(run(ARM_A, FIRST, [DELIVERIES]), run(ARM_B, SECOND, [DELIVERIES]))];

		expect(comparisonAt([], PROJECT, GROUP, addressOf(ARM_A, FIRST, DELIVERIES))).toBeNull();
		expect(
			comparisonAt(groups, PROJECT, 'another-group', addressOf(ARM_A, FIRST, DELIVERIES)),
		).toBeNull();
		// A group id only means something inside one project (`archive-listing.ts`).
		expect(
			comparisonAt(groups, 'another-project', GROUP, addressOf(ARM_A, FIRST, DELIVERIES)),
		).toBeNull();
	});

	/*
	 * A run whose address is not the archive's four levels is **skipped**, exactly as
	 * `group-tree.ts`'s `placedRunsOf` skips it: the pane's whole head is *which run this is*, and
	 * placing such a run would mean guessing which of its components was the run.
	 */
	it('skips a run whose address is not four components, and falls back with one pane left', () => {
		const short = [PROJECT, ARM_B, SECOND];
		const groups = [
			group(run(ARM_A, FIRST, [DELIVERIES]), {
				path: short,
				artifacts: [artifact(short, `001_${DELIVERIES}.png`, DELIVERIES)],
			}),
		];

		expect(comparisonAt(groups, PROJECT, GROUP, addressOf(ARM_A, FIRST, DELIVERIES))).toBeNull();
	});
});
