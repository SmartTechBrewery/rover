/**
 * The agent's half of an MCP test: a real client, speaking the real protocol, to the server
 * `src/mcp/server.ts` actually ships.
 *
 * The SDK's own `InMemoryTransport.createLinkedPair()` rather than a child process and stdio —
 * so the tools are exercised the way an agent reaches them, through `tools/list` and
 * `tools/call`, with no process to reap. The *host* half is a real daemon on a temp socket,
 * which each suite arranges for itself (ai/TESTING.md, the `tests/unit/mcp/` exception).
 *
 * These three functions live here rather than in each suite because four of them need the same
 * three, and a per-file copy is the fixture duplication ai/TESTING.md "Test data" is about.
 * Lifecycle stays with the suite: closing clients and daemons is what its `afterEach` is for.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HostName } from '@/daemon/host.js';
import { createRoverMcpServer } from '@/mcp/server.js';

/**
 * An MCP client connected to a Rover server configured for `host`. Close it in `afterEach`.
 *
 * `defaultProject` is what `ROVER_PROJECT_FILE` resolves to at startup in a real server
 * (`src/mcp/index.ts`), passed directly here for the reason `host` is: a suite says what the
 * server was configured with rather than arranging an environment for it to read.
 */
export async function connectMcpAgent(
	host: HostName = 'local',
	defaultProject?: string,
): Promise<Client> {
	return connectMcpAgentTo(createRoverMcpServer(host, defaultProject));
}

/**
 * The same client, over a server the suite built itself — what a test asserting the *startup*
 * path uses, since `createConfiguredServer` is what turns an environment into one of these.
 */
export async function connectMcpAgentTo(server: McpServer): Promise<Client> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'rover-test-agent', version: '0.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

/** One tool call, as an agent makes it. */
export async function callTool(
	client: Client,
	name: string,
	args: Record<string, unknown> = {},
): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** What the agent reads: the tool's own text blocks, joined. */
export function textOf(result: CallToolResult): string {
	return result.content
		.filter((block) => block.type === 'text')
		.map((block) => block.text)
		.join('\n');
}
