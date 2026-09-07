/**
 * **Which arm of an investigation a run's test name names, and how that is said out loud** — the
 * two halves of the comparison card's pane head (#199, `docs/DESIGN.md` §9).
 *
 * A group's arms are sibling test names under the group's own name —
 * `statistics-deliveries_variantA` and `…_variantB` in `statistics-deliveries` — so the whole test
 * name is the group's half and the arm's half together, and the group's half is the address the
 * reader is already standing on. What the pane says is the arm's half alone.
 *
 * **A test name is the caller's own string and Rover never wrote it** (D22), which is the whole
 * reason this module is careful. `run-identity.ts` is allowed to decompose a run directory's name
 * because `src/daemon/archive-path.ts` wrote it; nothing wrote this one. So {@link variantOf} reads
 * as little of it as will answer the question and falls back to the caller's own word rather than
 * failing, and {@link variantPhrase} only ever re-spaces and re-cases what it was given — no word is
 * translated, expanded, abbreviated or dropped, and the raw string stays on the element's `title`
 * so the thing the caller actually typed is one hover away.
 *
 * No React and no host: two pure functions over strings, unit-tested on their own.
 */

/**
 * The arm a test name names, given the group it is in — `statistics-deliveries_variantA` in
 * `statistics-deliveries` is `variantA`.
 *
 * Three rules, in order, and each one is a smaller claim than the one before it:
 *
 * - **The group's own id comes off the front**, when the name starts with it and an underscore.
 *   That is not a naming convention being assumed — the group id is a string Rover already holds,
 *   so the match is a fact rather than a guess, and a group id with an underscore of its own comes
 *   off whole where reading to the first underscore would have left half of it behind.
 * - **Failing that, everything after the first underscore.** Never the last: that would make
 *   `checkout_variant_A` read `A`, and a variant may contain a separator of its own.
 * - **Failing that, the test name in full.** A name with no separator in it names no arm, and the
 *   honest answer is what the caller called it rather than an empty strip.
 *
 * Nothing is trimmed, lower-cased or normalised: whatever comes back is a slice of the caller's own
 * string or the whole of it.
 */
export function variantOf(testName: string, groupId: string): string {
	const prefix = `${groupId}_`;
	if (groupId !== '' && testName.startsWith(prefix)) {
		return testName.slice(prefix.length);
	}
	const first = testName.indexOf('_');
	return first < 0 ? testName : testName.slice(first + 1);
}

/**
 * Where one word ends and the next begins inside a single run of characters, as the three
 * transitions that mean a boundary — applied in this order, each inserting a space.
 *
 * | pattern | reads | `variantA` … | for |
 * | --- | --- | --- | --- |
 * | `([a-z0-9])([A-Z])` | small then capital | `variant A` | the camel case the convention is written in |
 * | `([A-Z]+)([A-Z][a-z])` | a run of capitals then a word | `HTTPServer` → `HTTP Server` | an initialism keeping its own shape |
 * | `([a-zA-Z])([0-9])`, `([0-9])([a-z])` | letter meets digit | `variant2` → `variant 2` | arms numbered rather than lettered |
 *
 * The second rule is what stops the first from cutting an initialism into single letters, and it
 * has to run after it: `HTTPServer` is left alone by *small then capital* and is exactly what
 * *capitals then a word* is for.
 */
const WORD_BOUNDARIES = [
	[/([a-z0-9])([A-Z])/g, '$1 $2'],
	[/([A-Z]+)([A-Z][a-z])/g, '$1 $2'],
	[/([a-zA-Z])([0-9])/g, '$1 $2'],
	[/([0-9])([a-z])/g, '$1 $2'],
] as const;

/** What already separates two words in the caller's own writing, however many of them are in a row. */
const SEPARATORS = /[\s_-]+/;

/**
 * The arm's name as a phrase a person reads — `variantA` is **`Variant A`**, `variant_b` is
 * **`Variant B`**, `login-flow` is **`Login Flow`**.
 *
 * **It re-spaces and re-cases, and it does nothing else.** Every word that goes in comes out, in
 * order, spelled the way the caller spelled it apart from its first character: no word is
 * translated, expanded from an abbreviation, abbreviated into one, reordered or dropped, and
 * nothing is appended — a variant called `A` reads `A` and does not become `Variant A`, because the
 * word *variant* would be this panel's and not the caller's. That is the same rule the rest of the
 * archive keeps for a caller's strings (D22); the difference here is that a pane head is a phrase a
 * person reads at a glance rather than an address, and `variantA` four times across a row is
 * harder to tell apart than `Variant A` is.
 *
 * **Only the first character of a word is touched, and it is only ever raised.** The rest is left
 * exactly as written, so `variantA` keeps its `A` and an arm the caller wrote as `VariantA` is
 * unchanged by the casing pass. `toUpperCase` and never `toLocaleUpperCase`: the answer must not
 * depend on the reader's locale, which is the rule this screen already keeps for sorting.
 *
 * A string with no word in it — empty, or nothing but separators — comes back **exactly as it went
 * in**. There is nothing to phrase, and inventing a placeholder would be the panel saying something
 * the archive did not.
 */
export function variantPhrase(variant: string): string {
	const spaced = WORD_BOUNDARIES.reduce(
		(text, [pattern, replacement]) => text.replace(pattern, replacement),
		variant,
	);
	const words = spaced.split(SEPARATORS).filter((word) => word !== '');
	if (words.length === 0) {
		return variant;
	}
	return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}
