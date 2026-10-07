/**
 * What every tool declaration on this server says about itself beyond its own subject — one
 * sentence about how its arguments are spelled, and two more on the rows they apply to.
 *
 * **The tool names are `snake_case` and the arguments are `camelCase`, and that stays** (D26).
 * The `IPC_METHODS` params schema *is* the declaration (ai/CODING_STANDARDS.md, boundary #1):
 * it is the object the host parses the request with, and the field names in it are the names
 * the host's own refusals use — `Required at leaseId`. Renaming them on this surface alone
 * would put a translation in a client that owns translation only
 * (ai/ARCHITECTURE.md), and it would give one field two spellings: the one an agent sends and
 * the one every answer, every CLI `--json` document and every Zod message names it by. That is
 * the second vocabulary D10 refuses for verbs, arriving one layer down.
 *
 * What the casing mismatch actually costs is a first call written from the tool *name* rather
 * than from the schema, and the fix for that is legibility **before** the call — the same move
 * the verb descriptions make for capabilities (D11), rather than a rename after it. So the note
 * below rides on every tool, and `tests/unit/mcp/declarations.test.ts` holds that it does: an
 * agent that reads one tool's declaration has been told, and one that reads only the schema
 * sees the spelling in the properties either way.
 *
 * The same function carries a second note, on the tools that take `after` only — what the
 * compact after-state leaves out and how to ask for the rest — and a third, on the tools that
 * take `leaseId` only — that any call renews the lease and every verb answer says how long it has
 * left (#335). Both for the same reason: they are said where the declaration is built, so no row
 * can forget them.
 *
 * {@link declaring} is what makes "every tool" structural rather than remembered — the three
 * registrars hand their declaration through it, so a tool added later cannot land without the
 * note by forgetting a string.
 */

import { ZodObject } from 'zod';

/**
 * The one sentence appended to every tool's description.
 *
 * Short on purpose: it repeats on all twenty-six rows, so it names the rule, one example and
 * the reason, and leaves the argument for it to D26.
 */
export const ARGUMENT_CASING_NOTE =
	'Arguments are camelCase — `leaseId`, never `lease_id` — even though the tool names are ' +
	'snake_case: the input schema here is the host’s own, so what it spells is what the host ' +
	'parses and what a refusal names. Copy the property names from the schema rather than from ' +
	'the tool name.';

/**
 * The sentence appended to every tool whose input schema declares `after` — every action verb,
 * which answers a compact after-state unless asked otherwise (#330, `src/verbs/result.ts`).
 *
 * Keyed on the schema rather than on a list of tool names, so it cannot drift from the wire:
 * a row that takes `after` says what it does, and `read_screen`, which does not, says nothing.
 */
export const COMPACT_AFTER_NOTE =
	'The answer’s after-state is compact: `after.elements` lists only the elements that carry ' +
	'text, a label, an identifier, or a clickable, checkable or focused state, and ' +
	'`after.omitted` counts the textless containers left out — an empty list with a non-zero ' +
	'`omitted` is not a blank screen. Pass `after: "full"` for every node, or call ' +
	'`read_screen`, which always answers the whole tree.';

/**
 * The sentence appended to every tool whose input schema declares `leaseId` — every verb tool,
 * plus `release_device` (#335).
 *
 * Keyed on the schema rather than on a list of tool names, for {@link COMPACT_AFTER_NOTE}'s
 * reason: it cannot drift from the wire. It says what is true of every *verb* answer, which is
 * why it is also harmless on `release_device` — the one other row that carries a lease id, and
 * the row whose reader most needs to know that nothing else was keeping the lease alive for them.
 */
export const LEASE_EXPIRY_NOTE =
	'Any call you make on a lease renews it — there is no heartbeat to send and no renew tool to ' +
	'call — and every verb answer carries `expiresInMs`: how long the lease has left once this ' +
	'call has renewed it, measured on the host. Read it rather than assuming: an expiry you can ' +
	'see coming is one call away from being pushed out, while one you walk into is a `no-lease` ' +
	'refusal on a device the host has already restored and may have handed on.';

/** Whether a declared input schema carries the `after` option. */
function declaresAfter(schema: unknown): boolean {
	return schema instanceof ZodObject && 'after' in schema.shape;
}

/** Whether a declared input schema carries the lease id. */
function declaresLeaseId(schema: unknown): boolean {
	return schema instanceof ZodObject && 'leaseId' in schema.shape;
}

/** A tool declaration, whatever schema type it carries. Generic so the SDK still infers it. */
interface ToolDeclaration<Schema> {
	readonly title: string;
	readonly description: string;
	readonly inputSchema: Schema;
}

/**
 * One declaration, with {@link ARGUMENT_CASING_NOTE} on the end of its description — and,
 * before it, {@link COMPACT_AFTER_NOTE} when the schema takes `after` and
 * {@link LEASE_EXPIRY_NOTE} when it takes `leaseId`, in that order.
 *
 * Generic in the schema and nothing else, so `registerTool` infers the handler's argument type
 * from `inputSchema` exactly as it does when the object is written inline.
 */
export function declaring<Schema>(declaration: ToolDeclaration<Schema>): ToolDeclaration<Schema> {
	const notes = [
		...(declaresAfter(declaration.inputSchema) ? [COMPACT_AFTER_NOTE] : []),
		...(declaresLeaseId(declaration.inputSchema) ? [LEASE_EXPIRY_NOTE] : []),
		ARGUMENT_CASING_NOTE,
	];
	return { ...declaration, description: `${declaration.description} ${notes.join(' ')}` };
}
