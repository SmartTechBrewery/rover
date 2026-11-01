/**
 * The five device tools, driven by a real MCP client against a real daemon on a real socket.
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

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
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
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';
import { callTool, connectMcpAgent, textOf } from '../../helpers/mcp-agent.js';

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });

/** A token long enough for the client-side floor, so a remote case fails on the *connection*. */
const A_TOKEN = 'x'.repeat(43);

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: Client[] = [];

/**
 * One fully capable backend with `attached-1` on it, handed back so a suite can read what the host
 * asked of it. `describeDevice` is what re-verification answers — `null` being "this host cannot
 * see it" (D6) — and by default every serial asked about is attached here.
 */
function registerFakeBackend(
	describeDevice: DeviceBackend['describeDevice'] = async (serial) => createMockDevice({ serial }),
): DeviceBackend {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([attached]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	const backend = createMockDeviceBackend({ watchDevices, describeDevice });
	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: {
				canReadScreen: true,
				canInput: true,
				canControlNetwork: true,
				canRecordVideo: true,
				canControlRecording: true,
				canHideKeyboard: false,
				canPullAppFile: false,
			},
		},
		backend,
	});
	return backend;
}

async function startHost(): Promise<void> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		keptTestsPath: temp.keptTestsPath,
		retention: temp.retention,
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

/** An MCP client this suite closes in `afterEach` (`../../helpers/mcp-agent.ts`). */
async function connectAgent(host: HostName = 'local', defaultProject?: string): Promise<Client> {
	const client = await connectMcpAgent(host, defaultProject);
	clients.push(client);
	return client;
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

		const result = await callTool(agent, 'status');

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

		const result = await callTool(agent, 'list_devices');

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

		const granted = await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
		});
		expect(granted.isError).toBeFalsy();
		const lease = (granted.structuredContent as { lease: { leaseId: string } }).lease;

		const listed = await callTool(agent, 'list_devices');
		expect(listed.structuredContent).toMatchObject({
			devices: [{ heldBy: { owner: 'issue-112', project: 'rover', testName: 'checkout flow' } }],
		});

		const released = await callTool(agent, 'release_device', { leaseId: lease.leaseId });
		expect(released.isError).toBeFalsy();
		expect(released.structuredContent).toEqual({ released: true });
	});

	it('attributes a lease to the configured project when the call omits one', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent('local', 'checkout-web');

		const granted = await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-112',
			testName: 'checkout flow',
		});

		expect(granted.isError).toBeFalsy();
		// It reaches the *host* filled in — the wire is unchanged, and `project` is the required
		// opaque string it always was. What moved is who typed it (D22).
		expect(granted.structuredContent).toMatchObject({
			lease: { owner: 'issue-112', project: 'checkout-web' },
		});
		const listed = await callTool(agent, 'list_devices');
		expect(listed.structuredContent).toMatchObject({
			devices: [{ heldBy: { owner: 'issue-112', project: 'checkout-web' } }],
		});
	});

	it('passes a project the call did supply through untouched, default or no default', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent('local', 'checkout-web');

		const granted = await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-112',
			project: 'storefront',
			testName: 'checkout flow',
		});

		expect(granted.structuredContent).toMatchObject({ lease: { project: 'storefront' } });
	});

	/*
	 * The optional string an agent may supply (D22, as amended #148): it reaches the host, comes
	 * back on the grant, and is on the holder every other agent sees in a listing — which is the
	 * whole point of it being on `LeaseHolder` and not only on the grant.
	 */
	it('carries a testDescription to the host, onto the grant and into the listing', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();
		const testDescription = 'Checking the checkout flow survives the second app bar row.';

		const granted = await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
			testDescription,
		});

		expect(granted.isError).toBeFalsy();
		expect(granted.structuredContent).toMatchObject({ lease: { testDescription } });
		const listed = await callTool(agent, 'list_devices');
		expect(listed.structuredContent).toMatchObject({ devices: [{ heldBy: { testDescription } }] });
	});

	// It is optional, so a call without one is granted — and carries no key rather than a blank.
	it('grants a lease with no description at all when the call supplies none', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();

		const granted = await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
		});

		expect(granted.isError).toBeFalsy();
		expect(JSON.stringify(granted.structuredContent)).not.toContain('testDescription');
	});

	/*
	 * The lease half of #150 over a live host, as #205 amended it: the name reaches the store, the
	 * **minted** id comes back on the grant, and that same id is on the holder every other agent
	 * sees — the same three places `testDescription` is, and for the same reason it is on
	 * `LeaseHolder` rather than only on the grant. The round trip is the second half: the id the
	 * grant answered with, sent again, lands in that group.
	 */
	it('mints the groupId onto the grant, lists it, and takes it back verbatim', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();

		const granted = await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-150',
			project: 'rover',
			testName: 'app bar top space',
			groupId: 'app-bar-top-space',
		});

		expect(granted.isError).toBeFalsy();
		const filed = (granted.structuredContent as { lease: { groupId?: string } }).lease.groupId;
		expect(filed?.startsWith('app-bar-top-space.')).toBe(true);
		expect(filed).not.toBe('app-bar-top-space');

		const listed = await callTool(agent, 'list_devices');
		expect(listed.structuredContent).toMatchObject({
			devices: [{ heldBy: { groupId: filed } }],
		});

		const joined = await callTool(agent, 'acquire_device', {
			serial: 'attached-2',
			owner: 'issue-150',
			project: 'rover',
			testName: 'app bar top space',
			groupId: filed,
		});
		expect(joined.isError).toBeFalsy();
		expect(joined.structuredContent).toMatchObject({ lease: { groupId: filed } });
	});

	/*
	 * A refusal is data on the wire and an error to the agent, exactly as `label-without-group` is:
	 * a name carrying the reserved separator is refused by the host, in the host's own sentence,
	 * with no client code of its own (#205).
	 */
	it('surfaces the separator refusal as an error naming the field', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();

		const refused = await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-205',
			project: 'rover',
			testName: 'app bar top space',
			groupId: 'statistics.summary',
		});

		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("'groupId'");
		expect(refused.structuredContent).toMatchObject({
			outcome: 'refused',
			reason: 'separator-in-group-id',
			heldBy: null,
		});
	});

	// Optional, so a call without one is granted — and carries no key rather than a blank.
	it('grants a lease with no group at all when the call supplies none', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();

		const granted = await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-150',
			project: 'rover',
			testName: 'app bar top space',
		});

		expect(granted.isError).toBeFalsy();
		expect(JSON.stringify(granted.structuredContent)).not.toContain('groupId');
	});

	it('refuses a call that omits project when nothing is configured to default it', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();

		const result = await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-112',
			testName: 'checkout flow',
		});

		// Refused by the SDK against the declaration, before the handler runs — which is why
		// the declaration is what changes when a default exists, and never the handler alone.
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('project');
	});

	it('refuses a call that omits testName — nothing defaults it (D22, as amended #129)', async () => {
		registerFakeBackend();
		await startHost();
		// With a project hook file configured, so the one thing that can be defaulted is, and
		// the refusal is unambiguously about the field that cannot.
		const agent = await connectAgent('local', 'checkout-web');

		const result = await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-112',
			project: 'rover',
		});

		// Refused by the SDK against the declaration, so the requirement is surfaced to the
		// agent rather than sent to the host to be answered as `invalid_params`.
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('testName');
	});

	it('makes a refused acquire an error naming the holder, never a plausible success', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();
		await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
		});

		const refused = await callTool(agent, 'acquire_device', {
			serial: 'attached-1',
			owner: 'pr-127-review',
			project: 'rover',
			testName: 'checkout flow',
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

		const result = await callTool(agent, 'release_device', { leaseId: 'no-such-lease' });

		// The store cannot tell a never-granted id from an expired one, so this is an honest
		// answer and not an error — the agent reads `released: false` and moves on.
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({ released: false });
	});
});

/*
 * #345: the operator's own action, reached by an agent the operator is directing. Two clients
 * against one host, because that is the case the row exists for — the lease belongs to a different
 * session, and the agent ending it was never handed its id (D20). What `rover force-release` does
 * over the socket is the bar: the same release path, the same restoration (D9), and the holder
 * finding out from its next call.
 */
describe('force_release_device over a live host', () => {
	it('ends a lease the caller never took, restores the device, and refuses the holder next', async () => {
		const backend = registerFakeBackend();
		await startHost();
		const holder = await connectAgent();
		const directed = await connectAgent();
		const granted = await callTool(holder, 'acquire_device', {
			serial: 'attached-1',
			owner: 'dev-session',
			project: 'rover',
			testName: 'checkout flow',
		});
		const leaseId = (granted.structuredContent as { lease: { leaseId: string } }).lease.leaseId;

		// No lease id anywhere in the call: the device is what the directed agent names.
		const released = await callTool(directed, 'force_release_device', {
			serial: 'attached-1',
			actor: 'karolina',
		});

		expect(released.isError).toBeFalsy();
		expect(released.structuredContent).toMatchObject({
			outcome: 'released',
			heldBy: { owner: 'dev-session', project: 'rover', testName: 'checkout flow' },
		});
		// The holder through the public projection, and never its credential (D20) — ending a lease
		// must not be a way to come by the id for the next one.
		expect(textOf(released)).not.toContain(leaseId);
		expect(JSON.stringify(released.structuredContent)).not.toContain('leaseId');

		const next = await callTool(holder, 'device_info', { leaseId });
		expect(next.isError).toBe(true);
		expect(next.structuredContent).toMatchObject({ outcome: 'refused', reason: 'no-lease' });

		// A grant waits out the previous lessee's restoration (D9), so once this one is granted the
		// release path has run to the end — the radios put back exactly as a release puts them.
		const taken = await callTool(directed, 'acquire_device', {
			serial: 'attached-1',
			owner: 'issue-345',
			project: 'rover',
			testName: 'checkout flow',
		});
		expect(taken.isError).toBeFalsy();
		expect(backend.setAirplaneMode).toHaveBeenCalledWith('attached-1', false);
		expect(backend.setWifiEnabled).toHaveBeenCalledWith('attached-1', true);
	});

	/*
	 * Each refusal is the host's own answer, so it has to arrive as that answer: `isError`, so
	 * "nothing to end" never reads as something ended, with the reason by name in the document —
	 * never the `force_release_device failed: …` sentence a host that could not be reached gets.
	 */
	it.each([
		{ reason: 'not-held', serial: 'attached-1' },
		{ reason: 'gone', serial: 'vanished-1' },
		{ reason: 'not-attached', serial: 'foreign-1' },
	])('reaches the agent as the named refusal $reason', async ({ reason, serial }) => {
		registerFakeBackend(async (asked) => {
			if (asked === 'vanished-1') {
				return null;
			}
			return createMockDevice({
				serial: asked,
				attachment: asked === 'foreign-1' ? 'another-host' : 'this-host',
			});
		});
		await startHost();
		const agent = await connectAgent();

		const refused = await callTool(agent, 'force_release_device', { serial, actor: 'karolina' });

		expect(refused.isError).toBe(true);
		expect(refused.structuredContent).toMatchObject({ outcome: 'refused', reason });
		expect(textOf(refused)).toContain(`"reason": "${reason}"`);
		expect(textOf(refused)).not.toContain('force_release_device failed');
	});

	it('refuses a call that names no actor — nothing derives one', async () => {
		registerFakeBackend();
		await startHost();
		const agent = await connectAgent();

		const result = await callTool(agent, 'force_release_device', { serial: 'attached-1' });

		// Refused by the SDK against the declaration, before anything reaches the host: who ended
		// somebody else's lease is the caller's to say (D28), and the server has nothing to say it with.
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('actor');
	});
});

describe('what a tool does when the answer is not an answer', () => {
	it('rejects an argument the params schema refuses, before anything reaches the host', async () => {
		await startHost();
		const agent = await connectAgent();

		const result = await callTool(agent, 'acquire_device', {
			serial: '   ',
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
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

		const result = await callTool(agent, 'list_devices');

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
