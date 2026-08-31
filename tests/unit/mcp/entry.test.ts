/**
 * The MCP server's documented entry, asserted the only way that proves anything: by
 * **spawning it from a working directory that is not the Rover checkout**.
 *
 * An MCP client picks its own cwd — that is why the README makes the script path absolute — and
 * the failure this guards is a *resolution* failure, so no assertion on a string can see it.
 * `node --import tsx/esm /abs/rover/src/mcp/index.ts` resolves `tsx/esm` against the client's
 * directory rather than against the script, so it starts in the one directory nobody runs an
 * agent from and dies with `Cannot find package 'tsx' imported from <the agent's project>/`
 * everywhere else — before a single frame. `bin/rover-mcp.mjs` is the entry that resolves the
 * loader where the loader actually is, and this is the test that would have caught the version
 * that did not (#104).
 *
 * The cwd is a fresh `mkdtemp` under the OS temp directory, deliberately: nothing above it
 * holds a `node_modules`, so an entry that depended on the caller's directory cannot pass here
 * by accident on the machine that wrote it.
 *
 * The three frames are the README's own probe, and both halves of the answer matter — the
 * handshake, and a `tools/list` that names the `IPC_METHODS` rows, which is a whole module
 * graph having loaded rather than a process having started. **stdout carries nothing else**:
 * every line of it parses as one JSON-RPC message, which is `./stdout.test.ts`'s source scan
 * observed on a real process for once.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ROVER_MCP_NAME, ROVER_MCP_VERSION } from '@/mcp/server.js';

/** The entry an agent's configuration file names — the one the README documents. */
const LAUNCHER = fileURLToPath(new URL('../../../bin/rover-mcp.mjs', import.meta.url));

/** A whole Node process has to start, install a loader, transform this module tree and answer. */
const TEST_TIMEOUT_MS = 60_000;

/** `initialize`, the notification that completes it, and one request. The README's probe. */
const PROBE_FRAMES = [
	{
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'probe', version: '0' },
		},
	},
	{ jsonrpc: '2.0', method: 'notifications/initialized' },
	{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

let elsewhere: string | undefined;

afterEach(async () => {
	if (elsewhere !== undefined) {
		await rm(elsewhere, { recursive: true, force: true });
		elsewhere = undefined;
	}
});

interface Probed {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
}

/**
 * Run the launcher with `cwd` as its working directory, feed it the probe and read what it
 * wrote.
 *
 * stdin is closed after the frames, which is how a stdio transport is told the session is over
 * — so this resolves on the process's own exit rather than on a timer.
 *
 * `ROVER_HOST_ADDRESS` and `ROVER_PROJECT_FILE` are blanked rather than inherited: both are
 * startup-time configuration this server dies on when it is half-specified, and a value in the
 * environment of whoever runs the suite would make this test's subject their machine.
 */
async function probeFrom(cwd: string): Promise<Probed> {
	const child = spawn(process.execPath, [LAUNCHER], {
		cwd,
		env: { ...process.env, ROVER_HOST_ADDRESS: '', ROVER_PROJECT_FILE: '' },
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
		stderr += chunk;
	});

	child.stdin.end(PROBE_FRAMES.map((frame) => `${JSON.stringify(frame)}\n`).join(''));

	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	return { stdout, stderr, exitCode };
}

/** Every line of stdout, parsed as the JSON-RPC message it has to be. */
function messagesIn(stdout: string): Record<string, unknown>[] {
	return stdout
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the MCP server entry, started from somebody else’s project directory', () => {
	it('handshakes and lists its tools with no node_modules anywhere above the cwd', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		elsewhere = await mkdtemp(join(tmpdir(), 'rover-agent-project-'));

		const { stdout, stderr, exitCode } = await probeFrom(elsewhere);

		// The failure this exists for is `ERR_MODULE_NOT_FOUND` on stderr with nothing on
		// stdout at all, so the diagnostic is named rather than left to a length assertion.
		expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
		expect(stderr).toBe('');
		expect(exitCode).toBe(0);

		const [handshake, listed] = messagesIn(stdout);
		expect(handshake).toMatchObject({
			id: 1,
			result: { serverInfo: { name: ROVER_MCP_NAME, version: ROVER_MCP_VERSION } },
		});
		// A whole module graph loaded, not merely a process that started: the tool table is
		// built from `IPC_METHODS` at registration time.
		const tools = (listed?.result as { tools?: { name: string }[] }).tools ?? [];
		expect(tools.map((tool) => tool.name)).toContain('acquire_device');
		expect(tools.map((tool) => tool.name)).toContain('install_app');
	});

	it('writes protocol frames and nothing else to stdout', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		elsewhere = await mkdtemp(join(tmpdir(), 'rover-agent-project-'));

		const { stdout } = await probeFrom(elsewhere);

		// One stray line in front of the first frame is a protocol error whose cause is
		// nowhere near where it surfaces — which is why the entry is `node` on this launcher
		// and never `npm run mcp`, whose banner lands here.
		expect(messagesIn(stdout)).toHaveLength(2);
		for (const message of messagesIn(stdout)) {
			expect(message.jsonrpc).toBe('2.0');
		}
	});
});
