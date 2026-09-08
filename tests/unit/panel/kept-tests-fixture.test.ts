import { describe, expect, it } from 'vitest';
import {
	ListKeptTestsResultSchema,
	SetKeptTestsParamsSchema,
	SetKeptTestsResultSchema,
} from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/kept-tests.json' with { type: 'json' };

/**
 * The daemon's half of the ninth drift gate, and `force-release-fixture.test.ts`'s reasoning
 * applies verbatim.
 *
 * `panel/src/archive/kept-tests.ts` re-declares both of the `Keep` flag's methods — the read's two
 * outcomes, the write's three, and the pair that names a test — rather than importing them, for
 * the structural reason every other mirror exists: the panel is a separate tree, and
 * `src/ipc/methods.ts` drags `core/device.ts`, `core/capabilities.ts` and the verb schemas into a
 * browser bundle behind it. A second copy of a wire shape is a thing that drifts.
 *
 * So one fixture is parsed twice, by two projects that cannot import each other: **here** by the
 * host's own `.strict()` schemas, which is what makes each entry an answer the daemon could really
 * give, and in `panel/src/archive/kept-tests.test.ts` by the panel's mirror. Drift matters on this
 * pair for force-release's sharper reason and one of its own — the mirror narrows a result it
 * cannot parse to *nothing came back* (`kept-tests.ts`), so an outcome renamed on the host would
 * leave both suites green while every tick in the browser silently stopped moving.
 *
 * **`press` is why this file parses a params schema too.** Three of these gates already do — the
 * two parameterless methods' assert that `{}` is the whole request — and this is the first for a
 * request that *changes* something of the host's own that is not a lease. The panel builds those
 * params by hand; a field renamed on either side is `invalid_params` on the host, which the mirror
 * folds to `unanswered`, which leaves the tick exactly where it was. That is a press that silently
 * does nothing with both suites green, so the request shape is held across the two trees the same
 * way the answers are.
 *
 * **Every entry is constructed rather than captured, and that is stated here and in
 * `ai/TESTING.md` beside the rule it bends** (§"A wire answer is a fixture too"). Reaching the
 * five outcomes below off a real host means arranging five different states of one file —
 * including a store past `MAX_KEPT_TESTS` and one that will not parse — and both of those are
 * files a text editor writes rather than states a daemon reaches on its own. What keeps them
 * honest is this half: the schemas below are the host's own `.strict()` ones, so a field this file
 * invents fails here rather than teaching the panel a shape the host never sends — and the two
 * answered sets are in the order a **running** daemon put them in, checked against one over
 * `ROVER_HTTP_PORT` while this was written rather than guessed at.
 */
describe("the panel's kept-tests fixture", () => {
	it.each(
		fixture.list.map((answer, index) => [index, answer] as const),
	)('list entry %i is an answer the daemon could give', (_index, answer) => {
		const parsed = ListKeptTestsResultSchema.safeParse(answer);

		expect(parsed.success).toBe(true);
	});

	it.each(
		fixture.set.map((answer, index) => [index, answer] as const),
	)('set entry %i is an answer the daemon could give', (_index, answer) => {
		const parsed = SetKeptTestsResultSchema.safeParse(answer);

		expect(parsed.success).toBe(true);
	});

	/*
	 * Both coverage assertions are driven off the host's own unions rather than off a list written
	 * here, so a fourth arm added to either method fails this file until the fixture covers it —
	 * and so until the panel's mirror is asked about it too.
	 */
	it('carries every outcome of the read', () => {
		const drawn = fixture.list.map((answer) => ListKeptTestsResultSchema.parse(answer).outcome);

		expect([...new Set(drawn)].sort()).toEqual(
			ListKeptTestsResultSchema.options.map((arm) => arm.shape.outcome.value).sort(),
		);
	});

	it('carries every outcome of the write', () => {
		const drawn = fixture.set.map((answer) => SetKeptTestsResultSchema.parse(answer).outcome);

		expect([...new Set(drawn)].sort()).toEqual(
			SetKeptTestsResultSchema.options.map((arm) => arm.shape.outcome.value).sort(),
		);
	});

	// The press the panel makes, through the host's `.strict()` params schema: a group's tick is
	// **one** request carrying every test it stands over, so the array is what a group's press
	// looks like rather than a single test repeated.
	it('is a press the daemon would accept, carrying more than one test', () => {
		const parsed = SetKeptTestsParamsSchema.parse(fixture.press);

		expect(parsed.tests.length).toBeGreaterThan(1);
		expect(parsed.kept).toBe(true);
		expect(parsed.actor).toBe('karolina');
	});

	/*
	 * **Every answered set is in the host's own order**, which is one fixed code-unit order applied
	 * unconditionally on both the read and the write (`src/daemon/kept-tests.ts`,
	 * `sortedForStorage`) — so a fixture in any other order is not an answer the daemon could give,
	 * however well it parses. `press.tests` is deliberately *not* sorted: that is the caller's own
	 * array, in the order the group's tests came off the grouping answer.
	 */
	it('answers each set in the order the host files it in', () => {
		for (const tests of [
			ListKeptTestsResultSchema.parse(fixture.list[0]),
			SetKeptTestsResultSchema.parse(fixture.set[0]),
		].map((answer) => ('tests' in answer ? answer.tests : []))) {
			const filed = tests.map((test) => `${test.project}/${test.testName}`);

			expect(filed).toEqual([...filed].sort());
		}
	});

	/*
	 * **`keptBy` and `keptAt` are on the host's file and on its audit line, and on neither
	 * answer.** The read stays a set of tests, so a fixture that grew a `keptBy` would be teaching
	 * the panel that the wire carries who ticked something — which is the widening D28 leaves
	 * additive rather than the shape either method has today.
	 */
	it('answers tests and never who kept them', () => {
		expect(JSON.stringify(fixture.list)).not.toContain('keptBy');
		expect(JSON.stringify(fixture.list)).not.toContain('keptAt');
		expect(JSON.stringify(fixture.set)).not.toContain('keptBy');
		expect(JSON.stringify(fixture.set)).not.toContain('keptAt');
	});
});
