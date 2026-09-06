import type { ArchiveGroup } from '@panel/archive/archive-listing.js';
import { describe, expect, it } from 'vitest';
import {
	groupedProjects,
	groupRowsAt,
	groupRunSerial,
	groupsOfProject,
	runsOfTestName,
	testNamesOfGroup,
} from './group-tree.js';

const SERIAL = 'R5CT30ABCDE';
/** Two runs of one group under one test name, oldest first — the host's own order. */
const OLDER = '20260829T142201Z-issue-112-4b0e7c15';
const NEWER = '20260830T170501Z-issue-112-9f1c2ab4';

function run(project: string, testName: string, name: string, serial = SERIAL) {
	return { path: [project, testName, name, serial], artifacts: [] };
}

/**
 * The answer the cases below arrange: one project with two groups — one spanning two test names,
 * the `_variant` shape R41's worked example asks for — and a second project with one.
 */
function answer(): readonly ArchiveGroup[] {
	return [
		{
			project: 'checkout-app',
			groupId: 'app-bar-top-space',
			runs: [
				run('checkout-app', 'home_a_variant', OLDER),
				run('checkout-app', 'home_a_variant', NEWER),
				run('checkout-app', 'home_b_variant', NEWER),
			],
		},
		{
			project: 'checkout-app',
			groupId: 'basket-total',
			runs: [run('checkout-app', 'basket', NEWER)],
		},
		{
			project: 'payments-web',
			groupId: 'app-bar-top-space',
			runs: [run('payments-web', 'checkout', NEWER, 'emulator-5554')],
		},
	];
}

describe('the projects a groups view has', () => {
	// The root is projects, exactly as the `All` view's rows are — and a project appears once
	// however many groups it has.
	it('names each project once, in the answer’s own order', () => {
		expect(groupedProjects(answer()).map((row) => row.name)).toEqual([
			'checkout-app',
			'payments-web',
		]);
	});

	it('counts the runs a project stands over, across all of its groups', () => {
		expect(groupedProjects(answer()).map((row) => row.runs)).toEqual([4, 1]);
	});

	// A project with no grouped runs is not drawn: this view is *what groups exist*, and the `All`
	// view still shows every run, so nothing becomes unreachable by being absent here.
	it('draws nothing at all for an answer holding no groups', () => {
		expect(groupedProjects([])).toEqual([]);
	});
});

describe('the groups under a project', () => {
	it('names the group ids that project’s leases used, and no other project’s', () => {
		expect(groupsOfProject(answer(), 'checkout-app').map((row) => row.name)).toEqual([
			'app-bar-top-space',
			'basket-total',
		]);
	});

	/*
	 * **A group id only means something inside one project.** The same string is used by two
	 * projects here, and the host keys a group on the pair for that reason — so the two must not
	 * merge into one row with four runs under it.
	 */
	it('keeps one group id used by two projects apart', () => {
		expect(groupsOfProject(answer(), 'payments-web')).toEqual([
			{ name: 'app-bar-top-space', runs: 1, serial: null },
		]);
	});

	it('has nothing to draw for a project the answer does not hold', () => {
		expect(groupsOfProject(answer(), 'nothing-here')).toEqual([]);
	});
});

describe('the test names in a group', () => {
	// A group spanning two test names is the ordinary case — the `_variant` arms of one comparison.
	it('names each test name once, counting the runs filed under it in this group', () => {
		expect(testNamesOfGroup(answer(), 'checkout-app', 'app-bar-top-space')).toEqual([
			{ name: 'home_a_variant', runs: 2, serial: null },
			{ name: 'home_b_variant', runs: 1, serial: null },
		]);
	});

	it('has nothing to draw for a group id that project never used', () => {
		expect(testNamesOfGroup(answer(), 'checkout-app', 'never-named')).toEqual([]);
	});
});

describe('the runs under a test name in a group', () => {
	/*
	 * **The answer's own order, and no opinion about the direction.** *Most recent first* is
	 * `level-order.ts`'s, applied by each pane that draws these runs — the tree and the card beside
	 * it — exactly as the `All` view's two panes already reverse through it. A second opinion held
	 * here is what would let the two panes disagree about which run is first.
	 */
	it('keeps the host’s own chronological order, oldest first', () => {
		expect(
			runsOfTestName(answer(), 'checkout-app', 'app-bar-top-space', 'home_a_variant').map(
				(row) => row.name,
			),
		).toEqual([OLDER, NEWER]);
	});

	// The `<serial>` is on the answer, so this view needs no `onlyChild` off a second listing to
	// know where a run's contents are.
	it('carries each run’s own serial', () => {
		expect(runsOfTestName(answer(), 'payments-web', 'app-bar-top-space', 'checkout')).toEqual([
			{ name: NEWER, runs: 1, serial: 'emulator-5554' },
		]);
	});

	// Only the runs of *this* group under that test name — a run of the same test name in another
	// group is a different row of a different level.
	it('draws only the runs of the group asked about', () => {
		expect(runsOfTestName(answer(), 'checkout-app', 'basket-total', 'home_a_variant')).toEqual([]);
	});
});

describe('where one run’s contents are', () => {
	it('is the serial the answer carries for it', () => {
		expect(
			groupRunSerial(answer(), 'checkout-app', 'app-bar-top-space', 'home_a_variant', NEWER),
		).toBe(SERIAL);
	});

	it('is nothing at all for a run the answer does not hold', () => {
		expect(
			groupRunSerial(answer(), 'checkout-app', 'app-bar-top-space', 'home_a_variant', 'no-run'),
		).toBeNull();
	});
});

/**
 * A run whose address is not the archive's four levels cannot be placed without inventing which of
 * its components is the test name (D22), so it is skipped — and skipped at **every** level, which
 * is why the counts above are counts of placed runs rather than of the array's length.
 */
describe('a run the arrangement cannot place', () => {
	const malformed: readonly ArchiveGroup[] = [
		{
			project: 'checkout-app',
			groupId: 'app-bar-top-space',
			runs: [{ path: ['checkout-app', 'home'], artifacts: [] }],
		},
	];

	it('leaves the project, the group and the test name with nothing to draw', () => {
		expect(groupedProjects(malformed)).toEqual([]);
		expect(groupsOfProject(malformed, 'checkout-app')).toEqual([]);
		expect(testNamesOfGroup(malformed, 'checkout-app', 'app-bar-top-space')).toEqual([]);
	});
});

/**
 * The dispatcher, which is what the tree reads: one function from a node of this view to its rows,
 * and `null` at the depths this view does not own — a run, and everything inside it, which are the
 * `All` view's levels reached through the archive address.
 */
describe('the rows at one node', () => {
	it('answers each of the four levels this view owns', () => {
		const groups = answer();

		expect(groupRowsAt(groups, [])).toEqual(groupedProjects(groups));
		expect(groupRowsAt(groups, ['checkout-app'])).toEqual(groupsOfProject(groups, 'checkout-app'));
		expect(groupRowsAt(groups, ['checkout-app', 'basket-total'])).toEqual(
			testNamesOfGroup(groups, 'checkout-app', 'basket-total'),
		);
		expect(groupRowsAt(groups, ['checkout-app', 'basket-total', 'basket'])).toEqual(
			runsOfTestName(groups, 'checkout-app', 'basket-total', 'basket'),
		);
	});

	it('owns nothing at and below a run', () => {
		expect(groupRowsAt(answer(), ['checkout-app', 'basket-total', 'basket', NEWER])).toBeNull();
		expect(
			groupRowsAt(answer(), ['checkout-app', 'basket-total', 'basket', NEWER, SERIAL]),
		).toBeNull();
	});
});
