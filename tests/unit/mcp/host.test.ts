/**
 * What the server was configured with, and when it finds out.
 *
 * `ROVER_HOST_ADDRESS` set means the remote host, unset means the local daemon (D17), and the
 * whole configuration is resolved **at startup** — before a transport is connected — so a
 * half-configured server dies naming what is missing instead of advertising four tools and
 * failing at the agent's first call.
 *
 * `ROVER_PROJECT_FILE` is resolved in the same place and for one more reason: the SDK
 * validates a call against the tool declaration, so whether `acquire_device` may leave
 * `project` out is settled the moment the tool is advertised and nothing a handler did later
 * could change it.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST, REMOTE_HOST } from '@/daemon/host.js';
import {
	HOST_ADDRESS_ENV_VAR,
	HOST_PORT_ENV_VAR,
	HOST_TOKEN_ENV_VAR,
} from '@/daemon/network-config.js';
import { PROJECT_FILE_ENV_VAR } from '@/daemon/project-hooks.js';
import { resolveConfiguredHost } from '@/mcp/_shared/host.js';
import { createConfiguredServer } from '@/mcp/index.js';
import { connectMcpAgentTo } from '../../helpers/mcp-agent.js';

const A_TOKEN = 'x'.repeat(43);

let root: string;
const clients: Client[] = [];

beforeEach(async () => {
	for (const variable of [HOST_ADDRESS_ENV_VAR, HOST_PORT_ENV_VAR, HOST_TOKEN_ENV_VAR]) {
		vi.stubEnv(variable, '');
	}
	root = await mkdtemp(join(tmpdir(), 'rover-project-file-'));
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await rm(root, { recursive: true, force: true });
});

/** Whether the server this environment produces makes an agent supply `project`. */
async function acquireRequires(env: NodeJS.ProcessEnv): Promise<string[]> {
	const client = await connectMcpAgentTo(await createConfiguredServer(env));
	clients.push(client);
	const tools = (await client.listTools()).tools;
	const acquire = tools.find((tool) => tool.name === 'acquire_device');
	return (acquire?.inputSchema as { required?: string[] }).required ?? [];
}

describe('the host an MCP server was configured for', () => {
	it('is the local daemon when nothing names a remote one', () => {
		expect(resolveConfiguredHost(process.env)).toBe(LOCAL_HOST);
	});

	it('treats an exported-but-blank address as unset, the way a shell leaves one behind', () => {
		expect(resolveConfiguredHost({ [HOST_ADDRESS_ENV_VAR]: '' })).toBe(LOCAL_HOST);
	});

	it('is the remote host when the environment names one', () => {
		expect(
			resolveConfiguredHost({
				[HOST_ADDRESS_ENV_VAR]: '10.0.0.4',
				[HOST_PORT_ENV_VAR]: '7333',
				[HOST_TOKEN_ENV_VAR]: A_TOKEN,
			}),
		).toBe(REMOTE_HOST);
	});

	it('throws at startup, naming every missing variable, when the remote host is half there', () => {
		// One pass, not two: an operator who set the address and neither of the rest is told
		// about both, and is told now rather than through a failed tool call later.
		expect(() => resolveConfiguredHost({ [HOST_ADDRESS_ENV_VAR]: '10.0.0.4' })).toThrow(
			new RegExp(`${HOST_PORT_ENV_VAR}[\\s\\S]*${HOST_TOKEN_ENV_VAR}`),
		);
	});

	it('throws for a token too short to be the one a host issued', () => {
		expect(() =>
			resolveConfiguredHost({
				[HOST_ADDRESS_ENV_VAR]: '10.0.0.4',
				[HOST_PORT_ENV_VAR]: '7333',
				[HOST_TOKEN_ENV_VAR]: 'too-short',
			}),
		).toThrow(HOST_TOKEN_ENV_VAR);
	});

	it('never quotes the token it rejected, so a startup failure cannot leak a credential', () => {
		let said = '';
		try {
			resolveConfiguredHost({
				[HOST_ADDRESS_ENV_VAR]: '10.0.0.4',
				[HOST_PORT_ENV_VAR]: '7333',
				[HOST_TOKEN_ENV_VAR]: 'short-secret',
			});
		} catch (error) {
			said = error instanceof Error ? error.message : String(error);
		}

		expect(said).not.toBe('');
		expect(said).not.toContain('short-secret');
	});
});

describe('the project an MCP server defaults an acquire to', () => {
	it('is nothing at all when no hook file is configured, and project stays required', async () => {
		await expect(acquireRequires({})).resolves.toContain('project');
		await expect(acquireRequires({ [PROJECT_FILE_ENV_VAR]: '' })).resolves.toContain('project');
	});

	it('is the identifier in the file the variable names, which makes project optional', async () => {
		const path = join(root, 'checkout-web.json');
		await writeFile(path, JSON.stringify({ project: 'checkout-web' }), 'utf8');

		await expect(acquireRequires({ [PROJECT_FILE_ENV_VAR]: path })).resolves.not.toContain(
			'project',
		);
	});

	it('dies at startup, naming the path, rather than advertising a tool with no default', async () => {
		const missing = join(root, 'nothing-here.json');

		// The failure has to land on stderr before a transport is connected. A server that
		// started anyway would advertise `project` as optional and have nothing to fill it
		// with — a lease attributed to nothing, which is what D20 and D22 rule out.
		await expect(createConfiguredServer({ [PROJECT_FILE_ENV_VAR]: missing })).rejects.toThrow(
			missing,
		);
	});
});
