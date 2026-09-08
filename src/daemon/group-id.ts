/**
 * How a caller's investigation name becomes the `group_id` the host actually files (D22, as
 * amended #205).
 *
 * **The agent names the investigation; the host decides the id.** A name an agent typed comes
 * from what it is looking at rather than from any source of uniqueness, so the same words come
 * up again the next time somebody opens the same screen — and because a group is keyed
 * `(project, groupId)` (`./list-archive-groups.ts`), two unrelated investigations that both
 * picked `statistics-deliveries` in one project were one group. That is not a corner case; it
 * is what the field did by default over time. So the host appends a separator and a short
 * high-entropy suffix, and hands back what it filed; the caller passes **that** on every
 * further lease of the same comparison, which is how the second, third and seventh run join it.
 *
 * **Uniqueness comes from the bytes, never from a lookup.** Nothing here reads the archive,
 * checks another lease, or holds an index — the daemon still holds nothing it cannot re-derive
 * (D6). Every function in this module is pure but for `crypto`: no disk, no clock, no state, in
 * `./archive-path.ts`'s spirit, so the whole rule set is testable without a socket.
 *
 * **The separator is `.`, and the reason is `pathSegment`.** `.` is inside the
 * `[A-Za-z0-9._-]` set that survives a path component unrewritten (`./archive-path.ts`), so a
 * minted id can never pick up the collision hash on the way anywhere, where `~`, `+` or `:`
 * would each become `_` and would. A minted id never *leads* with one, because the name half is
 * required to be non-empty and `pathSegment` strips a leading `.` run.
 *
 * **What D22 keeps.** The host looks at the string's *shape* and never at what it says: nothing
 * here reads meaning out of a name, derives one from who authenticated or from any context
 * (D20, ai/RULES.md §1), or compares one against another lease's. Every other attribution
 * string — `owner`, `project`, `test_name`, `test_description` — is untouched and stays exactly
 * as opaque as it was, and `test_name` stays deliberately **not** unique, which is what still
 * puts the arms of one comparison side by side (D24).
 *
 * **A lease id is deliberately not reused as the suffix.** That one is the credential that ends
 * a lease (D20, `src/core/ids.ts`), and a group id is echoed into listings, refusals and
 * `group_id.json`; minting fresh bytes here is what keeps a credential out of all of them.
 */

import { randomInt } from 'node:crypto';
import { type AcquireRefusalReason, ATTRIBUTION_MAX_LENGTH } from '../ipc/methods.js';

/**
 * The one character that separates the caller's name from the host's suffix — reserved, so a
 * name containing one is refused rather than read as an id the host already minted.
 */
export const GROUP_ID_SEPARATOR = '.';

/**
 * How many characters the host adds after the separator.
 *
 * Seven lowercase base36 characters is ~36 bits, so a collision is not something anybody meets,
 * and `statistics-deliveries.h57ssn4` still reads as a name rather than as a hash.
 */
export const MINTED_SUFFIX_LENGTH = 7;

/**
 * The longest name the host can still mint an id for inside {@link ATTRIBUTION_MAX_LENGTH} —
 * 248. A longer one is refused **by name** rather than truncated, because a shortened name is a
 * different group.
 */
export const LONGEST_MINTABLE_NAME =
	ATTRIBUTION_MAX_LENGTH - GROUP_ID_SEPARATOR.length - MINTED_SUFFIX_LENGTH;

/**
 * `<name>.<suffix>` — exactly one separator, and the name half may not contain one.
 *
 * **Built from the two constants above rather than spelled out**, because this is the one place the
 * shape is actually decided: a literal here would let {@link MINTED_SUFFIX_LENGTH} be changed to 8
 * and leave {@link mintGroupId} emitting ids {@link isMintedGroupId} rejects, so every second lease
 * of every investigation would come back `separator-in-group-id`. The separator is escaped because
 * it is a regex metacharacter as written.
 */
const MINTED_GROUP_ID = new RegExp(
	`^[^${GROUP_ID_SEPARATOR}]+\\${GROUP_ID_SEPARATOR}[0-9a-z]{${MINTED_SUFFIX_LENGTH}}$`,
);

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

/**
 * Either the id to file, or the refusal to answer with — and never both, so no path can return
 * a rewritten value beside a complaint about it.
 *
 * A refusal rather than an `invalid_params`: an agent handed "the host broke" or a Zod complaint
 * learns nothing it can act on, and this is the same class of answer as `label-without-group`
 * (`src/ipc/verb-methods.ts`).
 */
export type GroupIdDecision =
	| { readonly groupId: string }
	| { readonly refusal: { readonly reason: AcquireRefusalReason; readonly message: string } };

/**
 * Whether this string has the shape of an id **this host mints** — checked by shape alone,
 * because looking it up anywhere is the thing this design does not do.
 *
 * **The guaranteed digit is why this is not just the regex.** With a plain `[0-9a-z]{7}` tail,
 * `statistics.summary` and `checkout.compare` would read as already-minted and be taken
 * verbatim — which restores the exact collision this exists to remove, in the field an agent is
 * most likely to write. Requiring at least one digit in the suffix makes every all-letters tail
 * a refusal instead, so *"a name may not contain the separator"* is true of every name anybody
 * would plausibly type. The issue's own example, `h57ssn4`, is unaffected.
 *
 * Never throws and never awaits.
 */
export function isMintedGroupId(value: string): boolean {
	if (!MINTED_GROUP_ID.test(value)) {
		return false;
	}
	return /[0-9]/.test(value.slice(-MINTED_SUFFIX_LENGTH));
}

/**
 * Append the separator and a fresh suffix. Assumes the name is mintable — {@link resolveGroupId}
 * is the caller that has decided that.
 */
export function mintGroupId(name: string): string {
	return `${name}${GROUP_ID_SEPARATOR}${mintedSuffix()}`;
}

/**
 * `randomInt` rather than `randomBytes` — `randomBytes(n) % 36` is biased towards the low
 * characters of the alphabet, which is a smaller keyspace than the one this claims.
 *
 * One randomly chosen position is then overwritten with a base10 digit, which buys
 * {@link isMintedGroupId}'s shape guarantee in bounded work: no rejection loop, and the draw
 * stays synchronous so it can sit above every `await` in the acquire handler.
 */
function mintedSuffix(): string {
	const drawn = Array.from(
		{ length: MINTED_SUFFIX_LENGTH },
		() => BASE36[randomInt(BASE36.length)],
	);
	drawn[randomInt(MINTED_SUFFIX_LENGTH)] = DIGITS[randomInt(DIGITS.length)];
	return drawn.join('');
}

/**
 * Mint it, take it verbatim, or refuse it — the whole of the host's policy on this field.
 *
 * **Verbatim is checked first, and the order is load-bearing**: a minted id contains the
 * separator, so testing for the separator first would refuse every second lease of every
 * investigation.
 */
export function resolveGroupId(name: string): GroupIdDecision {
	if (isMintedGroupId(name)) {
		// An id this host minted, handed back to join the group it names. Nothing is checked
		// against another lease and nothing is minted a second time.
		return { groupId: name };
	}
	if (name.includes(GROUP_ID_SEPARATOR)) {
		return {
			refusal: {
				reason: 'separator-in-group-id',
				message:
					`The 'groupId' '${name}' contains '${GROUP_ID_SEPARATOR}', which is reserved: ` +
					`the separator is how a run joins an existing group, so a name may not contain ` +
					`one. Nothing was granted, nothing was rewritten and no group was created. Send ` +
					`'groupId' as a name with no '${GROUP_ID_SEPARATOR}' in it — the host appends the ` +
					`separator and a short suffix of its own and answers with the id it filed — then ` +
					`pass that exact id on every further lease in the same comparison.`,
			},
		};
	}
	if (name.length > LONGEST_MINTABLE_NAME) {
		return {
			refusal: {
				reason: 'group-id-too-long',
				message:
					`The 'groupId' is ${name.length} characters, and the host appends ` +
					`'${GROUP_ID_SEPARATOR}' and ${MINTED_SUFFIX_LENGTH} more to mint the id it ` +
					`files, so a name past ${LONGEST_MINTABLE_NAME} characters cannot be minted ` +
					`within this surface's ${ATTRIBUTION_MAX_LENGTH}-character limit. Nothing is ` +
					`truncated, because a shortened name would be a different group: send a shorter ` +
					`name.`,
			},
		};
	}
	return { groupId: mintGroupId(name) };
}
