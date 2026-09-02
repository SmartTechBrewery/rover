import { PageHeader } from '@panel/components/layout/page-header.js';
import { ProjectCard } from '@panel/components/projects/project-card.js';
import { QuietBanner } from '@panel/components/quiet-banner.js';
import { QuietPanel } from '@panel/components/quiet-panel.js';
import {
	type RegisteredProjects,
	useRegisteredProjects,
} from '@panel/projects/registered-projects.js';
import { createRoute } from '@tanstack/react-router';
import { EyeOff } from 'lucide-react';
import { rootRoute } from './__root.js';

/**
 * The panel's fourth destination — **what is registered on this host, read-only**
 * (`docs/DESIGN.md` §10, `PROJECT.md` R42, D31).
 *
 * It answers one question with one call: `list_projects` reads the whole projects root in a single
 * request (R39, #152), so unlike the Archive there is no tree, no expansion, no second column and
 * no navigation — there is nowhere to navigate to. A registration is a leaf, and this screen is
 * the list of them.
 *
 * **Nothing on it writes.** No `Add`, no `Edit`, no `Delete`, no overflow menu, and not a disabled
 * one either: a hook file names programs the host spawns, so writing one is a different privilege
 * in kind and waits on the role model D27 defers (D31). The cards are not links.
 *
 * **No polling and no refresh control**, which is the Archive's rule rather than the Devices
 * screen's: a registration changes when a person runs `rover init` or edits a file on the host,
 * and this screen makes no claim to see that happen.
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
	const state = useRegisteredProjects();

	return (
		<>
			<PageHeader
				aside={badgeFor(state)}
				description="Projects registered on this host."
				trail={[{ label: 'Projects' }]}
			/>
			<Content state={state} />
		</>
	);
}

function Content({ state }: { readonly state: RegisteredProjects }) {
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

	/*
	 * **One card per row, never a grid** (§10), and **the order is the host's own**: code-unit
	 * ascending, from `src/daemon/list-projects.ts`. Nothing here sorts, partitions or filters, so
	 * a registration that will not parse sorts among the others rather than being grouped last —
	 * and `list_projects` takes no parameter, so there is no other ordering available and no sort
	 * control to build.
	 */
	return (
		<div className="mt-8 flex max-w-(--container-max) flex-col gap-(--gutter)">
			{state.projects.map((project) => (
				<ProjectCard key={project.project} project={project} />
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
