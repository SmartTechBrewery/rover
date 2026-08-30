/**
 * The four device tools, driven by a real MCP client against a real daemon on a real socket.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) and extends here for the
 * same reason it covers the CLI: the whole job of this layer is to drive a host over that
 * surface, so a mocked IPC client would leave the wiring — `registerTool` → `callHost` →
 * `connectToLocalDaemon` → the framing — asserted against nothing. Never `~/.rover/rover.sock`,
 * and every daemon closed through its own handle in `afterEach`.
 *
 * The MCP half is the SDK's own `InMemoryTransport.createLinkedPair()`: a real client speaking
 * the real protocol, with no child process and no stdio, so the tools are exercised the way an
 * agent reaches them rather than by calling the handlers directly.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import type { HostName } from '@/daemon/host.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import {
	HOST_ADDRESS_ENV_VAR,
	HOST_PORT_ENV_VAR,
	HOST_TOKEN_ENV_VAR,
} from '@/daemon/network-config.js';
import { createRoverMcpServer } from '@/mcp/server.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });

/** A token long enough for the client-side floor, so a remote case fails on the *connection*. */
const A_TOKEN = 'x'.repeat(43);

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: Client[] = [];

function registerFakeBackend(): void {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([attached]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: {
				canReadScreen: true,
				canInput: true,
				canControlNetwork: true,
				canRecordVideo: true,
			},
		},
		backend: createMockDeviceBackend({
			watchDevices,
			describeDevice: async (serial) => createMockDevice({ serial }),
		}),
	});
}

async function startHost(): Promise<void> {
	const result = await startDaemon({ socketPath: temp.socketPath });
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

/** An MCP client connected to a Rover server configured for `host`. */
async function connectAgent(host: HostName = 'local'): Promise<Client> {
	const server = createRoverMcpServer(host);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'rover-test-agent', version: '0.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	clients.push(client);
	return client;
}

async function call(
	client: Client,
	name: string,
	args: Record<string, unknown> = {},
): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** What the agent reads: the tool's own text blocks, joined. */
function textOf(result: CallToolResult): string {
	return result.content
		.filter((block) => block.type === 'text')
		.map((block) => block.text)
		.join('\n');
}

beforeEach(async () => {
	temp = await createTempSocket();
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	// Stubbed empty for every test so a developer's own exported remote host cannot decide
	// which host a `local` server here ends up asking.
	for (const variable of [HOST_ADDRESS_ENV_VAR, HOST_PORT_ENV_VAR, HOST_TOKEN_ENV_VAR]) {
		vi.stubEnv(variable, '');
	}
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	vi.restoreAllMocks();
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	await removeTempSocket(temp);
});

describe('the device tools over a live host', () => {
	it('answers status from the host the server was configured for', async () => {
		await startHost();
		const agent = await connectAgent();

		const result = await call(agent, 'status');

		expect(result.isError).toBeFalsy();
		// An in-process daemon, so the pid it reports is this one — what matters is that the
		// answer came from the host rather than from anything assembled inside this layer.
		expect(result.structuredContent).toMatchObject({ pid: process.pid });
		expect(JSON.parse(textOf(result))).toMatchObject({ pid: process.pid });
	});

	it('lists what the host has, with nobody holding it', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();

		const result = await call(agent, 'list_devices');

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			stale: false,
			devices: [{ serial: 'attached-1', heldBy: null }],
		});
	});

	it('grants a lease, shows it as held, and hands it back', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();

		const granted = await call(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
		});
		expect(granted.isError).toBeFalsy();
		const lease = (granted.structuredContent as { lease: { leaseId: string } }).lease;

		const listed = await call(agent, 'list_devices');
		expect(listed.structuredContent).toMatchObject({
			devices: [{ heldBy: { owner: 'issue-112', project: 'rover', testName: 'checkout flow' } }],
		});

		const released = await call(agent, 'release_device', { leaseId: lease.leaseId });
		expect(released.isError).toBeFalsy();
		expect(released.structuredContent).toEqual({ released: true });
	});

	it('makes a refused acquire an error naming the holder, never a plausible success', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();
		await call(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-112',
			project: 'rover',
		});

		const refused = await call(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'pr-127-review',
			project: 'rover',
		});

		expect(refused.isError).toBe(true);
		// The refusal travels whole: who holds it and for how long is what makes it actionable.
		expect(refused.structuredContent).toMatchObject({
			outcome: 'refused',
			reason: 'held',
			heldBy: { owner: 'issue-112' },
		});
		expect(textOf(refused)).toContain('issue-112');
	});

	it('reports a release that found no live lease as data rather than as a failure', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();

		const result = await call(agent, 'release_device', { leaseId: 'no-such-lease' });

		// The store cannot tell a never-granted id from an expired one, so this is an honest
		// answer and not an error — the agent reads `released: false` and moves on.
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({ released: false });
	});
});

describe('what a tool does when the answer is not an answer', () => {
	it('rejects an argument the params schema refuses, before anything reaches the host', async () => {
		await startHost();
		const agent = await connectAgent();

		const result = await call(agent, 'acquire_device', {
			serial: '   ',
			owner: 'issue-112',
			project: 'rover',
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('serial');
	});

	it('fails loudly, naming the address and the port, when the host is unreachable', async () => {
		// Port 1 is privileged, so nothing this suite could collide with is ever listening on
		// it — and the remote arm starts nothing, so this stays a refused connection (D5).
		vi.stubEnv(HOST_ADDRESS_ENV_VAR, '127.0.0.1');
		vi.stubEnv(HOST_PORT_ENV_VAR, '1');
		vi.stubEnv(HOST_TOKEN_ENV_VAR, A_TOKEN);
		const agent = await connectAgent('remote');

		const result = await call(agent, 'list_devices');

		// The whole point of D19's loud failure: an unreachable host is a sentence naming what
		// could not be reached, never an empty device list that reads like "nothing attached".
		expect(result.isError).toBe(true);
		const said = textOf(result);
		expect(said).toContain('list_devices');
		expect(said).toContain('127.0.0.1');
		expect(said).toContain('1');
		expect(result.structuredContent).toBeUndefined();
	});
});
