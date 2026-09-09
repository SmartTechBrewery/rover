import { describe, expect, it } from 'vitest';
import type { ArchiveSize } from './archive-size.js';
import { formatBytes } from './file-size.js';
import { type SizeScope, sizeSentence } from './size-sentence.js';

/** 7.7 MB, which is the figure the issue's own example badge carries. */
const BYTES = 8_074_035;

const MEASURED: ArchiveSize = { status: 'measured', bytes: BYTES, truncated: false };
const TRUNCATED: ArchiveSize = { status: 'measured', bytes: BYTES, truncated: true };

const SCOPES = [
	'archive',
	'project',
	'test',
	'run',
	'directory',
	'file',
	'grouped',
	'grouped-project',
	'group',
] as const satisfies readonly SizeScope[];

/** The three the groups view's own depths name (#262) — a subset of the archive in every case. */
const GROUPED_SCOPES = [
	'grouped',
	'grouped-project',
	'group',
] as const satisfies readonly SizeScope[];

describe('the badge’s sentence', () => {
	// One case per scope, because the subject and the verb are the whole of what a scope decides —
	// and the root is the one plural, which is why the verb is in the table beside the subject.
	it('names its own scope, in full and capitalised', () => {
		expect(sizeSentence('archive', MEASURED)).toBe('All tests take 7.7 MB on disk');
		expect(sizeSentence('project', MEASURED)).toBe('This project takes 7.7 MB on disk');
		expect(sizeSentence('test', MEASURED)).toBe('This test takes 7.7 MB on disk');
		expect(sizeSentence('run', MEASURED)).toBe('This run takes 7.7 MB on disk');
		expect(sizeSentence('directory', MEASURED)).toBe('This directory takes 7.7 MB on disk');
		expect(sizeSentence('file', MEASURED)).toBe('This file takes 7.7 MB on disk');
	});

	// The groups view's own three, whose subjects are plural for the reason the root's is — and
	// whose two shallow wordings are decided in #262 rather than specified.
	it('names the grouped scopes without ever saying `all`', () => {
		expect(sizeSentence('grouped', MEASURED)).toBe('Grouped tests take 7.7 MB on disk');
		expect(sizeSentence('grouped-project', MEASURED)).toBe(
			'Grouped tests in this project take 7.7 MB on disk',
		);
		expect(sizeSentence('group', MEASURED)).toBe('Tests in this group take 7.7 MB on disk');
	});

	/*
	 * **The gate this phase turns on**: the groups view lists only the runs that named a
	 * `group_id`, so every one of its scopes describes a **subset** of the archive — and a subset
	 * described with the word *all* is the one thing this badge must not do. Asserted over every
	 * state, because the *could not measure* sentence is a second place the word could get in.
	 */
	it('never says `all` for a grouped scope, in any state', () => {
		const states: readonly ArchiveSize[] = [MEASURED, TRUNCATED, { status: 'unmeasurable' }];

		for (const scope of GROUPED_SCOPES) {
			for (const state of states) {
				expect(sizeSentence(scope, state) ?? '').not.toMatch(/\ball\b/i);
			}
		}
		// And the `All` view's root scope still does say it, so the gate is about the subset and not
		// about the word.
		expect(sizeSentence('archive', MEASURED)).toContain('All tests');
	});

	/*
	 * A bounded walk renders a **lower bound** and never a plain figure: `truncated` means at least
	 * one directory that exists was not fully examined, so the number is short and the sentence has
	 * to say so.
	 */
	it('renders a truncated answer as an explicit lower bound, in every scope', () => {
		for (const scope of SCOPES) {
			const sentence = sizeSentence(scope, TRUNCATED) ?? '';
			expect(sentence).toContain('at least 7.7 MB on disk');
			expect(sentence).not.toBe(sizeSentence(scope, MEASURED));
		}
	});

	// The one thing the `unmeasurable` sentence must be is a sentence — the word `unknown` dropped
	// into a value slot is what `file-size.ts`'s `UNKNOWN` is for, and this badge has no slot.
	it('says an unmeasurable size as a sentence of its own, never as `unknown`', () => {
		expect(sizeSentence('test', { status: 'unmeasurable' })).toBe(
			'The host could not measure what this test takes on disk',
		);
		expect(sizeSentence('archive', { status: 'unmeasurable' })).toBe(
			'The host could not measure what all tests take on disk',
		);
		expect(sizeSentence('grouped', { status: 'unmeasurable' })).toBe(
			'The host could not measure what grouped tests take on disk',
		);
		expect(sizeSentence('group', { status: 'unmeasurable' })).toBe(
			'The host could not measure what tests in this group take on disk',
		);
		for (const scope of SCOPES) {
			expect(sizeSentence(scope, { status: 'unmeasurable' })).not.toContain('unknown');
		}
	});

	// Absent, not `0 B`: the count badge's own rule over the other kind of number. `0 B` is a true
	// claim about an empty directory, and *there is nothing at this address* is not that claim.
	it('draws no badge at all while the answer is out and where there is nothing to measure', () => {
		for (const scope of SCOPES) {
			expect(sizeSentence(scope, { status: 'loading' })).toBeNull();
			expect(sizeSentence(scope, { status: 'absent' })).toBeNull();
		}
	});

	// `0 B` is drawn, and is a measurement: a readable directory holding nothing is a fact the host
	// answered, unlike the two states above.
	it('says `0 B` for a scope the host measured as empty', () => {
		expect(sizeSentence('test', { status: 'measured', bytes: 0, truncated: false })).toBe(
			'This test takes 0 B on disk',
		);
	});

	/*
	 * **The decimal separator is a dot on every machine** (#223). `formatBytes` is the only
	 * formatter here and nothing calls `toLocaleString`, so the figure is asserted against that
	 * function's own output rather than against a literal a locale could move — a machine whose
	 * separator is a comma would render `7,7` out of anything that followed the viewer.
	 */
	it('renders the figure through `formatBytes` alone', () => {
		expect(formatBytes(BYTES)).toBe('7.7 MB');
		for (const scope of SCOPES) {
			expect(sizeSentence(scope, MEASURED)).toContain(formatBytes(BYTES));
			expect(sizeSentence(scope, MEASURED)).not.toContain('7,7');
		}
	});

	// Every scope × every answer state, so the matrix `docs/DESIGN.md` §9 carries has no row that is
	// only claimed — a sentence, or nothing, and never the empty string.
	it('answers for every scope in every state', () => {
		const states: readonly ArchiveSize[] = [
			MEASURED,
			TRUNCATED,
			{ status: 'unmeasurable' },
			{ status: 'loading' },
			{ status: 'absent' },
		];

		for (const scope of SCOPES) {
			for (const state of states) {
				const sentence = sizeSentence(scope, state);
				expect(sentence === null || sentence.length > 0).toBe(true);
			}
		}
	});
});
