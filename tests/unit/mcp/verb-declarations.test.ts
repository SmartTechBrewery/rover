/**
 * What an agent is told the verb tools are — `tools/list`, read through a real MCP client.
 *
 * The claim under test is the one this layer rests on: **the Zod schemas in
 * `src/ipc/methods.ts` are the tool declarations** (ai/CODING_STANDARDS.md, boundary #1). So
 * every expectation here is *derived* — from the `IPC_METHODS` table, and through the SDK's own
 * schema conversion, the same call `registerTool`'s advertisement goes through. A test that
 * spelled the properties out again would be the second hand-written copy this design exists to
 * avoid, and it would go green on the day the two drifted together.
 *
 * `./declarations.test.ts` is the same suite for the four device and lease rows; the
 * completeness gate at the bottom of this file is what covers the whole table at once.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { afterEach, describe, expect, it } from 'vitest';
import { IPC_METHODS, type IpcMethodName } from '@/ipc/methods.js';
import { connectMcpAgent } from '../../helpers/mcp-agent.js';

/** The sixteen verb rows this phase exposes, in `IPC_METHODS` order. */
const VERB_METHODS = [
	'wait_for',
	'wait_until_gone',
	'tap',
	'long_press',
	'swipe',
	'scroll',
	'type_text',
	'press_key',
	'read_screen',
	'device_info',
	'launch_app',
	'stop_app',
	'clear_app_data',
	'read_logs',
	'set_airplane_mode',
	'set_wifi',
] as const satisfies readonly IpcMethodName[];

/** The four rows `./declarations.test.ts` owns. Not verbs, and not this suite's subject. */
const DEVICE_METHODS = ['status', 'list_devices', 'acquire_device', 'release_device'] as const;

/**
 * The rows deliberately **not** exposed yet, and the reason is one thing they have in common:
 * every one of them carries a payload of bytes, in or out. What a tool result does with several
 * megabytes of base64 — and where, if anywhere, a client writes them — is R19 phase 3's own
 * subject rather than a detail to settle in passing here.
 *
 * The list is short and named so the gate below can be exact: a verb row added later is either
 * a registered tool or a deliberate entry here, never a row that quietly has no tool.
 */
const NOT_YET_EXPOSED = [
	'screenshot',
	'record_video',
	'install_app',
	'push_file',
	'pull_file',
] as const satisfies readonly IpcMethodName[];

/** The platform vocabulary `tests/unit/no-platform-names.test.ts` keeps out of `src/` (D10). */
const PLATFORM_NAMES = /android|ios|iphone|ipad|adb|simctl|xcrun|uiautomator|emulator|espresso/i;

interface AdvertisedTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

const clients: Client[] = [];

async function advertisedTools(): Promise<AdvertisedTool[]> {
	const client = await connectMcpAgent('local');
	clients.push(client);
	return (await client.listTools()).tools as unknown as AdvertisedTool[];
}

/** One advertised tool, or a failed test naming what was missing. */
function toolNamed(tools: AdvertisedTool[], name: string): AdvertisedTool {
	const found = tools.find((tool) => tool.name === name);
	if (!found) {
		throw new Error(`No tool is advertised under '${name}'`);
	}
	return found;
}

/**
 * The JSON Schema an `IPC_METHODS` row's params schema converts to, through the SDK's own
 * converter with the SDK's own options — which is what `registerTool` puts on the wire.
 *
 * Derived this way rather than written out so the comparison below is the whole object: not
 * "the same properties", but the same schema, `anyOf` branches and bounds and all.
 */
function declarationOf(method: IpcMethodName): Record<string, unknown> {
	return toJsonSchemaCompat(IPC_METHODS[method].params, {
		strictUnions: true,
		pipeStrategy: 'input',
	});
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('what tools/list advertises for the verbs', () => {
	it('names the sixteen verb rows, spelled exactly as IPC_METHODS spells them', async () => {
		const tools = await advertisedTools();

		const device: readonly string[] = DEVICE_METHODS;
		const verbs = tools.map((tool) => tool.name).filter((name) => !device.includes(name));
		// The `IPC_METHODS` keys verbatim. A renamed tool would be a second vocabulary for the same
		// operation, and there is one set of verbs — no `_android`, no platform suffix (D10).
		expect(verbs.sort()).toEqual([...VERB_METHODS].sort());
	});

	it('puts no platform name in any tool name', async () => {
		const tools = await advertisedTools();

		for (const tool of tools) {
			expect(tool.name).not.toMatch(PLATFORM_NAMES);
		}
	});

	it('declares each verb from its own params schema, whole', async () => {
		const tools = await advertisedTools();

		for (const method of VERB_METHODS) {
			expect(toolNamed(tools, method).inputSchema).toEqual(declarationOf(method));
		}
	});

	it('shares one declaration between the rows that share one params schema', async () => {
		const tools = await advertisedTools();

		// Three app rows on `AppVerbParamsSchema` and two environment rows on
		// `EnvironmentVerbParamsSchema`: the calls are identical, so a near-copy per row would be
		// a copy that drifts. Asserted on the advertised schemas, which is where a fork would show.
		const app = ['launch_app', 'stop_app', 'clear_app_data'].map(
			(name) => toolNamed(tools, name).inputSchema,
		);
		expect(app).toEqual([app[0], app[0], app[0]]);
		expect(toolNamed(tools, 'set_wifi').inputSchema).toEqual(
			toolNamed(tools, 'set_airplane_mode').inputSchema,
		);
	});

	it('asks every verb for the lease id and never for a serial or a host', async () => {
		const tools = await advertisedTools();

		for (const method of VERB_METHODS) {
			const schema = toolNamed(tools, method).inputSchema;
			// The lease id is the credential and the host derives the device from it (D20); a
			// serial accepted beside it is the one field that would let the holder of one lease
			// drive another device. And where the hardware sits is server configuration (D17), so
			// no tool may offer an agent a host, an address, a port or a token to choose.
			expect(schema.required).toContain('leaseId');
			expect(Object.keys(schema.properties as object)).not.toContain('serial');
			for (const property of Object.keys(schema.properties as object)) {
				expect(property.toLowerCase()).not.toMatch(/host|address|port|token/);
			}
		}
	});

	it('gives every verb a description, and names the capability on the rows that need one', async () => {
		const tools = await advertisedTools();

		for (const method of VERB_METHODS) {
			expect(toolNamed(tools, method).description ?? '').not.toHaveLength(0);
		}
		// D11 legibility *before* the call: an agent that reads the capability in the declaration
		// can check it against the list `acquire_device` handed it, rather than discovering the
		// asymmetry from a failure.
		expect(toolNamed(tools, 'read_screen').description).toContain('canReadScreen');
		for (const method of ['set_wifi', 'set_airplane_mode']) {
			expect(toolNamed(tools, method).description).toContain('canControlNetwork');
		}
	});
});

describe('the completeness gate over IPC_METHODS', () => {
	it('leaves no row without either a tool or a deliberate entry saying why not', async () => {
		const advertised = new Set((await advertisedTools()).map((tool) => tool.name));

		// The gate: a verb row added later cannot land with no MCP tool and no decision. Without
		// it, "the tools are the method table" quietly becomes "the tools are whatever somebody
		// remembered to register".
		const unexposed = Object.keys(IPC_METHODS).filter((method) => !advertised.has(method));
		expect(unexposed.sort()).toEqual([...NOT_YET_EXPOSED].sort());
	});

	it('advertises nothing that is not a row of the table', async () => {
		const advertised = (await advertisedTools()).map((tool) => tool.name);

		// The other direction, which the first assertion cannot see: a tool this layer invented
		// would be a device operation living only in the MCP server (ai/RULES.md §1).
		expect(advertised.filter((name) => !Object.hasOwn(IPC_METHODS, name))).toEqual([]);
	});
});
