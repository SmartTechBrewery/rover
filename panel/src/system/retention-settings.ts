import { useState } from 'react';

/**
 * The two numbers that bound what the archive keeps, as the System screen edits them — and
 * **nothing on the host knows about either of them yet**.
 *
 * There is no retention mechanism: nothing sweeps the archive, no host answer carries a budget or
 * an age, and no method takes one. So this module is the UI half landing first, and it keeps the
 * draft in React state and lets it end with the mount: a number that survived a reload would look
 * like a setting the host had been told about, and the operator would have configured nothing.
 *
 * **The `Keep` tick was the other half of that pair and no longer is** (D33, #237). It was React
 * state for this exact reason until the host had somewhere to put it; it now has one, so a tick
 * survives a reload and a daemon restart while these two numbers still do not. What separates them
 * is a host method, which is the only thing that ever separated them.
 *
 * **The pair is two rules and not one**, which is why both are here and neither is derived from the
 * other. A budget alone lets a quiet month keep everything forever; an age alone lets a busy week
 * fill the disk inside the window. Whichever bound is reached first is the one that acts, and the
 * screen says so in as many words.
 */

/**
 * Megabytes the archive may occupy. **1 GiB**, written as `1024` rather than as a gigabyte because
 * the setting *is* an integer count of MB — the host will be given a number, not a unit to parse.
 *
 * A default is a claim about somebody else's disk, so it is deliberately **small**: this panel
 * cannot see how large the disk is, a percentage would be arithmetic off a number nobody sent
 * (D19), and of the two ways to be wrong the cheap one is right. A budget set too low deletes runs
 * an operator could have kept — recoverable by raising it, and the `Keep` tick is there for the
 * ones that matter — while one set too high fills a disk the host needs to keep working. It is the
 * operator's number to raise, and a gigabyte is enough archive to see that the mechanism works.
 */
export const DEFAULT_DISK_BUDGET_MB = 1024;

/**
 * Days after which a test's traces go even if the budget is nowhere near reached. **30**, which is
 * long enough that a month-old investigation is still there and short enough that the archive does
 * not grow without a second bound.
 */
export const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * One field's text, and it is **text rather than a number**.
 *
 * A field a person is typing into passes through states no integer can hold: empty, while they
 * clear it to type something else, is the ordinary one. Storing `number` here would have to invent
 * a value for that — `0` is a real setting and a wrong one, `NaN` is not a value — so the draft
 * holds what was typed and {@link retentionValueOf} is where it becomes a number, once, at the edge
 * that needs one.
 */
export type FieldText = string;

/**
 * Digits and nothing else: the shape a count of megabytes or days can take.
 *
 * Applied on the way *in* rather than validated on the way out, so a field cannot hold `-1`, `1.5`,
 * `1e6` or a pasted `12 MB` at all. That is also why the inputs are `type="text"` with
 * `inputMode="numeric"` and not `type="number"`: a number input accepts `e` and `-` in some
 * browsers, hands back an empty string for anything it dislikes — losing what was typed — and
 * brings a spinner this design has no styling for.
 *
 * A leading zero is left alone while typing; it is not this function's business to rewrite what
 * somebody is halfway through.
 */
export function digitsOnly(typed: string): FieldText {
	return typed.replace(/\D/g, '');
}

/**
 * What a field's text means as a setting, or `null` when it does not mean one yet.
 *
 * `null` for empty and for zero — a zero-megabyte archive and a zero-day window are both *keep
 * nothing*, which no operator sets on purpose and which this screen must not be the accidental way
 * to ask for. It is not an error either: it is a field that is not finished, and the screen says
 * that where it matters rather than colouring the field.
 */
export function retentionValueOf(text: FieldText): number | null {
	if (text === '') {
		return null;
	}
	const value = Number(text);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The draft the screen edits: two fields, and the two setters that keep them digits. */
export interface RetentionDraft {
	readonly diskBudgetMb: FieldText;
	readonly maxAgeDays: FieldText;
	setDiskBudgetMb(typed: string): void;
	setMaxAgeDays(typed: string): void;
}

export function useRetentionDraft(): RetentionDraft {
	const [diskBudgetMb, setDisk] = useState<FieldText>(String(DEFAULT_DISK_BUDGET_MB));
	const [maxAgeDays, setDays] = useState<FieldText>(String(DEFAULT_MAX_AGE_DAYS));

	return {
		diskBudgetMb,
		maxAgeDays,
		setDiskBudgetMb: (typed) => setDisk(digitsOnly(typed)),
		setMaxAgeDays: (typed) => setDays(digitsOnly(typed)),
	};
}
