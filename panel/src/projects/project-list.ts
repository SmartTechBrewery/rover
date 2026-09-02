import { z } from 'zod';

/**
 * `list_projects`' answer — what is registered under this host's projects root (R39, #152), as
 * much of it as the Projects screen reads.
 *
 * **Deliberately re-declared rather than imported from `src/ipc/methods.ts`**, for the reason
 * `panel/src/devices/device-list.ts` and `panel/src/archive/archive-listing.ts` both give at
 * length: the panel is a separate tree with its own `tsconfig.json` and its own `@panel` alias,
 * precisely so one alias never means two trees (`vitest.config.ts`) — and the daemon's method
 * table drags `core/device.ts`, `core/capabilities.ts` and the whole verb schema neighbourhood
 * into a browser bundle behind it.
 *
 * The drift that buys is pinned rather than hoped for: `tests/fixtures/panel/list-projects.json`
 * is parsed by the **daemon's** `ListProjectsResultSchema` in
 * `tests/unit/panel/list-projects-fixture.test.ts` and by the mirror below in
 * `project-list.test.ts`. One fixture, two projects, no cross-tree import.
 *
 * **Nothing here is `.strict()`**, which is the same deliberate difference from the host's copy
 * both other mirrors make: the host's `.strict()` protects the host from a handler leaking a
 * field it never meant to publish, and a browser that blanks a working screen because a newer
 * daemon added a field is worse than one that ignores it. Zod's default strips what it does not
 * know.
 *
 * **`project`, `apps` and a service name are plain `z.string()`** rather than the host's
 * `AttributionStringSchema` / `AppIdSchema`: a bound is what matters on the way *in*, and nothing
 * comes in here — `list_projects` takes no parameter at all, so there is no value this panel
 * sends that a shape would have to hold. The panel uses each string verbatim and parses none of
 * them to decide anything (D22).
 */

/**
 * A registration the host read, and the five fields are **everything** it answers.
 *
 * **`env` values and every host path are structurally absent** (D19): there is no field a
 * command, a `cwd`, a port or an environment value could arrive in, because this answer reaches a
 * browser and a hook file's `env` may hold anything an operator put there. So `install` and
 * `teardown` arrive as booleans — *whether* the host has one, never which program it is — and a
 * service arrives as its name alone. The mirror must not grow a sixth field either.
 */
const RegisteredProjectSchema = z.object({
	kind: z.literal('registered'),
	/** The hook file's own name, and the exact string a lease may carry as its `project` (D22). */
	project: z.string(),
	/** The applications a lease on this project drives, as the hook file declares them. */
	apps: z.array(z.string()),
	/** Whether an `install` is declared — never what it runs. */
	hasInstall: z.boolean(),
	/**
	 * Its helper services **by name, in declaration order** — the order the host starts them in
	 * and the reverse of the order it stops them in. Nothing in this panel sorts it: re-ordering
	 * the list would state something false about the host (`docs/DESIGN.md` §10).
	 */
	services: z.array(z.string()),
	/** Whether a `teardown` is declared — never what it runs. */
	hasTeardown: z.boolean(),
});
export type RegisteredProject = z.infer<typeof RegisteredProjectSchema>;

/**
 * The file is there and the host **cannot say what this project declares** — an arm of the union
 * rather than a registration with empty fields, and that is the whole of what D31's read buys.
 *
 * A project that asks the host to do nothing (`apps: []`, `services: []`, no `install`, no
 * `teardown`) is the common, correct case, so this must never render like one (D6). Which of the
 * four causes it was is deliberately not on the wire (D19) — the diagnosis names a path and stays
 * in a warning on the host, where `src/daemon/list-projects.ts` puts it.
 */
const UnreadableProjectSchema = z.object({
	kind: z.literal('unreadable'),
	/** The file's own name, without `.json`. Never a field read out of a file that will not parse. */
	project: z.string(),
});

export const ProjectRegistrationSchema = z.discriminatedUnion('kind', [
	RegisteredProjectSchema,
	UnreadableProjectSchema,
]);
export type ProjectRegistration = z.infer<typeof ProjectRegistrationSchema>;

/**
 * Three answers, never two — the archive's own three, one level up.
 *
 * `listed` with `projects: []` is *nobody has registered one here* and is not a failure;
 * `missing` is *there is no projects root*, also ordinary; `unreadable` is *the root is there and
 * the host cannot say what is in it*. The last must never render like either of the first two
 * (D6, `docs/DESIGN.md` §10), which is why it arrives as a discriminated union rather than as two
 * readings of one array.
 */
export const ListProjectsResultSchema = z.discriminatedUnion('outcome', [
	z.object({ outcome: z.literal('listed'), projects: z.array(ProjectRegistrationSchema) }),
	z.object({ outcome: z.literal('missing') }),
	z.object({ outcome: z.literal('unreadable') }),
]);
export type ListProjectsResult = z.infer<typeof ListProjectsResultSchema>;
