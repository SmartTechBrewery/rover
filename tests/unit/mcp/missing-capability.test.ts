/**
 * **A missing capability is a loud, agent-readable error naming the capability and the device**
 * — D11, and this phase's headline criterion.
 *
 * Backends are genuinely asymmetric (`PROJECT.md` §5): one platform has no cheap equivalent of a
 * screen read, another cannot touch the radios. The failure this suite exists to prevent is not
 * an exception escaping — it is the *plausible* answer: an empty element list, a toggle that
 * reports success and does nothing, an `ok` with nothing in it. Any of those reads to an agent
 * as "the screen is blank" or "wifi is off now" and sends it down a path that cannot work
 * (ai/RULES.md §2).
 *
 * So the backend registered here declares `canReadScreen: false` and `canControlNetwork: false`
 * and answers every method anyway — a mock that would happily return an empty screen if anything
 * ever called it. Nothing does, and that is the point: the capability is asserted before
 * anything is dispatched, and what comes back is an error carrying the `missing-capability`
 * failure whole.
 *
 * A real daemon on a temp socket, as the rest of `tests/unit/mcp/` (ai/TESTING.md).
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Capabilities } from '@/core/capabilities.js';
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
const PLATFORM = 'test-platform';
const LABEL = 'Test';
const attached = createMockDevice({ serial: SERIAL });

/** What the backend *would* answer with, if the capability gate let anything ask it. */
const onScreen = createMockScreenElement({ id: 'save', text: 'Save' });

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: Client[] = [];

/** A daemon whose one device sits behind a backend declaring `capabilities`. */
async function serve(capabilities: Partial<Capabilities>): Promise<void> {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([attached]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	registerDeviceBackend({
		manifest: {
			platform: PLATFORM,
			label: LABEL,
			capabilities: createMockCapabilities(capabilities),
		},
		backend: createMockDeviceBackend({
			watchDevices,
			describeDevice: async (serial) => createMockDevice({ serial }),
			deviceInfo: async (serial) => createMockDeviceInfo({ serial }),
			// Present and willing. If the gate were missing, this is the empty-looking-but-plausible
			// answer that would reach the agent instead of the failure.
			readScreen: async () => [onScreen],
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

async function acquire(agent: Client): Promise<string> {
	const granted = await callTool(agent, 'acquire_device', {
		serial: SERIAL,
		owner: 'issue-89',
		project: 'rover',
	});
	const answer = granted.structuredContent as {
		outcome: string;
		lease?: { leaseId: string };
		capabilities?: Capabilities;
	};
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

describe('read_screen on a backend that cannot read a screen', () => {
	it('is an error carrying the missing-capability failure, never an empty screen', async () => {
		await serve({ canReadScreen: false });
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'read_screen', { leaseId });

		expect(result.isError).toBe(true);
		// The structured half: an agent branches on `kind` and reads the fields, rather than
		// matching on the text of a message.
		expect(result.structuredContent).toMatchObject({
			outcome: 'failed',
			failure: {
				kind: 'missing-capability',
				capability: 'canReadScreen',
				serial: SERIAL,
				platform: PLATFORM,
				backendLabel: LABEL,
			},
		});
		// The readable half, leading the text: the capability, the device and the backend, in the
		// host's own sentence.
		const said = textOf(result);
		expect(said).toContain('canReadScreen');
		expect(said).toContain(SERIAL);
		expect(said).toContain(LABEL);
	});

	it('is not an ok answer and carries no elements at all', async () => {
		await serve({ canReadScreen: false });
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'read_screen', { leaseId });

		// The silent-degradation case, closed: no `ok`, no `result`, and nothing anywhere in the
		// answer that an agent could read as "this is what is on the screen".
		const answer = result.structuredContent as { outcome: string; result?: unknown };
		expect(answer.outcome).not.toBe('ok');
		expect(answer.result).toBeUndefined();
		expect(textOf(result)).not.toContain(onScreen.id);
	});

	it('fails the two waits the same way, since a wait is a screen read in a loop', async () => {
		await serve({ canReadScreen: false });
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'wait_for', {
			leaseId,
			target: { by: 'text', text: 'Save' },
			timeoutMs: 0,
		});

		// Told before the loop starts rather than by a poll that happened to ask: a device that
		// cannot read its screen can never answer this, so waiting on it is not a next move.
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			outcome: 'failed',
			failure: { kind: 'missing-capability', capability: 'canReadScreen' },
		});
	});
});

describe('the environment verbs on a backend that cannot touch the radios', () => {
	it('makes set_wifi an error naming the capability and the device', async () => {
		await serve({ canControlNetwork: false });
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'set_wifi', { leaseId, enabled: false });

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			outcome: 'failed',
			failure: {
				kind: 'missing-capability',
				capability: 'canControlNetwork',
				serial: SERIAL,
				backendLabel: LABEL,
			},
		});
		expect(textOf(result)).toContain('canControlNetwork');
	});

	it('makes set_airplane_mode the same error, on the same capability', async () => {
		await serve({ canControlNetwork: false });
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'set_airplane_mode', { leaseId, enabled: true });

		// Two rows, one capability and one vocabulary: an agent learns the answer once.
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			outcome: 'failed',
			failure: { kind: 'missing-capability', capability: 'canControlNetwork', serial: SERIAL },
		});
	});
});

describe('what the agent was told before it asked', () => {
	it('hands the capability list back on the lease, so the failure is never a surprise', async () => {
		await serve({ canReadScreen: false, canControlNetwork: false });
		const agent = await connectAgent();

		const granted = await callTool(agent, 'acquire_device', {
			serial: SERIAL,
			owner: 'issue-89',
			project: 'rover',
		});

		// The other half of D11 being *readable*: an agent that reads this never has to discover
		// the asymmetry from a failed call, and the tool descriptions name the same capabilities.
		expect(granted.structuredContent).toMatchObject({
			outcome: 'granted',
			capabilities: { canReadScreen: false, canControlNetwork: false },
		});
	});
});
