import { describe, expect, it } from 'vitest';
import {
	DeletedPartSchema,
	DeleteProjectParamsSchema,
	DeleteProjectResultSchema,
} from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/delete-project.json' with { type: 'json' };

/**
 * The daemon's half of `delete_project`'s drift gate (#273), and
 * `force-release-fixture.test.ts`'s reasoning applies verbatim.
 *
 * `panel/src/projects/delete-project.ts` re-declares this method's params, its `DeletedPart` enum
 * and its four-arm result union rather than importing them, for the same structural reason every
 * other mirror exists: the panel is a separate tree, and `src/ipc/methods.ts` drags
 * `core/device.ts`, `core/capabilities.ts` and the verb schemas into a browser bundle behind it. A
 * second copy of a wire shape is a thing that drifts.
 *
 * So one fixture is parsed twice, by two projects that cannot import each other: **here** by the
 * host's own `.strict()` schemas, which is what makes each entry an answer the daemon could really
 * give, and in `panel/src/projects/delete-project.test.ts` by the panel's mirror. Drift matters on
 * this method for force-release's sharper reason: the mirror narrows an outcome it does not
 * recognise to `unanswered` because *the panel never reports a deletion it did not get*, so an
 * outcome renamed on the host would leave both suites green while every real delete in the browser
 * silently became *"nothing came back from the host"* — a wrong sentence rather than a failure.
 *
 * **It is a *case list***, `list-projects.json`'s shape: this method's request names one project
 * by an identifier, but what makes an answer interesting is the **host state** that produced it —
 * three halves that each went, were never there, or would not go — so each entry is named by that
 * rather than by its request. The `params` are on the file and parsed too, which is what makes
 * *the identifier and never a path* (D19) executable rather than claimed.
 *
 * **Every entry is constructed rather than captured, and that is stated here and in
 * `ai/TESTING.md`** beside the rule it bends (§"A wire answer is a fixture too"). It bends it as
 * far as `force-release.json` does and for the same kind of reason: the five entries need five
 * different host states, and three of them cannot be arranged without breaking a host on purpose —
 * an archive subtree the daemon's user may not remove, a kept-tests store that will not read, and
 * a live lease on a project whose registration is being deleted. What keeps them honest is this
 * half: the schema below is `.strict()`, so a field this file invents fails here rather than
 * teaching the panel a shape the host never sends, and every value is one
 * `src/daemon/delete-project.ts` composes — `removed`/`absent`/`failed` per half, `freedBytes: 0`
 * wherever the archive half did not go, and `keptTestsRemoved` counted only on a `removed` store.
 */

const ANSWERS = fixture.answers;

describe("the panel's delete_project fixture", () => {
	it.each(
		ANSWERS.map((answer, index) => [index, answer.case, answer] as const),
	)('entry %i (%s) is an answer the daemon could give', (_index, _case, answer) => {
		const parsed = DeleteProjectResultSchema.safeParse(answer.result);

		expect(parsed.success).toBe(true);
	});

	/*
	 * The request half, and the reason it is on the file at all: `delete_project` is keyed on **an
	 * identifier**, so a fixture whose params the host would accept is what pins that no path ever
	 * goes in. `.strict()` is what makes the second assertion bite.
	 */
	it('names each project by an identifier the host would accept, and never by a path', () => {
		for (const answer of ANSWERS) {
			expect(DeleteProjectParamsSchema.safeParse(answer.params).success).toBe(true);
		}

		expect(
			DeleteProjectParamsSchema.safeParse({
				project: 'checkout-web',
				actor: 'karolina',
				path: ['checkout-web'],
			}).success,
		).toBe(false);
	});

	/*
	 * Driven off the host's own union rather than a list written here, so a **fifth** outcome added
	 * to `DeleteProjectResultSchema` fails this assertion until the fixture covers it — and so the
	 * panel's mirror is never left unpinned on an answer it would narrow to `unanswered`.
	 */
	it('carries every outcome the panel has to tell apart', () => {
		const parsed = ANSWERS.map((answer) => DeleteProjectResultSchema.parse(answer.result));

		expect([...new Set(parsed.map((answer) => answer.outcome))].sort()).toEqual(
			DeleteProjectResultSchema.options.map((option) => option.shape.outcome.value).sort(),
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
			const parsed = DeleteProjectResultSchema.parse(answer.result);
			return parsed.outcome === 'deleted' || parsed.outcome === 'partial'
				? [parsed.registration, parsed.archive, parsed.keptTests]
				: [];
		});

		expect([...new Set(fates)].sort()).toEqual([...DeletedPartSchema.options].sort());
	});

	/*
	 * **`not-registered` is a different arm and not a delete of zero bytes**, which is the one
	 * property of this method's answer the panel must not flatten (D42). Asserted on the file
	 * because it is a claim about the *shape* of the two: the arm that reached nothing carries no
	 * report at all, so a screen cannot accidentally read a `0` off it.
	 */
	it('keeps the answer that reached nothing free of a deletion report', () => {
		const nothing = ANSWERS.map((answer) => DeleteProjectResultSchema.parse(answer.result)).filter(
			(answer) => answer.outcome === 'not-registered',
		);

		expect(nothing).toEqual([{ outcome: 'not-registered' }]);
	});

	/*
	 * **No host path, no root and no `errno` anywhere in the file** (D19). The host's `.strict()`
	 * schemas already refuse a field one would fit in, so this is the belt to that braces: it also
	 * catches one smuggled into a *value* — an identifier written as a path, a diagnosis pasted
	 * into a case label — which no schema would notice.
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
