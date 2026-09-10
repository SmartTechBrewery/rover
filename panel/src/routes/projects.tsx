import { PageHeader } from '@panel/components/layout/page-header.js';
import {
	DeleteProjectNotice,
	type SettledDeleteProject,
} from '@panel/components/projects/delete-project-notice.js';
import { ProjectCard } from '@panel/components/projects/project-card.js';
import { QuietBanner } from '@panel/components/quiet-banner.js';
import { QuietPanel } from '@panel/components/quiet-panel.js';
import type { DeleteProjectAnswer } from '@panel/projects/delete-project.js';
import { useDrawnRegistrations } from '@panel/projects/drawn-registrations.js';
import type { ProjectRegistration } from '@panel/projects/project-list.js';
import {
	type RegisteredProjects,
	useRegisteredProjects,
} from '@panel/projects/registered-projects.js';
import { createRoute } from '@tanstack/react-router';
import { EyeOff } from 'lucide-react';
import { useState } from 'react';
import { rootRoute } from './__root.js';

/**
 * The panel's fourth destination — **what is registered on this host, and the one write that is a
 * removal** (`docs/DESIGN.md` §10, `PROJECT.md` R42, R50, D31, D42).
 *
 * It answers one question with one call: `list_projects` reads the whole projects root in a single
 * request (R39, #152), so unlike the Archive there is no tree, no expansion, no second column and
 * no navigation — there is nowhere to navigate to. A registration is a leaf, and this screen is
 * the list of them.
 *
 * **One thing on it writes, and the write is a *removal*** — this paragraph is rewritten in place
 * with its reasoning rather than deleted (`ai/RULES.md` §1, #273). It read *nothing on it writes:
 * no `Add`, no `Edit`, no `Delete`, no overflow menu, and not a disabled one either*, on the ground
 * that a hook file names programs the host spawns, so writing one is a different privilege in kind
 * and waits on the role model D27 defers. **That ground is unchanged and still shuts the other
 * three**: nothing here creates, edits or renames a registration, and registering is still
 * `rover init`'s. What it never covered is a *delete*, which makes the host run strictly less and
 * names no program — so D31 was amended and the card's `Delete project` control has its action
 * (D42). The cards are still not links.
 *
 * **The screen re-reads rather than editing what it had.** A settled delete calls `reload()`, and
 * the list afterwards is `list_projects`' answer again: a locally filtered array would be a list
 * nothing on the host answered with, and it would be wrong for a `partial` that left the
 * registration in place and for a `not-registered` that proves the list was already stale.
 *
 * **And the card the answer stopped carrying leaves rather than vanishing** (#285, §5). That is a
 * motion and not a second opinion about what is registered: the cards drawn are still the host's
 * answer in the host's order, and the one on its way out is marked as such, `inert`, and dropped
 * the moment the motion is over. {@link ProjectList} owns it, and `useDrawnRegistrations` is why
 * holding a card for 160ms is not the locally filtered array the paragraph above refuses.
 *
 * **Still no polling and no refresh control, for this screen's own reason** — rewritten in place,
 * because it used to cite the Archive's rule and that rule changed under it (#287, `ai/RULES.md`
 * §1). The behaviour is untouched: a registration changes when a person runs `rover init` or edits
 * a hook file on the host, which this screen makes no claim to see happen, and no lease writes one
 * — so the live-lease gate the Archive's clock runs behind has no counterpart here. It re-reads on
 * a settled delete and on nothing else, so there is nothing for a reader to press.
 *
 * | The host's answer | What the content area is |
 * | --- | --- |
 * | nothing yet | one quiet line, no spinner |
 * | a listing | one card per registration, **in the host's own order** |
 * | an empty listing, or no projects root at all | *No projects registered* |
 * | unreadable | `PROJECTS ROOT NOT READABLE` |
 *
 * Exported for `projects.test.tsx`, as `DevicesScreen` and `ArchiveScreen` are: a route's
 * component is otherwise reachable only through a router instance, and what is worth asserting is
 * which state renders what.
 */
export function ProjectsScreen() {
	const { state, reload } = useRegisteredProjects();
	const [settled, setSettled] = useState<SettledDeleteProject | undefined>(undefined);

	/*
	 * What a delete settled, and the fresh read that makes it visible.
	 *
	 * **All four outcomes are reported and three of them re-read.** `refused` is the one that does
	 * not: a live lease means nothing at all was touched, so what is registered is exactly what the
	 * list already says and a second `list_projects` would ask the host a question whose answer the
	 * screen is holding. The other three each changed something or proved the list wrong —
	 * `not-registered` most of all, since it says the registration was already gone.
	 *
	 * **The request that reached nothing settles nothing, so it never arrives here.** It stays in
	 * the dialog, which stays open with the control usable again, and the panel reports no deletion
	 * it did not get (§7's fourth case).
	 */
	const onDeleteSettled = (answer: DeleteProjectAnswer, project: string): void => {
		if (answer.outcome === 'unanswered' || answer.outcome === 'access-ended') {
			return;
		}
		setSettled({ answer, project });
		if (answer.outcome !== 'refused') {
			reload();
		}
	};

	return (
		<>
			<PageHeader
				aside={badgeFor(state)}
				description="Projects registered on this host."
				trail={[{ label: 'Projects' }]}
			/>
			{/*
			 * Above the content area, so it is above the list — and still there when the list is not.
			 * Deleting the only registration on this host empties it, and the line saying which
			 * project went must not sit inside the branch it just emptied.
			 */}
			<DeleteProjectNotice onDismiss={() => setSettled(undefined)} settled={settled} />
			<Content onDeleteSettled={onDeleteSettled} state={state} />
		</>
	);
}

function Content({
	state,
	onDeleteSettled,
}: {
	readonly state: RegisteredProjects;
	readonly onDeleteSettled: (answer: DeleteProjectAnswer, project: string) => void;
}) {
	if (state.status === 'loading') {
		// One line, and no spinner (§5). It is not an empty projects root and must not read as one.
		return (
			<p aria-live="polite" className="mt-8 font-code-md text-code-md text-on-surface-variant">
				Reading what is registered on this host.
			</p>
		);
	}
	if (state.status === 'empty') {
		return <NothingRegistered />;
	}
	if (state.status === 'unreadable') {
		return <RootNotReadable />;
	}

	return <ProjectList onDeleteSettled={onDeleteSettled} projects={state.projects} />;
}

/**
 * The listing itself — **one card per row, never a grid** (§10), and **the order is the host's
 * own**: code-unit ascending, from `src/daemon/list-projects.ts`. Nothing here sorts, partitions or
 * filters, so a registration that will not parse sorts among the others rather than being grouped
 * last — and `list_projects` takes no parameter, so there is no other ordering available and no
 * sort control to build.
 *
 * **The list carries no maximum of its own** (§4, #240), so it ends where the header above it ends.
 * A registration's card is therefore as wide as the content box — which is what an admin list is —
 * and its body is a two-column `<dl>` (§10, *As built* #157) rather than one stretched line, so the
 * width goes to the value columns instead of making a single string very long.
 *
 * **And a card the host's next answer no longer carries leaves rather than vanishing** (#285, §5).
 * It is its own component for that and only that: the holding is state, and the states above it —
 * *nothing yet*, *nothing registered*, *not readable* — are not a list at all, so a hook called in
 * `Content` would have had to be called in branches that never draw a card. What follows from that
 * boundary is deliberate and is the honest reading of it: **a delete whose answer stops being a
 * listing takes this component down with it**, so deleting the last registration on a host still
 * swaps straight to *No projects registered*. The screen has changed state there rather than a card
 * having left a list, and there is nothing below the card for a motion to move.
 *
 * See {@link useDrawnRegistrations} for what a leaving row is and why holding it is not a claim
 * about what is registered.
 */
function ProjectList({
	projects,
	onDeleteSettled,
}: {
	readonly projects: readonly ProjectRegistration[];
	readonly onDeleteSettled: (answer: DeleteProjectAnswer, project: string) => void;
}) {
	const rows = useDrawnRegistrations(projects);

	return (
		<div className="mt-8 flex flex-col gap-(--gutter)">
			{rows.map((row) => (
				/*
				 * **The box is on every card and is mounted open**, because a CSS transition does not
				 * run on an element's first style computation: a wrapper that appeared already shut
				 * would take the card away in the one frame this exists to remove. So the card that
				 * leaves is the class changing on a box that was already there — `Subtree`'s
				 * arrangement in the archive tree (`directory-tree.tsx`), in the other direction.
				 * `.card-collapse` in `index.css` carries the reason for every declaration, the
				 * cancelled gutter included.
				 *
				 * **`inert` is the accessibility half and it is set from the same condition.** A card
				 * on its way out is visible and nothing else: its `Delete project` control is not
				 * reachable by tab or by click, and the card is out of the accessibility tree — the
				 * registration is already gone, and a second confirmation over it is the failure this
				 * must not introduce. A branch of the tree uses `visibility: hidden` for the same job;
				 * that is not available to something that has to stay on screen while it moves.
				 */
				<div
					className={row.leaving ? 'card-collapse card-collapse-shut' : 'card-collapse'}
					inert={row.leaving}
					key={row.project.project}
				>
					<div className="card-collapse-clip">
						<ProjectCard onDeleteSettled={onDeleteSettled} project={row.project} />
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * The one number on the screen, and it **goes rather than reading `0`** — `archive.tsx`'s rule and
 * §7's for the held/free counter: a `0 registered` describes a set, and a root that is empty or
 * unreadable is not a set of none.
 *
 * **It counts every registration the host answered, an unreadable one included.** The file is
 * there, so it is a registration; leaving it out would make the badge disagree with the cards
 * below it. No singular branch either — *registered* does not pluralise.
 */
function badgeFor(state: RegisteredProjects) {
	if (state.status !== 'listed') {
		return undefined;
	}
	return (
		<div className="rounded-sm border-2 border-outline-variant bg-surface-container px-3 py-1.5 font-code-md text-code-md text-on-surface">
			{`${state.projects.length} registered`}
		</div>
	);
}

/**
 * Nothing is registered on this host — §7's *nothing attached* treatment, and normal rather than a
 * fault. **A root that is not there at all says exactly this**, which is the fold §10 settles and
 * the one the Archive already makes at its root: both are the ordinary state of a host whose
 * operator has not done a thing yet, and a reader has the same next step either way.
 *
 * It says what would change it, and the badge is absent rather than `0 registered`.
 */
function NothingRegistered() {
	return (
		<QuietPanel heading="No projects registered">
			{/* The one command on this screen, in the monospace face because it is one — the face is
			    the token's, not a colour or a treatment invented here. */}
			A project is registered when someone runs <span className="font-code-md">rover init</span> in
			its own directory on this host. Nothing is registered here yet.
		</QuietPanel>
	);
}

/**
 * The projects root is there and the host cannot say what is in it — the grey treatment §7
 * settled, one level up from the card that says the same thing about one file.
 *
 * **The second line is the whole point of the state** (D6): this and *No projects registered* must
 * never render alike, and the two share no phrase. `EyeOff` rather than a new glyph, matching
 * `ArchiveNotReadable`: it is the same fact about a directory the host cannot see into.
 *
 * No retry, no error code and nothing near red — which of the causes it was is deliberately not on
 * the wire (D19).
 */
function RootNotReadable() {
	return (
		<QuietBanner Icon={EyeOff} heading="PROJECTS ROOT NOT READABLE">
			Rover cannot see into this host's projects directory. Something is there and the host will not
			read it.
			<span className="mt-2 block">
				This is not the same as no projects being registered — registrations may well be here.
			</span>
		</QuietBanner>
	);
}

export const projectsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects',
	component: ProjectsScreen,
});
