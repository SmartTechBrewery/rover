import { access } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { hostOnSocket } from '@/daemon/host-on-socket.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

/**
 * The probe two guards refuse on — `rover server` and `bin/rover-server-agent install`.
 *
 * Against a **real** unix socket, for `bind-race.test.ts`' reason: what is being claimed is that
 * this question can be answered *without starting a host*, and a mocked connection that never
 * touches the filesystem cannot show that nothing appeared at the path.
 *
 * The stakes are why this has a suite of its own rather than riding on the command's. A wrong
 * `free` tells `install` to write a `KeepAlive` launchd job against a socket somebody already
 * holds, and that is not an error message — it is a host that exits 1 and is restarted every
 * thirty seconds forever, with a panel nobody can explain the absence of (#294).
 */

let temp: TempSocket;
const running: RunningDaemon[] = [];
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	await Promise.all(
		servers
			.splice(0)
			.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
	if (temp) {
		await removeTempSocket(temp);
	}
});

async function startHost(socketPath: string): Promise<void> {
	const result = await startDaemon({
		socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		keptTestsPath: temp.keptTestsPath,
		retention: temp.retention,
	});
	if (!result.started) {
		throw new Error(`nothing bound ${socketPath}`);
	}
	running.push(result);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe('hostOnSocket', () => {
	it('answers free when nothing is listening', async () => {
		temp = await createTempSocket();

		await expect(hostOnSocket(temp.socketPath)).resolves.toEqual({ outcome: 'free' });
	});

	/**
	 * The property the module exists for (D5): `connectToLocalDaemon` would *spawn* a daemon here,
	 * which would make asking whether a host is running the thing that starts one — and the daemon
	 * it started would be the portless kind this whole feature is about.
	 */
	it('starts nothing when it finds nothing', async () => {
		temp = await createTempSocket();

		await hostOnSocket(temp.socketPath);

		expect(await exists(temp.socketPath)).toBe(false);
		await expect(hostOnSocket(temp.socketPath)).resolves.toEqual({ outcome: 'free' });
	});

	/**
	 * The pid is the whole reason the answer is structured rather than a sentence: it is what
	 * `rover-server-agent status` compares against the pid launchd holds for its own job, which is
	 * how a host that autostarted onto the socket is told apart from the agent's own.
	 */
	it('names the pid of the host that answers', async () => {
		temp = await createTempSocket();
		await startHost(temp.socketPath);

		const found = await hostOnSocket(temp.socketPath);

		expect(found.outcome).toBe('host');
		expect(found).toMatchObject({ pid: process.pid });
		expect(found.outcome === 'host' && found.uptimeMs).toBeGreaterThanOrEqual(0);
	});

	/**
	 * Something is on the path and will not talk the surface. Not this module's to diagnose or to
	 * clear away — and starting a second host at it is the one thing that must not happen, so it
	 * is deliberately *not* `free`.
	 */
	it('answers foreign when the path is held by something that is not a host', async () => {
		temp = await createTempSocket();
		const server = createServer((socket) => socket.destroy());
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(temp.socketPath, resolve));

		await expect(hostOnSocket(temp.socketPath)).resolves.toEqual({ outcome: 'foreign' });
	});
});
