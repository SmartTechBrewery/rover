import type { ArchiveGroup, ArchiveGroupArtifact } from '@panel/archive/archive-listing.js';
import { keyOf } from '@panel/archive/archive-path.js';
import { describe, expect, it } from 'vitest';
import { labelledArtifactsOf, numbersOfGroup } from './group-labels.js';

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

describe('the numbers one group hands out', () => {
	// `1`, `2`, `3`, … in the order the host answered them — runs as the walk met them, artifacts in
	// the name order it read them in.
	it('gives each distinct label a number, in the answer’s own order', () => {
		const numbers = numbersOfGroup(
			group(run('checkout-app', 'home_a_variant', NEWER, [BASELINE, AFTER])),
		);

		expect([...numbers]).toEqual([
			[BASELINE, 1],
			[AFTER, 2],
		]);
	});

	/*
	 * **The same label is the same number everywhere in the group** — which is the whole point of
	 * the badge: two runs filed `home-baseline` and the reader has to see one number on both.
	 */
	it('keeps one number for a label filed by two runs', () => {
		const numbers = numbersOfGroup(
			group(
				run('checkout-app', 'home_a_variant', OLDER, [BASELINE, AFTER]),
				run('checkout-app', 'home_b_variant', NEWER, [AFTER, BASELINE]),
			),
		);

		expect(numbers.size).toBe(2);
		expect(numbers.get(BASELINE)).toBe(1);
		expect(numbers.get(AFTER)).toBe(2);
	});

	/*
	 * **The nine-label group all three phases were reported with** — `statistics-deliveries`, a
	 * before/after of a Compose migration filing one label per screen. Under the four-letter
	 * alphabet five of these nine read `@` and the badge distinguished nothing for most of the
	 * group; every one of them now takes a number of its own, and would have under #197's alphabet
	 * too. What #206 changes is the group this test can no longer be written for.
	 */
	it('numbers all nine labels of the real group that overflowed the four', () => {
		const labels = [
			'remaining-deliveries',
			'all-deliveries',
			'to-delivery',
			'delivered-successfully',
			'delivered-unsuccessfully',
			'undelivered-dispositions',
			'transferred-to-pickup',
			'transferred-to-courier',
			'details-from-list',
		];

		const numbers = numbersOfGroup(group(run('c-ai', 'statistics_deliveries', NEWER, labels)));

		expect([...numbers.values()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	/*
	 * **There is no ceiling and no overflow value** (#206, `docs/DESIGN.md` §9). This is the case
	 * that used to collapse into `@` — first at the fifth distinct label, then at the twenty-seventh
	 * — and there is now nothing for it to collapse into: a hundred distinct labels are a hundred
	 * distinct numbers, none of them repeated and none of them standing for *not distinguished*.
	 * The palette's own ceiling is a separate thing and is `label-badge.tsx`'s (`29` repeats `1`'s
	 * fill and differs by its digits).
	 */
	it('numbers a hundred labels without repeating one or reaching an overflow', () => {
		const labels = Array.from({ length: 100 }, (_, index) => `label-${index}`);

		const numbers = numbersOfGroup(group(run('checkout-app', 'home_a_variant', NEWER, labels)));

		expect([...numbers.values()]).toEqual(labels.map((_, index) => index + 1));
		expect(new Set(numbers.values()).size).toBe(100);
		expect(numbers.get('label-99')).toBe(100);
	});

	// A group whose runs produced nothing labelled is ordinary: a group is a claim about *runs*, and
	// labelling artifacts inside one is a second, independent choice (`archive-listing.ts`).
	it('hands out nothing for a group whose runs carry no label', () => {
		expect(numbersOfGroup(group(run('checkout-app', 'home_a_variant', NEWER, [])))).toEqual(
			new Map(),
		);
	});

	/*
	 * **Nothing about a number is stable across groups**, and this is what that means in practice:
	 * the same string in a second group takes whatever number that group's own order gives it. The
	 * criterion forbids stability across groups; it requires it inside one.
	 */
	it('assigns per group, so one label may be two numbers in two groups', () => {
		const first = numbersOfGroup(group(run('checkout-app', 'home_a_variant', NEWER, [BASELINE])));
		const second = numbersOfGroup(
			group(run('checkout-app', 'basket', NEWER, ['totals', 'coupon', BASELINE])),
		);

		expect(first.get(BASELINE)).toBe(1);
		expect(second.get(BASELINE)).toBe(3);
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

	it('answers the number and the filed label at the artifact’s own address', () => {
		const labelled = labelledArtifactsOf(ANSWER, 'checkout-app', 'app-bar-top-space');

		expect(labelled.get(address('home_a_variant', OLDER, 1, BASELINE))).toEqual({
			number: 1,
			label: BASELINE,
		});
		expect(labelled.get(address('home_a_variant', OLDER, 2, AFTER))).toEqual({
			number: 2,
			label: AFTER,
		});
		// The second run's copy of the first label, which is what the number exists to connect.
		expect(labelled.get(address('home_b_variant', NEWER, 1, BASELINE))).toEqual({
			number: 1,
			label: BASELINE,
		});
	});

	// The group is keyed on the pair, because a `groupId` is an opaque caller string that nothing
	// makes unique and only means something inside one project (`archive-listing.ts`).
	it('answers only that group’s artifacts, and gives them that group’s own numbers', () => {
		const other = labelledArtifactsOf(ANSWER, 'checkout-app', 'basket-total');

		expect(other.get(address('basket', NEWER, 2, BASELINE))).toEqual({
			number: 2,
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
