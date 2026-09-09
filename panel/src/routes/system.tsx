import { useArchiveSize } from '@panel/archive/archive-size.js';
import { PageHeader } from '@panel/components/layout/page-header.js';
import { RetentionCard } from '@panel/components/system/retention-card.js';
import { useRetentionDraft } from '@panel/system/retention-settings.js';
import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root.js';

/**
 * The whole archive, which is what an empty path names to `measure_archive` — the same address the
 * Archive screen's own root badge measures, so the two screens are reading one answer about one
 * directory rather than two figures that could differ.
 *
 * A named constant rather than a bare `[]` at the call site, and it buys nothing at runtime: the
 * hook keys its request on what was asked about rather than on the array's identity
 * (`archive/archive-size.ts`). What it buys is that the one address this screen measures has a
 * name, since *the whole archive* is not what an empty array says on its own.
 */
const WHOLE_ARCHIVE: readonly string[] = [];

/**
 * The panel's settings destination (`docs/DESIGN.md` §3, §13) — **and it is `System` rather than a
 * fifth nav item called `Settings`.**
 *
 * §3 settles four destinations and says in as many words that *`System` stands in for settings*;
 * the placeholder this replaces promised *the host's own settings will be shown here*. A second
 * door to the same room would be the one thing that arrangement cannot survive, so this fills the
 * promise instead of adding to the nav. Renaming the destination is a §3 decision and a one-line
 * edit if the operator wants it; nothing here assumes either answer.
 *
 * **It holds two settings and nothing else yet**: how much disk the archive may use, and how old a
 * test may get. They are the two bounds of one rule, so they are one card
 * (`components/system/retention-card.tsx`).
 *
 * **Nothing is stored, and no `Save` is drawn.** No method takes either number and no answer
 * carries one, so the draft lives in React state and ends with the mount
 * (`system/retention-settings.ts`). A control that appeared to write would be exactly what §11
 * refuses on a destination that is not built, and the card says plainly where the numbers stand
 * instead. *Corrected in place, 2026-09-08 (#238): the host does have a retention mechanism now —
 * it enforces these two bounds from its own environment and `rover sweep` runs them — and that
 * changes nothing here, because what is still missing is a method that writes them.*
 *
 * **This screen does read one host fact, and exactly one** (#260): what the whole archive weighs.
 * It is the request `measure_archive` has answered since #259, and it is asked **here** rather than
 * in the card, so the card stays what it is — a thing given its data — and the one round trip this
 * destination makes is visible in the screen that makes it. Nothing polls it: the archive is
 * finished data, so the answer is taken once per mount, exactly as the Archive screen's own badge
 * takes it (`archive/archive-size.ts`).
 *
 * **No `CalmNotice` any more.** The screen is not *empty*: it has the two fields, so the *not built
 * yet* wording would now be false of it, and the one temporary fact — that the numbers are not kept
 * — belongs beside the fields it is about rather than in a panel above them.
 *
 * Exported for `system.test.tsx`, as the other screens are: a route's component is otherwise
 * reachable only through a router instance.
 */
export function SystemScreen() {
	const draft = useRetentionDraft();
	const archive = useArchiveSize(WHOLE_ARCHIVE);

	return (
		<>
			<PageHeader description="How this host is configured." trail={[{ label: 'System' }]} />
			<RetentionCard archive={archive} draft={draft} />
		</>
	);
}

export const systemRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/system',
	component: SystemScreen,
});
