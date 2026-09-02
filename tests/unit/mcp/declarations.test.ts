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
import { ARGUMENT_CASING_NOTE } from '@/mcp/_shared/declaration.js';
import { createRoverMcpServer, ROVER_MCP_NAME, ROVER_MCP_VERSION } from '@/mcp/server.js';

/** The four device and lease rows. The verb rows have their own suite, `./verb-declarations`. */
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

async function advertisedTools(defaultProject?: string): Promise<AdvertisedTool[]> {
	const server = createRoverMcpServer('local', defaultProject);
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
		// same operation, and no platform suffix ever appears in one (D10). Which rows are
		// advertised *in total* — and that every row is either advertised or deliberately not —
		// is `./verb-declarations.test.ts`'s completeness gate.
		expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...DEVICE_METHODS]));
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

	it('still requires acquire_device’s project when no project hook file is configured', async () => {
		const tools = await advertisedTools();

		// The declaration is what the SDK validates a call against, so it has to tell an agent
		// the truth about what it must supply: with nothing to default from, that is `project`.
		const acquire = tools.find((tool) => tool.name === 'acquire_device');
		expect(acquire?.inputSchema.required).toEqual(shapeOf('acquire_device').required);
		expect(acquire?.inputSchema.required).toContain('project');
		// And `testName`, which the SDK then refuses a call without — the requirement surfaced
		// upstream of the handler rather than left for the host to answer (D22, as amended #129).
		expect(acquire?.inputSchema.required).toContain('testName');
	});

	/*
	 * The one **optional** argument on that row (D22, as amended #148), and the declaration is
	 * where an agent learns both halves: that the key exists, and that it may be left out. It is
	 * derived from `AcquireDeviceParamsSchema` like everything else here — the generic test above
	 * already holds that the properties and the required list are the schema's own, so what this
	 * adds is that the optional one is on the right side of that line.
	 */
	it('declares acquire_device’s testDescription, and never as a requirement', async () => {
		const tools = await advertisedTools();

		const acquire = tools.find((tool) => tool.name === 'acquire_device');
		expect(Object.keys(acquire?.inputSchema.properties ?? {})).toContain('testDescription');
		expect(acquire?.inputSchema.required ?? []).not.toContain('testDescription');
		// And the description says what to put there and that it is optional, so an agent reading
		// only the prose is not left guessing at a key it can see in the schema.
		expect(acquire?.description).toContain('testDescription');
		expect(acquire?.description).toContain('optional');
	});

	it('drops project from acquire_device’s required list when one is, and changes nothing else', async () => {
		const tools = await advertisedTools('checkout-web');

		const acquire = tools.find((tool) => tool.name === 'acquire_device');
		const { keys, required } = shapeOf('acquire_device');
		// Derived from `AcquireDeviceParamsSchema` rather than written out a second time: every
		// property, every other required key and the `.strict()` refusal of a typo'd argument
		// survive, and exactly one key moves.
		expect(Object.keys(acquire?.inputSchema.properties ?? {})).toEqual(keys);
		expect(acquire?.inputSchema.required).toEqual(required.filter((key) => key !== 'project'));
		expect(acquire?.inputSchema.required).toContain('testName');
		expect(acquire?.inputSchema.additionalProperties).toBe(false);
		// And the agent is told there is a default and where it came from, rather than being
		// left to infer it from an argument that is suddenly optional.
		expect(acquire?.description).toContain('checkout-web');
		expect(acquire?.description).toContain('ROVER_PROJECT_FILE');
	});

	it('tells every tool’s reader that the arguments are camelCase (D26)', async () => {
		const tools = await advertisedTools();

		// The decision is to keep the wire's spelling (D26); the obligation that comes with it is
		// that an agent reading only the tool surface is not left to infer the casing from the
		// tool *name* and have its first call refused. `declaring()` is what makes this true of
		// every row rather than of the rows somebody remembered, and this is the gate under it.
		for (const tool of tools) {
			expect(tool.description ?? '').toContain(ARGUMENT_CASING_NOTE);
		}
		// The note is only honest while it matches the schemas. `leaseId` is the field it names,
		// and it is on every verb row.
		expect(
			Object.keys(
				(tools.find((tool) => tool.name === 'tap')?.inputSchema.properties ?? {}) as object,
			),
		).toContain('leaseId');
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
