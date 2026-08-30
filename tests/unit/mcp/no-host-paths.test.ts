/**
 * **No path an agent receives is a host path** (D19) — the headline criterion of the artifact
 * contract, asserted from the agent's end.
 *
 * The point is not that the two tools happen to report sensible paths today. It is that the
 * host has paths of its own for exactly these bytes — the durable archive writes every capture
 * and every recording into its own tree (D23) — and none of them may ever appear in an answer.
 * On a local host the two machines are the same machine and a leaked host path would still
 * *work*, which is precisely why this is a test rather than a habit: the day the host is
 * somewhere else, the path names nothing, or worse, names something.
 *
 * So the agent's artifact directory is a temp directory of its own, deliberately **not** under
 * the one holding the socket and the host's archive, and the host's side is asserted non-empty
 * first — a green run over an archive that wrote nothing would be proving nothing.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDeviceBackendRegistryForTesting } from '@/backends/registry.js';
import type { DeviceBackend } from '@/core/device.js';
import type { RunningDaemon } from '@/daemon/listen.js';
import {
	HOST_ADDRESS_ENV_VAR,
	HOST_PORT_ENV_VAR,
	HOST_TOKEN_ENV_VAR,
} from '@/daemon/network-config.js';
import { ARTIFACT_DIR_ENV_VAR } from '@/mcp/_shared/artifact.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockRecordingBytes } from '../../helpers/factories.js';
import { callTool, connectMcpAgent, textOf } from '../../helpers/mcp-agent.js';
import {
	acquireLease,
	EXTRACTED_FRAMES,
	filesIn,
	serveDevice,
} from '../../helpers/mcp-artifacts.js';

const extractFramesMock = vi.hoisted(() => vi.fn());

vi.mock('@/daemon/frames.js', () => ({ extractFrames: extractFramesMock }));

let temp: TempSocket;
/** The agent's own directory, in its own place — never under the host's. */
let agentDir: string;
const running: RunningDaemon[] = [];
const clients: Client[] = [];

/** Everything the agent was handed for one call: the blocks, the text and the document. */
function wholeAnswer(result: CallToolResult): string {
	return `${textOf(result)}\n${JSON.stringify(result.structuredContent)}`;
}

/** Every file under `root`, however deep — what the host wrote for itself. */
async function treeOf(root: string): Promise<string[]> {
	try {
		return (await readdir(root, { recursive: true })).map(String);
	} catch {
		return [];
	}
}

beforeEach(async () => {
	temp = await createTempSocket();
	agentDir = await mkdtemp(path.join(tmpdir(), 'rover-agent-'));
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	vi.stubEnv(ARTIFACT_DIR_ENV_VAR, agentDir);
	for (const variable of [HOST_ADDRESS_ENV_VAR, HOST_PORT_ENV_VAR, HOST_TOKEN_ENV_VAR]) {
		vi.stubEnv(variable, '');
	}
	extractFramesMock.mockReset();
	extractFramesMock.mockResolvedValue(EXTRACTED_FRAMES);
	running.push(
		await serveDevice(temp, {
			recordVideo: vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
				createMockRecordingBytes(),
			),
		}),
	);
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	vi.restoreAllMocks();
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	await removeTempSocket(temp);
	await rm(agentDir, { recursive: true, force: true });
});

async function connectAgent(): Promise<Client> {
	const client = await connectMcpAgent('local');
	clients.push(client);
	return client;
}

describe('what an artifact answer may contain', () => {
	it('puts the recording under the agent’s own directory and reports it absolute', async () => {
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'record_video', { leaseId });

		const { artifactPath } = result.structuredContent as { artifactPath: string };
		expect(path.isAbsolute(artifactPath)).toBe(true);
		// This process wrote it, on this machine, in the directory its own configuration named.
		expect(artifactPath.startsWith(`${path.resolve(agentDir)}${path.sep}`)).toBe(true);
		expect(filesIn(agentDir)).toHaveLength(1);
	});

	it('names no path from the host’s side of the wire, in either answer', async () => {
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const answers = [
			wholeAnswer(await callTool(agent, 'screenshot', { leaseId })),
			wholeAnswer(await callTool(agent, 'record_video', { leaseId })),
		];

		// The positive control: the host really did write these same bytes into its own archive,
		// so a green assertion below is about restraint rather than about an empty tree.
		expect(await treeOf(temp.artifactsRoot)).not.toEqual([]);
		for (const answer of answers) {
			// The archive root, the archive tree it built under it, and the socket the call
			// arrived on. None of the three exists on an agent's machine when the host is
			// somewhere else, and all three are trivially available to the code that answers.
			expect(answer).not.toContain(temp.artifactsRoot);
			expect(answer).not.toContain(temp.socketPath);
			expect(answer).not.toContain(temp.dir);
		}
	});

	it('gives screenshot no path at all, because an inline image needs none', async () => {
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'screenshot', { leaseId });

		// D19 is satisfied here by there being nothing to satisfy it about, which is why the
		// capture comes back as an image block rather than as a file this server invented a name
		// for on somebody's disk.
		expect(result.structuredContent).not.toHaveProperty('artifactPath');
		expect(filesIn(agentDir)).toEqual([]);
	});
});
