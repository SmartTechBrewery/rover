/**
 * The two tools whose answer is bytes, driven by a real MCP client against a real daemon on a
 * real socket (ai/TESTING.md, the `tests/unit/mcp/` exception).
 *
 * The subject is what the **agent** receives: an image it can look at, a file on its own disk,
 * and a document that does not repeat either of them as base64. What the host did to the
 * hardware is `tests/unit/daemon/verb-dispatch.test.ts`' subject and nothing here adds to it.
 *
 * `ROVER_MCP_ARTIFACT_DIR` is stubbed into the same temp directory the socket lives in, so
 * cleanup is one `rm` and no test ever writes into the operator's real one.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
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
import { DEFAULT_RECORDING_MS } from '@/verbs/record.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockRecordingBytes } from '../../helpers/factories.js';
import { callTool, connectMcpAgent, textOf } from '../../helpers/mcp-agent.js';
import {
	acquireLease,
	CAPTURED_IMAGE,
	EXTRACTED_FRAMES,
	filesIn,
	serveDevice,
} from '../../helpers/mcp-artifacts.js';

const extractFramesMock = vi.hoisted(() => vi.fn());

// The host's decoder is an external program; slicing is `tests/unit/daemon/frames.test.ts`'
// subject, and this suite only needs the `frames` field to arrive carrying real PNG bytes.
vi.mock('@/daemon/frames.js', () => ({ extractFrames: extractFramesMock }));

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

/** One image content block, or a failed test naming what came back instead. */
function imageBlocks(content: unknown): Array<{ data: string; mimeType: string }> {
	return (content as Array<{ type: string; data: string; mimeType: string }>).filter(
		(block) => block.type === 'image',
	);
}

beforeEach(async () => {
	temp = await createTempSocket();
	artifactDir = path.join(temp.dir, 'agent-artifacts');
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	vi.stubEnv(ARTIFACT_DIR_ENV_VAR, artifactDir);
	// Stubbed empty so a developer's own exported remote host cannot decide which host the
	// `local` server here ends up asking.
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

describe('the screenshot tool', () => {
	it('hands the capture back as an image block, byte for byte', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'screenshot', { leaseId });

		expect(result.isError).toBeFalsy();
		const [image] = imageBlocks(result.content);
		// The whole point of the round trip: what the backend captured is what the model sees.
		expect(new Uint8Array(Buffer.from(image?.data ?? '', 'base64'))).toEqual(CAPTURED_IMAGE);
		// The host's own media type, sniffed off the bytes — never one this client guessed.
		expect(image?.mimeType).toBe('image/png');
	});

	it('writes nothing and reports no path at all', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'screenshot', { leaseId });

		// An inline image is the one form of an artifact that needs no path, which is how D19's
		// "a path handed to the agent must exist on the agent's machine" is satisfied here.
		expect(filesIn(artifactDir)).toEqual([]);
		expect(result.structuredContent).not.toHaveProperty('artifactPath');
	});

	it('carries the answer whole in structuredContent, with no base64 in it', async () => {
		await serve();
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'screenshot', { leaseId });

		expect(result.structuredContent).toMatchObject({
			outcome: 'ok',
			result: {
				verb: 'screenshot',
				device: { serial: expect.any(String) },
				// Described rather than repeated: the bytes are already in the image block above,
				// and a second copy would put several megabytes in front of the model twice.
				artifact: { mediaType: 'image/png', byteLength: CAPTURED_IMAGE.byteLength },
			},
		});
		expect(JSON.stringify(result.structuredContent)).not.toContain('base64');
		expect(textOf(result)).not.toContain('base64');
	});
});

describe('the record_video tool', () => {
	it('writes the recording on this machine and reports its absolute local path', async () => {
		await serve({
			recordVideo: vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
				createMockRecordingBytes(),
			),
		});
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'record_video', { leaseId });

		expect(result.isError).toBeFalsy();
		const { artifactPath } = result.structuredContent as { artifactPath: string };
		expect(path.isAbsolute(artifactPath)).toBe(true);
		expect(path.dirname(artifactPath)).toBe(path.resolve(artifactDir));
		// The file is real, and it is the recording rather than a shorter version of it.
		expect(new Uint8Array(await readFile(artifactPath))).toEqual(createMockRecordingBytes());
	});

	it('hands the frames back as image blocks, in recording order', async () => {
		await serve({
			recordVideo: vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
				createMockRecordingBytes(),
			),
		});
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'record_video', { leaseId });

		// The frames are the part an agent actually looks at — an mp4 is not something a model
		// can read — so they come back inline rather than as a second file to open.
		const decoded = imageBlocks(result.content).map((block) =>
			Uint8Array.from(Buffer.from(block.data, 'base64')),
		);
		expect(decoded).toEqual(EXTRACTED_FRAMES);
		expect(imageBlocks(result.content).map((block) => block.mimeType)).toEqual([
			'image/png',
			'image/png',
		]);
	});

	it('describes the recording and the frames without repeating either as base64', async () => {
		await serve({
			recordVideo: vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
				createMockRecordingBytes(),
			),
		});
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const result = await callTool(agent, 'record_video', { leaseId });

		expect(result.structuredContent).toMatchObject({
			outcome: 'ok',
			result: {
				verb: 'record_video',
				artifact: { mediaType: 'video/mp4' },
				// The array stays and each entry is described, so a host that extracted nothing is
				// never confused with a field this client dropped.
				frames: EXTRACTED_FRAMES.map((frame) => ({
					mediaType: 'image/png',
					byteLength: frame.byteLength,
				})),
			},
		});
		expect(JSON.stringify(result.structuredContent)).not.toContain('base64');
	});

	it('sends no duration of its own, leaving the verb’s default the only one', async () => {
		const recordVideo = vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
			createMockRecordingBytes(),
		);
		await serve({ recordVideo });
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		await callTool(agent, 'record_video', { leaseId });

		// The tool imports `DEFAULT_RECORDING_MS` to size its request timeout and never puts it
		// on the wire: a second default there is a second number free to disagree with the
		// verb's own.
		expect(recordVideo.mock.calls[0]?.[1]).toEqual({ durationMs: DEFAULT_RECORDING_MS });
	});

	it('passes the caller’s own knobs through to the host', async () => {
		const recordVideo = vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
			createMockRecordingBytes(),
		);
		await serve({ recordVideo });
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		await callTool(agent, 'record_video', { leaseId, durationMs: 1500, framesPerSecond: 3 });

		expect(recordVideo.mock.calls[0]?.[1]).toEqual({ durationMs: 1500 });
		// The rate is the extractor's knob rather than the recorder's: the device is asked for a
		// recording and the sampling happens on the bytes afterwards.
		expect(extractFramesMock.mock.calls[0]?.[2]).toEqual({ framesPerSecond: 3 });
	});

	it('gives two calls two files rather than overwriting the first answer’s path', async () => {
		await serve({
			recordVideo: vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
				createMockRecordingBytes(),
			),
		});
		const agent = await connectAgent();
		const leaseId = await acquireLease(agent);

		const first = await callTool(agent, 'record_video', { leaseId });
		const second = await callTool(agent, 'record_video', { leaseId });

		// An agent recording twice in a row is ordinary, and a name that collided would delete a
		// file whose path had already been reported as an answer.
		expect((first.structuredContent as { artifactPath: string }).artifactPath).not.toBe(
			(second.structuredContent as { artifactPath: string }).artifactPath,
		);
		expect(filesIn(artifactDir)).toHaveLength(2);
	});
});
