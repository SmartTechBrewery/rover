import { describe, expect, it } from 'vitest';
import { ListProjectsParamsSchema, ListProjectsResultSchema } from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/list-projects.json' with { type: 'json' };

/**
 * The daemon's half of the Projects screen's drift gate.
 *
 * `panel/src/projects/project-list.ts` re-declares `list_projects`' answer instead of importing
 * these schemas, for the structural reason `list-devices-fixture.test.ts` sets out: the panel is a
 * separate tree with its own `tsconfig.json` and its own alias, and `src/ipc/methods.ts` drags
 * `core/device.ts`, `core/capabilities.ts` and the verb schemas into a browser bundle behind it.
 * So one fixture is parsed twice, by two projects that cannot import each other — **here** by the
 * host's own schemas, and in `panel/src/projects/project-list.test.ts` by the panel's mirror.
 *
 * **It is a *case list*.** `list_projects` takes no parameter at all, so an answer cannot be named
 * by its request the way `list-archive.json`'s levels are named by their `path`: each is named by
 * the host state that produced it instead — `{ "answers": [ { "case": …, "result": … } ] }`.
 *
 * **All four were captured and none was hand-edited**, which `list-archive.json` and
 * `search-archive.json` are the precedent for and for their reason: this method needs **no
 * device** — it reads the host's own disk — so the whole file is a daemon's own bytes off the
 * panel's HTTP surface (`ROVER_HTTP_PORT`) against a seeded `ROVER_PROJECTS_PATH`. Every awkward
 * case came from the filesystem rather than from a text editor: a hook file whose `project` field
 * disagrees with its own name answers `kind: 'unreadable'`, a `{"project": …}` file with nothing
 * else in it is the *declares nothing* arm without an edit, the root moved aside answers
 * `missing`, and one with mode `000` answers `unreadable`.
 *
 * **The seeding put the broken registration in the middle on purpose.** `legacy-kiosk` sorts
 * between `checkout-web` and `rover-sandbox` in the host's code-unit order, so *a registration
 * that will not parse is not grouped last* is a property of the fixture and assertable off it
 * rather than something the screen's test has to construct.
 */

const answers = fixture.answers;

describe("the panel's list_projects fixture", () => {
	it('is a set of answers the daemon could give', () => {
		for (const answer of answers) {
			expect(ListProjectsResultSchema.safeParse(answer.result).success).toBe(true);
		}
	});

	/*
	 * The *no parameter at all* claim, made executable. There is no filter, no sort and no page to
	 * pass, which is why this screen has no sort control and could not grow one from this side.
	 */
	it('answers a request that carries nothing, and refuses one that carries anything', () => {
		expect(ListProjectsParamsSchema.safeParse({}).success).toBe(true);
		expect(ListProjectsParamsSchema.safeParse({ path: [] }).success).toBe(false);
	});

	it('carries all three outcomes, because the screen renders all three differently', () => {
		const outcomes = new Set(answers.map((answer) => answer.result.outcome));

		expect(outcomes).toEqual(new Set(['listed', 'missing', 'unreadable']));
	});

	// The two arms of `ProjectRegistrationSchema`, and the pair D6 forbids rendering alike.
	it('carries both arms of a registration', () => {
		const kinds = new Set(registrations().map((registration) => registration.kind));

		expect(kinds).toEqual(new Set(['registered', 'unreadable']));
	});

	/*
	 * The common, correct case — a project that asks the host to do nothing — beside the one that
	 * will not parse. A fixture with only full registrations would leave the whole of D6's pair
	 * unpinned on the wire.
	 */
	it('carries a registration that declares nothing at all', () => {
		const declaresNothing = registrations().find(
			(registration) =>
				registration.kind === 'registered' &&
				registration.apps.length === 0 &&
				registration.services.length === 0 &&
				!registration.hasInstall &&
				!registration.hasTeardown,
		);

		expect(declaresNothing?.project).toBe('rover-sandbox');
	});

	// The host's own order (`src/daemon/list-projects.ts`), with the broken registration in among
	// the others rather than at the end — which is what the panel is forbidden to re-sort.
	it('lists the registration it cannot read in among the others, not last', () => {
		const listed = registrations();

		expect(listed.map((registration) => registration.project)).toEqual([
			'checkout-web',
			'legacy-kiosk',
			'rover-sandbox',
		]);
		expect(listed.at(-1)?.kind).toBe('registered');
	});

	/*
	 * Declaration order, which is the order the host starts the services in — so a fixture whose
	 * services happened to be alphabetical would make *never alphabetised* unassertable anywhere.
	 */
	it('carries services in a declaration order that is not alphabetical', () => {
		const withServices = registrations().find(
			(registration) => registration.kind === 'registered' && registration.services.length > 1,
		);

		expect(withServices?.kind === 'registered' && withServices.services).toEqual([
			'mock-payments',
			'api',
		]);
	});

	/*
	 * The five fields are everything, and the host's `.strict()` is what makes that structural: a
	 * captured answer carrying a sixth would fail the parse above rather than teaching the panel a
	 * field it could draw. Asserted here as well, because *no command, no `cwd`, no port and no
	 * `env` value* (D19) is the criterion and not an implementation detail.
	 */
	it('carries no host path and no environment value anywhere in it', () => {
		const registered = registrations().filter((registration) => registration.kind === 'registered');

		for (const registration of registered) {
			expect([...Object.keys(registration)].sort()).toEqual([
				'apps',
				'hasInstall',
				'hasTeardown',
				'kind',
				'project',
				'services',
			]);
		}
	});
});

/** Every registration the fixture's one populated answer lists, parsed by the host's own schema. */
function registrations() {
	const populated = ListProjectsResultSchema.parse(answers[0]?.result);
	return populated.outcome === 'listed' ? populated.projects : [];
}
