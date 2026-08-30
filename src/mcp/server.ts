/**
 * The MCP server itself — a name, a version and the tools registered on it.
 *
 * Everything about *which* host it asks arrives as an argument (D17, `./_shared/host.ts`), so
 * this module is transport-agnostic and a test builds one without an environment. The project
 * an `acquire_device` call defaults to arrives the same way and for the same reason: it is
 * resolved once, at startup, in `./index.ts`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HostName } from '../daemon/host.js';
import { registerArtifactTools } from './tools/artifacts.js';
import { registerDeviceTools } from './tools/devices.js';
import { registerVerbTools } from './tools/verbs.js';

/** What an MCP client sees this server called. The `IPC_METHODS` names are the tool names. */
export const ROVER_MCP_NAME = 'rover';

/**
 * Kept in step with `package.json`'s `version` by `tests/unit/mcp/server.test.ts` rather than
 * imported from it: `rootDir` is `src`, so importing the manifest would pull a file from
 * outside the compiled tree into the build.
 */
export const ROVER_MCP_VERSION = '0.1.0';

/**
 * `defaultProject` is the `project` an `acquire_device` call may leave out — the identifier in
 * the hook file `ROVER_PROJECT_FILE` names (D22). Absent, and the tool requires the argument
 * exactly as it did.
 */
export function createRoverMcpServer(host: HostName, defaultProject?: string): McpServer {
	const server = new McpServer({ name: ROVER_MCP_NAME, version: ROVER_MCP_VERSION });
	registerDeviceTools(server, host, defaultProject);
	registerVerbTools(server, host);
	registerArtifactTools(server, host);
	return server;
}
