/**
 * What every tool declaration on this server says about itself beyond its own subject — today,
 * one sentence about how its arguments are spelled.
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
 * {@link declaring} is what makes "every tool" structural rather than remembered — the three
 * registrars hand their declaration through it, so a tool added later cannot land without the
 * note by forgetting a string.
 */

/**
 * The one sentence appended to every tool's description.
 *
 * Short on purpose: it repeats on all twenty-three rows, so it names the rule, one example and
 * the reason, and leaves the argument for it to D26.
 */
export const ARGUMENT_CASING_NOTE =
	'Arguments are camelCase — `leaseId`, never `lease_id` — even though the tool names are ' +
	'snake_case: the input schema here is the host’s own, so what it spells is what the host ' +
	'parses and what a refusal names. Copy the property names from the schema rather than from ' +
	'the tool name.';

/** A tool declaration, whatever schema type it carries. Generic so the SDK still infers it. */
interface ToolDeclaration<Schema> {
	readonly title: string;
	readonly description: string;
	readonly inputSchema: Schema;
}

/**
 * One declaration, with {@link ARGUMENT_CASING_NOTE} on the end of its description.
 *
 * Generic in the schema and nothing else, so `registerTool` infers the handler's argument type
 * from `inputSchema` exactly as it does when the object is written inline.
 */
export function declaring<Schema>(declaration: ToolDeclaration<Schema>): ToolDeclaration<Schema> {
	return { ...declaration, description: `${declaration.description} ${ARGUMENT_CASING_NOTE}` };
}
