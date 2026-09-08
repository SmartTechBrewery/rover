import { PageHeader } from '@panel/components/layout/page-header.js';
import { RetentionCard } from '@panel/components/system/retention-card.js';
import { useRetentionDraft } from '@panel/system/retention-settings.js';
import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root.js';

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
 * **No `CalmNotice` any more.** The screen is not *empty*: it has the two fields, so the *not built
 * yet* wording would now be false of it, and the one temporary fact — that the numbers are not kept
 * — belongs beside the fields it is about rather than in a panel above them.
 *
 * Exported for `system.test.tsx`, as the other screens are: a route's component is otherwise
 * reachable only through a router instance.
 */
export function SystemScreen() {
	const draft = useRetentionDraft();

	return (
		<>
			<PageHeader description="How this host is configured." trail={[{ label: 'System' }]} />
			<RetentionCard draft={draft} />
		</>
	);
}

export const systemRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/system',
	component: SystemScreen,
});
