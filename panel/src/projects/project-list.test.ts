import { describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/panel/list-projects.json';
import { ListProjectsResultSchema } from './project-list.js';

/**
 * The panel's half of the drift gate `tests/unit/panel/list-projects-fixture.test.ts` opens.
 *
 * The same four captured answers, parsed here by the mirror and there by the daemon's own
 * schemas. What this half proves is that every field the card renders survives the parse — **by
 * name, field by field**, which is #123's lesson: a mirror that quietly drops a key leaves both
 * suites green while the screen stops saying something. What the other half proves is that the
 * file is a set of answers the daemon could really give.
 */

/** The one answer that lists anything, which is where every field on the card comes from. */
const POPULATED = fixture.answers[0]?.result;

describe("the panel's mirror of list_projects", () => {
	it('reads every captured answer', () => {
		for (const answer of fixture.answers) {
			expect(ListProjectsResultSchema.safeParse(answer.result).success).toBe(true);
		}
	});

	it('keeps every field the card draws, one registration at a time', () => {
		const parsed = ListProjectsResultSchema.parse(POPULATED);

		expect(parsed.outcome).toBe('listed');
		if (parsed.outcome !== 'listed') {
			return;
		}
		expect(parsed.projects[0]).toEqual({
			kind: 'registered',
			project: 'checkout-web',
			apps: ['com.example.checkout', 'com.example.checkout.debug'],
			hasInstall: true,
			services: ['mock-payments', 'api'],
			hasTeardown: true,
		});
		// The common, correct case: a project that asks the host to do nothing at all.
		expect(parsed.projects[2]).toEqual({
			kind: 'registered',
			project: 'rover-sandbox',
			apps: [],
			hasInstall: false,
			services: [],
			hasTeardown: false,
		});
	});

	/*
	 * The captured file's own services are `mock-payments` then `api` — deliberately not
	 * alphabetical, so *never alphabetised* is assertable rather than merely stated. That order is
	 * the order the host starts them in (`docs/DESIGN.md` §10).
	 */
	it('leaves the service names in the order the host answered them', () => {
		const parsed = ListProjectsResultSchema.parse(POPULATED);
		if (parsed.outcome !== 'listed') {
			return;
		}
		const [first] = parsed.projects;

		expect(first?.kind === 'registered' && first.services).toEqual(['mock-payments', 'api']);
	});

	// The two arms are what D6 rests on here, and a mirror that collapsed them would be the one
	// place *a project declaring nothing* could start rendering like *the host cannot read it*.
	it('keeps the registration it cannot read apart from the one that declares nothing', () => {
		const parsed = ListProjectsResultSchema.parse(POPULATED);
		if (parsed.outcome !== 'listed') {
			return;
		}

		expect(parsed.projects.map((project) => project.kind)).toEqual([
			'registered',
			'unreadable',
			'registered',
		]);
		expect(parsed.projects[1]).toEqual({ kind: 'unreadable', project: 'legacy-kiosk' });
	});

	// The host's own order, carried through the parse: the broken one is second and not last.
	it('answers the identifiers in the order the host listed them', () => {
		const parsed = ListProjectsResultSchema.parse(POPULATED);
		if (parsed.outcome !== 'listed') {
			return;
		}

		expect(parsed.projects.map((project) => project.project)).toEqual([
			'checkout-web',
			'legacy-kiosk',
			'rover-sandbox',
		]);
	});

	it('reads all three outcomes and keeps an empty listing apart from an unreadable root', () => {
		expect(ListProjectsResultSchema.parse({ outcome: 'listed', projects: [] })).toEqual({
			outcome: 'listed',
			projects: [],
		});
		expect(ListProjectsResultSchema.parse({ outcome: 'missing' })).toEqual({
			outcome: 'missing',
		});
		expect(ListProjectsResultSchema.parse({ outcome: 'unreadable' })).toEqual({
			outcome: 'unreadable',
		});
	});

	/*
	 * Nothing here is `.strict()`, on purpose: a newer daemon that adds a field must not blank a
	 * working screen. The extra key is stripped rather than rejected.
	 */
	it('ignores a field a newer daemon might add rather than refusing the answer', () => {
		const parsed = ListProjectsResultSchema.parse({
			outcome: 'listed',
			projects: [
				{
					kind: 'registered',
					project: 'checkout-web',
					apps: [],
					hasInstall: false,
					services: [],
					hasTeardown: false,
					registeredAt: '2026-09-01T09:00:00.000Z',
				},
			],
		});

		expect(parsed.outcome).toBe('listed');
		if (parsed.outcome !== 'listed') {
			return;
		}
		expect(parsed.projects[0]).not.toHaveProperty('registeredAt');
	});

	// An outcome this panel has never heard of is not an answer it may guess at — the screen folds
	// it into *not readable*, and that fold starts with the parse failing here.
	it('refuses an outcome it does not know', () => {
		expect(ListProjectsResultSchema.safeParse({ outcome: 'partially listed' }).success).toBe(false);
	});
});
