import type { RegisteredProject } from './project-list.js';

/**
 * How one registration's four declared fields render — the pure seam beside the route that
 * `panel/src/devices/device-list.ts` and `panel/src/archive/archive-listing.ts` are the precedent
 * for, and what keeps `components/projects/project-card.tsx` thin.
 *
 * **The face is part of the answer, not a decoration on it** (`docs/DESIGN.md` §10). `APPS` and
 * `SERVICES` are lists of identifiers and take the monospace face; `INSTALL` and `TEARDOWN` are
 * only ever *declared* or *none declared* and take the ordinary body face. The face is what
 * separates a list from an answer, so the two-across pairing reads without a rule between the
 * cells — which is why the choice is derived here rather than made by a ternary in JSX.
 *
 * **`none declared` is a complete answer, not missing data.** A project that asks the host to do
 * nothing is the common, correct case — `apps: []`, `services: []`, no `install`, no `teardown`
 * (`src/daemon/project-hooks.ts`, and no default there ever names an application, D13) — so
 * nothing here returns `undefined`, and a card of four `none declared`s must not look faded,
 * empty, unloaded or pending.
 *
 * **Nothing is sorted, trimmed or case-folded.** `services` is passed through verbatim in
 * declaration order, which is the order the host starts them in and the reverse of the order it
 * stops them in, so re-ordering would state something false about the host; `apps` likewise (D22).
 */

/** What a field says, and in which face it says it. */
export type DeclaredField =
	/** Identifiers, one per line, in the monospace face. Never empty. */
	| { readonly face: 'code'; readonly lines: readonly string[] }
	/** A complete answer in the ordinary body face. */
	| { readonly face: 'body'; readonly answer: 'declared' | 'none declared' };

export interface DeclaredFields {
	readonly apps: DeclaredField;
	readonly services: DeclaredField;
	readonly install: DeclaredField;
	readonly teardown: DeclaredField;
}

/** The words the body face ever carries, in one place because four fields can reach them. */
const DECLARED: DeclaredField = { face: 'body', answer: 'declared' };
const NONE_DECLARED: DeclaredField = { face: 'body', answer: 'none declared' };

export function declaredFieldsOf(project: RegisteredProject): DeclaredFields {
	return {
		apps: listField(project.apps),
		services: listField(project.services),
		install: project.hasInstall ? DECLARED : NONE_DECLARED,
		teardown: project.hasTeardown ? DECLARED : NONE_DECLARED,
	};
}

/**
 * A list of identifiers, or the answer that there are none.
 *
 * The empty list crosses into the *body* face deliberately: an empty monospace cell would read as
 * a value that failed to load, and what the host said is that this project declares none.
 */
function listField(values: readonly string[]): DeclaredField {
	return values.length === 0 ? NONE_DECLARED : { face: 'code', lines: values };
}
