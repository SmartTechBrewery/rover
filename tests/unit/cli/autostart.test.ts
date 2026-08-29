/**
 * "Using the CLI never requires starting anything by hand" (D5), as one executable test.
 *
 * A **real detached child process**, like `tests/unit/daemon/autostart.test.ts` — a mocked
 * `spawn` would prove that a function was called, not that a command run against a socket
 * nobody serves comes back with an answer (ai/TESTING.md).
 *
 * The CLI implements none of this: it calls `connectToLocalDaemon()`, and every part of
 * autostart — the spawn, the bounded retry, the "nothing is listening" discrimination —
 * lives there. What this asserts is that the CLI is wired to it and did not grow its own.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_OK, run } from '@/cli/index.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	stopDaemonAt,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

/** A whole Node process has to start, load a loader and this module tree, and bind. */
const TEST_TIMEOUT_MS = 30_000;

let temp: TempSocket;

afterEach(async () => {
	vi.restoreAllMocks();
	if (temp) {
		await stopDaemonAt(temp.socketPath);
		await removeTempSocket(temp);
	}
});

describe('rover status, with no daemon running', () => {
	it('brings one up and answers', { timeout: TEST_TIMEOUT_MS }, async () => {
		temp = await createTempSocket();
		vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
		const logged: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((line: string) => logged.push(line));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await connectWithoutStarting(temp.socketPath)).toBeNull();

		expect(await run(['status', '--json'])).toBe(EXIT_OK);

		const answer: unknown = JSON.parse(logged[0] ?? '');
		expect(answer).toMatchObject({ host: 'local' });
		// A separate process, so the CLI never became its own host.
		expect((answer as { pid: number }).pid).not.toBe(process.pid);

		// And it is still there for the next command, rather than having answered once from
		// something that exited with the request.
		const later = await connectWithoutStarting(temp.socketPath);
		await expect(later?.request('status', {})).resolves.toMatchObject({
			pid: (answer as { pid: number }).pid,
		});
		await later?.close();
	});
});
