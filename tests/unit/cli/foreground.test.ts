import { describe, expect, it } from 'vitest';
import { runInForeground } from '@/cli/_shared/foreground.js';
import * as panel from '@/cli/commands/panel.js';
import * as server from '@/cli/commands/server.js';
import { daemonForegroundCommand } from '@/daemon/connect.js';
import { HTTP_PORT_ENV_VAR, LISTEN_PORT_ENV_VAR } from '@/daemon/network-config.js';
import { SOCKET_PATH_ENV_VAR } from '@/daemon/socket-path.js';

/**
 * The deliberate start — `rover server` and `rover panel` — and the runner both share.
 *
 * The child here is always a `node -e`, never a daemon and never a dev server: what these cases
 * are about is the contract around the process (its exit code, the environment it is handed),
 * and starting a real host would make this suite a port allocator.
 */

describe('runInForeground', () => {
	it("answers with the child's own exit code", async () => {
		await expect(
			runInForeground({ args: ['-e', 'process.exit(3)'], cwd: process.cwd() }),
		).resolves.toBe(3);
	});

	/** The shell's own convention, so `rover server` interrupted reads like anything else killed. */
	it('answers 128 + n when a signal ended the child', async () => {
		await expect(
			runInForeground({ args: ['-e', 'process.kill(process.pid, "SIGTERM")'], cwd: process.cwd() }),
		).resolves.toBe(143);
	});

	it('hands the child the environment it was given', async () => {
		await expect(
			runInForeground({
				args: ['-e', 'process.exit(process.env.ROVER_TEST_MARKER === "here" ? 0 : 9)'],
				cwd: process.cwd(),
				env: { ...process.env, ROVER_TEST_MARKER: 'here' },
			}),
		).resolves.toBe(0);
	});

	/** Nothing is left listening for signals once the child is gone. */
	it('removes its signal handlers when the child exits', async () => {
		const before = process.listenerCount('SIGINT');

		await runInForeground({ args: ['-e', ''], cwd: process.cwd() });

		expect(process.listenerCount('SIGINT')).toBe(before);
	});
});

describe('the command the daemon is started with', () => {
	/**
	 * **The load-bearing difference from the autostart** (D17, D29): a client that brings a daemon
	 * up behind you clears both of these, because a host that began listening for the network or
	 * for browsers as a side effect of `rover list` would be exposure nobody chose. One somebody
	 * typed `rover server` for is the opposite, and this is where that is decided.
	 */
	it('keeps the two settings that make a host reachable', () => {
		const { env } = daemonForegroundCommand('/tmp/rover-test.sock');

		expect(env[LISTEN_PORT_ENV_VAR]).toBe(process.env[LISTEN_PORT_ENV_VAR]);
		expect(env[HTTP_PORT_ENV_VAR]).toBe(process.env[HTTP_PORT_ENV_VAR]);
	});

	it('points the child at the socket it was given', () => {
		const { env, args, cwd } = daemonForegroundCommand('/tmp/rover-test.sock');

		expect(env[SOCKET_PATH_ENV_VAR]).toBe('/tmp/rover-test.sock');
		expect(args.at(-1)).toMatch(/daemon\/main\.[tj]s$/);
		// The package the entry belongs to, never wherever the operator happened to type: a host
		// outlives that directory, and holding one that is later deleted is how a long-lived
		// process ends up unable to resolve anything.
		expect(args.at(-1)?.startsWith(cwd)).toBe(true);
	});
});

describe('what the two commands take', () => {
	it.each([
		['server', server],
		['panel', panel],
	])('%s prints its usage for --help and takes no positionals', async (name, command) => {
		await expect(command.run(['--help'])).resolves.toBe(0);
		await expect(command.run(['something'])).rejects.toThrow(new RegExp(name));
	});

	/**
	 * Neither takes `--host`: one runs a host here and the other serves a page beside it, and a
	 * flag naming another machine would be a promise neither can keep (D17).
	 */
	it.each([
		['server', server],
		['panel', panel],
	])('%s refuses --host rather than quietly ignoring it', async (_name, command) => {
		await expect(command.run(['--host', 'remote'])).rejects.toThrow();
	});
});
