import { type RetentionDraft, retentionValueOf } from '@panel/system/retention-settings.js';
import { useId } from 'react';

/**
 * `Archive settings` — what the archive is allowed to keep, the System screen's one card
 * (`docs/DESIGN.md` §13).
 *
 * **Two settings, one card, because they are one rule with two bounds.** A disk budget alone lets a
 * quiet month keep everything; an age alone lets a busy week fill the disk inside the window.
 * Whichever is reached first acts, and the sentence under the fields says exactly that — put once,
 * under the pair, rather than half in each field's own line where a reader would have to assemble
 * it.
 *
 * **No approved Stitch screen shows this**, and none was commissioned: the operator asked for it to
 * be designed here (`ai/RULES.md` §8, and §13 records the decision). So nothing is invented — the
 * card is the run panel's own section shell, the labels are the sign-in field's caps step, the
 * fields are that screen's input with a unit after it, and the explaining lines are the archive
 * card's quiet body text. Every value is already somewhere in this panel.
 *
 * **There is no `Save`, and that is the settled rule rather than an omission.** No method on the
 * host **takes** either number and no answer carries one, so a control that appeared to store them
 * would be the first thing on this screen to lie, which is the objection §11 already makes to a
 * button on a destination that is not built. The fields are editable because a form nobody can type
 * into says nothing about the design being right; what they are worth is stated under them.
 *
 * *Corrected in place, 2026-09-08 (#238).* The reason above used to end "no sweep", and the host
 * has one now: it enforces these two bounds from its own environment and `rover sweep` runs them.
 * The half that matters here is unchanged — nothing takes them *from this screen* — so the button
 * stays absent for exactly the reason it always was, and the line under the fields says the true
 * half rather than the old sentence's both halves.
 */
export function RetentionCard({ draft }: { readonly draft: RetentionDraft }) {
	return (
		/*
		 * **The device card's anatomy**, which is `ContentsCard`'s too: `overflow-hidden rounded-lg
		 * border-2 border-outline-variant bg-surface-container`, a header strip in
		 * `bg-surface-container-high` above a `border-b-2`, and the body under it. Reused rather than
		 * re-invented — a card that says what it holds in a strip is what every other card on this
		 * panel already is, and a title floating inside the body would make this the one that is not.
		 */
		<section className="mt-8 overflow-hidden rounded-lg border-2 border-outline-variant bg-surface-container">
			<div className="border-outline-variant border-b-2 bg-surface-container-high px-4 py-3">
				{/*
				 * The tree card's own heading step (`directory-tree.tsx`'s `DIRECTORY`) in the place that
				 * card puts it. A second heading step invented for this screen is how two cards start
				 * disagreeing about what a card title looks like.
				 */}
				<h2 className="font-label-caps text-label-caps text-on-surface uppercase tracking-widest">
					Archive settings
				</h2>
			</div>

			<div className="p-6">
				{/*
				 * **Both lines sit under the title rather than under the fields, and both run the card's
				 * full width.** They say what this card is *for* — which bound acts, and that neither is
				 * stored yet — so they are read before the numbers they are about rather than discovered
				 * after them. The card's own measure rather than the prose measure the field copy wraps
				 * at: two short paragraphs capped at 65ch inside a card twice that wide read as a
				 * mistake.
				 */}
				<p className="font-code-md text-on-surface-variant text-xs">
					Whichever of the two is reached first is the one that acts. A test you have marked{' '}
					<span className="text-tertiary">Keep</span> in the Archive is exempt from both.
				</p>
				{/*
				 * **The true half of what this used to say** (#238). It read *Nothing is stored yet. Rover
				 * has no retention mechanism, so these two numbers are not saved anywhere and nothing on
				 * this host is sweeping the archive.* The host has a retention mechanism now — it reads
				 * its own two numbers and sweeps when an operator asks — so the second clause went and
				 * the first stayed, because it is the one that explains the missing `Save`. Softening it
				 * into *may be swept* was refused: a screen that hedges about whether the host deletes an
				 * operator's runs is worse than one that is out of date.
				 */}
				<p className="mt-2 font-code-md text-on-surface-variant text-xs">
					These two numbers are not saved anywhere. The host reads its own, from its own
					environment, and no control here can set them.
				</p>

				{/*
				 * **The subtle weight, and the panel already has exactly two.** `border-b` in
				 * `border-outline-variant` is the 1px rule an archive row and the device card's lease
				 * panel use *inside* a card; `border-b-2` is the structural one carrying this card's own
				 * header strip and the sidebar's sections. The lighter one on purpose: it separates what
				 * the card says from what it lets you set, and the 2px rule there would read as two cards
				 * inside one border.
				 *
				 * An `<hr>` rather than a styled `<div>` — the break is real rather than decorative,
				 * prose above and controls below, so the element that means *thematic break* is the
				 * honest one, and preflight's own `border-top-width` makes the token alone enough.
				 */}
				<hr className="mt-5 border-outline-variant" />

				{/*
				 * Two columns from `sm` up and stacked below it, the run panel's own grid: the two
				 * settings are read together, and side by side is what says so.
				 */}
				<div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
					<NumberSetting
						explanation="Rover deletes the oldest tests first once the archive passes this size."
						label="Disk space for test data"
						onChange={draft.setDiskBudgetMb}
						unit="MB"
						value={draft.diskBudgetMb}
					/>
					<NumberSetting
						explanation="A test this old goes even if the disk budget is nowhere near reached."
						label="Delete tests after"
						onChange={draft.setMaxAgeDays}
						unit="days"
						value={draft.maxAgeDays}
					/>
				</div>
			</div>
		</section>
	);
}

/**
 * One integer setting: a caps label, a field with its unit, and one line saying what the number
 * does.
 *
 * **The unit sits after the field rather than in it.** It is not part of the value — the setting is
 * a count, and the host will be handed a number — so it is text beside the input, `aria-hidden`
 * because the label already says `Disk space for test data` and a screen reader reading *MB* as
 * part of the field's name would make the name a sentence.
 *
 * **An unfinished field says so in words, not in colour.** Cleared, or left at zero, it is not an
 * error and is not dressed as one: `error` is this palette's critical step (§5) and nothing has gone
 * wrong. The line under the field is replaced by what is missing, which is also the one thing a
 * reader can act on.
 */
function NumberSetting({
	label,
	value,
	unit,
	explanation,
	onChange,
}: {
	readonly label: string;
	readonly value: string;
	readonly unit: string;
	readonly explanation: string;
	readonly onChange: (typed: string) => void;
}) {
	const field = useId();
	const unfinished = retentionValueOf(value) === null;

	return (
		<div className="flex flex-col gap-2">
			<label
				className="font-label-caps text-label-caps text-on-surface-variant uppercase"
				htmlFor={field}
			>
				{label}
			</label>
			<div className="relative flex items-center">
				{/*
				 * `type="text"` with `inputMode="numeric"`, not `type="number"` — the reasoning is in
				 * `retention-settings.ts`: a number input accepts `e` and `-` in some browsers, throws
				 * away what was typed when it dislikes it, and brings a spinner this design has no
				 * styling for. Digits are enforced on the way in instead, so the field cannot hold a
				 * value the setting could not take.
				 */}
				<input
					autoComplete="off"
					className="w-full rounded-sm border-2 border-outline bg-surface-container-lowest p-3 pr-16 font-code-md text-code-md text-on-surface focus:border-tertiary focus:outline-none"
					id={field}
					inputMode="numeric"
					onChange={(event) => onChange(event.target.value)}
					spellCheck={false}
					type="text"
					value={value}
				/>
				<span
					aria-hidden="true"
					className="absolute right-3 font-code-md text-on-surface-variant text-xs uppercase"
				>
					{unit}
				</span>
			</div>
			<p className="font-code-md text-on-surface-variant text-xs">
				{unfinished ? `Enter a whole number of ${unit} above zero.` : explanation}
			</p>
		</div>
	);
}
