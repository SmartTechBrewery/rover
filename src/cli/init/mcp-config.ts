/**
 * The `.mcp.json` half of `rover init`: the server entry an agent's MCP client reads, merged
 * into whatever the project already had.
 *
 * **Merged, never written over.** A project's MCP configuration is the project's, not Rover's:
 * it may name three other servers, and a command that replaced the file would take them away
 * to add one. So this parses what is there, changes the `rover` key alone and leaves every
 * other key — inside the file and inside our own entry's `env` — exactly as it found it. A file
 * that will not parse is a **loud failure that writes nothing**, for the same reason
 * `readProjectHooks` refuses to treat an unparseable hook file as "no hooks": the quiet version
 * of this is somebody's configuration replaced by ours.
 *
 * **No credential is ever written here.** A `.mcp.json` is committed in most projects, and
 * `ROVER_HOST_TOKEN` is what authenticates a client to a remote host (D20) — so init writes the
 * project file path and nothing else, and tells the operator to put the host variables in their
 * own environment. `ai/RULES.md` §4's "no secrets, ever" is about skills; the reason is the
 * same and it applies to anything this repository generates into somebody's checkout.
 *
 * A pure function over text, so the command owns every read and write and a test needs no
 * filesystem to pin the merge.
 */

/** The file an MCP client reads out of a project's own directory. */
export const MCP_CONFIG_FILE = '.mcp.json';

/**
 * The key our entry lives under.
 *
 * A literal rather than `ROVER_MCP_NAME`, which is the same string in `src/mcp/server.ts`:
 * importing it would pull the MCP SDK into the CLI's module graph for one word.
 * `tests/unit/cli/init.test.ts` asserts the two agree, which is the part that actually
 * matters — an agent calls the tools by this name.
 */
export const MCP_SERVER_KEY = 'rover';

/** One MCP server as a client's configuration file spells it. */
export interface McpServerEntry {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

/** What writing produced: three outcomes, because "nothing to do" is worth reporting as such. */
export type WriteOutcome = 'created' | 'updated' | 'unchanged';

export interface MergedConfig {
	readonly text: string;
	readonly outcome: WriteOutcome;
}

/**
 * The entry that starts Rover's MCP server for this project.
 *
 * `node` on one absolute path, and never `npm run mcp`: npm writes its own two-line banner to
 * stdout ahead of the first frame, and stdout belongs to the protocol (`src/mcp/index.ts`).
 * The path is `bin/rover-mcp.mjs` rather than `src/mcp/index.ts` because `--import tsx/esm` is
 * resolved against the *client's* working directory, so that form starts in this checkout and
 * nowhere else (`PROJECT.md` §6).
 */
export function mcpServerEntry(launcher: string, projectFile: string | undefined): McpServerEntry {
	return {
		command: 'node',
		args: [launcher],
		env: projectFile === undefined ? {} : { ROVER_PROJECT_FILE: projectFile },
	};
}

/**
 * `existing` with our entry in it — created, updated, or unchanged.
 *
 * `path` is carried for the failures alone: this function does no IO, and a caller who reads a
 * file has a path a reader can go and look at.
 */
export function mergeMcpConfig(
	path: string,
	existing: string | undefined,
	entry: McpServerEntry,
): MergedConfig {
	const document = parseConfig(path, existing);
	const servers = readServers(path, document);
	const previous = servers[MCP_SERVER_KEY];

	servers[MCP_SERVER_KEY] = {
		...entry,
		// An operator may have added variables of their own to this entry — a host address, a log
		// level. Ours win where they collide and theirs survive where they do not, so re-running
		// init is not a way to lose them.
		env: { ...readEnv(previous), ...entry.env },
	};
	document.mcpServers = servers;

	const text = `${JSON.stringify(document, null, 2)}\n`;
	if (existing === undefined) {
		return { text, outcome: 'created' };
	}
	return { text, outcome: text === existing ? 'unchanged' : 'updated' };
}

function parseConfig(path: string, existing: string | undefined): Record<string, unknown> {
	if (existing === undefined || existing.trim() === '') {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(existing);
	} catch {
		throw new Error(
			`${path} is not valid JSON, so there is nothing to merge into and it has been left ` +
				`untouched. Fix it and run init again, or move it aside to have a fresh one written.`,
		);
	}
	if (!isRecord(parsed)) {
		throw new Error(
			`${path} holds ${Array.isArray(parsed) ? 'an array' : typeof parsed}, and an MCP ` +
				`configuration is an object. It has been left untouched.`,
		);
	}
	return parsed;
}

function readServers(path: string, document: Record<string, unknown>): Record<string, unknown> {
	const servers = document.mcpServers;
	if (servers === undefined) {
		return {};
	}
	if (!isRecord(servers)) {
		throw new Error(
			`${path} has an 'mcpServers' that is not an object, so there is no table to add a ` +
				`server to. It has been left untouched.`,
		);
	}
	return { ...servers };
}

/** The `env` of whatever was under our key before, or nothing if it was never a server entry. */
function readEnv(previous: unknown): Record<string, string> {
	if (!isRecord(previous) || !isRecord(previous.env)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(previous.env).filter(
			(pair): pair is [string, string] => typeof pair[1] === 'string',
		),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
