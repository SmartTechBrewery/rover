/**
 * A wait that runs out, as the agent reads it.
 *
 * This is the answer the whole wait vocabulary exists to produce instead of a sleep (D12(b)):
 * the target never appeared, the host says so by name, and it says what *was* on the screen —
 * which is the difference between an agent that retries the same call forever and one that
 * looks at what it actually got. The tool must carry that through as an error rather than as an
 * `ok` with nothing in it, and it must not be indistinguishable from a client that gave up
 * waiting (`./request-timeouts.test.ts` holds that end).
 *
 * `timeoutMs: 0` throughout: the wait vocabulary probes before any delay, so zero is exactly one
 * screen read — a real timeout with no test waiting on a duration (ai/RULES.md §2, and
 * `tests/unit/daemon/verb-dispatch.test.ts` does the same).
 *
 * A real daemon on a temp socket, as the rest of `tests/unit/mcp/` (ai/TESTING.md).
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
	createMockScreenElement,
} from '../../helpers/factories.js';
import { callTool, connectMcpAgent, textOf } from '../../helpers/mcp-agent.js';

const SERIAL = parseDeviceSerial('attached-1');
const attached = createMockDevice({ serial: SERIAL });

/** The only thing this device ever shows. Nothing here is what any wait below asks for. */
const onScreen = createMockScreenElement({ id: 'cancel', text: 'Cancel' });

/** A target this device will never show, so the wait can only end one way. */
const NEVER = { by: 'text', text: 'Save' } as const;

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: Client[] = [];

async function serve(): Promise<void> {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([attached]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	registerDeviceBackend({
		manifest: { platform: 'test-platform', label: 'Test', capabilities: createMockCapabilities() },
		backend: createMockDeviceBackend({
			watchDevices,
			describeDevice: async (serial) => createMockDevice({ serial }),
			deviceInfo: async (serial) => createMockDeviceInfo({ serial }),
			readScreen: async () => [onScreen],
		}),
	});

	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
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

describe('wait_for against a screen that never shows the target', () => {
	it('answers with the wait-timeout failure, naming what it waited for and what was there', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'wait_for', { leaseId, target: NEVER, timeoutMs: 0 });

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			outcome: 'failed',
			// `polls: 1` is the proof this was the host's own deadline: the wait probed once and
			// gave up, rather than the call being cut off from this end.
			failure: { kind: 'wait-timeout', timeoutMs: 0, polls: 1 },
		});
		const said = textOf(result);
		// Both halves reach the agent: what it asked for, and what the device was actually
		// showing instead — which is the field that makes the next move obvious.
		expect(said).toContain('Save');
		expect(said).toContain('Cancel');
	});

	it('is never an ok answer, so a wait that failed cannot read as one that landed', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'wait_for', { leaseId, target: NEVER, timeoutMs: 0 });

		const answer = result.structuredContent as { outcome: string; result?: unknown };
		expect(answer.outcome).toBe('failed');
		expect(answer.result).toBeUndefined();
	});
});

describe('wait_until_gone against a screen that keeps showing it', () => {
	it('answers with the same failure and the same vocabulary', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'wait_until_gone', {
			leaseId,
			target: { by: 'text', text: 'Cancel' },
			timeoutMs: 0,
		});

		// One refusal vocabulary whatever was asked: the agent reads `wait-timeout` here for the
		// opposite condition, and reads it the same way.
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			outcome: 'failed',
			failure: { kind: 'wait-timeout', polls: 1 },
		});
		expect(textOf(result)).toContain('Cancel');
	});
});
