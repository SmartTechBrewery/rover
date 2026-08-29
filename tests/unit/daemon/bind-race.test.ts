/**
 * The bind race, against a real unix socket in a temp directory.
 *
 * There is no mock of a socket here on purpose (ai/TESTING.md): what R6 promises is that
 * **the kernel's `bind` is the mutual exclusion**, and a fake `listen()` that never touches
 * the filesystem cannot fail with `EADDRINUSE`, so it cannot prove the thing being claimed.
 */

import { access, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningDaemon, type StartResult, startDaemon } from '@/daemon/listen.js';
import { PROTOCOL_VERSION } from '@/ipc/protocol.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

let temp: TempSocket;
const running: RunningDaemon[] = [];

async function start(socketPath: string): Promise<StartResult> {
	const result = await startDaemon({ socketPath });
	if (result.started) {
		running.push(result);
	}
	return result;
}

afterEach(async () => {
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	if (temp) {
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

describe('startDaemon', () => {
	it('serves status over the socket it bound', async () => {
		temp = await createTempSocket();
		await start(temp.socketPath);

		const client = await connectWithoutStarting(temp.socketPath);
		expect(client).not.toBeNull();

		await expect(client?.request('status', {})).resolves.toMatchObject({
			protocolVersion: PROTOCOL_VERSION,
			pid: process.pid,
		});
		await client?.close();
	});

	it('lets exactly one of two concurrent starts win the bind', async () => {
		temp = await createTempSocket();

		const results = await Promise.all([start(temp.socketPath), start(temp.socketPath)]);

		expect(results.filter((result) => result.started)).toHaveLength(1);
		expect(results.filter((result) => !result.started)).toHaveLength(1);

		// The loser is not an error state: the path is served, which is all its caller wanted.
		const client = await connectWithoutStarting(temp.socketPath);
		await expect(client?.request('status', {})).resolves.toMatchObject({ pid: process.pid });
		await client?.close();
	});

	it('keeps exactly one winner when five starts race', async () => {
		temp = await createTempSocket();

		const results = await Promise.all(Array.from({ length: 5 }, () => start(temp.socketPath)));

		expect(results.filter((result) => result.started)).toHaveLength(1);
	});

	it('recovers from a socket path left behind by a crashed daemon', async () => {
		temp = await createTempSocket();
		// A file sitting on the path is what a killed daemon leaves: `bind` refuses with
		// EADDRINUSE, and nothing is listening behind it.
		await writeFile(temp.socketPath, '');
		const staleInode = (await stat(temp.socketPath, { bigint: true })).ino;

		const result = await start(temp.socketPath);

		expect(result.started).toBe(true);
		expect((await stat(temp.socketPath, { bigint: true })).ino).not.toBe(staleInode);

		const client = await connectWithoutStarting(temp.socketPath);
		await expect(client?.request('status', {})).resolves.toMatchObject({ pid: process.pid });
		await client?.close();
	});

	it('does not unlink a socket a live daemon is serving', async () => {
		temp = await createTempSocket();
		const winner = await start(temp.socketPath);
		const inode = (await stat(temp.socketPath, { bigint: true })).ino;

		const loser = await start(temp.socketPath);

		expect(winner.started).toBe(true);
		expect(loser.started).toBe(false);
		expect((await stat(temp.socketPath, { bigint: true })).ino).toBe(inode);
	});

	it('unlinks its socket on close', async () => {
		temp = await createTempSocket();
		const daemon = await start(temp.socketPath);
		expect(await exists(temp.socketPath)).toBe(true);

		await Promise.all(running.splice(0).map((each) => each.close()));

		expect(daemon.started).toBe(true);
		expect(await exists(temp.socketPath)).toBe(false);
	});

	it('closes even with a client still connected, and is safe to call twice', async () => {
		temp = await createTempSocket();
		const daemon = await start(temp.socketPath);
		const client = await connectWithoutStarting(temp.socketPath);
		await client?.request('status', {});

		const [first] = running.splice(0);
		// A `close()` that waited for an idle connection to end would never resolve here.
		await first?.close();
		await first?.close();

		expect(daemon.started).toBe(true);
		expect(await exists(temp.socketPath)).toBe(false);
		await client?.close();
	});
});
