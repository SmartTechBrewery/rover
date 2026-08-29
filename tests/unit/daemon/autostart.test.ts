/**
 * Autostart (D5) end to end, with **real detached child processes**.
 *
 * This is issue #29's acceptance criterion: three concurrent clients against a socket
 * nobody is serving get three answers carrying the same `pid`. Nothing here is mocked —
 * a mocked `spawn` would prove that a function was called, not that two invocations racing
 * for the same path produce one daemon (ai/TESTING.md).
 *
 * Every test cleans up after itself through the `status` result's `pid`: a detached child
 * is never held as a `ChildProcess`, so the protocol is the only handle on it.
 */

import { access } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { connectToLocalDaemon } from '@/daemon/connect.js';
import { PROTOCOL_VERSION } from '@/ipc/protocol.js';
import {
	connectWithoutStarting,
	createTempSocket,
	isRunning,
	removeTempSocket,
	stopDaemonAt,
	stopProcess,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

/**
 * A whole Node process has to start, load a loader and this module tree, and bind, before
 * any of this can pass — well past vitest's 5 s default, which the unit project does not
 * override.
 */
const TEST_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 20_000;

let temp: TempSocket;

afterEach(async () => {
	if (temp) {
		await stopDaemonAt(temp.socketPath);
		await removeTempSocket(temp);
	}
});

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function connect() {
	return connectToLocalDaemon({
		socketPath: temp.socketPath,
		startTimeoutMs: START_TIMEOUT_MS,
	});
}

describe('connectToLocalDaemon', () => {
	it('starts one daemon for three concurrent first calls', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		temp = await createTempSocket();
		expect(await exists(temp.socketPath)).toBe(false);

		const clients = await Promise.all([connect(), connect(), connect()]);
		const results = await Promise.all(clients.map((client) => client.request('status', {})));
		await Promise.all(clients.map((client) => client.close()));

		expect(results).toHaveLength(3);
		// The headline assertion: one daemon, not three.
		expect(new Set(results.map((result) => result.pid)).size).toBe(1);
		for (const result of results) {
			expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
			// A separate process, so the client never became its own host.
			expect(result.pid).not.toBe(process.pid);
			expect(result.uptimeMs).toBeGreaterThanOrEqual(0);
		}
		expect(isRunning(results[0].pid)).toBe(true);
	});

	it('reuses the running daemon on a later call instead of starting another', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		temp = await createTempSocket();

		const first = await connect();
		const started = await first.request('status', {});
		await first.close();

		const second = await connect();
		const reused = await second.request('status', {});
		await second.close();

		expect(reused.pid).toBe(started.pid);
	});

	it('brings a fresh daemon up over the socket a killed one left behind', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		temp = await createTempSocket();
		const first = await connect();
		const killed = await first.request('status', {});
		await first.close();

		// SIGKILL, so the daemon never runs its shutdown and the socket file survives it —
		// the crashed-daemon case the stale-socket recovery exists for.
		await stopProcess(killed.pid, 'SIGKILL');
		expect(await exists(temp.socketPath)).toBe(true);
		expect(await connectWithoutStarting(temp.socketPath)).toBeNull();

		const second = await connect();
		const replacement = await second.request('status', {});
		await second.close();

		expect(replacement.pid).not.toBe(killed.pid);
	});

	it('starts one daemon when three concurrent clients meet a stale socket', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		temp = await createTempSocket();
		const first = await connect();
		const killed = await first.request('status', {});
		await first.close();

		await stopProcess(killed.pid, 'SIGKILL');
		expect(await exists(temp.socketPath)).toBe(true);

		// Three separate processes now race to reclaim the same corpse — the interleaving in
		// which an unserialized reclaimer can unlink the address of the daemon that just won.
		// One pid across all three answers is the proof that never happened.
		const clients = await Promise.all([connect(), connect(), connect()]);
		const results = await Promise.all(clients.map((client) => client.request('status', {})));
		await Promise.all(clients.map((client) => client.close()));

		expect(new Set(results.map((result) => result.pid)).size).toBe(1);
		expect(results[0].pid).not.toBe(killed.pid);
		// The survivor is reachable through the path, not stranded behind an unlinked one.
		const later = await connectWithoutStarting(temp.socketPath);
		await expect(later?.request('status', {})).resolves.toMatchObject({ pid: results[0].pid });
		await later?.close();
	});

	it('unlinks the socket when the daemon is asked to shut down', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		temp = await createTempSocket();
		const client = await connect();
		const status = await client.request('status', {});
		await client.close();

		await stopProcess(status.pid, 'SIGTERM');

		expect(await exists(temp.socketPath)).toBe(false);
	});
});
