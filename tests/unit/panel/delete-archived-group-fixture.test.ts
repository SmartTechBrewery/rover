import { describe, expect, it } from 'vitest';
import {
	DeleteArchivedGroupParamsSchema,
	DeleteArchivedGroupResultSchema,
	DeletedPartSchema,
} from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/delete-archived-group.json' with { type: 'json' };

/**
 * The daemon's half of `delete_archived_group`'s drift gate (#277), and
 * `delete-archived-test-fixture.test.ts`'s reasoning applies verbatim one scope over.
 *
 * `panel/src/archive/delete-archived-group.ts` re-declares this method's params, its `DeletedPart`
 * enum and its four-arm result union rather than importing them, for the same structural reason
 * every other mirror exists: the panel is a separate tree, and `src/ipc/methods.ts` drags
 * `core/device.ts`, `core/capabilities.ts` and the verb schemas into a browser bundle behind it.
 *
 * So one fixture is parsed twice, by two projects that cannot import each other: **here** by the
 * host's own `.strict()` schemas, which is what makes each entry an answer the daemon could really
 * give, and in `panel/src/archive/delete-archived-group.test.ts` by the panel's mirror. Drift
 * matters on this method for the test row's reason with one addition of its own: the mirror narrows
 * an outcome it does not recognise to `unanswered`, so an outcome renamed on the host would leave
 * both suites green while every real delete in the browser silently became *"nothing came back from
 * the host"* — and `runsRemoved` dropped from an arm would leave the group's line unable to say the
 * one figure only this scope can state.
 *
 * **Every entry is constructed rather than captured, and that is stated here** beside the rule it
 * bends (`ai/TESTING.md` §"A wire answer is a fixture too"). It bends it exactly as far as
 * `delete-archived-test.json` does and for the same kind of reason: the six entries need six
 * different host states, and three of them cannot be arranged without breaking a host on purpose —
 * a run directory the daemon's user may not remove, a walk stopped by its own directory bound, and a
 * live lease filing into one of the very runs being deleted. What keeps them honest is this half:
 * the schemas below are `.strict()`, so a field this file invents fails here rather than teaching
 * the panel a shape the host never sends, and every value is one
 * `src/daemon/delete-archived-group.ts` composes.
 *
 * **The params half is where this row differs from the test's most sharply.** A group id is
 * `GroupIdSchema` and is **never joined into a path** (R41), so `nightly-export.7f3a91` — a minted
 * id, dot and all — is a legitimate value here where the equivalent in a `testName` would not be.
 */

const ANSWERS = fixture.answers;

describe("the panel's delete_archived_group fixture", () => {
	it.each(
		ANSWERS.map((answer, index) => [index, answer.case, answer] as const),
	)('entry %i (%s) is an answer the daemon could give', (_index, _case, answer) => {
		const parsed = DeleteArchivedGroupResultSchema.safeParse(answer.result);

		expect(parsed.success).toBe(true);
	});

	/*
	 * The request half, and the reason it is on the file at all: this row is keyed on **one path
	 * component and one opaque id**, so a fixture whose params the host would accept is what pins
	 * that no path ever goes in and that the id is not held to a directory's shape.
	 */
	it('names each group by a project component and an opaque id, and never by a path', () => {
		for (const answer of ANSWERS) {
			expect(DeleteArchivedGroupParamsSchema.safeParse(answer.params).success).toBe(true);
		}

		// `.strict()` is what makes this bite: a `path` key is not a shape the host ever sends.
		expect(
			DeleteArchivedGroupParamsSchema.safeParse({
				project: 'checkout-web',
				groupId: 'app-bar-top-space',
				actor: 'karolina',
				path: ['checkout-web'],
			}).success,
		).toBe(false);
		// The project is a directory name and is held to it…
		expect(
			DeleteArchivedGroupParamsSchema.safeParse({
				project: 'checkout-web/login-flow',
				groupId: 'app-bar-top-space',
				actor: 'karolina',
			}).success,
		).toBe(false);
		// …and the group id is not, because the archive has no directory for one (R41).
		expect(
			DeleteArchivedGroupParamsSchema.safeParse({
				project: 'checkout-web',
				groupId: '../../etc/passwd',
				actor: 'karolina',
			}).success,
		).toBe(true);
	});

	/*
	 * Driven off the host's own union rather than a list written here, so a **fifth** outcome added
	 * to `DeleteArchivedGroupResultSchema` fails this assertion until the fixture covers it — and so
	 * the panel's mirror is never left unpinned on an answer it would narrow to `unanswered`.
	 */
	it('carries every outcome the panel has to tell apart', () => {
		const parsed = ANSWERS.map((answer) => DeleteArchivedGroupResultSchema.parse(answer.result));

		expect([...new Set(parsed.map((answer) => answer.outcome))].sort()).toEqual(
			DeleteArchivedGroupResultSchema.options.map((option) => option.shape.outcome.value).sort(),
		);
	});

	/*
	 * And every fate a half can meet, off the host's own enum for the same reason. On this row
	 * `failed` carries two readings the panel's line does not distinguish and the operator's next
	 * move does not either — a run that would not go, and a walk that was cut short — so both are on
	 * the file, per `ai/TESTING.md`'s rule that the fixture holds every combination the code
	 * branches on.
	 */
	it('carries every fate a half of the delete can meet', () => {
		const fates = ANSWERS.flatMap((answer) => {
			const parsed = DeleteArchivedGroupResultSchema.parse(answer.result);
			return parsed.outcome === 'deleted' || parsed.outcome === 'partial'
				? [parsed.archive, parsed.keptTests]
				: [];
		});

		expect([...new Set(fates)].sort()).toEqual([...DeletedPartSchema.options].sort());
	});

	/*
	 * **Both sides of the branch the group's line draws on `runsRemoved`.** *Only part of it could be
	 * taken, N runs went* and *not one run could be taken* are two different sentences
	 * (`remove-notice.tsx`), because the host's `partial` arm has no floor on how many runs went — a
	 * truncated walk that reached nothing is the ordinary way it is `0`.
	 */
	it('carries a partial that took runs and one that took none', () => {
		const partials = ANSWERS.map((answer) =>
			DeleteArchivedGroupResultSchema.parse(answer.result),
		).filter(
			(answer): answer is Extract<typeof answer, { outcome: 'partial' }> =>
				answer.outcome === 'partial',
		);

		expect(partials.map((answer) => answer.runsRemoved > 0)).toContain(true);
		expect(partials.map((answer) => answer.runsRemoved > 0)).toContain(false);
		// And the one that took none freed nothing and pruned nothing, which is what makes the
		// panel's silence about both figures the truth rather than a choice.
		for (const answer of partials.filter((partial) => partial.runsRemoved === 0)) {
			expect(answer.freedBytes).toBe(0);
			expect(answer.keptTestsRemoved).toBe(0);
		}
	});

	/*
	 * **A `deleted` never removed nothing**, which is the one property of this answer the panel must
	 * not flatten (D42's rule two scopes down): *no run named that group* is `not-found`, a separate
	 * arm carrying no report at all, so a screen cannot read a `0` off it.
	 */
	it('keeps the answer that reached nothing free of a deletion report, and every deleted above zero', () => {
		const parsed = ANSWERS.map((answer) => DeleteArchivedGroupResultSchema.parse(answer.result));

		expect(parsed.filter((answer) => answer.outcome === 'not-found')).toEqual([
			{ outcome: 'not-found' },
		]);
		for (const answer of parsed.filter((candidate) => candidate.outcome === 'deleted')) {
			expect(answer.runsRemoved).toBeGreaterThan(0);
		}
	});

	/*
	 * **No host path, no root and no `errno` anywhere in the file** (D19). The host's `.strict()`
	 * schemas already refuse a field one would fit in, so this is the belt to that braces: it also
	 * catches one smuggled into a *value* — a diagnosis pasted into a case label — which no schema
	 * would notice.
	 *
	 * The `/` check the test row's gate makes is deliberately **not** here: a group id may legally
	 * carry a separator, so a fixture that could never hold one would be pinning the wrong claim.
	 * What is asserted instead is that no *project* does, which is the component that is a path.
	 */
	it('discloses no path, no root and no errno', () => {
		const raw = JSON.stringify(fixture);

		expect(raw).not.toContain('\\\\');
		expect(raw).not.toContain('errno');
		expect(raw).not.toContain('ENOENT');
		expect(raw).not.toContain('EACCES');
		expect(raw).not.toContain('.rover');
		// The host's one sentence per outcome is for a terminal; the panel says each in its own
		// words, so nothing on this wire carries the daemon's wording either.
		expect(raw).not.toContain('message');
		for (const answer of ANSWERS) {
			expect(answer.params.project).not.toContain('/');
		}
	});
});
