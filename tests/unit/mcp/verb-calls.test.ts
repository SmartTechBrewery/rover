/**
 * The verb tools, driven by a real MCP client against a real daemon on a real socket.
 *
 * `./tools.test.ts`'s reasoning applies unchanged (ai/TESTING.md, the `tests/unit/mcp/`
 * exception): the whole job of this layer is to carry a tool call to a host, so a mocked IPC
 * client would leave the wiring — `registerTool` → `callHost` → `connectToLocalDaemon` → the
 * framing → the daemon's own verb handler — asserted against nothing. Never
 * `~/.rover/rover.sock`, and every daemon closed through its own handle in `afterEach`.
 *
 * Every call here goes over a lease taken through `acquire_device`, because that is how an agent
 * gets one: the lease id is the credential and the host derives the device from it (D20), so
 * there is no serial anywhere below.
 *
 * The device the daemon drives is a mock, and the assertions are about what the **agent** reads.
 * What the host did to the hardware is `tests/unit/daemon/verb-dispatch.test.ts`' subject, and
 * nothing in this layer is allowed to add to it.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import {
	HOST_ADDRESS_ENV_VAR,
	HOST_PORT_ENV_VAR,
	HOST_TOKEN_ENV_VAR,
} from '@/daemon/network-config.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import {
	createMockCapabilities,
	createMockDevice,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockLogEntry,
	createMockLogRead,
	createMockScreenElement,
} from '../../helpers/factories.js';
import { callTool, connectMcpAgent, textOf } from '../../helpers/mcp-agent.js';

const SERIAL = parseDeviceSerial('attached-1');
const attached = createMockDevice({ serial: SERIAL });
const save = createMockScreenElement({ id: 'save', text: 'Save' });

/** What the device said about an application that is no longer on screen to be seen. */
const crashed = createMockLogEntry({
	level: 'error',
	tag: 'CrashReporter',
	message: 'FATAL: com.example.app died',
});

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: Client[] = [];

/** A daemon on the temp socket, with one ready device behind one fully capable backend. */
async function serve(): Promise<void> {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([attached]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	registerDeviceBackend({
		manifest: { platform: 'test-platform', label: 'Test', capabilities: createMockCapabilities() },
		backend: createMockDeviceBackend({
			watchDevices,
			// The factory's own default ignores the serial it is asked about, which would quietly
			// make every call land on one device whatever the lease said.
			describeDevice: async (serial) => createMockDevice({ serial }),
			deviceInfo: async (serial) => createMockDeviceInfo({ serial }),
			readScreen: async () => [save],
			readLogs: async () => createMockLogRead({ entries: [crashed] }),
		}),
	});

	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

async function connectAgent(): Promise<Client> {
	const client = await connectMcpAgent('local');
	clients.push(client);
	return client;
}

/** A held lease, taken the way an agent takes one, or a failed test. */
async function acquire(agent: Client): Promise<string> {
	const granted = await callTool(agent, 'acquire_device', {
		serial: SERIAL,
		owner: 'issue-89',
		project: 'rover',
	});
	const answer = granted.structuredContent as { outcome: string; lease?: { leaseId: string } };
	if (answer.outcome !== 'granted' || !answer.lease) {
		throw new Error(`The test needs a lease and was refused: ${textOf(granted)}`);
	}
	return answer.lease.leaseId;
}

beforeEach(async () => {
	temp = await createTempSocket();
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	// Stubbed empty so a developer's own exported remote host cannot decide which host the
	// `local` server here ends up asking.
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

describe('a verb call over a lease the agent took itself', () => {
	it('answers device_info with the device the lease names', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'device_info', { leaseId });

		expect(result.isError).toBeFalsy();
		// The whole answer, where the host put it: the outcome, the verb, and the device half
		// every result carries (D14). Nothing in this layer reshapes or summarises it.
		expect(result.structuredContent).toMatchObject({
			outcome: 'ok',
			result: { verb: 'device_info', device: { serial: SERIAL }, target: null },
		});
		expect(JSON.parse(textOf(result))).toMatchObject({ outcome: 'ok' });
	});

	it('answers tap with the target the host resolved and the state after it', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'tap', { leaseId, target: { by: 'text', text: 'Save' } });

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			outcome: 'ok',
			result: {
				verb: 'tap',
				// Resolved from a screen the host read inside the call, never from a coordinate
				// (D12(a)) — and the after-state is what tells the agent the tap landed (D12(c)).
				target: { source: 'screen', element: { id: 'save' } },
				after: { kind: 'screen', elements: [{ id: 'save' }] },
			},
		});
	});

	it('carries read_logs’ own entries on the answer, untouched', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'read_logs', { leaseId });

		expect(result.isError).toBeFalsy();
		// The one verb whose answer carries a field beyond an `ActionResult`. The mapping is
		// generic in the `ok` payload precisely so this arrives whole rather than dropped.
		expect(result.structuredContent).toMatchObject({
			outcome: 'ok',
			result: {
				verb: 'read_logs',
				logs: { truncated: false, entries: [{ tag: 'CrashReporter', message: crashed.message }] },
			},
		});
	});

	it('answers an environment verb the backend declares, as data rather than a silence', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'set_wifi', { leaseId, enabled: false });

		// The `ok` half of the D11 pair `./missing-capability.test.ts` owns the other half of.
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({ outcome: 'ok', result: { verb: 'set_wifi' } });
	});
});

describe('what a verb tool does when the answer is not a result', () => {
	it('makes a released lease an error naming the reason, never a plausible success', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);
		await callTool(agent, 'release_device', { leaseId });

		const result = await callTool(agent, 'tap', { leaseId, target: { by: 'text', text: 'Save' } });

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
		// The host's own sentence leads the text, so the reason is the first thing read and it
		// says what to do next.
		expect(textOf(result)).toContain('Acquire the device again');
	});

	it('rejects an argument the params schema refuses, before anything reaches the host', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'launch_app', { leaseId, appId: 'not a package id' });

		// The declaration *is* the parse: a malformed id is refused against the same schema the
		// daemon would have parsed the request with, one round trip earlier.
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('appId');
	});
});
