import { describe, expect, it } from 'vitest';
import {
	DeleteArchivedTestParamsSchema,
	DeleteArchivedTestResultSchema,
	DeletedPartSchema,
} from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/delete-archived-test.json' with { type: 'json' };

/**
 * The daemon's half of `delete_archived_test`'s drift gate (#276), and
 * `delete-project-fixture.test.ts`'s reasoning applies verbatim one level down.
 *
 * `panel/src/archive/delete-archived-test.ts` re-declares this method's params, its `DeletedPart`
 * enum and its four-arm result union rather than importing them, for the same structural reason
 * every other mirror exists: the panel is a separate tree, and `src/ipc/methods.ts` drags
 * `core/device.ts`, `core/capabilities.ts` and the verb schemas into a browser bundle behind it. A
 * second copy of a wire shape is a thing that drifts.
 *
 * So one fixture is parsed twice, by two projects that cannot import each other: **here** by the
 * host's own `.strict()` schemas, which is what makes each entry an answer the daemon could really
 * give, and in `panel/src/archive/delete-archived-test.test.ts` by the panel's mirror. Drift
 * matters on this method for `delete_project`'s sharper reason: the mirror narrows an outcome it
 * does not recognise to `unanswered` because *the panel never reports a deletion it did not get*,
 * so an outcome renamed on the host would leave both suites green while every real delete in the
 * browser silently became *"nothing came back from the host"* — a wrong sentence rather than a
 * failure.
 *
 * **It is the same *case list* the project's fixture is**: the request names one test by the two
 * components a listing answered with, and what makes an answer interesting is the **host state**
 * that produced it — two halves that each went, were never there, or would not go — so each entry
 * is named by that rather than by its request. The `params` are on the file and parsed too, which
 * is what makes *the components and never a path* (D19) executable rather than claimed.
 *
 * **Every entry is constructed rather than captured, and that is stated here** beside the rule it
 * bends (`ai/TESTING.md` §"A wire answer is a fixture too"). It bends it exactly as far as
 * `delete-project.json` does and for the same kind of reason: the six entries need six different
 * host states, and four of them cannot be arranged without breaking a host on purpose — an archive
 * subtree the daemon's user may not remove, a kept-tests store that will not read, both refusing
 * the write at once (the `partial` in which nothing went, which the panel says in words of its
 * own), and a live lease filing into the very test being deleted. What keeps them honest is this
 * half: the schemas below are `.strict()`, so a field this file invents fails here rather than
 * teaching the panel a shape the host never sends, and every value is one
 * `src/daemon/delete-archived-test.ts` composes — `removed`/`absent`/`failed` per half,
 * `freedBytes: 0` wherever the directory did not go, and `keptTestsRemoved` counted only on a
 * `removed` store.
 */

const ANSWERS = fixture.answers;

describe("the panel's delete_archived_test fixture", () => {
	it.each(
		ANSWERS.map((answer, index) => [index, answer.case, answer] as const),
	)('entry %i (%s) is an answer the daemon could give', (_index, _case, answer) => {
		const parsed = DeleteArchivedTestResultSchema.safeParse(answer.result);

		expect(parsed.success).toBe(true);
	});

	/*
	 * The request half, and the reason it is on the file at all: `delete_archived_test` is keyed on
	 * **the two components a listing answered with**, so a fixture whose params the host would
	 * accept is what pins that no path ever goes in. `.strict()` is what makes the second assertion
	 * bite, and the third is the shape this row holds tighter than `delete_project` does — both
	 * components are `ArchivePathSegmentSchema`, so a separator inside one is refused rather than
	 * read as two levels.
	 */
	it('names each test by its two components, and never by a path', () => {
		for (const answer of ANSWERS) {
			expect(DeleteArchivedTestParamsSchema.safeParse(answer.params).success).toBe(true);
		}

		expect(
			DeleteArchivedTestParamsSchema.safeParse({
				project: 'checkout-web',
				testName: 'the checkout flow',
				actor: 'karolina',
				path: ['checkout-web', 'the checkout flow'],
			}).success,
		).toBe(false);
		expect(
			DeleteArchivedTestParamsSchema.safeParse({
				project: 'checkout-web',
				testName: 'checkout-web/the checkout flow',
				actor: 'karolina',
			}).success,
		).toBe(false);
	});

	/*
	 * Driven off the host's own union rather than a list written here, so a **fifth** outcome added
	 * to `DeleteArchivedTestResultSchema` fails this assertion until the fixture covers it — and so
	 * the panel's mirror is never left unpinned on an answer it would narrow to `unanswered`.
	 */
	it('carries every outcome the panel has to tell apart', () => {
		const parsed = ANSWERS.map((answer) => DeleteArchivedTestResultSchema.parse(answer.result));

		expect([...new Set(parsed.map((answer) => answer.outcome))].sort()).toEqual(
			DeleteArchivedTestResultSchema.options.map((option) => option.shape.outcome.value).sort(),
		);
	});

	/*
	 * And every fate a half can meet, off the host's own enum for the same reason. The three are
	 * three different next moves for an operator (`src/ipc/methods.ts`), and the `partial` line the
	 * panel draws names which half stayed — so a fate this file never carried would be a sentence
	 * nothing had ever produced.
	 */
	it('carries every fate a half of the delete can meet', () => {
		const fates = ANSWERS.flatMap((answer) => {
			const parsed = DeleteArchivedTestResultSchema.parse(answer.result);
			return parsed.outcome === 'deleted' || parsed.outcome === 'partial'
				? [parsed.archive, parsed.keptTests]
				: [];
		});

		expect([...new Set(fates)].sort()).toEqual([...DeletedPartSchema.options].sort());
	});

	/*
	 * **Both sides of the branch the `partial` line draws.** The panel says a `partial` in which
	 * some half went differently from one in which neither did — *the rest went, with N back*
	 * against *nothing of it could be removed* — because the host's `partial` arm has no floor on
	 * how many halves went (`src/daemon/delete-archived-test.ts`). Asserted on the file so the
	 * combination the wording branches on is a host answer this fixture carries, per
	 * `ai/TESTING.md`'s rule that the fixture holds every combination the code branches on.
	 */
	it('carries a partial that removed something and one that removed nothing', () => {
		const partials = ANSWERS.map((answer) =>
			DeleteArchivedTestResultSchema.parse(answer.result),
		).filter(
			(answer): answer is Extract<typeof answer, { outcome: 'partial' }> =>
				answer.outcome === 'partial',
		);
		const went = partials.map(
			(answer) => answer.archive === 'removed' || answer.keptTests === 'removed',
		);

		expect(went).toContain(true);
		expect(went).toContain(false);
		// And the one where nothing went freed nothing and took no exemption with it, which is what
		// makes the panel's silence about both figures the truth rather than a choice.
		for (const answer of partials.filter(
			(partial) => partial.archive !== 'removed' && partial.keptTests !== 'removed',
		)) {
			expect(answer.freedBytes).toBe(0);
			expect(answer.keptTestsRemoved).toBe(0);
		}
	});

	/*
	 * **`not-found` is a different arm and not a delete of zero bytes**, which is the one property
	 * of this method's answer the panel must not flatten (D42 one level down, D43). Asserted on the
	 * file because it is a claim about the *shape* of the two: the arm that reached nothing carries
	 * no report at all, so a screen cannot accidentally read a `0` off it.
	 */
	it('keeps the answer that reached nothing free of a deletion report', () => {
		const nothing = ANSWERS.map((answer) =>
			DeleteArchivedTestResultSchema.parse(answer.result),
		).filter((answer) => answer.outcome === 'not-found');

		expect(nothing).toEqual([{ outcome: 'not-found' }]);
	});

	/*
	 * **No host path, no root and no `errno` anywhere in the file** (D19). The host's `.strict()`
	 * schemas already refuse a field one would fit in, so this is the belt to that braces: it also
	 * catches one smuggled into a *value* — a component written as a path, a diagnosis pasted into
	 * a case label — which no schema would notice.
	 */
	it('discloses no path, no root and no errno', () => {
		const raw = JSON.stringify(fixture);

		expect(raw).not.toContain('/');
		expect(raw).not.toContain('\\');
		expect(raw).not.toContain('errno');
		expect(raw).not.toContain('ENOENT');
		expect(raw).not.toContain('EACCES');
		expect(raw).not.toContain('.json');
		expect(raw).not.toContain('.rover');
		// The host's one sentence per outcome is for a terminal; the panel says each in its own
		// words, so nothing on this wire carries the daemon's wording either.
		expect(raw).not.toContain('message');
	});
});
