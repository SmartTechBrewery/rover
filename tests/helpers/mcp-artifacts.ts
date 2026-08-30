/**
 * The arrangement the three artifact suites share: a device whose captures are real bytes, a
 * daemon on a temp socket, and a lease taken the way an agent takes one.
 *
 * Three suites need the same six things — `tests/unit/mcp/artifact-tools.test.ts`,
 * `./artifact-refusals.test.ts` and `./no-host-paths.test.ts` — and a per-file copy is the
 * fixture duplication ai/TESTING.md "Test data" is about. What is *not* here is lifecycle:
 * closing the agent, closing the daemon and resetting the registry stay with each suite's own
 * `afterEach`, exactly as `./mcp-agent.ts` says.
 */

import { existsSync, readdirSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { vi } from 'vitest';
import { registerDeviceBackend } from '@/backends/registry.js';
import type { DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { TempSocket } from './daemon-socket.js';
import { createMockCapabilities, createMockDevice, createMockDeviceBackend } from './factories.js';
import { callTool, textOf } from './mcp-agent.js';

/** The one device every artifact suite leases. */
export const ARTIFACT_SERIAL = parseDeviceSerial('attached-1');

/**
 * A PNG signature and then some, so the media type the host sniffs off the capture is a real
 * one and the `image` block an agent receives carries a real `mimeType` rather than
 * `application/octet-stream`.
 */
export const CAPTURED_IMAGE = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef,
]);

/**
 * Two frames, each a different length, so a mapping that dropped the array and one that kept
 * only its first entry are told apart — and so the two `image` blocks cannot be confused.
 */
export const EXTRACTED_FRAMES = [
	Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
	Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02, 0x03]),
];

/**
 * A daemon on `temp`'s socket with one ready device behind a fully capable backend.
 *
 * A real daemon rather than a mocked IPC client, for `tests/unit/mcp/verb-calls.test.ts`'s
 * reason: the whole job of this layer is to carry a tool call to a host and carry its bytes
 * back, so the wiring is the subject and a stub in the middle of it asserts nothing.
 */
export async function serveDevice(
	temp: TempSocket,
	overrides: Partial<DeviceBackend> = {},
): Promise<RunningDaemon> {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([createMockDevice({ serial: ARTIFACT_SERIAL })]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	registerDeviceBackend({
		manifest: { platform: 'test-platform', label: 'Test', capabilities: createMockCapabilities() },
		backend: createMockDeviceBackend({
			watchDevices,
			// The factory's own default ignores the serial it is asked about, which would quietly
			// make every call land on one device whatever the lease said.
			describeDevice: async (serial) => createMockDevice({ serial }),
			screenshot: vi.fn<DeviceBackend['screenshot']>(async () => CAPTURED_IMAGE),
			...overrides,
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
	return result;
}

/** A held lease, taken through `acquire_device` because that is how an agent gets one. */
export async function acquireLease(agent: Client): Promise<string> {
	const granted = await callTool(agent, 'acquire_device', {
		serial: ARTIFACT_SERIAL,
		owner: 'issue-90',
		project: 'rover',
	});
	const answer = granted.structuredContent as { outcome: string; lease?: { leaseId: string } };
	if (answer.outcome !== 'granted' || !answer.lease) {
		throw new Error(`The test needs a lease and was refused: ${textOf(granted)}`);
	}
	return answer.lease.leaseId;
}

/**
 * What is in `directory` right now — and `[]` for a directory that does not exist.
 *
 * The two are the same answer to the question every refusal test asks: **nothing was left
 * behind**. A server that never had bytes to write never creates the directory at all, and a
 * test that demanded one exist would be asserting the opposite of what it wants.
 */
export function filesIn(directory: string): string[] {
	return existsSync(directory) ? readdirSync(directory) : [];
}
