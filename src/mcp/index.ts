/**
 * The Rover MCP server (D4, R19): one per agent session, speaking MCP over stdio, and — like
 * the CLI — a **client** of a host and nothing more (D19).
 *
 * It holds **no verb logic** and drives no device itself. A tool declares itself with the IPC
 * params schema the host parses the request with, connects, makes one request, closes and
 * renders the answer (ai/ARCHITECTURE.md, "The adapters own translation only").
 * `tests/unit/no-backend-in-a-client.test.ts` walks this module's graph and holds that line.
 *
 * **The host is resolved before the transport is connected.** A server told
 * `ROVER_HOST_ADDRESS` with no port or no token dies here, on stderr, with the message naming
 * every variable still missing — rather than starting, advertising four tools and failing at
 * the agent's first call.
 *
 * **stdout belongs to the protocol**, so every diagnostic goes to stderr and nothing under
 * `src/mcp/` may print through `src/cli/_shared/output.ts` (`./_shared/answer.ts`). That extends
 * past this tree: `npm run mcp` writes npm's own two-line banner to stdout ahead of the first
 * frame, so an agent's server entry is `node --import tsx/esm src/mcp/index.ts` and the npm
 * script is the by-hand form of it (`npm run -s mcp`).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { entryUrl } from '../core/entrypoint.js';
import { resolveConfiguredHost } from './_shared/host.js';
import { createRoverMcpServer } from './server.js';

/**
 * Build the server this process would serve, host configuration included.
 *
 * Exported separately from {@link main} so a test can assert what a given environment
 * produces without connecting a transport to this process's stdio.
 */
export function createConfiguredServer(env: NodeJS.ProcessEnv = process.env): McpServer {
	return createRoverMcpServer(resolveConfiguredHost(env));
}

export async function main(): Promise<void> {
	await createConfiguredServer().connect(new StdioServerTransport());
}

// Entrypoint guard: self-run only when invoked directly, never when a test imports the
// builder. The same guard `src/cli/index.ts` uses, out of `src/core/entrypoint.ts`, so the two
// normalisations it makes — percent-encoding and `realpath` — exist once.
if (process.argv[1] && import.meta.url === entryUrl(process.argv[1])) {
	try {
		await main();
	} catch (error) {
		// `process.exitCode` rather than `process.exit()`, so anything already written to the
		// transport is flushed instead of truncated.
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
