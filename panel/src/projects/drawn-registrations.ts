import { useEffect, useState } from 'react';
import type { ProjectRegistration } from './project-list.js';

/**
 * **What the Projects list draws, which is the host's answer plus whatever it has just stopped
 * carrying** (#285, `docs/DESIGN.md` §5 and §10).
 *
 * A settled delete makes the screen re-read (`registered-projects.ts`), and the deleted
 * registration is simply absent from the next `list_projects` answer — so the card was unmounted in
 * a single commit and every card below it travelled up by a full card height, which on this screen
 * is a two-column `<dl>` rather than a line. This is what holds that card on screen for the length
 * of the motion, and nothing else.
 *
 * **It is not a second source of truth about what is registered, and the shape is what keeps that
 * true** (D42, #273). Every row it returns is either one the answer carries, verbatim and in the
 * host's own order, or one marked {@link DrawnRegistration.leaving} — which says *this card was on
 * screen a moment ago and the host's answer no longer has it*, a fact about the last two answers
 * rather than a claim about the projects root. Nothing here filters the answer, nothing sorts it,
 * and nothing counts these rows: the `N registered` badge reads `state.projects` as it always did.
 *
 * **The trigger is `the row is no longer listed`, never `the outcome was deleted`.** That is not a
 * detail of the implementation, it is the criterion — a `refused` touched nothing, and a `partial`
 * can leave the registration exactly where it was (`src/daemon/delete-project.ts`). Both of those
 * answer with the row still listed, so both leave every card exactly where it is, without this
 * module having to know an outcome exists.
 *
 * **`prefers-reduced-motion` is read here, in JavaScript.** The global block in `panel/src/index.css`
 * floors every transition duration and delay, so the CSS half of the motion inherits the
 * suppression — but a `setTimeout` escapes it entirely, and a card held on screen for 160ms with no
 * transition running is exactly the half-collapsed state under `reduce` that must not exist. So
 * under `reduce` no row is ever marked leaving: the card goes with the answer that dropped it.
 */
export interface DrawnRegistration {
	/**
	 * The registration this card is about — the answer's own row while it is listed, and the last
	 * one the host gave for it once it is not.
	 */
	readonly project: ProjectRegistration;
	/**
	 * Whether this card is on its way out: it was drawn a moment ago and the host's latest answer
	 * does not carry it.
	 *
	 * `projects.tsx` draws it in a shut `.card-collapse` box and marks it `inert`, so for the length
	 * of the motion it is visible and nothing else — not clickable, not focusable, out of the
	 * accessibility tree. A second confirmation over a registration that is already gone is the
	 * failure that attribute exists to prevent.
	 */
	readonly leaving: boolean;
}

/**
 * How long a leaving card is held on screen, in milliseconds — **the same number as
 * `--panel-motion` in `panel/src/index.css`**, which is where the motion itself is declared.
 *
 * It has to be written twice because the transition is CSS and the unmount is not: no stylesheet
 * can drop a React child, and `transitionend` is the wrong instrument for it — `grid-template-rows`
 * is not interpolable in every engine the panel runs in, and an event that never fires would leave
 * a card standing on the screen for good rather than for 160ms.
 * `tests/unit/panel/card-leaves-by-a-transition.test.ts` asserts the two numbers agree, so the pair
 * cannot drift.
 */
export const PANEL_MOTION_MS = 160;

/**
 * Whether the reader has asked for no motion, **read at the moment an answer lands** rather than
 * subscribed to.
 *
 * Holding a card is a one-shot decision about one gesture that has already happened, so a listener
 * would only ever change the answer for a departure the reader is no longer looking at. `matchMedia`
 * is guarded because a render without a window is a shape this module should not care about.
 */
function noMotionWanted(): boolean {
	if (typeof window === 'undefined') {
		return false;
	}
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function staying(project: ProjectRegistration): DrawnRegistration {
	return { project, leaving: false };
}

export function useDrawnRegistrations(
	projects: readonly ProjectRegistration[],
): readonly DrawnRegistration[] {
	const [drawn, setDrawn] = useState<readonly DrawnRegistration[]>(() => projects.map(staying));
	/*
	 * The answer `drawn` was built from, held so a *new* answer can be told from a re-render.
	 * `useRegisteredProjects` hands out the array it parsed, so one answer is one identity for as
	 * long as the screen holds it, and the comparison is the cheap one rather than a walk.
	 */
	const [answered, setAnswered] = useState(projects);

	/*
	 * Merged **during render**, which is the whole reason this is not an effect. A commit that drew
	 * the new answer first and spliced the departures back in afterwards would move every card below
	 * the deleted one up by a card height and then back down — the jump this exists to remove,
	 * played twice. React's own "adjusting state when props change": the render-phase update
	 * re-renders this component immediately, before anything is painted.
	 */
	if (answered !== projects) {
		setAnswered(projects);
		setDrawn(noMotionWanted() ? projects.map(staying) : held(drawn, projects));
	}

	/*
	 * And what ends the motion. Keyed on `drawn` rather than on a count, so it is armed by the same
	 * value that put the leaving rows there and disarms itself when the filter takes them away — the
	 * next run sees no leaving row and schedules nothing.
	 *
	 * A second delete settling mid-motion re-arms this, which gives the first card the length of a
	 * second transition rather than the rest of its own. It is already collapsed, `inert` and zero
	 * pixels tall by then, so what that costs is a shell in the document and nothing a reader can
	 * see.
	 */
	useEffect(() => {
		if (!drawn.some((row) => row.leaving)) {
			return undefined;
		}
		const timer = setTimeout(() => {
			setDrawn((rows) => rows.filter((row) => !row.leaving));
		}, PANEL_MOTION_MS);
		return () => clearTimeout(timer);
	}, [drawn]);

	return drawn;
}

/**
 * The rows to draw for a fresh answer: **the answer, in the host's own order, with the cards it
 * has stopped carrying still standing where they stood.**
 *
 * Position is the point. A card that leaves from the bottom of the list would collapse somewhere
 * the reader was not looking, so a departure is emitted after the same surviving card it followed
 * on screen — and the surviving cards themselves come out of `projects` untouched, so a card the
 * answer still carries does not move at all and a registration the answer has *added* lands where
 * the host sorted it rather than at the end.
 *
 * Two cases that look like edges and are not:
 *
 * - **a card already leaving stays leaving**, so two deletes in quick succession do not snap the
 *   first one away;
 * - **a leaving identifier the answer carries again is not a departure at all.** It is drawn as an
 *   ordinary row, once — which is also what keeps the keys unique, since a card's key is its
 *   identifier and two rows for one registration would be a collision.
 */
function held(
	drawn: readonly DrawnRegistration[],
	projects: readonly ProjectRegistration[],
): readonly DrawnRegistration[] {
	const listed = new Set(projects.map((project) => project.project));
	/** The departures that stood before every surviving card, and after each one that survived. */
	const leading: DrawnRegistration[] = [];
	const following = new Map<string, DrawnRegistration[]>();
	let previous: string | undefined;

	for (const row of drawn) {
		if (listed.has(row.project.project)) {
			previous = row.project.project;
			continue;
		}
		const departure = row.leaving ? row : { project: row.project, leaving: true };
		if (previous === undefined) {
			leading.push(departure);
			continue;
		}
		const after = following.get(previous) ?? [];
		after.push(departure);
		following.set(previous, after);
	}

	const rows: DrawnRegistration[] = [...leading];
	for (const project of projects) {
		rows.push(staying(project));
		rows.push(...(following.get(project.project) ?? []));
	}
	return rows;
}
