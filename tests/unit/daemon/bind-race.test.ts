/**
 * The bind race, against a real unix socket in a temp directory.
 *
 * There is no mock of a socket here on purpose (ai/TESTING.md): what R6 promises is that
 * **the kernel's `bind` is the mutual exclusion**, and a fake `listen()` that never touches
 * the filesystem cannot fail with `EADDRINUSE`, so it cannot prove the thing being claimed.
 */

import { access, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
	type RunningDaemon,
	reclaimLockPath,
	type StartResult,
	startDaemon,
} from '@/daemon/listen.js';
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
		expect((await stat(temp.socketPath)).isSocket()).toBe(false);

		const result = await start(temp.socketPath);

		expect(result.started).toBe(true);
		// Not an inode comparison: a freed inode can be reused for the very next file created
		// in the same directory, which some filesystems do deterministically for an
		// unlink-then-create this close together. What actually proves the reclaim is that the
		// stale regular file is gone and a socket is bound in its place.
		expect((await stat(temp.socketPath)).isSocket()).toBe(true);

		const client = await connectWithoutStarting(temp.socketPath);
		await expect(client?.request('status', {})).resolves.toMatchObject({ pid: process.pid });
		await client?.close();
	});

	it("keeps exactly one winner when four starts race over a crashed daemon's socket", async () => {
		temp = await createTempSocket();
		await writeFile(temp.socketPath, '');

		// The interleaving F1 is about: every one of these fails its first bind, judges the
		// same corpse stale, and would — unserialized — be free to unlink whatever the winner
		// had just bound there.
		const results = await Promise.all(Array.from({ length: 4 }, () => start(temp.socketPath)));

		expect(results.filter((result) => result.started)).toHaveLength(1);

		// The winner is the daemon on the path, not a daemon stranded beside it: the path
		// answers, and closing the winner is what takes it away.
		const client = await connectWithoutStarting(temp.socketPath);
		await expect(client?.request('status', {})).resolves.toMatchObject({ pid: process.pid });
		await client?.close();

		await Promise.all(running.splice(0).map((each) => each.close()));
		expect(await exists(temp.socketPath)).toBe(false);
	});

	it('leaves the stale path alone while another reclaimer holds the lock', {
		// The full lock wait plus a bind attempt, well past vitest's 5 s default.
		timeout: 15_000,
	}, async () => {
		temp = await createTempSocket();
		await writeFile(temp.socketPath, '');
		const staleInode = (await stat(temp.socketPath, { bigint: true })).ino;
		// Stand in for the reclaimer that is between its probe and its bind. Whatever it does
		// with the path next, this start may not remove it.
		await writeFile(reclaimLockPath(temp.socketPath), '');

		const result = await start(temp.socketPath);

		expect(result.started).toBe(false);
		expect((await stat(temp.socketPath, { bigint: true })).ino).toBe(staleInode);
		await rm(reclaimLockPath(temp.socketPath), { force: true });
	});

	it('reclaims through a lock whose owner died holding it', async () => {
		temp = await createTempSocket();
		await writeFile(temp.socketPath, '');
		const lockPath = reclaimLockPath(temp.socketPath);
		await writeFile(lockPath, '');
		// A lock is held for one probe and one bind. A minute old is a process that was killed
		// mid-reclaim, and believing it forever would make the path unreclaimable for good.
		const longAgo = new Date(Date.now() - 60_000);
		await utimes(lockPath, longAgo, longAgo);

		const result = await start(temp.socketPath);

		expect(result.started).toBe(true);
		expect(await exists(lockPath)).toBe(false);
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
