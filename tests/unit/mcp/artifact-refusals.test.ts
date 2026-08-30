/**
 * **A refusal is loud, and it leaves no file behind.**
 *
 * The four named refusals a byte-carrying verb can give — `artifact-too-large`,
 * `unfinished-recording`, `frame-extraction-unavailable`, `frames-too-large` — and a lease that
 * is no longer live. Each has to reach the agent as `isError` naming it, because not getting
 * what you asked for must never read as having got it. The fifth way this can end, a decoded
 * length that disagrees with the host's, is a property of the writer both adapters now share
 * and is asserted on it directly (`tests/unit/cli/artifacts.test.ts`).
 *
 * The assertion that matters most here is a **negative** one, repeated on every path:
 * `filesIn(artifactDir)` is empty. A transfer that failed and left a short or zero-byte file
 * behind is exactly what this contract exists to prevent, and it is invisible to any test that
 * only checks `isError` — the ordering it rests on is that the write is the last thing that
 * happens and only on the `ok` branch.
 */

import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDeviceBackendRegistryForTesting } from '@/backends/registry.js';
import type { DeviceBackend } from '@/core/device.js';
import { UnfinishedRecordingError } from '@/core/errors.js';
import type { RunningDaemon } from '@/daemon/listen.js';
import {
	HOST_ADDRESS_ENV_VAR,
	HOST_PORT_ENV_VAR,
	HOST_TOKEN_ENV_VAR,
} from '@/daemon/network-config.js';
import { ARTIFACT_DIR_ENV_VAR } from '@/mcp/_shared/artifact.js';
import { FrameExtractionUnavailableError, FramesTooLargeError } from '@/verbs/errors.js';
import { MAX_FRAMES_BYTES } from '@/verbs/record.js';
import { MAX_ARTIFACT_BYTES } from '@/verbs/result.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockRecordingBytes } from '../../helpers/factories.js';
import { callTool, connectMcpAgent, textOf } from '../../helpers/mcp-agent.js';
import {
	ARTIFACT_SERIAL,
	acquireLease,
	EXTRACTED_FRAMES,
	filesIn,
	serveDevice,
} from '../../helpers/mcp-artifacts.js';

const extractFramesMock = vi.hoisted(() => vi.fn());

vi.mock('@/daemon/frames.js', () => ({ extractFrames: extractFramesMock }));

/** A backend that records fine, so a refusal in these tests is the one the test arranged. */
const recordsFine = {
	recordVideo: vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
		createMockRecordingBytes(),
	),
};

let temp: TempSocket;
let artifactDir: string;
const running: RunningDaemon[] = [];
const clients: Client[] = [];

async function serve(overrides: Partial<DeviceBackend> = {}): Promise<void> {
	running.push(await serveDevice(temp, overrides));
}

async function connectAgent(): Promise<Client> {
	const client = await connectMcpAgent('local');
	clients.push(client);
	return client;
}

beforeEach(async () => {
	temp = await createTempSocket();
	artifactDir = path.join(temp.dir, 'agent-artifacts');
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	vi.stubEnv(ARTIFACT_DIR_ENV_VAR, artifactDir);
	for (const variable of [HOST_ADDRESS_ENV_VAR, HOST_PORT_ENV_VAR, HOST_TOKEN_ENV_VAR]) {
		vi.stubEnv(variable, '');
	}
	extractFramesMock.mockReset();
	extractFramesMock.mockResolvedValue(EXTRACTED_FRAMES);
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	vi.restoreAllMocks();
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	await removeTempSocket(temp);
});

describe('a capture the host will not carry', () => {
	it('names artifact-too-large with both numbers, and writes nothing', async () => {
		await serve({
			screenshot: vi.fn<DeviceBackend['screenshot']>(
				async () => new Uint8Array(MAX_ARTIFACT_BYTES + 1),
			),
		});
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'screenshot', { leaseId });

		expect(result.isError).toBe(true);
		const said = textOf(result);
		expect(said).toContain('artifact-too-large');
		// Both numbers, which is what makes the refusal actionable rather than merely a no.
		expect(said).toContain(String(MAX_ARTIFACT_BYTES + 1));
		expect(said).toContain(String(MAX_ARTIFACT_BYTES));
		expect(filesIn(artifactDir)).toEqual([]);
	});

	it('sends no image block back with a refusal', async () => {
		await serve({
			screenshot: vi.fn<DeviceBackend['screenshot']>(
				async () => new Uint8Array(MAX_ARTIFACT_BYTES + 1),
			),
		});
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'screenshot', { leaseId });

		// There are no bytes: an empty or placeholder image beside a refusal would be exactly
		// the plausible-looking result ai/RULES.md §2 forbids.
		expect(result.content.filter((block) => block.type === 'image')).toEqual([]);
		expect(result.structuredContent).toMatchObject({ outcome: 'failed' });
	});
});

describe('a recording the host will not hand over', () => {
	it('names unfinished-recording and the device, and writes nothing', async () => {
		await serve({
			recordVideo: vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () => {
				throw new UnfinishedRecordingError(ARTIFACT_SERIAL, 512);
			}),
		});
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'record_video', { leaseId });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('unfinished-recording');
		expect(textOf(result)).toContain(ARTIFACT_SERIAL);
		// A file no player would open is never written here either.
		expect(filesIn(artifactDir)).toEqual([]);
	});

	it('names frame-extraction-unavailable on a host with no decoder, and writes nothing', async () => {
		extractFramesMock.mockRejectedValue(
			new FrameExtractionUnavailableError(ARTIFACT_SERIAL, 'ffmpeg', 'spawn ffmpeg ENOENT'),
		);
		await serve(recordsFine);
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'record_video', { leaseId });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('frame-extraction-unavailable');
		// The answer is the video and the frames or neither. Writing the recording anyway would
		// hand back a file whose absent frames read as a screen on which nothing happened.
		expect(filesIn(artifactDir)).toEqual([]);
	});

	it('names frames-too-large and writes nothing', async () => {
		extractFramesMock.mockRejectedValue(
			new FramesTooLargeError(ARTIFACT_SERIAL, 61, MAX_FRAMES_BYTES + 1, MAX_FRAMES_BYTES),
		);
		await serve(recordsFine);
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'record_video', { leaseId });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('frames-too-large');
		expect(filesIn(artifactDir)).toEqual([]);
	});
});

describe('a lease that is not live', () => {
	it('refuses both byte-carrying tools by name and leaves the directory alone', async () => {
		await serve(recordsFine);
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);
		await callTool(agent, 'release_device', { leaseId });

		for (const tool of ['screenshot', 'record_video']) {
			const result = await callTool(agent, tool, { leaseId });

			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({ outcome: 'refused', reason: 'no-lease' });
		}
		expect(filesIn(artifactDir)).toEqual([]);
	});
});
