import { BADGE_SHAPE, BADGE_TYPE } from '@panel/components/archive/header-badge.js';
import { type DeclaredField, declaredFieldsOf } from '@panel/projects/declared-fields.js';
import type { ProjectRegistration } from '@panel/projects/project-list.js';
import { Trash2 } from 'lucide-react';

/**
 * One registration under this host's projects root, exactly to `docs/DESIGN.md` §10.
 *
 * **One card per row, never a grid.** A registration is a row of facts about one project rather
 * than a tile, and unlike the Devices screen there is no second thing for a card to sit beside —
 * no hardware to compare at a glance, and nothing that changes under the reader.
 *
 * **The header strip is identical on both arms; only the body differs.** That is what makes a
 * registration the host cannot read draw as *that* — a project, named, whose configuration will
 * not parse — rather than as a failure of the panel or as a project declaring nothing (D6, D31).
 *
 * **One control, and it is `Delete project` in the header strip** — the affordance, deliberately
 * ahead of the action it names: it is wired to nothing, writes nothing and asks the host nothing.
 * The card is still not a link and carries no other control, no overflow menu and no form control.
 * The action itself is unchanged by its presence: deleting a registration means a write into the
 * projects root over the wire, which D31 refuses on every transport, and it waits on the role model
 * D27 defers. See {@link DeleteProjectButton} for what this does and does not promise.
 *
 * **No LED, no dot, no status glyph and no colour on any field.** The device card's LED means
 * *held or free*, a live fact about hardware; a registration has no such state, and borrowing that
 * vocabulary here would invent one.
 *
 * **The design's scanline layer in the header strip is dropped**, the precedent being
 * `held-free-counter.tsx` and the rule `app-shell.test.tsx` already asserts: the texture is
 * confined to the navigation chrome and nothing inside `<main>` carries it (§5).
 */
export function ProjectCard({ project }: { readonly project: ProjectRegistration }) {
	return (
		<article className="flex flex-col overflow-hidden rounded-sm border-2 border-outline-variant bg-surface-container">
			{/*
			 * **The `PROJECT` label is load-bearing** (§10). The device card's header needs none
			 * because a phone model is self-evidently one; `checkout-web` on its own reads as a
			 * title, and it is not — it is the hook file's own name, the identifier the host looked
			 * the project up by, and the exact string a lease carries as its `project` (D22).
			 *
			 * What sits on the right of the strip is the one control and **never a status**: a
			 * registration has none, so there is still no LED, no dot and no glyph standing for one.
			 * `ml-auto` rather than `justify-between`, so the label and the identifier stay a pair
			 * reading left to right and the control is what is pushed away from them.
			 *
			 * **Two levels of alignment, because the strip now holds two different things.** The pill
			 * made the strip taller than the words, and `items-baseline` across the whole row then
			 * left the two words sitting where the shorter strip had put them — a row that reads as
			 * having grown downwards rather than as one row. So the strip centres its *children* and
			 * the label and the identifier are **one child**: they keep the shared baseline they
			 * always had — 10px caps against a 14px identifier, which is what a baseline is for —
			 * and that pair is centred against the control beside it.
			 */}
			<div className="flex items-center gap-3 border-outline-variant border-b-2 bg-surface-container-high px-4 py-2">
				<div className="flex min-w-0 items-baseline gap-3">
					<span className="shrink-0 font-label-caps text-[10px] text-on-surface-variant uppercase">
						Project
					</span>
					{/* Monospace, verbatim, wrapping on whole words: never truncated, never ellipsised,
					    never lower-cased. */}
					<span className="break-words font-code-md text-code-md text-on-surface">
						{project.project}
					</span>
				</div>
				<DeleteProjectButton className="ml-auto" project={project.project} />
			</div>

			{project.kind === 'registered' ? <DeclaredBody project={project} /> : <NotReadableBody />}
		</article>
	);
}

/**
 * `Delete project` — the strip's one control, **the affordance and not yet the action**.
 *
 * **It is wired to nothing on purpose.** No `onClick`, no confirmation, no call: pressed, it does
 * exactly nothing, and it is here so the shape of the row can be settled before the write behind it
 * exists. That write is a different privilege in kind — deleting a registration means the host
 * removing a file that names programs it spawns, which D31 refuses on every transport and which
 * waits on the role model D27 defers — so **nothing about this control claims the privilege is
 * there**, and it must not grow a handler that pretends otherwise. What it will grow, when the
 * action lands, is `ForceReleaseControl`'s shape: a confirmation that asks first, and an answer that
 * says what actually happened.
 *
 * **It is the badge treatment, not a new one** — `BADGE_SHAPE` and `BADGE_TYPE` are the Archive
 * header's own pill (`header-badge.tsx`), so the radius, the border width, the padding, the face and
 * the 12px step are shared rather than copied, and the glyph-beside-12px-words arrangement is
 * `artifact-body-view.tsx`'s *Open in a new window*. Nothing here is invented at the keyboard
 * (`ai/RULES.md` §8).
 *
 * **The accent is `error`, and that is a departure recorded rather than assumed.** §5 has no red
 * *device state* and never will — a device that vanished is simply not listed — and the
 * force-release control drops the design's red hover for that reason. Neither rule is about a
 * destructive control's own accent, which is what this is: `error` is Analog Horizon's own red
 * (`--color-error`), it is on the glyph and the words rather than in a fill, and the frame stays
 * `outline-variant` until the pointer is on it. §5's *destructive actions are recessive* is what
 * that shape is for — the loudest thing on a Projects card is still the identifier it is about, and
 * a solid red pill repeated down a list of registrations is exactly the full-width orange button §5
 * records as the mistake.
 */
function DeleteProjectButton({
	project,
	className,
}: {
	/** The identifier this control is about — for the accessible name, so a screen reader hears
	 *  which of the cards' identical labels it has landed on. */
	readonly project: string;
	readonly className: string;
}) {
	return (
		<button
			// `aria-label` overrides the visible words rather than adding to them, which is what a
			// list of same-labelled controls needs: `Delete project checkout-web`, not `Delete
			// project` eight times.
			aria-label={`Delete project ${project}`}
			className={`${BADGE_SHAPE} ${BADGE_TYPE} ${className} flex shrink-0 items-center gap-2 border-outline-variant bg-surface-container text-error transition-colors hover:border-error`}
			type="button"
		>
			<Trash2 aria-hidden="true" size={14} strokeWidth={2} />
			Delete project
		</button>
	);
}

/**
 * The four declared fields, two across and paired like with like (§10): `APPS` beside `SERVICES`,
 * the two lists; `INSTALL` beside `TEARDOWN`, the two that are only ever *declared* or *none
 * declared*.
 *
 * **`grid-cols-2` with no breakpoint**, which is one deviation from the reference's
 * `md:grid-cols-2`: the two-across pairing *is* what the columns are, and a breakpoint would read
 * the viewport instead (§4).
 *
 * **No per-field rules.** The gutter separates them now that they are a grid; a rule under one
 * cell reads as a line across the whole card.
 */
function DeclaredBody({
	project,
}: {
	readonly project: Extract<ProjectRegistration, { kind: 'registered' }>;
}) {
	const fields = declaredFieldsOf(project);
	return (
		<dl className="grid flex-1 grid-cols-2 gap-(--gutter) p-4">
			<Field field={fields.apps} label="Apps" />
			<Field field={fields.services} label="Services" />
			<Field field={fields.install} label="Install" />
			<Field field={fields.teardown} label="Teardown" />
		</dl>
	);
}

/**
 * One label over one value, and **the face is the answer's own** (`declared-fields.ts`): a list of
 * identifiers is monospace, and a complete answer — *declared*, *none declared* — is the ordinary
 * body face. The face is what separates a list from an answer, so the pairing reads without a rule
 * between the cells.
 *
 * **A `none declared` card must not look faded, empty, unloaded or pending** (§10): the body face
 * carries the same `text-on-surface` a list does, and nothing here is dimmed, italicised or
 * placeheld. A project that asks the host to do nothing is the common, correct case.
 */
function Field({ label, field }: { readonly label: string; readonly field: DeclaredField }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className="font-label-caps text-[10px] text-on-surface-variant uppercase">{label}</dt>
			{field.face === 'code' ? (
				/*
				 * One value per line, which the design draws with `<br>`. A `block` span per line
				 * instead: the values are separate identifiers rather than one string with breaks in
				 * it, and nothing joins them into one.
				 */
				<dd className="break-words font-code-md text-[14px] text-on-surface">
					{field.lines.map((line) => (
						<span className="block" key={line}>
							{line}
						</span>
					))}
				</dd>
			) : (
				<dd className="font-body-md text-body-md text-on-surface">{field.answer}</dd>
			)}
		</div>
	);
}

/**
 * The registration the host cannot read — **an arm of the union, not a project with empty fields**
 * (§10), which is the whole of what D31's read buys.
 *
 * Today a hook file that will not parse costs a project its teardown and says so only in one
 * warning on the daemon's stderr (`src/daemon/restore.ts`); this card is where that becomes
 * visible to a person.
 *
 * **The chip is at its own width and left-aligned** — §10 forbids a slab across a full-width card,
 * which is why this is deliberately *not* `QuietBanner`. **No error code, no path and no retry**,
 * and §5's no-red rule holds: which of the four causes it was is deliberately not on the wire
 * (D19), so a code here would dress a refusal up as a diagnosis.
 */
function NotReadableBody() {
	return (
		<div className="flex flex-1 flex-col gap-4 p-4">
			<p className="self-start rounded-sm border-2 border-outline-variant bg-surface-container-high px-3 py-1.5 font-label-caps text-[10px] text-on-surface-variant uppercase">
				Configuration not readable
			</p>
			{/*
			 * The sentence is the whole point of the state, exactly as *a phone may well be plugged
			 * in* is for *no view* (§7): the pair must never render alike (D6).
			 */}
			<p className="font-body-md text-body-md text-on-surface-variant">
				This is not the same as a project that declares nothing — the file is there and the host
				cannot read it.
			</p>
		</div>
	);
}
