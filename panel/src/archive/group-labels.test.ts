import type { ArchiveGroup, ArchiveGroupArtifact } from '@panel/archive/archive-listing.js';
import { keyOf } from '@panel/archive/archive-path.js';
import { describe, expect, it } from 'vitest';
import { LABEL_LETTERS, labelledArtifactsOf, lettersOfGroup } from './group-labels.js';

const SERIAL = 'R5CT30ABCDE';
/** Two runs of one group under one test name, oldest first — the host's own order. */
const OLDER = '20260829T142201Z-issue-112-4b0e7c15';
const NEWER = '20260830T170501Z-issue-112-9f1c2ab4';

/** One labelled artifact, at the address a `list_archive` walk would have reached it by. */
function artifact(run: readonly string[], name: string, label: string): ArchiveGroupArtifact {
	return { path: [...run, 'screenshots', name], label };
}

function run(project: string, testName: string, name: string, labels: readonly string[]) {
	const path = [project, testName, name, SERIAL];
	return {
		path,
		artifacts: labels.map((label, index) => artifact(path, `00${index + 1}_${label}.png`, label)),
	};
}

/** One group of two runs, each filing the same two labels — R41's own worked example. */
function group(...runs: readonly ReturnType<typeof run>[]): ArchiveGroup {
	return { project: 'checkout-app', groupId: 'app-bar-top-space', runs: [...runs] };
}

const BASELINE = 'home-baseline';
const AFTER = 'home-after';

describe('the letters one group hands out', () => {
	// `A`, `B`, `C`, … in the order the host answered them — runs as the walk met them, artifacts in
	// the name order it read them in.
	it('gives each distinct label a letter, in the answer’s own order', () => {
		const letters = lettersOfGroup(
			group(run('checkout-app', 'home_a_variant', NEWER, [BASELINE, AFTER])),
		);

		expect([...letters]).toEqual([
			[BASELINE, 'A'],
			[AFTER, 'B'],
		]);
	});

	/*
	 * **The same label is the same letter everywhere in the group** — which is the whole point of
	 * the badge: two runs filed `home-baseline` and the reader has to see one letter on both.
	 */
	it('keeps one letter for a label filed by two runs', () => {
		const letters = lettersOfGroup(
			group(
				run('checkout-app', 'home_a_variant', OLDER, [BASELINE, AFTER]),
				run('checkout-app', 'home_b_variant', NEWER, [AFTER, BASELINE]),
			),
		);

		expect(letters.size).toBe(2);
		expect(letters.get(BASELINE)).toBe('A');
		expect(letters.get(AFTER)).toBe('B');
	});

	/*
	 * **Overflow is `@`, and it is a case rather than a corner** (`docs/DESIGN.md` §9). There is no
	 * honest fifth hue in this palette, so the fifth distinct label and every one after it stops
	 * being distinguished by the badge — and says so, rather than reusing `A`.
	 */
	it('gives every label past the fourth `@`', () => {
		const letters = lettersOfGroup(
			group(run('checkout-app', 'home_a_variant', NEWER, ['a', 'b', 'c', 'd', 'e', 'f'])),
		);

		expect([...letters.values()]).toEqual([...LABEL_LETTERS, '@', '@']);
		// Two overflowing labels are two entries with one letter, never one entry: the row still says
		// which artifact it is, and the filed label is still on each badge.
		expect(letters.size).toBe(6);
	});

	// A group whose runs produced nothing labelled is ordinary: a group is a claim about *runs*, and
	// labelling artifacts inside one is a second, independent choice (`archive-listing.ts`).
	it('hands out nothing for a group whose runs carry no label', () => {
		expect(lettersOfGroup(group(run('checkout-app', 'home_a_variant', NEWER, [])))).toEqual(
			new Map(),
		);
	});

	/*
	 * **Nothing about a letter is stable across groups**, and this is what that means in practice:
	 * the same string in a second group takes whatever letter that group's own order gives it. The
	 * criterion forbids stability across groups; it requires it inside one.
	 */
	it('assigns per group, so one label may be two letters in two groups', () => {
		const first = lettersOfGroup(group(run('checkout-app', 'home_a_variant', NEWER, [BASELINE])));
		const second = lettersOfGroup(
			group(run('checkout-app', 'basket', NEWER, ['totals', 'coupon', BASELINE])),
		);

		expect(first.get(BASELINE)).toBe('A');
		expect(second.get(BASELINE)).toBe('C');
	});
});

describe('the badge for one artifact', () => {
	const ANSWER: readonly ArchiveGroup[] = [
		{
			project: 'checkout-app',
			groupId: 'app-bar-top-space',
			runs: [
				run('checkout-app', 'home_a_variant', OLDER, [BASELINE, AFTER]),
				run('checkout-app', 'home_b_variant', NEWER, [BASELINE]),
			],
		},
		{
			project: 'checkout-app',
			groupId: 'basket-total',
			runs: [run('checkout-app', 'basket', NEWER, ['totals', BASELINE])],
		},
	];

	/** The address of one run's `<n>_<label>.png`, as the answer names it. */
	function address(testName: string, name: string, index: number, label: string) {
		return keyOf([
			'checkout-app',
			testName,
			name,
			SERIAL,
			'screenshots',
			`00${index}_${label}.png`,
		]);
	}

	it('answers the letter and the filed label at the artifact’s own address', () => {
		const labelled = labelledArtifactsOf(ANSWER, 'checkout-app', 'app-bar-top-space');

		expect(labelled.get(address('home_a_variant', OLDER, 1, BASELINE))).toEqual({
			letter: 'A',
			label: BASELINE,
		});
		expect(labelled.get(address('home_a_variant', OLDER, 2, AFTER))).toEqual({
			letter: 'B',
			label: AFTER,
		});
		// The second run's copy of the first label, which is what the letter exists to connect.
		expect(labelled.get(address('home_b_variant', NEWER, 1, BASELINE))).toEqual({
			letter: 'A',
			label: BASELINE,
		});
	});

	// The group is keyed on the pair, because a `groupId` is an opaque caller string that nothing
	// makes unique and only means something inside one project (`archive-listing.ts`).
	it('answers only that group’s artifacts, and gives them that group’s own letters', () => {
		const other = labelledArtifactsOf(ANSWER, 'checkout-app', 'basket-total');

		expect(other.get(address('basket', NEWER, 2, BASELINE))).toEqual({
			letter: 'B',
			label: BASELINE,
		});
		expect(other.get(address('home_a_variant', OLDER, 1, BASELINE))).toBeUndefined();
	});

	// No badge on any row, which is the same nothing an unlabelled group draws: there is no label,
	// so there is nothing to say about one.
	it('answers nothing for a group the answer does not hold', () => {
		expect(labelledArtifactsOf(ANSWER, 'checkout-app', 'never-named').size).toBe(0);
		expect(labelledArtifactsOf([], 'checkout-app', 'app-bar-top-space').size).toBe(0);
	});
});
