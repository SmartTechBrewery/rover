import { describe, expect, it } from 'vitest';
import {
	ListArchiveGroupsParamsSchema,
	ListArchiveGroupsResultSchema,
	ListArchiveParamsSchema,
} from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/list-archive-groups.json' with { type: 'json' };

/**
 * The daemon's half of the drift gate for `list_archive_groups` (R41, #178).
 *
 * The panel is a separate tree with its own `tsconfig.json` and its own alias, and
 * `src/ipc/methods.ts` drags `core/device.ts`, `core/capabilities.ts` and the verb schemas into a
 * browser bundle behind it — the structural reason `list-devices-fixture.test.ts` sets out. So one
 * fixture is parsed twice, by two projects that cannot import each other: **here** by the host's
 * own schemas, and by the panel's mirror when phase 2 draws it. Nothing in the panel reads it yet,
 * and that is deliberate — this half of the gate is the half the host owes.
 *
 * **It is a *case list***, `list-projects.json`'s shape and for its reason: this method takes **no
 * parameter at all**, so an answer cannot be named by its request the way `list-archive.json`'s
 * levels are named by their `path`. Each is named by the host state that produced it instead —
 * `{ "answers": [ { "case": …, "result": … } ] }`.
 *
 * **All five were captured and none was hand-edited.** This method needs **no device** — it reads
 * the host's own disk — so the whole file is a daemon's own bytes off the panel's HTTP surface
 * (`ROVER_HTTP_PORT`, `POST /rpc` with a real bearer token) against a seeded
 * `ROVER_ARTIFACTS_PATH` written by the real `createArtifactArchive`. Every awkward case came from
 * the filesystem rather than from a text editor, which is the trick `list-archive.json` and
 * `search-archive.json` are the precedent for: a `group_id.json` overwritten with text that is not
 * JSON drops its run and answers `truncated: true` **with the rest of the groups intact**, deleting
 * the two grouped projects leaves the ungrouped run alone and answers `groups: []`, the root moved
 * aside answers `missing`, and one with mode `000` answers `unreadable`.
 *
 * **The seeding put the group with no labels *first* on purpose.** `checkout-web` sorts before
 * `rover` in the host's code-unit order, so *a group whose runs labelled nothing is not grouped
 * last* is a property of the captured file rather than something a screen test has to construct —
 * the general rule `search-archive.json` states: the fixture has to carry every combination the
 * code branches on, not merely every field.
 */

const answers = fixture.answers;

describe("the panel's list_archive_groups fixture", () => {
	it('is a set of answers the daemon could give', () => {
		for (const answer of answers) {
			expect(ListArchiveGroupsResultSchema.safeParse(answer.result).success).toBe(true);
		}
	});

	/*
	 * The *no parameter at all* claim, made executable. There is no group, project, filter, sort or
	 * page to pass, which is why the view phase 2 draws could not grow one from this side.
	 */
	it('answers a request that carries nothing, and refuses one that carries anything', () => {
		expect(ListArchiveGroupsParamsSchema.safeParse({}).success).toBe(true);
		expect(ListArchiveGroupsParamsSchema.safeParse({ groupId: 'app-bar' }).success).toBe(false);
	});

	it('carries all three outcomes, because all three must render differently', () => {
		const outcomes = new Set(answers.map((answer) => answer.result.outcome));

		expect(outcomes).toEqual(new Set(['listed', 'missing', 'unreadable']));
	});

	/*
	 * D6's pair on this method: *no run on this host named a group* against *the host cannot read
	 * the archive*. A file that only ever carried groups would leave the distinction unpinned on
	 * the wire, which is what makes an empty answer draw like a failure.
	 */
	it('carries an empty listing beside the two answers that are not listings', () => {
		expect(listed('nothing on this host named a group')).toEqual({
			outcome: 'listed',
			groups: [],
			truncated: false,
		});
	});

	// `truncated` in both states, and — the part the flag exists for — in both states *with groups
	// in the answer*, so a partial answer and a complete one are two captured bytes apart.
	it('carries a truncated answer beside a complete one, both with groups in them', () => {
		const complete = listed('two groups, one with labels and one without');
		const short = listed('a run whose group_id.json will not parse');

		expect(complete.truncated).toBe(false);
		expect(short.truncated).toBe(true);
		expect(complete.groups.length).toBeGreaterThan(0);
		expect(short.groups.length).toBeGreaterThan(0);
		// The run whose claim the host could not read is the one that is gone, and the group it
		// belonged to is still answered — short by a run, which is exactly what `truncated` says.
		expect(runsOf(complete).length).toBe(runsOf(short).length + 1);
	});

	/*
	 * One group with labels and one without, and the one without is **not last**. A group is a
	 * claim about runs; labelling artifacts inside one is a second, independent choice.
	 */
	it('carries a group whose runs labelled nothing, in among the ones that did', () => {
		const groups = listed('two groups, one with labels and one without').groups;

		expect(groups.map((group) => group.groupId)).toEqual(['basket-total', 'app-bar-top-space']);
		expect(groups[0]?.runs.every((run) => run.artifacts.length === 0)).toBe(true);
		expect(groups.at(-1)?.runs.every((run) => run.artifacts.length > 0)).toBe(true);
	});

	/*
	 * A group keyed on a `(project, groupId)` pair rather than on the group id alone, visible in
	 * the file: the two groups sit under two different projects, so a reader that dropped
	 * `project` would still look right and would be wrong the moment two projects reuse a string.
	 */
	it('names the project of every group, and every run is filed under it', () => {
		for (const group of listed('two groups, one with labels and one without').groups) {
			expect(group.project.length).toBeGreaterThan(0);
			for (const run of group.runs) {
				expect(run.path[0]).toBe(group.project);
			}
		}
	});

	/*
	 * One path vocabulary for the archive (R37), made executable rather than claimed: every run and
	 * every artifact this method answers is an address `list_archive` accepts, so the view phase 2
	 * draws composes no path of its own (D19).
	 */
	it('answers only paths list_archive would accept, for a run and for an artifact alike', () => {
		for (const run of everyRun()) {
			expect(ListArchiveParamsSchema.safeParse({ path: run.path }).success).toBe(true);
			// A run is the archive's four levels; an artifact is one or two deeper.
			expect(run.path).toHaveLength(4);
			for (const artifact of run.artifacts) {
				expect(ListArchiveParamsSchema.safeParse({ path: artifact.path }).success).toBe(true);
				expect(artifact.path.slice(0, 4)).toEqual(run.path);
			}
		}
	});

	/*
	 * All three artifact kinds the archive files, and the recording's frame directory beside the
	 * recording — the pair that is the whole reason the frames are named after it (#150). A fixture
	 * carrying only screenshots would leave the frame directory's own label unpinned.
	 */
	it('carries a labelled screenshot, recording, frame directory and log', () => {
		const labelled = runsOf(listed('two groups, one with labels and one without')).flatMap(
			(run) => run.artifacts,
		);

		expect(labelled.some((one) => one.path.at(-1)?.endsWith('_screenshot.png'))).toBe(true);
		expect(labelled.some((one) => one.path.at(-1)?.endsWith('.mp4'))).toBe(true);
		expect(labelled.some((one) => one.path.at(-1)?.endsWith('_frames'))).toBe(true);
		expect(labelled.some((one) => one.path.at(-1)?.endsWith('_read_logs.txt'))).toBe(true);
		// The recording and its frames carry one label, which is what says they are one thing.
		const recordings = labelled.filter((one) => one.path.at(-2) === 'recordings');
		expect(new Set(recordings.map((one) => one.label)).size).toBe(1);
	});

	/*
	 * An unlabelled artifact is **absent**, never present with an empty or null label — and the
	 * seeding wrote one into every labelled run, so this is a property of the captured file rather
	 * than of a run that happened to have none.
	 */
	it('carries no artifact without a label, though the seeded runs each hold one', () => {
		for (const run of runsOf(listed('two groups, one with labels and one without'))) {
			for (const artifact of run.artifacts) {
				expect(artifact.label.length).toBeGreaterThan(0);
			}
			// `002_screenshot.png` is on disk in each of those runs and is in no answer.
			expect(run.artifacts.map((one) => one.path.at(-1))).not.toContain('002_screenshot.png');
		}
	});

	/*
	 * The load-bearing negative (D19): no host path anywhere, and no field one would fit in. The
	 * `.strict()` parse above is what makes that structural — a captured answer carrying a
	 * `message` would fail it — and this is the criterion said out loud.
	 */
	it('carries no host path and no absolute path anywhere in it', () => {
		const encoded = JSON.stringify(fixture);

		expect(encoded).not.toContain('/Users/');
		expect(encoded).not.toContain('/var/folders/');
		expect(encoded).not.toContain('.rover/artifacts');
		for (const answer of answers) {
			expect(Object.keys(answer.result)).not.toContain('message');
		}
	});
});

/** One captured answer by its case name, parsed by the host's own schema and known to be listed. */
function listed(named: string) {
	const answer = answers.find((one) => one.case === named);
	const result = ListArchiveGroupsResultSchema.parse(answer?.result);
	if (result.outcome !== 'listed') {
		throw new Error(`The '${named}' answer is not a listing: ${result.outcome}`);
	}
	return result;
}

/** Every run of every group in one listed answer. */
function runsOf(result: ReturnType<typeof listed>) {
	return result.groups.flatMap((group) => group.runs);
}

/** Every run in every listed answer the fixture carries, parsed by the host's own schema. */
function everyRun() {
	return answers
		.map((answer) => ListArchiveGroupsResultSchema.parse(answer.result))
		.flatMap((result) => (result.outcome === 'listed' ? result.groups : []))
		.flatMap((group) => group.runs);
}
