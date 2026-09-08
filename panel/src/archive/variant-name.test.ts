import { describe, expect, it } from 'vitest';
import { variantOf, variantPhrase } from './variant-name.js';

/**
 * A group id in the shape the host actually files since #205 — the investigation's name, the
 * reserved separator and the minted suffix. Every case below runs against this rather than against
 * a bare name, because a bare name is no longer what `list_archive_groups` answers with for a group
 * filed today.
 */
const GROUP = 'statistics-deliveries.h57ssn4';

/** The same investigation as it was filed before #205, which no archive rewrote. */
const UNMINTED_GROUP = 'statistics-deliveries';

/**
 * **What is read out of a test name, and it is as little as will answer the question.** A test name
 * is the caller's own string and Rover never wrote it (D22), so every rule here either matches
 * something Rover holds — the group id — or falls back to the caller's own word.
 */
describe('the arm a test name names', () => {
	/*
	 * The common case: the arms of one group are sibling test names under the investigation's own
	 * name, and the id the host filed carries a suffix the caller never typed into a test name — so
	 * it is the id's **name half** that comes off the front (#205).
	 */
	it('is the test name with the group’s own name taken off the front', () => {
		expect(variantOf(`${UNMINTED_GROUP}_variantA`, GROUP)).toBe('variantA');
		expect(variantOf(`${UNMINTED_GROUP}_variantB`, GROUP)).toBe('variantB');
	});

	/*
	 * **An archive written before #205 is not rewritten**, so its group ids carry no suffix and the
	 * whole id is still what comes off the front. That is why the whole id is tried first.
	 */
	it('takes off the whole id of a group filed before the host minted them', () => {
		expect(variantOf(`${UNMINTED_GROUP}_variantA`, UNMINTED_GROUP)).toBe('variantA');
	});

	/*
	 * The prefix match is on the **group id**, which is a string Rover holds — so a group id with an
	 * underscore in it comes off whole, where reading to the first underscore would have left half
	 * of it on the front of every arm.
	 */
	it('takes off a group id that has an underscore of its own', () => {
		expect(variantOf('stats_deliveries_variantA', 'stats_deliveries.h57ssn4')).toBe('variantA');
		expect(variantOf('stats_deliveries_variantA', 'stats_deliveries')).toBe('variantA');
	});

	/*
	 * **The first underscore, never the last** — a name that does not start with the group id still
	 * has the convention's shape, and a variant may contain a separator of its own.
	 */
	it('falls back to everything after the first underscore', () => {
		expect(variantOf('checkout_variant_A', GROUP)).toBe('variant_A');
		expect(variantOf('checkout_variantB', GROUP)).toBe('variantB');
	});

	// A name with no separator names no arm, so the honest answer is what the caller called it.
	it('is the test name in full when there is no separator in it', () => {
		expect(variantOf('login-flow', GROUP)).toBe('login-flow');
		expect(variantOf('basket', GROUP)).toBe('basket');
	});

	// Nothing normalises it: what comes back is a slice of the caller's own string (D22).
	it('keeps the arm exactly as the caller named it', () => {
		expect(variantOf(`${UNMINTED_GROUP}_ Variant A `, GROUP)).toBe(' Variant A ');
		expect(variantOf(`${UNMINTED_GROUP}_VARIANT_a`, GROUP)).toBe('VARIANT_a');
	});

	// A group id of nothing matches nothing, rather than matching the front of every name.
	it('does not take an empty group id off anything', () => {
		expect(variantOf('variantA', '')).toBe('variantA');
	});
});

/**
 * **How the arm is said out loud, and it re-spaces and re-cases and does nothing else.** Every word
 * that goes in comes out, in order, spelled as the caller spelled it apart from its first
 * character — which is what keeps a phrase a re-rendering of the caller's string rather than a
 * replacement for it (D22). The raw string is on the head's `title` either way.
 */
describe('the arm as a phrase', () => {
	// The convention, and the case the pane head exists for.
	it('reads camel case as words, each one capitalised', () => {
		expect(variantPhrase('variantA')).toBe('Variant A');
		expect(variantPhrase('variantB')).toBe('Variant B');
		expect(variantPhrase('variantC')).toBe('Variant C');
	});

	// A caller's own separators are word breaks already, however many are in a row.
	it('reads underscores, hyphens and spaces as word breaks', () => {
		expect(variantPhrase('variant_a')).toBe('Variant A');
		expect(variantPhrase('variant-b')).toBe('Variant B');
		expect(variantPhrase('variant  c')).toBe('Variant C');
		expect(variantPhrase('variant__d')).toBe('Variant D');
		expect(variantPhrase(' variant e ')).toBe('Variant E');
	});

	it('reads an arm numbered rather than lettered', () => {
		expect(variantPhrase('variant2')).toBe('Variant 2');
		expect(variantPhrase('2ndVariant')).toBe('2 Nd Variant');
	});

	// An initialism keeps its own shape rather than being cut into single letters.
	it('keeps a run of capitals together', () => {
		expect(variantPhrase('HTTPServer')).toBe('HTTP Server');
		expect(variantPhrase('variantAB')).toBe('Variant AB');
	});

	/*
	 * **Only the first character of a word is touched, and only ever raised.** The rest is left as
	 * written, so an arm the caller shouted stays shouted and one already capitalised is unchanged.
	 */
	it('raises the first character and leaves the rest as written', () => {
		expect(variantPhrase('VariantA')).toBe('Variant A');
		expect(variantPhrase('VARIANT')).toBe('VARIANT');
	});

	/*
	 * **The one shape the boundary rules read differently from a person**, asserted so that it is a
	 * known answer rather than a surprise: a lowercase letter in front of a run of capitals is a
	 * word break by *small then capital*, so `iOS` reads `I OS`. Left as it is — a rule that made an
	 * exception of it would have to guess which single leading letters are part of the next word,
	 * and the raw string is on the head's `title` for the reader either way.
	 */
	it('cuts a lowercase letter off the front of a run of capitals', () => {
		expect(variantPhrase('iOS')).toBe('I OS');
	});

	/*
	 * **Nothing is appended.** A variant called `A` reads `A`: the word *variant* would be this
	 * panel's and not the caller's, and inventing it is exactly what D22 forbids.
	 */
	it('adds no word the caller did not write', () => {
		expect(variantPhrase('A')).toBe('A');
		expect(variantPhrase('control')).toBe('Control');
	});

	// The fallback arm — a test name with no separator — is a phrase like any other.
	it('phrases a whole test name that named no arm', () => {
		expect(variantPhrase('login-flow')).toBe('Login Flow');
	});

	// Nothing to phrase, so nothing is invented in its place.
	it('gives back a string with no word in it exactly as it came', () => {
		expect(variantPhrase('')).toBe('');
		expect(variantPhrase('__')).toBe('__');
	});
});
