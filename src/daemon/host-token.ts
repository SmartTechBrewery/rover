/**
 * The host token gate — the one place a token is compared, and the only thing standing
 * between a network caller and the message surface (D20).
 *
 * Two properties are the whole point of the module, and both are easy to lose by writing the
 * obvious thing instead:
 *
 * - **The gate holds a digest, never the secret.** Nothing on the returned object can be
 *   stringified back into the token, so an accidental `JSON.stringify(gate)`, a template
 *   literal in an error path or a debugger dump cannot leak it. D20 is "never let a token
 *   reach a log or a report", and the reliable way to keep that promise is to have nothing
 *   left to log.
 * - **The comparison is constant-time.** A `===` on a secret a stranger can retry over the
 *   network is a timing oracle: it returns on the first differing byte, so an attacker who
 *   can measure the difference recovers the token one character at a time. Hashing both sides
 *   first is what makes `timingSafeEqual` usable at all here — it throws on unequal lengths,
 *   which would itself leak the token's length, and digests are always 32 bytes.
 *
 * The token authenticates and grants nothing beyond reaching the surface. A lease's owner is
 * a separate, caller-supplied string and is never derived from whoever authenticated (D20).
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export interface TokenGate {
	/** Whether `candidate` is the token this gate was built with. */
	accepts(candidate: string): boolean;
}

export function createTokenGate(token: string): TokenGate {
	// The only reference this module keeps. `token` itself goes out of scope with this call.
	const expected = digestOf(token);

	return {
		accepts(candidate: string): boolean {
			return timingSafeEqual(expected, digestOf(candidate));
		},
	};
}

function digestOf(value: string): Buffer {
	return createHash('sha256').update(value, 'utf8').digest();
}
