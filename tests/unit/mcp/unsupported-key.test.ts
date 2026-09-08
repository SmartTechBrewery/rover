/**
 * A key the device has no equivalent for, as the agent reads it.
 *
 * This is the answer #215 exists to produce: a backend that declares `canInput` and takes
 * input can still have nothing behind one key of the shared `DeviceKey` vocabulary, and the
 * honest answer names **that key** rather than claiming the device takes no input at all.
 * Both halves of the AC's "reaches the agent" are asserted here — the sentence in the text
 * block, and the `--json`-shaped document in `structuredContent` — plus the control that
 * makes the refusal provably *per key*: `home` on the very same backend still answers `ok`.
 *
 * A file of its own rather than a case in `./verb-calls.test.ts`, whose `serve()` deliberately
 * takes no overrides. `./wait-timeout.test.ts` and `./missing-capability.test.ts` are the
 * established one-named-failure-end-to-end shape and this is modelled on them.
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
import { UnsupportedKeyError } from '@/core/errors.js';
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

/** Something for the post-state to report, so an `ok` answer is a whole answer. */
const onScreen = createMockScreenElement({ id: 'cancel', text: 'Cancel' });

/** The one key this device has nothing behind. Every other key of the vocabulary works. */
const ABSENT = 'recents';

/** The backend's own words for why, which reach the agent through the error's message. */
const REASON = 'this device has no app-switcher key, and no gesture that reaches one';

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: Client[] = [];

/** The keys the backend was actually asked to press, so a refusal that never got there shows. */
let pressed: string[];

/**
 * A backend that declares `canInput` — it does take input — and refuses exactly one key.
 *
 * That combination is the whole point: `missing-capability` is unavailable to it by
 * construction, so whatever the agent reads has to come from the per-key refusal.
 */
async function serve(): Promise<void> {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([attached]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: createMockCapabilities({ canInput: true }),
		},
		backend: createMockDeviceBackend({
			watchDevices,
			describeDevice: async (serial) => createMockDevice({ serial }),
			deviceInfo: async (serial) => createMockDeviceInfo({ serial }),
			readScreen: async () => [onScreen],
			pressKey: async (serial, key) => {
				pressed.push(key);
				if (key === ABSENT) throw new UnsupportedKeyError(serial, key, REASON);
			},
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
		owner: 'issue-215',
		project: 'rover',
		testName: 'checkout flow',
	});
	const answer = granted.structuredContent as { outcome: string; lease?: { leaseId: string } };
	if (answer.outcome !== 'granted' || !answer.lease) {
		throw new Error(`The test needs a lease and was refused: ${textOf(granted)}`);
	}
	return answer.lease.leaseId;
}

beforeEach(async () => {
	pressed = [];
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

describe('press_key on a device that takes input and has no equivalent for one key', () => {
	it("leads with the host's own sentence, and that sentence names the key", async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'press_key', { leaseId, key: ABSENT });

		expect(result.isError).toBe(true);
		const said = textOf(result);
		// The key by name, and the backend's own words for why — the two things that tell an
		// agent what to ask for instead. A sentence about the device's input in general would
		// leave it with nowhere to go.
		expect(said).toContain(ABSENT);
		expect(said).toContain('app-switcher');
		expect(pressed).toEqual([ABSENT]);
	});

	it('carries a document a client can branch on, and it is not missing-capability', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'press_key', { leaseId, key: ABSENT });

		expect(result.structuredContent).toMatchObject({
			outcome: 'failed',
			failure: { kind: 'unsupported-key', serial: SERIAL, key: ABSENT },
		});
		// The distinctness criterion, asserted rather than left to the shape above: this device
		// declares `canInput`, so a client reading `missing-capability` here would take the whole
		// device off the table over one key it does not have.
		const answer = result.structuredContent as { failure: { kind: string } };
		expect(answer.failure.kind).not.toBe('missing-capability');
	});

	it('still presses every other key, so the refusal is per key and not the tool', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquire(agent);

		const result = await callTool(agent, 'press_key', { leaseId, key: 'home' });

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			outcome: 'ok',
			result: { verb: 'press_key', target: null, device: { serial: SERIAL } },
		});
		expect(pressed).toEqual(['home']);
	});
});
