/**
 * What an agent is told this server can do — `tools/list`, read through a real MCP client.
 *
 * The claim under test is the one the whole layer rests on: **the Zod schemas in
 * `src/ipc/methods.ts` are the tool declarations** (ai/CODING_STANDARDS.md, boundary #1). So
 * the expectations here are *derived from those schemas* rather than written out beside them —
 * a test that spelled the properties again would be the second hand-written copy this design
 * exists to avoid, and it would go green on the day the two drifted together.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { IPC_METHODS } from '@/ipc/methods.js';
import { createRoverMcpServer, ROVER_MCP_NAME, ROVER_MCP_VERSION } from '@/mcp/server.js';

/** The four rows this phase exposes. The verb rows are phase 2 (R19). */
const DEVICE_METHODS = ['status', 'list_devices', 'acquire_device', 'release_device'] as const;

interface AdvertisedTool {
	name: string;
	description?: string;
	inputSchema: {
		type: string;
		properties?: Record<string, unknown>;
		required?: string[];
		additionalProperties?: boolean;
	};
}

const clients: Client[] = [];

async function advertisedTools(): Promise<AdvertisedTool[]> {
	const server = createRoverMcpServer('local');
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'rover-test-agent', version: '0.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	clients.push(client);
	return (await client.listTools()).tools as unknown as AdvertisedTool[];
}

/** The keys and the required subset of one `IPC_METHODS` row's params schema. */
function shapeOf(method: (typeof DEVICE_METHODS)[number]): {
	keys: string[];
	required: string[];
} {
	const shape = (
		IPC_METHODS[method].params as unknown as {
			shape: Record<string, { isOptional(): boolean }>;
		}
	).shape;
	const keys = Object.keys(shape);
	return { keys, required: keys.filter((key) => shape[key]?.isOptional() === false) };
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('what tools/list advertises', () => {
	it('names the four device and lease rows, spelled exactly as IPC_METHODS spells them', async () => {
		const tools = await advertisedTools();

		// The `IPC_METHODS` keys verbatim: a renamed tool would be a second vocabulary for the
		// same operation, and no platform suffix ever appears in one (D10).
		expect(tools.map((tool) => tool.name).sort()).toEqual([...DEVICE_METHODS].sort());
	});

	it('gives every tool a description an agent can act on', async () => {
		const tools = await advertisedTools();

		for (const tool of tools) {
			expect(tool.description ?? '').not.toHaveLength(0);
		}
	});

	it('declares each tool from its own params schema, properties, optionality and all', async () => {
		const tools = await advertisedTools();

		for (const method of DEVICE_METHODS) {
			const tool = tools.find((candidate) => candidate.name === method);
			const { keys, required } = shapeOf(method);

			expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(keys);
			expect(tool?.inputSchema.required ?? []).toEqual(required);
			// Every one of these rows is `.strict()`, so a typo'd argument is refused rather
			// than silently ignored — and the advertised schema says so.
			expect(tool?.inputSchema.additionalProperties).toBe(false);
		}
	});

	it('takes no host parameter anywhere: where the hardware sits is configuration (D17)', async () => {
		const tools = await advertisedTools();

		// An agent that could redirect a call would be able to take a lease on a machine nobody
		// pointed it at — and no model has any way to know a good value for an address.
		for (const tool of tools) {
			for (const property of Object.keys(tool.inputSchema.properties ?? {})) {
				expect(property.toLowerCase()).not.toMatch(/host|address|port|token/);
			}
		}
	});
});

describe('how the server introduces itself', () => {
	it('reports the version in package.json, so the two cannot drift', async () => {
		// Asserted rather than imported: `rootDir` is `src`, so the manifest cannot be an
		// import without pulling a file outside the compiled tree into the build.
		const manifest: unknown = JSON.parse(
			await readFile(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
		);

		expect(ROVER_MCP_VERSION).toBe((manifest as { version: string }).version);
		expect(ROVER_MCP_NAME).toBe('rover');
	});
});
