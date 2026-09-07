/**
 * The host's whole policy on `group_id` (D22, as amended #205), asserted where it lives.
 *
 * No socket, no disk and no clock: `resolveGroupId` is a pure function of the caller's string
 * plus `crypto`, which is what makes "the host mints it" testable as a rule rather than only
 * through a grant. `tests/unit/daemon/acquire-device.test.ts` covers the round trip end to end.
 *
 * The load-bearing properties are asserted rather than inferred from the implementation: a name
 * is minted and a minted id is taken **verbatim**, two mints of one name differ, the separator is
 * refused in a name, nothing is ever truncated, and a minted id survives `pathSegment`
 * unrewritten.
 */

import { describe, expect, it } from 'vitest';
import { pathSegment } from '@/daemon/archive-path.js';
import {
	GROUP_ID_SEPARATOR,
	isMintedGroupId,
	LONGEST_MINTABLE_NAME,
	MINTED_SUFFIX_LENGTH,
	mintGroupId,
	resolveGroupId,
} from '@/daemon/group-id.js';
import { ATTRIBUTION_MAX_LENGTH } from '@/ipc/methods.js';

const NAME = 'statistics-deliveries';

/** The `{ groupId }` half of the decision, or a failure naming what came back instead. */
function granted(name: string): string {
	const decided = resolveGroupId(name);
	if ('refusal' in decided) {
		throw new Error(`expected '${name}' to be filed, got ${decided.refusal.reason}`);
	}
	return decided.groupId;
}

/** The `{ refusal }` half, likewise. */
function refused(name: string) {
	const decided = resolveGroupId(name);
	if (!('refusal' in decided)) {
		throw new Error(`expected '${name}' to be refused, got '${decided.groupId}'`);
	}
	return decided.refusal;
}

describe('a name with no separator', () => {
	it('is minted: the name verbatim, the separator, and a suffix', () => {
		const filed = granted(NAME);

		expect(filed.startsWith(`${NAME}${GROUP_ID_SEPARATOR}`)).toBe(true);
		expect(filed).toHaveLength(NAME.length + 1 + MINTED_SUFFIX_LENGTH);
		// The name half is byte-identical to what was sent: the host adds, and never rewrites.
		expect(filed.slice(0, NAME.length)).toBe(NAME);
		expect(filed.slice(-MINTED_SUFFIX_LENGTH)).toMatch(/^[0-9a-z]{7}$/);
	});

	/*
	 * Uniqueness comes from the minted bytes and from nothing else — no lookup, no index, no read
	 * of the archive (D6) — so it is worth asserting over enough draws that a degenerate generator
	 * could not pass. The guaranteed digit is asserted here too rather than assumed: it is what
	 * `isMintedGroupId` tells an already-minted id from a dotted name by.
	 */
	it('mints a different id every time, and every suffix carries a digit', () => {
		const minted = new Set<string>();
		for (let i = 0; i < 500; i += 1) {
			const filed = mintGroupId(NAME);
			expect(filed.slice(-MINTED_SUFFIX_LENGTH)).toMatch(/[0-9]/);
			minted.add(filed);
		}

		expect(minted.size).toBe(500);
	});

	it('is what two callers who typed one name each get — two groups, not one', () => {
		expect(granted(NAME)).not.toBe(granted(NAME));
	});
});

describe('an id the host minted', () => {
	it('is taken verbatim, with no second mint appended', () => {
		const filed = mintGroupId(NAME);

		expect(granted(filed)).toBe(filed);
	});

	it('is recognised by shape alone', () => {
		expect(isMintedGroupId(mintGroupId(NAME))).toBe(true);
		expect(isMintedGroupId(`${NAME}${GROUP_ID_SEPARATOR}h57ssn4`)).toBe(true);
		// The issue's own example, so the shape check cannot drift away from what it specified.
		expect(isMintedGroupId('statistics-deliveries.h57ssn4')).toBe(true);
	});

	it('is not read out of a name that merely has a dot in it', () => {
		// An all-letters tail is the case the guaranteed digit exists for: without it,
		// `stats.summary` would be taken verbatim and the collision would be back.
		expect(isMintedGroupId('stats.summary')).toBe(false);
		expect(isMintedGroupId('com.example.app')).toBe(false);
		// Two separators, a wrong-length tail, an uppercase tail, and an empty name half.
		expect(isMintedGroupId(`${NAME}.h57ssn4.h57ssn4`)).toBe(false);
		expect(isMintedGroupId(`${NAME}.h57ss`)).toBe(false);
		expect(isMintedGroupId(`${NAME}.H57SSN4`)).toBe(false);
		expect(isMintedGroupId('.h57ssn4')).toBe(false);
	});
});

describe('a name containing the reserved separator', () => {
	it.each([
		'a.b',
		'com.example.app',
		'stats.summary',
		`${NAME}.`,
		`.${NAME}`,
	])('is refused rather than rewritten or joined: %s', (name) => {
		const refusal = refused(name);

		expect(refusal.reason).toBe('separator-in-group-id');
		// Named in the host's own sentence, so an agent can fix the call without the docs.
		expect(refusal.message).toContain("'groupId'");
		expect(refusal.message).toContain('the separator is how a run joins an existing group');
		expect(refusal.message).toContain('a name may not contain');
	});

	it('quotes the value back, which is what the length bound exists for', () => {
		expect(refused('a.b').message).toContain("'a.b'");
	});
});

describe('a name too long to mint an id from', () => {
	it(`mints at ${LONGEST_MINTABLE_NAME} characters, and exactly fills the bound`, () => {
		const filed = granted('n'.repeat(LONGEST_MINTABLE_NAME));

		expect(filed).toHaveLength(ATTRIBUTION_MAX_LENGTH);
	});

	it('is refused by name one character past that, and nothing is truncated', () => {
		const name = 'n'.repeat(LONGEST_MINTABLE_NAME + 1);
		const decided = resolveGroupId(name);

		expect('groupId' in decided).toBe(false);
		if (!('refusal' in decided)) {
			throw new Error('expected a refusal');
		}
		expect(decided.refusal.reason).toBe('group-id-too-long');
		expect(decided.refusal.message).toContain("'groupId'");
		expect(decided.refusal.message).toContain(String(LONGEST_MINTABLE_NAME));
		// A shortened name would be a *different* group, so the sentence says so rather than
		// leaving a caller to discover it from the archive.
		expect(decided.refusal.message).toContain('truncated');
		// It does not echo the value: 249 characters of it says nothing the length did not.
		expect(decided.refusal.message).not.toContain(name);
	});
});

/*
 * A group id is **not** a path component today — it is filed as the contents of
 * `group_id.json` (PROJECT.md §10) — so this is a property kept deliberately rather than one the
 * archive currently depends on: `.` is inside `pathSegment`'s `[A-Za-z0-9._-]` set, so a minted
 * id can never pick up the collision hash on the way anywhere, where `~`, `+` or `:` each would.
 * The short name is `pathSegment`'s own truncation caveat (`MAX_SEGMENT_LENGTH`) and says nothing
 * about the mint.
 */
describe('a minted id and pathSegment', () => {
	it('survives unrewritten, so nothing about it can pick up the collision hash', () => {
		const filed = mintGroupId('app-bar-top-space');

		expect(pathSegment(filed)).toBe(filed);
	});
});
