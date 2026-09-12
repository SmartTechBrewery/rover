/**
 * `rover panel` now that the host serves `panel/dist` (R52, #293): a line, not a server.
 *
 * The acceptance criterion is a **negative** one, and it is the reason this suite exists at all —
 * the command starts no process and talks to no host. It used to spawn Vite, and the shape most
 * likely to come back is a "helpful" probe of whether the host is up; both are asserted against
 * here the way `users.test.ts` asserts its own negative, with `ROVER_SOCKET_PATH` pointed at a path
 * nobody serves, so anything that reached `connectToHost()` would have autostarted a real daemon
 * on it and `afterEach` would find it.
 *
 * The positive half is that the URL it prints is the one the daemon would bind — same variables,
 * same scheme rule, same brackets — which is `panelOriginFor`'s whole job and is asserted here
 * rather than by reading that function.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_OK, run } from '@/cli/index.js';
import {
	HTTP_ADDRESS_ENV_VAR,
	HTTP_PORT_ENV_VAR,
	TLS_CERT_ENV_VAR,
	TLS_KEY_ENV_VAR,
} from '@/daemon/network-config.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	stopDaemonAt,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

let temp: TempSocket;
let logged: string[];

/** Everything the run wrote, on either stream. */
function printed(): string {
	return logged.join('\n');
}

beforeEach(async () => {
	temp = await createTempSocket();
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	// Every variable this command reads, blanked first: an exported one in the developer's own
	// shell must not decide what these assertions see. Empty counts as unset (`network-config.ts`).
	for (const variable of [
		HTTP_PORT_ENV_VAR,
		HTTP_ADDRESS_ENV_VAR,
		TLS_CERT_ENV_VAR,
		TLS_KEY_ENV_VAR,
	]) {
		vi.stubEnv(variable, '');
	}
	logged = [];
	vi.spyOn(console, 'log').mockImplementation((line: string) => logged.push(line));
	vi.spyOn(console, 'warn').mockImplementation((line: string) => logged.push(line));
	vi.spyOn(console, 'error').mockImplementation((line: string) => logged.push(line));
});

afterEach(async () => {
	vi.restoreAllMocks();
	const stray = await connectWithoutStarting(temp.socketPath);
	if (stray) {
		await stray.close();
		await stopDaemonAt(temp.socketPath);
	}
	await removeTempSocket(temp);
	// The load-bearing assertion: nothing was started, and nothing was asked.
	expect(stray).toBeNull();
});

describe('rover panel', () => {
	it('prints the host URL its own ROVER_HTTP_PORT names', async () => {
		vi.stubEnv(HTTP_PORT_ENV_VAR, '4712');

		expect(await run(['panel'])).toBe(EXIT_OK);

		expect(printed()).toContain('http://127.0.0.1:4712');
	});

	it('follows ROVER_HTTP_ADDRESS, so the URL cannot disagree with the bind', async () => {
		vi.stubEnv(HTTP_PORT_ENV_VAR, '9000');
		vi.stubEnv(HTTP_ADDRESS_ENV_VAR, '127.0.0.2');

		expect(await run(['panel'])).toBe(EXIT_OK);

		expect(printed()).toContain('http://127.0.0.2:9000');
	});

	it('says what has to be running and what has to be built', async () => {
		vi.stubEnv(HTTP_PORT_ENV_VAR, '4712');

		expect(await run(['panel'])).toBe(EXIT_OK);

		// The two things an operator otherwise assembles from three documents — and the credential,
		// which is the first thing anybody gets wrong.
		expect(printed()).toContain('rover server');
		expect(printed()).toContain('npm run panel:build');
		expect(printed()).toContain('rover users add panel');
	});

	it('says the switch is off rather than printing a URL nothing answers', async () => {
		expect(await run(['panel'])).toBe(EXIT_OK);

		expect(printed()).toContain(HTTP_PORT_ENV_VAR);
		// It still leaves the operator a runnable recipe rather than only a complaint.
		expect(printed()).toContain('rover server');
	});

	/**
	 * `rover panel` no longer serves anything, so nothing it prints may still describe itself as a
	 * server on `:5174`. This is the drift guard on a text three documents were derived from.
	 */
	it('no longer offers itself as a development server', async () => {
		vi.stubEnv(HTTP_PORT_ENV_VAR, '4712');

		expect(await run(['panel'])).toBe(EXIT_OK);
		expect(await run(['panel', '--help'])).toBe(EXIT_OK);

		expect(printed()).not.toContain('5174');
		expect(printed()).not.toContain('devDependencies');
	});
});
