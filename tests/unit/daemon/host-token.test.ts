import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createTokenGate } from '@/daemon/host-token.js';

/**
 * The gate accepts one string and holds none.
 *
 * The constant-time comparison itself is not asserted here — a timing assertion is the
 * flakiest test there is, and `crypto.timingSafeEqual` is the thing being relied on. What is
 * asserted is everything that would silently undo it: the gate answering on a prefix, on a
 * length difference, or holding the secret somewhere it can be printed from.
 */

const TOKEN = 'a-thirty-two-character-token-1234';

describe('the token gate', () => {
	it('accepts exactly the token it was built with', () => {
		expect(createTokenGate(TOKEN).accepts(TOKEN)).toBe(true);
	});

	it.each([
		['a prefix', TOKEN.slice(0, -1)],
		['a suffix', TOKEN.slice(1)],
		['one character changed', `${TOKEN.slice(0, -1)}5`],
		['the empty string', ''],
		['a differently-cased variant', TOKEN.toUpperCase()],
		['the token with trailing whitespace', `${TOKEN} `],
		['a much longer string starting with the token', `${TOKEN}${TOKEN}`],
	])('rejects %s', (_what, candidate) => {
		expect(createTokenGate(TOKEN).accepts(candidate)).toBe(false);
	});

	it('answers a candidate of a different length without throwing', () => {
		// `timingSafeEqual` throws on unequal lengths, which is why both sides are hashed
		// first. Without that, a length probe would be an exception instead of a `false` — and
		// an exception on the accept path is a crashed connection handler.
		expect(() => createTokenGate(TOKEN).accepts('x')).not.toThrow();
	});
});

describe('the gate holds a digest, not the secret (D20)', () => {
	it.each([
		['JSON.stringify', (value: unknown) => JSON.stringify(value)],
		['String', (value: unknown) => String(value)],
		['util.inspect', (value: unknown) => inspect(value, { depth: null })],
	])('leaks nothing of the token through %s', (_how, render) => {
		const gate = createTokenGate(TOKEN);

		// Not merely "does not equal the token": any substring of it would be a leak, and an
		// accidental dump of this object is the realistic way a secret reaches a log.
		expect(render(gate)).not.toContain(TOKEN);
		expect(render(gate)).not.toContain(TOKEN.slice(0, 8));
	});
});
