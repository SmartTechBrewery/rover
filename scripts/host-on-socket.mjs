#!/usr/bin/env node
/**
 * `src/daemon/host-on-socket.ts`, answered as one line of JSON on stdout — the only way a shell
 * script can ask *is a Rover host already holding this socket, and which process is it*.
 *
 * **It exists so that `bin/rover-server-agent` does not write a second check.** That script has to
 * refuse `install` while a host already holds the socket, because a launchd job with `KeepAlive`
 * that loses the bind is not an error message, it is a thirty-second crash loop forever. The check
 * it needs is the one `rover server` already makes, and a hand-rolled `nc`/`lsof` equivalent in bash
 * is exactly the copy that eventually disagrees with it (ai/RULES.md §2, #171's reason).
 *
 * **`rover status` is not an alternative and must never become one**: it is a client call, so it
 * *autostarts* a daemon when none is running (D5, `src/daemon/connect.ts`) — with `ROVER_LISTEN_PORT`
 * and `ROVER_HTTP_PORT` cleared. Using it to ask whether a host is running is the exact damage the
 * install guard exists to prevent.
 *
 * **It reads the environment and nothing else.** `ROVER_SOCKET_PATH` where the operator set one, the
 * default otherwise — the same resolution every client and the daemon itself make.
 *
 * `.mjs` and plain JavaScript, then the TypeScript loader registered by hand: `bin/rover.mjs` states
 * the whole of that reasoning, including why the loader is a bare specifier resolved from *this*
 * module's URL rather than from the caller's working directory. The caller here is a shell in
 * whatever directory the operator is standing in, so that property is not incidental.
 *
 * Output is one JSON object, always, on a single line:
 *
 *   {"outcome":"free"}
 *   {"outcome":"host","pid":4321,"uptimeMs":11045}
 *   {"outcome":"foreign"}
 *   {"outcome":"error","message":"…"}     — and exit 1
 */

import { fileURLToPath } from 'node:url';

/** The checkout this probe belongs to, named in the one failure an operator can act on. */
const checkout = new URL('..', import.meta.url);

function say(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
	const { register } = await import('tsx/esm/api');
	register();
	const { hostOnSocket } = await import(new URL('src/daemon/host-on-socket.ts', checkout).href);
	const { resolveSocketPath } = await import(new URL('src/daemon/socket-path.ts', checkout).href);
	say(await hostOnSocket(resolveSocketPath()));
} catch (error) {
	say({
		outcome: 'error',
		message: `${error instanceof Error ? error.message : String(error)} (in ${fileURLToPath(checkout)})`,
	});
	process.exitCode = 1;
}
